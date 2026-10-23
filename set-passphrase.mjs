#!/usr/bin/env node
/**
 * set-passphrase.mjs — 改暗号的唯一入口
 * ============================================================================
 * 暗号只有三个可能存放处（guard.mjs 的 loadPassphraseDigest 按此优先级读）：
 *   ① 环境变量  YOUZI_PASSPHRASE       ← 优先级最高；窗口里 set 的不算数，必须是 DSH 进程能看到的
 *   ② 摘要文件  %DSH_HOME%\youzi-guard\passphrase.sha256   ← 推荐；磁盘上只有 sha256，没有明文
 *   ③ config.json 的 passphrase.sha256 ← 兜底（与 ② 同义，只是换个位置）
 *
 * 用法：
 *   node set-passphrase.mjs                 交互式设置（输入隐藏回显，要求输两遍）
 *   node set-passphrase.mjs --stdin         从管道读（脚本/一次性用）
 *   node set-passphrase.mjs --verify        输入一个暗号，校验是否与当前摘要一致
 *   node set-passphrase.mjs --show          看当前用的是哪个来源、摘要前 12 位
 *   node set-passphrase.mjs --clear         删掉摘要 = 谁都不能认主（宁拒不认）
 * 附加开关：
 *   --keep-bindings   轮换时保留已认证的绑定（默认轮换即撤销，因为轮换通常意味着旧暗号已泄漏）
 *   --dir <path>      指定 youzi-guard 目录（默认 %DSH_HOME%\youzi-guard）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, timingSafeEqual } from 'node:crypto'
import { normalizeText } from './guard.mjs'

function argvOf(argv) {
  const out = { mode: 'set', keepBindings: false, dir: '', file: '', clear: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--stdin') out.mode = 'stdin'
    else if (a === '--verify') out.mode = 'verify'
    else if (a === '--show') out.mode = 'show'
    else if (a === '--clear') out.mode = 'clear'
    else if (a === '--keep-bindings') out.keepBindings = true
    else if (a === '--dir') out.dir = String(argv[++i] ?? '')
    else if (a === '--config') out.file = String(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') out.mode = 'help'
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const opts = argvOf(process.argv.slice(2))
if (opts.mode === 'help') {
  console.log('用法：node set-passphrase.mjs [--stdin|--verify|--show|--clear] [--keep-bindings] [--dir <youzi-guard 目录>]')
  process.exit(0)
}

const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const dir = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : join(process.cwd(), opts.dir)) : join(dshHome, 'youzi-guard')
const digestFile = join(dir, 'passphrase.sha256')
const configFile = opts.file ? (isAbsolute(opts.file) ? opts.file : join(process.cwd(), opts.file)) : join(dir, 'config.json')
const stateFile = join(dir, 'state.json')

const digestOf = text => createHash('sha256').update(normalizeText(text), 'utf8').digest('hex')
const same = (a, b) => /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

function currentSource() {
  const envName = String(process.env.YOUZI_PASSPHRASE ?? '')
  if (envName.trim()) return { source: '环境变量 YOUZI_PASSPHRASE', digest: digestOf(envName), note: '⚠️ 环境变量存在时，摘要文件会被忽略' }
  if (existsSync(digestFile)) {
    const text = readFileSync(digestFile, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(text)) return { source: digestFile, digest: text.toLowerCase() }
    if (text) return { source: digestFile + '（明文，建议改用摘要）', digest: digestOf(text) }
  }
  try {
    const json = JSON.parse(readFileSync(configFile, 'utf8'))
    const inline = String(json?.passphrase?.sha256 ?? '').trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(inline)) return { source: configFile + ' 的 passphrase.sha256', digest: inline }
  } catch { /* 没有 config 也算没配置 */ }
  return { source: '（未配置）', digest: '', note: '未配置 = 谁都不能认主' }
}

/** 隐藏回显地读一行；非 TTY（管道）时直接读 stdin */
async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  process.stdout.write(prompt)
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const done = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      error ? reject(error) : resolve(value)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return done(new Error('已取消'))
        if (char === '\r' || char === '\n') return done()
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

