/**
 * adapters/zaofan-qqbot-inbound.mjs — 给 @zaofan/dsh-qqbot 这类带入站钩子的插件用（不用打补丁）
 * ============================================================================
 * 背景：dsh-im-connect 没有入站钩子，所以那个方案要给 gateway.js 打 6 行挂点（见 apply-guard-patch.mjs）。
 *      而 @zaofan/dsh-qqbot 自带 `.qqbot-extensions/inbound/*.mjs` 契约（onInbound / onDecide），
 *      直接把本文件拷进 `{数据根}/.qqbot-extensions/inbound/` 就能接上同一套 guard.mjs，零侵入。
 *
 * 契约要点（来自该插件的 ext-inbound 文档）：
 *   · 早挂点：export async function onInbound(ctx, next) —— 能 rewrite / annihilate / forceWake
 *   · 晚挂点：export default async (ctx, next)       —— 能覆盖 @ 判定，不能 annihilate
 *   · 单个扩展抛错只告警并继续 next()，不会吞消息
 *
 * 本适配器做三件事：
 *   ① 调 guard.intercept()，拿到 block/text；
 *   ② block ⇒ ctx.annihilate({ ownerAck: true }) 并自己回一条（吞掉这条，模型看不到）；
 *   ③ 放行 ⇒ ctx.rewrite({ text }) 把注入行塞进正文（模型看到"校验=通过/未通过"）。
 * ============================================================================
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

export const name = 'youzi-guard-adapter'

let guard = null
let send = null

/** 在扩展加载时把 guard.mjs 接上；路径可用环境变量 DSH_YOUZI_GUARD 覆盖 */
async function loadGuard(ctx) {
  if (guard) return guard
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const file = process.env.DSH_YOUZI_GUARD || join(dshHome, 'youzi-guard', 'guard.mjs')
  guard = await import(pathToFileURL(file).href)
  return guard
}

export async function onInbound(ctx, next) {
  try {
    const g = await loadGuard(ctx)
    const msg = ctx?.message ?? {}
    const verdict = await g.intercept({
      channelId: String(ctx?.config?.settingsNs ?? ctx?.scope ?? 'unknown'),
      chatId: String(ctx?.chatId ?? ''),
      kind: msg.kind === 'group' ? 'group' : 'dm',
      userId: String(msg.userId ?? msg.author?.id ?? ''),
      text: String(ctx?.text ?? ''),
      // 该插件的入站钩子没有直接的"发消息"句柄，这里留空：配对码提示会由模型转述
      sendTo: async () => undefined,
    })
    if (verdict?.block) {
      // 吞掉这条：不进群历史、不进模型上下文
      const acked = ctx?.annihilate?.({ reason: 'youzi-guard 身份闸门拦截', ownerAck: true })
      if (acked && verdict.text) ctx?.reply?.(verdict.text)
      return acked ? undefined : next()
    }
    if (typeof verdict?.text === 'string' && verdict.text && typeof ctx?.rewrite === 'function') {
      ctx.rewrite({ text: verdict.text, reason: 'youzi-guard 注入身份状态' })
    }
  } catch { /* 兜底：本扩展出任何问题都绝不影响主链 */ }
  return next()
}
