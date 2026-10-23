#!/usr/bin/env node
/**
 * discover-ids.mjs — 把「同一个人」的两种 id 绑成一组，让认主能跨私聊/群聊生效
 * ============================================================================
 * 为什么需要它：QQ 开放平台给同一个人的 id 分两套 ——
 *   私聊消息 author.user_openid ；群聊消息 author.member_openid 。
 *   两者是不同的值，所以"私聊认了主、群里还算主人"必须靠一张身份映射表。
 *
 * 用法：
 *   node discover-ids.mjs             # 看看闸门日志里出现过哪些 id
 *   node discover-ids.mjs --apply     # 把同一渠道的私聊 id 与群聊 id 绑成一个人，写进 config.json
 *
 * 前提：先在群里 @ 小柚 说一句话（让闸门记下你在群里的 id），再跑 --apply。
 * 写完即时生效（闸门每次调用都读最新 config），不用重启。
 * ============================================================================
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const apply = process.argv.includes('--apply')
const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const guardDir = process.env.YOUZI_GUARD_DIR
  ? (isAbsolute(process.env.YOUZI_GUARD_DIR) ? process.env.YOUZI_GUARD_DIR : join(process.cwd(), process.env.YOUZI_GUARD_DIR))
  : join(dshHome, 'youzi-guard')
const configFile = join(guardDir, 'config.json')
const logFile = join(guardDir, 'attempts.jsonl')

if (!existsSync(configFile)) { console.error(`找不到 ${configFile}`); process.exit(2) }
const cfg = JSON.parse(readFileSync(configFile, 'utf8'))
const rows = existsSync(logFile)
  ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []

const seen = new Map() // channelId -> { dm:Set, group:Set }
for (const row of rows) {
  if (!row?.uid || !row?.channelId) continue
  if (!seen.has(row.channelId)) seen.set(row.channelId, { dm: new Set(), group: new Set() })
  const bucket = seen.get(row.channelId)
  const isGroup = String(row.chatId ?? '').startsWith('g:') || row.group === true
  ;(isGroup ? bucket.group : bucket.dm).add(row.uid)
}

if (!seen.size) {
  console.log('日志里还没有可用的 id。')
  console.log('请先在私聊和群里各 @/发给小柚 一句话（并确认闸门已生效），再回来跑这个命令。')
  process.exit(1)
}

console.log(`日志文件：${logFile}\n`)
for (const [channelId, bucket] of seen) {
  console.log(`渠道 ${channelId}`)
  console.log(`  私聊 id（user_openid）：${bucket.dm.size ? [...bucket.dm].join(', ') : '（无）'}`)
  console.log(`  群聊 id（member_openid）：${bucket.group.size ? [...bucket.group].join(', ') : '（无）'}`)
}

if (!apply) {
  console.log('\n加 --apply 可把同一渠道的私聊 id 与群聊 id 绑成"同一个人"，之后群里也算主人。')
  process.exit(0)
}

const identities = cfg.identities && typeof cfg.identities === 'object' ? cfg.identities : {}
let changed = 0
for (const [channelId, bucket] of seen) {
  const ids = [...bucket.dm, ...bucket.group]
  if (!ids.length) continue
  const list = Array.isArray(identities[channelId]) ? identities[channelId] : []
  const existing = list.find(item => Array.isArray(item?.userIds) && item.userIds.some(id => ids.includes(id)))
  if (existing) {
    const merged = [...new Set([...existing.userIds.map(String), ...ids])]
    if (merged.length !== existing.userIds.length) { existing.userIds = merged; changed += 1 }
  } else {
    list.push({ label: '主人', userIds: ids })
    identities[channelId] = list
    changed += 1
  }
}
if (!changed) { console.log('\n身份映射已是最新，没有需要改的。'); process.exit(0) }

copyFileSync(configFile, `${configFile}.bak-ids-${Date.now()}`)
cfg.identities = identities
writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
console.log('\n已写入身份映射（原文件已备份 .bak-ids-*）：')
console.log(JSON.stringify(identities, null, 2))
console.log('\n即时生效，不用重启。现在去群里 @ 小柚 试一句。')