function revokeBindings() {
  if (!existsSync(stateFile)) return false
  try {
    const json = JSON.parse(readFileSync(stateFile, 'utf8'))
    const count = Object.keys(json.bindings ?? {}).length
    json.bindings = {}
    json.failures = {}
    const tmp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8')
    renameSync(tmp, stateFile)
    return count
  } catch { return false }
}

function writeDigest(digest) {
  mkdirSync(dir, { recursive: true })
  const tmp = `${digestFile}.${process.pid}.tmp`
  writeFileSync(tmp, digest + '\n', 'utf8')
  renameSync(tmp, digestFile)
}

if (opts.mode === 'show') {
  const cur = currentSource()
  console.log(`生效来源：${cur.source}`)
  console.log(`摘要：${cur.digest ? cur.digest.slice(0, 12) + '…（共 64 位，不可逆）' : '未配置'}`)
  if (cur.note) console.log(cur.note)
  if (existsSync(stateFile)) {
    try {
      const json = JSON.parse(readFileSync(stateFile, 'utf8'))
      const ids = Object.keys(json.bindings ?? {})
      const locks = Object.keys(json.locks ?? {})
      console.log(`已认证绑定：${ids.length} 个${ids.length ? '（' + ids.join(', ') + '）' : ''}`)
      console.log(`锁定中：${locks.length} 个${locks.length ? '（' + locks.join(', ') + '）' : ''}`)
    } catch { console.log('state.json 读取失败') }
  } else {
    console.log('state.json 还不存在：一条消息都没过闸门（多半是宿主没重启，或还没人发消息）')
  }
  process.exit(0)
}

if (opts.mode === 'verify') {
  const cur = currentSource()
  if (!cur.digest) { console.error('未配置暗号，无法校验'); process.exit(2) }
  const input = await readHidden('输入要校验的暗号（不回显）：')
  console.log(same(digestOf(input), cur.digest) ? '✔ 一致：这个暗号能认主' : '✘ 不一致：这个暗号认不了主')
  process.exit(0)
}

if (opts.mode === 'clear') {
  rmSync(digestFile, { force: true })
  console.log(`已删除 ${digestFile}`)
  console.log('现在谁都不能认主（宁拒）。要恢复：node set-passphrase.mjs')
  console.log('⚠️ 若你设了 YOUZI_PASSPHRASE 环境变量，它仍然生效，删文件没用')
  process.exit(0)
}

// 设置 / 轮换
let phrase
if (opts.mode === 'stdin') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  phrase = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
} else {
  phrase = await readHidden('新暗号（不回显）：')
  const again = await readHidden('再输一遍：')
  if (phrase !== again) { console.error('两次不一致，未做任何修改'); process.exit(3) }
}
const normalized = normalizeText(phrase)
if (!normalized) { console.error('暗号不能为空'); process.exit(3) }
if (normalized.length < 4) { console.error('暗号至少 4 个字符（太短容易被试出来）'); process.exit(3) }

writeDigest(digestOf(normalized))
console.log(`✔ 摘要已写入 ${digestFile}（磁盘上只有 sha256，没有明文）`)
console.log(`  归一化长度 = ${normalized.length}；注意：比对按 NFKC + 去首尾空格，半角/全角标点视为相同`)

if (process.env.YOUZI_PASSPHRASE?.trim()) {
  console.log('⚠️ 检测到环境变量 YOUZI_PASSPHRASE：它优先级最高，**会让刚写的摘要失效**。要改用新暗号请二选一：')
  console.log('   a) 把环境变量改成同一个新暗号（或删掉它）后重启 DSH')
  console.log('   b) 什么都不做 —— 生效的会是环境变量里的那个')
}
if (!opts.keepBindings) {
  const count = revokeBindings()
  if (count) console.log(`↺ 已撤销 ${count} 个已认证绑定（要保留请加 --keep-bindings）`)
}
console.log('生效条件：完全退出 DSH 桌面端（含托盘）再启动 —— 闸门是进程内加载的，热改不生效')
