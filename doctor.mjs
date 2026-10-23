#!/usr/bin/env node
/**
 * doctor.mjs — 一条命令看清闸门到底在不在工作（只读，不改任何东西）
 * 用法：node doctor.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizeText } from './guard.mjs'

const HERE = import.meta.dirname
const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const profile = join(dshHome, 'profiles', 'desktop')
const guardDir = join(dshHome, 'youzi-guard')
const gatewayJs = join(profile, 'node_modules', '@michengai', 'dsh-im-connect', 'lib', 'engine', 'gateway.js')
const logFile = join(dshHome, 'dsh-im-connect', 'gateway.log')
const md5 = file => createHash('md5').update(readFileSync(file)).digest('hex')
const ok = v => (v ? '✔' : '✘')

console.log('══ 1. 插件挂点 ══')
if (!existsSync(gatewayJs)) console.log('✘ 找不到 gateway.js，插件路径变了')
else {
  const src = readFileSync(gatewayJs, 'utf8')
  const markers = src.split('// [youzi-guard:BEGIN]').length - 1
  console.log(`${ok(markers === 2)} 挂点标记 = ${markers}/2  （插件更新会清掉，重跑 apply-guard-patch.mjs）`)
  console.log(`   备份 = ${existsSync(gatewayJs + '.youzi-guard.bak') ? '在' : '不在（无法 revert）'}`)
}

console.log('\n══ 2. 闸门本体 ══')
for (const name of ['guard.mjs', 'config.json', 'passphrase.sha256']) {
  const file = join(guardDir, name)
  console.log(`${ok(existsSync(file))} ${name} ${existsSync(file) ? `(${statSync(file).size} 字节)` : '缺失'}`)
}
if (existsSync(join(guardDir, 'guard.mjs')) && existsSync(join(HERE, 'guard.mjs'))) {
  const same = md5(join(guardDir, 'guard.mjs')) === md5(join(HERE, 'guard.mjs'))
  console.log(`${ok(same)} 部署里的 guard.mjs 与工作区这份${same ? '一致' : '不一致（改过代码就要重新拷过去）'}`)
}

console.log('\n══ 3. 暗号来源（谁在生效）══')
const envValue = String(process.env.YOUZI_PASSPHRASE ?? '')
const digestFile = join(guardDir, 'passphrase.sha256')
const fileDigest = existsSync(digestFile) ? readFileSync(digestFile, 'utf8').trim() : ''
const digestOf = t => createHash('sha256').update(normalizeText(t), 'utf8').digest('hex')
if (envValue.trim()) {
  console.log(`⚠️ 环境变量 YOUZI_PASSPHRASE 已设置（${envValue.length} 字符）→ 它压过摘要文件`)
  console.log(`   环境变量摘要 = ${digestOf(envValue).slice(0, 12)}…`)
}
console.log(`${ok(Boolean(fileDigest))} 摘要文件 = ${fileDigest ? fileDigest.slice(0, 12) + '…（64 位 sha256）' : '未配置（谁都不能认主）'}`)
if (envValue.trim() && fileDigest && digestOf(envValue) !== fileDigest) console.log('⚠️ 两者不是同一个暗号，实际生效的是环境变量那个')

console.log('\n══ 4. 运行状态 ══')
const stateFile = join(guardDir, 'state.json')
try {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const bindings = Object.keys(state.bindings ?? {})
  const locks = Object.entries(state.locks ?? {})
  console.log(`${ok(bindings.length > 0)} 已认证绑定 ${bindings.length} 个 ${bindings.join(', ')}`)
  for (const [key, lock] of locks) console.log(`   锁定中：${key} 到 ${new Date(Number(lock.until)).toLocaleString()}`)
} catch { console.log('✘ state.json 不存在：闸门一次都没被触发过（宿主没重启，或消息走了群聊策略 off）') }

const attempts = join(guardDir, 'attempts.jsonl')
if (existsSync(attempts)) {
  const rows = readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const counts = {}
  for (const row of rows) counts[row.event] = (counts[row.event] ?? 0) + 1
  console.log(`✔ 留档 ${rows.length} 条：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('  ')}`)
  const last = rows.slice(-3)
  for (const row of last) console.log(`   最近：${row.ts} ${row.event}${row.reason ? ' ' + row.reason : ''}${row.user ? ' user=' + row.user : ''}${row.channelId ? ' @' + row.channelId : ''}`)
} else console.log('✘ attempts.jsonl 不存在：闸门没跑过')

console.log('\n══ 4.5 群聊能不能算主人（跨场景认主）══')
try {
  const cfg = JSON.parse(readFileSync(join(guardDir, 'config.json'), 'utf8'))
  console.log('crossChatVerify = ' + (cfg.crossChatVerify !== false) + ' ｜ groupVerify = ' + (cfg.groupVerify === true) + ' ｜ groupPolicy = ' + (cfg.groupPolicy ?? 'inject'))
  const ids = cfg.identities ?? {}
  const groups = Object.entries(ids).filter(([, list]) => Array.isArray(list) && list.length)
  if (!groups.length) console.log('✘ 还没配 identities：群里认不出"你就是私聊那位"（QQ 的私聊 id 与群聊 id 是两套）→ 跑 node discover-ids.mjs --apply')
  for (const [channel, list] of groups) for (const item of list) console.log('✔ ' + channel + '：' + (item.label ?? '身份') + ' = ' + item.userIds.join(' , '))
} catch { console.log('config.json 读取失败') }

console.log('\n══ 4.6 群聊配对（把群里的 id 绑到主人）══')
try {
  const st = JSON.parse(readFileSync(join(guardDir, 'state.json'), 'utf8'))
  const pend = Object.entries(st.pairings ?? {})
  if (!pend.length) console.log('（没有待用的配对码。要认群：私聊发「配对」→ 群里 @ 她说「配对 六位码」）')
  for (const [channel, rec] of pend) console.log('✔ 待用配对码 @' + channel + '：' + rec.code + '（有效期至 ' + new Date(Number(rec.exp)).toLocaleTimeString('zh-CN') + '）')
  const viaPairing = Object.entries(st.bindings ?? {}).filter(([, v]) => v.via === 'pairing').map(([k]) => k)
  if (viaPairing.length) console.log('✔ 靠配对绑定进来的身份：' + viaPairing.join(' , '))
} catch { console.log('state.json 读取失败') }

console.log('\n══ 5. 最近的消息走的是私聊还是群聊 ══')
if (!existsSync(logFile)) console.log('✘ 找不到 gateway.log')
else {
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(line => line.includes('已注入')).slice(-5)
  if (!lines.length) console.log('最近没有消息注入过')
  for (const line of lines) {
    const m = /\[(qq_[0-9a-f]+|weixin_[0-9a-f]+)\] 已注入 (\S+)/.exec(line)
    if (!m) continue
    const kind = m[2].includes(':group:') ? '群聊' : '私聊'
    const ts = (line.match(/^(\S+)T/) ?? [])[1]
    console.log(`   ${ts ?? ''} ${m[1]} ${kind}  ${m[2]}`)
  }
  const lastGroup = /:group:/.test(lines[lines.length - 1] ?? '')
  console.log(lastGroup
    ? '   ⚠️ 最近一条是群聊：认主不在群里发生。想在群里也当主人：先在群里 @ 她说一句，再跑 node discover-ids.mjs --apply'
    : '   最近一条是私聊：对暗号应该能认主')
}

console.log('\n══ 结论 ══')
console.log('· 想让改动生效：改完代码/提示词 → 完全退出 DSH（含托盘）再启动')
console.log('· 想验认主：只能在私聊里发暗号；群里发暗号会被吞掉并提示去私聊')
console.log('· 想换暗号：node set-passphrase.mjs（注意环境变量优先级最高）')
