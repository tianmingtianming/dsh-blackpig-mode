/**
 * section-mute — 用**空文本段**遮蔽同名的全局 prompt 段。
 *
 * 背景：`harness:source`（325 B）与 `app:web-surface`（1,006 B）是宿主注入的
 * 两段模型面文本，黑猪模式用不到。`systemPrompt.section()` 的层合并规则是
 * 「同层同名抛错、scoped 段遮蔽 global 段」，所以本模块在 preset scope 上注册
 * 两个**同名 + 空文本**的段：全局段被遮蔽，而 `renderPrompt()` 会丢弃
 * `text.length === 0` 的段（`dsh-system-prompt/lib/index.js:121`），因此它们
 * 既不进 prompt、也不需要改宿主。
 *
 * 失败取向：同名冲突 / 服务形状变化都可能让 `section()` 抛错。这里**只记日志、
 * 绝不向上抛** —— 遮蔽失效只是省不下 token，不能让整个 preset 挂载失败。
 *
 * order 的取法：先问 `systemPrompt.getSectionOrder(name)`；该表以
 * `HARNESS_SOURCE`/`WEB_SURFACE` 这类大写键索引，冒号名通常取不到，
 * 于是回落到已知值（10,000 / 10,100）。
 *
 * @module blackpig-model/section-mute
 */

/** Cordis 插件名。 */
export const name = 'blackpig-section-mute'

/** 需要 `systemPrompt` 服务；没有它就不能注册段。 */
export const inject = ['systemPrompt']

/** 目标段：`[段名, 已知 order 兜底]`。 */
const TARGETS = [
  ['harness:source', 10000],
  ['app:web-surface', 10100],
]

/**
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行的 `config`（只认 `{ enabled }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`blackpig-section-mute: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话语义。
    }
  }

  for (const [sectionName, fallbackOrder] of TARGETS) {
    try {
      ctx.effect(() => {
        let order = fallbackOrder
        try {
          const resolved = ctx.systemPrompt?.getSectionOrder?.(sectionName)
          if (typeof resolved === 'number' && Number.isFinite(resolved)) order = resolved
        } catch {
          // 取不到就用已知值。
        }
        return ctx.systemPrompt.section({ name: sectionName, order, text: '' })
      }, `section-mute:${sectionName}`)
    } catch (error) {
      // 同层同名 / 服务形状不符 → 降级为「遮蔽失效」，不影响启动。
      warn(`could not mute prompt section "${sectionName}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
