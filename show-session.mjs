#!/usr/bin/env node
/**
 * show-session.mjs — 把某条 IM 会话记录解出来看（只读，不改任何东西）
 * 用途：怀疑"是不是模型自己拒答"时，直接看模型到底收到了什么、回了什么。
 * 会话文件是多帧 zstd 追加写，Node 的 zstdDecompressSync 只解第一帧，所以这里逐帧解。
 *
 * 用法：
 *   node show-session.mjs                     # 自动挑最新的私聊会话
 *   node show-session.mjs dm|group            # 自动挑最新的一条
 *   node show-session.mjs <会话目录或 .zstd>   # 指定
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { normalizeText } from './guard.mjs'

const REFUSAL = '这个不能说喔'
const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

function frames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  const out = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try { out.push(zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8')) } catch { /* 跳坏帧 */ }
  }
  return out.join('')
}

function pick(kind) {
  const roots = join(dshHome, 'sessions')
  if (!existsSync(roots)) return ''
  const candidates = []
  for (const dir of readdirSync(roots)) {
    const full = join(roots, dir)
    try { if (!statSync(full).isDirectory()) continue } catch { continue }
    for (const sub of readdirSync(full)) {
      const inner = join(full, sub)
      try { if (!statSync(inner).isDirectory()) continue } catch { continue }
      const file = join(inner, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      if (kind === 'dm' && !sub.includes('~003Adm')) continue
      if (kind === 'group' && !sub.includes('~003Agroup')) continue
      candidates.push({ file, at: statSync(file).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]?.file ?? ''
}

const arg = process.argv[2] ?? 'dm'
let file = arg.endsWith('.zstd') ? arg : pick(arg === 'group' ? 'group' : 'dm')
if (file && !file.endsWith('.zstd') && existsSync(file)) {
  const guess = join(file, 'session.v4.jsonl.zstd')
  if (existsSync(guess)) file = guess
}
if (!file || !existsSync(file)) { console.error('找不到会话记录'); process.exit(2) }
console.log('会话文件 =', file, '\n')

const rows = frames(readFileSync(file)).split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const digestFile = join(dshHome, 'youzi-guard', 'passphrase.sha256')
const passDigest = existsSync(digestFile) ? readFileSync(digestFile, 'utf8').trim() : ''
const textOf = msg => (Array.isArray(msg?.content) ? msg.content : []).filter(p => p?.type === 'text').map(p => p.text).join('')
let n = 0
let hits = 0
for (const row of rows) {
  if (row.type !== 'user/message' && row.type !== 'assistant/message') continue
  n += 1
  const isUser = row.type === 'user/message'
  const msg = isUser ? row.data : row.data?.message
  const full = textOf(msg)
  const when = row.time ? new Date(Number(row.time)).toLocaleString('zh-CN') : '?'
  const hasInject = full.includes('身份闸门·宿主注入')
  const verdict = (full.match(/校验=([^｜】]+)/) ?? [])[1] ?? '无'
  const body = isUser ? (full.split('——以下为消息正文——').pop() ?? '') : full
  const isSecret = isUser && hasInject && passDigest
    && createHash('sha256').update(normalizeText(body), 'utf8').digest('hex') === passDigest
  const refusal = body.includes(REFUSAL)
  if (refusal) hits += 1
  console.log(`#${n} ${isUser ? '👤用户' : '🤖小柚'} ${when}`)
  console.log(`   注入：${hasInject ? '有，判定=' + verdict : '无'}${isSecret ? '  ⚠️ 正文就是暗号原文（进了模型）' : ''}${refusal ? '  ⚠️ 出现固定话术' : ''}`)
  console.log('   ' + (isSecret ? '«暗号原文（隐去）»' : body.slice(0, 260)).replace(/\n/g, ' ⏎ '))
}
console.log(`\n共 ${n} 条消息，出现固定话术 ${hits} 次`)
