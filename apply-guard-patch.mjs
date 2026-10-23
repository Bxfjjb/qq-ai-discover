#!/usr/bin/env node
/**
 * apply-guard-patch.mjs — 给 @michengai/dsh-im-connect 的编译产物加一个 6 行入站闸门挂点
 * ============================================================================
 * 为什么必须打这个补丁：该插件（1.0.12）**没有**任何入站中间件 / 钩子
 * （已核：src 里 grep 不到 extensions / onInbound / onDecide / annihilate），
 * 而"发送者是谁"这个事实只存在于 `engine/gateway.js` 的 handleInbound 里。
 * 闸门逻辑本体不在这个补丁里 —— 它全部住在外部 guard.mjs，插件自更新也不会动它。
 *
 * 用法：
 *   node apply-guard-patch.mjs                # 打到默认路径（自动备份）
 *   node apply-guard-patch.mjs --check        # 只检查是否已打（幂等校验，退出码 0=已打）
 *   node apply-guard-patch.mjs --revert       # 用备份原样还原
 *   node apply-guard-patch.mjs --file <path>  # 打到指定文件（沙箱验证用）
 *
 * ⚠️ 插件自更新（@michengai/dsh-im-connect 有内置 updater）会覆盖 lib/，
 *    更新后重跑一次本脚本即可（--check 可挂在启动脚本里做守门）。
 * ============================================================================
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BEGIN = '// [youzi-guard:BEGIN]'
const END = '// [youzi-guard:END]'

const LOADER = [
  BEGIN + ' 身份闸门加载器（逻辑在外部 guard.mjs，插件更新不会覆盖它）',
  'let __youziGuardModule = null;',
  'let __youziGuardTried = false;',
  'async function __youziGuard() {',
  '    if (__youziGuardTried)',
  '        return __youziGuardModule;',
  '    __youziGuardTried = true;',
  '    try {',
  "        const path = await import('node:path');",
  "        const os = await import('node:os');",
  "        const { pathToFileURL } = await import('node:url');",
  "        const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');",
  "        const file = process.env.DSH_YOUZI_GUARD || path.join(root, 'youzi-guard', 'guard.mjs');",
  '        __youziGuardModule = await import(pathToFileURL(file).href);',
  '    }',
  '    catch (error) {',
  '        __youziGuardModule = null;',
  "        console.warn('[youzi-guard] 闸门模块未加载：', error?.message ?? error);",
  '    }',
  '    return __youziGuardModule;',
  '}',
  END,
]

const HOOK = [
  '            ' + BEGIN + ' 身份闸门：进入会话前由代码判定，模型无参与权',
  '            {',
  '                const guard = await __youziGuard();',
  '                if (guard?.intercept) {',
  '                    let verdict;',
  '                    try {',
  '                        verdict = await guard.intercept({',
  '                            channelId,',
  '                            chatId: msg.chatId,',
  "                            kind: msg.kind === 'group' ? 'group' : 'dm',",
  '                            userId: msg.userId,',
  '                            text: msg.text,',
  '                            send: (body) => this.deliver(channel, msg.chatId, body),',
  '                            sendTo: (chatId, body) => {',
  '                                const target = this.channels.get(channelId);',
  '                                return target ? target.send(chatId, body) : Promise.resolve();',
  '                            },',
  '                        });',
  '                    }',
  '                    catch (error) {',
  '                        // 宁可错拒、不可错认：闸门自身异常 => 丢弃本条，绝不把裸消息喂给模型',
  "                        this.log(`[youzi-guard] 闸门异常，按最保守策略丢弃本条: ${error instanceof Error ? error.message : String(error)}`);",
  '                        return;',
  '                    }',
  '                    if (verdict?.block) {',
  '                        if (verdict.text)',
  '                            await this.deliver(channel, msg.chatId, verdict.text);',
  '                        return;',
  '                    }',
  "                    if (typeof verdict?.text === 'string')",
  '                        msg = { ...msg, text: verdict.text };',
  '                }',
  '            }',
  '            ' + END,
]

const ANCHOR_LOADER = 'const SEND_RETRY_DELAYS_MS = [0, 1_000, 3_000, 8_000, 20_000];'
const ANCHOR_HOOK = '            if (!/^\\/delivery(?:\\s|$)/i.test(msg.text.trim()))'

function defaultTarget() {
  const root = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(root, 'profiles', 'desktop', 'node_modules', '@michengai', 'dsh-im-connect', 'lib', 'engine', 'gateway.js')
}

function parseArgv(argv) {
  const out = { mode: 'apply', file: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') out.mode = 'check'
    else if (arg === '--revert') out.mode = 'revert'
    else if (arg === '--apply') out.mode = 'apply'
    else if (arg === '--file') { out.file = String(argv[++i] ?? ''); }
    else if (arg.startsWith('--file=')) out.file = arg.slice('--file='.length)
    else if (arg === '--help' || arg === '-h') out.mode = 'help'
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

function assertAnchors(source) {
  if (!source.includes(ANCHOR_LOADER)) throw new Error('找不到挂点 A（SEND_RETRY_DELAYS_MS），插件版本可能变了')
  if (!source.includes(ANCHOR_HOOK)) throw new Error('找不到挂点 B（delivery 判定行），插件版本可能变了')
}

function stripBlocks(source) {
  const out = []
  let skipping = false
  for (const line of source.split('\n')) {
    if (line.includes(BEGIN)) { skipping = true; continue }
    if (line.includes(END)) { skipping = false; continue }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

function countMarker(source) {
  return source.split(BEGIN).length - 1
}

function applyPatch(file) {
  if (!existsSync(file)) throw new Error(`目标不存在：${file}`)
  const source = readFileSync(file, 'utf8')
  const markers = countMarker(source)
  if (markers > 0) return { changed: false, markers, message: `已打过补丁（${markers}/2 个标记），跳过` }
  assertAnchors(source)
  const backup = file + '.youzi-guard.bak'
  if (!existsSync(backup)) copyFileSync(file, backup)

  let next = source.replace(ANCHOR_LOADER, LOADER.join('\n') + '\n' + ANCHOR_LOADER)
  next = next.replace(ANCHOR_HOOK, HOOK.join('\n') + '\n' + ANCHOR_HOOK)
  if (countMarker(next) !== 2) throw new Error('补丁写入标记数量异常，已放弃写入')
  writeFileSync(file, next, 'utf8')
  return { changed: true, markers: 2, backup, message: '补丁已写入' }
}

function revertPatch(file) {
  const backup = file + '.youzi-guard.bak'
  if (!existsSync(backup)) throw new Error(`没有备份可还原：${backup}`)
  copyFileSync(backup, file)
  return { message: `已用备份还原：${backup}` }
}

const argv = parseArgv(process.argv.slice(2))
if (argv.mode === 'help') {
  console.log('用法：node apply-guard-patch.mjs [--check|--apply|--revert] [--file <gateway.js>]')
  process.exit(0)
}
const file = argv.file ? (isAbsolute(argv.file) ? argv.file : join(process.cwd(), argv.file)) : defaultTarget()
try {
  if (argv.mode === 'check') {
    const source = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const markers = countMarker(source)
    const ok = markers === 2
    console.log(`${ok ? 'PATCHED' : 'NOT-PATCHED'}  ${file}  markers=${markers}`)
    process.exit(ok ? 0 : 1)
  }
  if (argv.mode === 'revert') {
    console.log(revertPatch(file).message)
    process.exit(0)
  }
  console.log(applyPatch(file).message + ' → ' + file)
  process.exit(0)
} catch (error) {
  console.error('[youzi-guard] ' + (error?.message ?? error))
  process.exit(2)
}
