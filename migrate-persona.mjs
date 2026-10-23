#!/usr/bin/env node
/**
 * migrate-persona.mjs — 小柚人格块：首次迁移（搬走暗号）/ 升级（换新版人格）
 * ============================================================================
 * 人格文本不再写死在脚本里，而是读同目录的 persona-block.txt（好改、好 review、不用改代码）。
 * persona-block.txt 第一行是标题，第二行是版本标记 <!-- youzi-guard:persona-vN -->。
 *
 * 模式：
 *   首次迁移：抽旧提示词里的暗号 → 写 sha256 → 删暗号 → 换成人格块
 *   --upgrade：已经迁移过，只把人格块换成模板里的新版（不动暗号摘要）
 *   --dry：只打印，不写文件
 * ============================================================================
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeText, matchPassphrase } from './guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, 'persona-block.txt')

function argvOf(argv) {
  const out = { dry: false, upgrade: false, file: '', digestOut: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry') out.dry = true
    else if (a === '--upgrade') out.upgrade = true
    else if (a === '--file') out.file = String(argv[++i] ?? '')
    else if (a === '--digest-out') out.digestOut = String(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const opts = argvOf(process.argv.slice(2))
if (opts.help) {
  console.log('用法：node migrate-persona.mjs [--dry] [--upgrade] [--file <cordis.patch.yml>] [--digest-out <passphrase.sha256>]')
  process.exit(0)
}

const template = readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '')
const VERSION_MARK = (/<!-- youzi-guard:persona-(v\d+) -->/.exec(template) ?? [])[0] ?? ''
const VERSION = (/persona-(v\d+)/.exec(VERSION_MARK) ?? [])[1] ?? 'unversioned'
if (!VERSION_MARK) { console.error('[youzi-guard] persona-block.txt 缺少版本标记'); process.exit(2) }
const IND = ' '.repeat(16)
const NEW_BLOCK = template.split('\n').map(l => (l === '' ? '' : IND + l))

const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const target = opts.file ? (isAbsolute(opts.file) ? opts.file : join(process.cwd(), opts.file)) : join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
const digestOut = opts.digestOut ? (isAbsolute(opts.digestOut) ? opts.digestOut : join(process.cwd(), opts.digestOut)) : join(dshHome, 'youzi-guard', 'passphrase.sha256')

if (!existsSync(target)) { console.error(`[youzi-guard] 目标不存在：${target}`); process.exit(2) }
const lines = readFileSync(target, 'utf8').split('\n')
const start = lines.findIndex(l => /^\s+# 人格设定｜小柚\s*$/.test(l))
if (start < 0) { console.error('[youzi-guard] 找不到小柚人格块（# 人格设定｜小柚）'); process.exit(2) }
let end = -1
for (let i = start + 1; i < lines.length; i += 1) if (/^\s+complete: true\s*$/.test(lines[i])) { end = i; break }
if (end < 0) { console.error('[youzi-guard] 找不到人格块结束行（complete: true）'); process.exit(2) }

const block = lines.slice(start, end).join('\n')
const migrated = block.includes('身份闸门') || block.includes('人格设定｜小柚') && block.includes('【主人模式')

if (block.includes(VERSION_MARK)) { console.log(`[youzi-guard] 已经是最新（${VERSION}），跳过`); process.exit(0) }
if (migrated && !opts.upgrade) {
  console.log(`[youzi-guard] 已有旧版人格块。要换成 ${VERSION} 请加 --upgrade`)
  process.exit(0)
}

let digest = ''
let passphrase = ''
if (!block.includes('身份闸门')) {
  const found = /识别主人的方法是对暗号[:：]([^。\n]+)。/.exec(block)
  if (!found) { console.error('[youzi-guard] 旧提示词里找不到暗号，拒绝迁移'); process.exit(2) }
  passphrase = found[1].trim()
  digest = createHash('sha256').update(normalizeText(passphrase), 'utf8').digest('hex')
  console.log(`[youzi-guard] 抽取到暗号（长度 ${passphrase.length}），摘要 = ${digest.slice(0, 12)}…`)
} else {
  console.log(`[youzi-guard] 升级模式：只换人格块（→ ${VERSION}），不动暗号摘要`)
}
console.log(`[youzi-guard] 目标：${target}`)
if (opts.dry) { console.log('[youzi-guard] --dry：未写入任何文件'); process.exit(0) }

if (digest) writeFileSync(digestOut, digest + '\n', 'utf8')
const backup = `${target}.bak-youzi-guard-${Date.now()}`
copyFileSync(target, backup)
writeFileSync(target, [...lines.slice(0, start), ...NEW_BLOCK, ...lines.slice(end)].join('\n'), 'utf8')

const after = readFileSync(target, 'utf8').split('\n').slice(start, start + NEW_BLOCK.length).join('\n')
if (passphrase && after.includes(passphrase)) { console.error('[youzi-guard] !! 迁移后仍残留暗号原文'); process.exit(3) }
console.log(`[youzi-guard] 已备份：${backup}`)
console.log(`[youzi-guard] 完成：${VERSION} 人格块已写入`)
if (digest) {
  const probe = { caseSensitive: true, passphrase: { env: '', file: digestOut, sha256: '' } }
  const exact = matchPassphrase(probe, passphrase)
  const nfkc = matchPassphrase(probe, '  ' + passphrase.replace('，', ',') + '  ')
  console.log(`[youzi-guard] 自检：认出真实暗号 = ${exact}；全半角/空格等价写法 = ${nfkc}`)
  if (!exact || !nfkc) { console.error('[youzi-guard] !! 摘要与归一化规则不一致'); process.exit(4) }
}
console.log('[youzi-guard] ⚠️ 备份里仍有明文暗号：轮换暗号后请删掉旧备份')
