/**
 * blackpig-subtalk — 让黑猪模式的大脑能跟**一次性代理**继续说话（包括中途纠错）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 本模块服务于 `subagent_preset` 派出的子代理；团队通道走 `send_message`。
 * （`subagent`/`subagent_fork` 仍声明在 YAML，但已被 extraDeny 从大脑面摘掉，
 *   不是保留给大脑的委派路径；`spawn_teammate` 属于团队通道。）
 *
 * 宿主的 `dsh-tool-subagent` 本身支持「对直系可续代理继续说话、甚至在它让出后唤醒」，
 * 协议就是 `ctx.subagents.sendMessage(sender, childId, content, { signal })`。
 * 但**脑子上拿不到那个工具**：
 *
 *   `dsh-tool-subagent-control` 把 `send_message` 注册在**全局层**（`ctx.tools.register`），
 *   而 `dsh-tool-agent-team` 把同名的 `send_message` 注册在每个 agent **自己的层**上
 *   （`scoped.tools.register`）。宿主 `view()` 的规则是先算继承层（受 restriction 过滤）、
 *   **再用本层无条件覆盖 `visible`** —— 于是团队版（参数 `target`）盖掉了代理版
 *   （参数 `agent_id`）。
 *
 * 实测（2026-10-30，运行时探针）：黑猪模式下大脑拿到的
 * `send_message` 参数是 `["target","message"]`，`interrupt_agent` 参数是 `["target"]`
 * —— 都是团队版，无法指定代理 id。
 *
 * 本模块注册一个**不同名字**的工具，直接调代理的 `sendMessage`，绕开撞名。
 * 它**不改变任何现有工具**，是纯增量。
 *
 * ── 为什么不给代理版 send_message 改个名再装 ────────────────────────────────
 *
 * `tool-subagent-control` 的 Config **没有** `toolName` 字段（`tool-subagent` 有，
 * 它没有）。所以无法通过配置把它注册成别的名字 —— 只能自己封一层。
 *
 * ── 设计 1：发送前先中断（interrupt-before-send）──────────────────────────────
 *
 * 宿主的投递语义是 `steer`（**最近的步骤边界**投递）。而「一步」可以是整个长工具调用
 * （跑一次构建、扫一棵目录树）。于是纯发送会出现这个失效：
 *
 *     代理正按错误要求往下做 → 脑子发纠错 → 纠错排在队里
 *     → 错误要求继续跑完 → 纠错才被读到 → 错误已经造成
 *
 * 纠错的价值全在**时效**。所以本模块在发送前先请求 `interrupt(目标, 凭据)`：
 *
 *   · 只停**当前轮次**，收件箱（`keepInbox`）与它派出的后代都不动；
 *   · 对**已结束 / 不存在**的目标是 Host 既定的**静默空操作**，不抛错、不改状态；
 *   · 已经 append 到会话日志的事实全部保留 —— 丢掉的只有「正在进行的那一个动作」。
 *
 * ⚠️ 但这只是**请求**，不是回执。宿主 `interrupt()` 返回 `void`，并且对非 resident
 * 目标直接 `return`；本模块因此**永不**输出「已中断 / 已停止」这种断言，只输出
 * `interruptRequested` + `interruptVerified: false`。把它当回执就是「假装成功」。
 *
 * ⚠️ 时序（宿主 `dsh-agent-loop` 的 `send()`）：`wakingAfterAbort = wakeup &&
 * phase.kind !== 'idle' && phase.abort.signal.aborted` 为真时，投递目标从
 * `next-step` 改道 `next-turn`。所以「刚被中断、紧接着的那条 steer」会落到**下一轮**，
 * 不是最近的步骤边界。竞态本身不丢消息（收件箱保住），不必消除，但**话必须说对**：
 * 工具描述与返回文案都写「这条会在它下一轮开始时处理」。
 *
 * ⚠️ 为什么是独立工具而不是「挂到 send_message 前面」：可靠性。
 * 模型在赶进度时不会去分辨「这次是追加还是纠错」，所以中断必须内建进工具本身，
 * 而不是靠调用方记得多传一个参数。措辞上也不承诺「立即生效」（见上文时序说明）。
 *
 * ── 借鉴 2：失败取向 ─────────────────────────────────────────────────────────
 *
 * 中断失败（服务缺失、目标不是自己的后代、id 读不出来）**绝不能**影响发送本身 ——
 * 那会把「纠错稍晚」变成「纠错根本没发出去」，方向正好反了。所以中断的任何失败都只
 * 记一条 info，然后照常发送。而**发送失败必须响亮**：把原因原样抛回去，让脑子能改派，
 * 而不是对着一个空 id 发呆。
 *
 * ── 适用范围：大脑 + 队友，只到「直接子代理」这一层 ───────────────────────────
 *
 * `send_to_subagent` 对**所有 agent** 可用（大脑、队友都能调）。底层
 * `ctx.subagents.sendMessage` 的授权是「直接父 ↔ 直接子」，越界抛
 * `belongs to another parent session` —— 所以这条通路天然有硬边界：
 * 只能给自己**直接派出**的代理发消息，发不到孙代理，也发不到别人派出的代理。
 *
 * `stop_subagent` 仍然只给大脑：它给子会话的新增能力只有「停自己的后代」，
 * 而协调者对这件事零可见性（宿主 `interrupt()` 返回 void，没有回执），
 * 所以不下放。子会话 scope 上它被 `restrict` 摘掉（B7）。
 *
 * 2026-11-06 实测纠正一条旧说法：这里原来写「worker 停掉的就是它自己的父会话，
 * 用户正在看的回答会被掐断」—— 那是**过度陈述**。宿主的 `interrupt()` 只作用于
 * `resident` 表（活跃子代理登记表），大脑是根会话、从不进表，直接静默 no-op；
 * 而停嵌套父代理会因 ancestry 判定抛 UNAUTHORIZED。真正该防的是「回执不可信」：
 * 对停不掉的目标服务层不报错，我们只能回 `request-sent-unverified`，
 * 看着像成功、其实什么都没发生。
 *
 * @module blackpig-subtalk
 */

import {
  applyToTools,
  callSendMessage,
  detectControlApi,
  resolveTargetId,
  targetOf,
} from './compat.mjs'

export const name = 'blackpig-subtalk'

/**
 * 要注册工具，也要在调用那一刻能取到 `subagents` / `agents`。
 *
 * 只 inject `tools`：`subagents` 若在 apply 时就要求就绪，会把本行绑死在宿主服务的
 * 就绪时机上；而本模块的取向是「取不到就安静退场、下次再试」。工具在、服务缺时
 * 一次调用失败并报清楚原因，比整行显示 waiting 更有诊断价值。
 */
export const inject = ['tools']

/** 工具名。必须与 guard 的保留集逐字一致（否则会被 guard 自己拦掉）。 */
export const TOOL_NAME = 'send_to_subagent'

/** 另一个工具名：只中断、不发送。 */
export const INTERRUPT_TOOL_NAME = 'stop_subagent'

/**
 * Logger sinks are untrusted too: ctx.logger?.error?.() may throw (throwing
 * getter or broken sink). A log call must never change a business result or
 * abort a restrict() submission. These local helpers swallow their own
 * failures; message text and call sites stay exactly as before.
 */
function logError(ctx, message) {
  try {
    ctx.logger?.error?.(message)
  } catch {
    // A broken log sink must not take the session down with it.
  }
}

function logInfo(ctx, message) {
  try {
    ctx.logger?.info?.(message)
  } catch {
    // Same: logging is best-effort only.
  }
}

function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // Same: logging is best-effort only.
  }
}

/**
 * 安全读 `ctx.logger`，并给出**传给 compat 的 ctx**。
 *
 * 为什么不是直接写 `logger: ctx.logger`、也不是只写 `logger: loggerOf(ctx)`：
 * compat 每个入口内部都是 `opts.logger ?? ctx?.logger` —— 把读出来的 undefined 传进去，
 * 它还会**再读一次**同一处 getter，throwing getter 照样把整条调用炸掉（实测见 R11 验证）。
 * 所以读失败时额外给一个只在自己身上覆写 `logger` 的视图：其余属性经原型照旧读到，
 * compat 的 `ctx?.logger` 回退读到的是 undefined，而不是抛出。
 * 正常 logger 或没有 logger 时返回的 ctx 与入参**同一个对象**，行为逐字节不变。
 */
function compatViewOf(c) {
  try {
    return { ctx: c, logger: c?.logger }
  } catch {
    const view = Object.create(c ?? null)
    Object.defineProperty(view, 'logger', {
      value: undefined,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    return { ctx: view, logger: undefined }
  }
}

/**
 * 一个「按作用域」只警告一次的记录器（自身已兜住 logger 抛错）。
 *
 * ⚠️ 2026-11-07 修（R15，BUG-3）：去重键原来只有**整条消息串**，没有 agent 作用域。
 * 两个不同队友同因失败时，消息文本一样 → 只留 1 条日志，读不出受害面。
 * 现在去重键 = `scopeKey + "\u0000" + message`：
 *   · `scopeKey` 给定时（agent 相关告警传 agent 标识），不同 agent 各自一条；
 *   · `scopeKey` 缺省时（注册 / 整体回填等全局告警），行为与改前逐字节一致。
 * 同一个 agent 的重复故障仍只记一次，不会刷屏。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message, scopeKey) => {
    const key =
      scopeKey === undefined || scopeKey === null || scopeKey === ''
        ? message
        : `${scopeKey}\u0000${message}`
    if (seen.has(key)) return
    seen.add(key)
    try {
      logWarn(ctx, `blackpig-subtalk: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子会话。
 *
 * 与 guard 里的同名函数保持同一判据（四信号：origin / delegationDepth / isSeeded 取反排除 /
 * parentSession 兜底）；fork 会话（种子会话）的 parentSession 只是历史来源，不算子会话。
 * 本模块在 preset 层注册两个工具（一次）。`stop_subagent` 在**子会话 scope 上
 * 被隐藏**（B7）；`send_to_subagent` 对子会话**开放** —— 队友需要它才能给
 * 自己派出的直接子代理追加指令。服务层 `sendMessage` 的授权是「直接父 ↔ 直接子」，
 * 越界必抛 UNAUTHORIZED，所以这条通路天然只到一层。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  // GUI fork / 种子会话：parentSession 只是历史来源，它是新的一条根，不是被委派的工具面。
  if (header.isSeeded === true) return false
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  return false
}

/**
 * agent 相关告警的作用域键：优先 `agent.session.id`，退回 `agent.id`。
 * 读不出来时用 `'<unknown>'`（仍可去重，只是不同未知 agent 会合并 —— 没有可用标识）。
 */
function agentScopeKeyOf(agent) {
  // 两次读取各自兜错：session 是 throwing getter 时仍要退回 agent.id，
  // 否则不同 agent 会全部塌成同一个 <unknown>，又回到没有作用域的老问题。
  try {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  } catch {
    // 读 session.id 抛错，继续试 agent.id。
  }
  try {
    const agentId = agent?.id
    if (typeof agentId === 'string' && agentId !== '') return agentId
  } catch {
    // 连 agent.id 都读不出：只能退到 <unknown>。
  }
  return '<unknown>'
}

/**
 * 取 `subagents` 服务（调用那一刻才取）。
 * @returns 服务或 undefined。
 */
function subagentsOf(ctx) {
  try {
    return ctx.get('subagents')
  } catch {
    return undefined
  }
}

/**
 * 目标代理此刻的可核对状态。
 *
 * `running` / `idle` 来自**活 agent 注册表**（`ctx.agents.get(id)`，宿主
 * `dsh-agent` 的公开读方法）；`finished` 来自**已落盘的子会话目录**
 * （`subagents.listChildren(parent)`，宿主 `dsh-subagent` 的公开读方法）；
 * `unknown` 表示两处都查不到 —— 可能是 id 写错，也可能会话已被清理。
 *
 * @typedef {'running' | 'idle' | 'finished' | 'unknown'} TargetState
 */

/** 一个目标的探查结果。`looked === false` 表示**两个来源都不可用**，即「没查成」。 */
function targetRow(state, source, looked, extra) {
  return { state, source, looked, ...(extra ?? {}) }
}

/**
 * 读活 agent 注册表。
 *
 * 宿主 API 是 `agents.get(id)`（`dsh-agent` 的 `agents` service），**没有**
 * `subagents.get(id)`、也没有 `.stop()` —— 所以「目标在不在」只能从这两条公开
 * 读路径判定，本模块不去猜内部字段（`resident` 是管理器私有 Map）。
 *
 * @param ctx - 插件上下文。
 * @param id - 会话 id。
 * @returns `{ kind: 'live' | 'absent' | 'unavailable', agent? }`。
 */
function liveAgentOf(ctx, id) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    agents = undefined
  }
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    return { kind: 'unavailable' }
  }
  try {
    const agent = agents.get(id)
    if (agent === undefined || agent === null) return { kind: 'absent' }
    return { kind: 'live', agent }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * 调用方（父）自己的会话 id 候选。
 *
 * 宿主的 agent id 与会话 id 一般同名，但根会话在目录里出现过 `session-<uuid>`
 * 的形式，所以**两种写法都试**，不假定只有一种。去重后按顺序返回。
 *
 * @param sender - 调用方 agent。
 * @returns 非空字符串 id 的数组（可能为空）。
 */
function parentSessionIdsOf(sender) {
  const candidates = new Set()
  for (const candidate of [sender?.session?.id, sender?.session?.header?.id, sender?.id]) {
    if (typeof candidate === 'string' && candidate !== '') candidates.add(candidate)
  }
  return [...candidates]
}

/**
 * 问「这个 id 是不是我派出过的子会话」——查已落盘的子会话目录。
 *
 * 只用来区分「已结束 / 早先派过」（目录里有）与「根本不是我的子会话」（两边都没有）。
 * 服务不在、或该 composition 没装 `sessionQuery` 投影时返回 `'unavailable'`，
 * **绝不当成「存在」**。
 *
 * @param sub - subagents 服务。
 * @param parentSessionIds - 调用方（父）会话 id 候选。
 * @param targetId - 被查的 id。
 * @param signal - 调用方取消信号。
 * @returns `'present' | 'absent' | 'unavailable'`。
 */
async function catalogHas(sub, parentSessionIds, targetId, signal) {
  if (sub === undefined || sub === null || typeof sub.listChildren !== 'function') return 'unavailable'
  if (!Array.isArray(parentSessionIds) || parentSessionIds.length === 0) return 'unavailable'
  let answered = false
  for (const parentSessionId of parentSessionIds) {
    try {
      const rows = await sub.listChildren(parentSessionId, signal)
      if (!Array.isArray(rows)) continue
      answered = true
      if (rows.some((row) => row?.id === targetId)) return 'present'
    } catch {
      // 换个候选 id 再试；全都不行才算 unavailable。
    }
  }
  return answered ? 'absent' : 'unavailable'
}

/**
 * 判定目标此刻的状态，并说明**凭据是什么、什么没查到**。
 *
 * @param ctx - 插件上下文。
 * @param sub - subagents 服务。
 * @param sender - 调用方 agent。
 * @param targetId - 目标 id。
 * @param signal - 调用方取消信号。
 * @returns `{ state, source, looked }`。
 */
async function describeTarget(ctx, sub, sender, targetId, signal) {
  const live = liveAgentOf(ctx, targetId)

  if (live.kind === 'live') {
    let status
    try {
      status = live.agent?.status
    } catch {
      status = undefined
    }
    return targetRow(status === 'running' ? 'running' : 'idle', 'agents.get()', true)
  }

  const catalog = await catalogHas(sub, parentSessionIdsOf(sender), targetId, signal)
  if (live.kind === 'absent' && catalog === 'present') {
    // 活注册表查成了、明确说「没有」，而目录里有 → 这个子会话确实派出去过，但此刻不再活着。
    return targetRow('finished', 'subagents.listChildren()', true)
  }
  if (live.kind === 'unavailable') {
    // ⚠️ 2026-11-07 修（R13）：活注册表**没查成**（`agents` 服务取不到 / 抛错）时，
    // 目录只证明「派出去过、目录里有」，**不证明「已结束」**。旧实现把这一支无条件并入
    // `finished`，于是调用方以为「目标已死无需打断」，而它可能正在运行且从未收到取消请求
    // —— 假成功。这里如实说没查成（looked:false = 没查成），绝不并入 finished。
    return targetRow('unknown', 'subagents.listChildren()', false, {
      catalogUnavailable: catalog === 'unavailable',
    })
  }
  // 活注册表可用且明确说「没有」：活着的代理不可能缺席于注册表。
  return targetRow('unknown', catalog === 'absent' ? 'agents.get()+listChildren()' : 'agents.get()', true, {
    catalogUnavailable: catalog === 'unavailable',
  })
}

/**
 * 「这个 id 是不是我派出过的」判据 —— `send_to_subagent` 与 `stop_subagent` 共用的**唯一**一份。
 *
 * 参数按调用点原样传入：`exec` 整个传进来，`exec?.signal` 仍在闭包体内按**调用时刻**读，
 * 与原闭包捕获自由变量的求值时机一致（提前读会改变 throwing getter 的抛点）。
 *
 * @param ctx - 插件上下文。
 * @param sub - subagents 服务。
 * @param sender - 调用方 agent。
 * @param exec - 执行上下文（惰性取 `exec?.signal`）。
 * @returns `async (candidate) => boolean`。
 */
function isKnownIdProbe(ctx, sub, sender, exec) {
  return async (candidate) => {
    const probed = await describeTarget(ctx, sub, sender, candidate, exec?.signal)
    // ⚠️ 2026-11-07 修（R15，BUG-2）：`looked === false` 表示**两个来源都没查成**，
    // 不是「目标不存在」，更不是「这是一个已知 id」。旧实现把「没查成」判成 known-id，
    // resolveTargetId 于是整段跳过 resolveName()，把名字原样交给服务层 —— 新契约宿主上
    // 回执 ok:true 而实际收到的是名字，是假成功。
    // 只有**确实查成且命中**（looked === true 且状态非 unknown）才算 known-id 直通；
    // 其余一律让 resolveName() 有机会解析，解析不出来就由 resolveTargetId 抛
    // UNRESOLVED_TARGET —— 绝不把名字当 id 发出去。
    return probed.state !== 'unknown' && probed.looked === true
  }
}

/**
 * 发出一次中断请求。
 *
 * ⚠️ 宿主的 `interrupt(targetSessionId, authority)` **没有返回值**，文档原话是
 * `Fire-and-return: the cancel signal is issued before this returns, but the target
 * may keep running until it observes the signal`。所以这里只能如实回答
 * **「请求已发出」**，不能回答「已停止」—— 本函数因此返回 `{ requested, reason }`，
 * 并且调用方必须以 `verified: false` 对外呈现。
 *
 * 另外：宿主对**不存在 / 非 resident 的目标是静默 no-op**
 * （`const activation = this.resident.get(targetSessionId); if (activation === void 0) return;`），
 * 所以「没抛异常」不足以证明任何事 —— 这正是本模块不再输出 `interrupted=true` 的原因。
 *
 * **静默降级**：中断失败不影响发送（那会把「纠错稍晚」变成「纠错没发出去」）。
 *
 * @param sub - subagents 服务（已确认有 interrupt）。
 * @param ctx - 插件上下文（日志用）。
 * @param sender - 调用方 agent（必须是目标的精确活祖先）。
 * @param childId - 目标代理 id。
 * @returns `{ requested: boolean, reason?: string }`。
 */
function requestInterrupt(sub, ctx, sender, childId) {
  try {
    // 宿主签名只有两个参数：interrupt(targetSessionId, authority)。
    sub.interrupt(childId, { kind: 'ancestor', agent: sender })
    return { requested: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      logInfo(ctx, `blackpig-subtalk: the interrupt request was rejected (${detail}); the message is still delivered`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
    return { requested: false, reason: `the host rejected the interrupt request: ${detail}` }
  }
}

/**
 * 注册两个工具。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, interruptBeforeSend }`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const interruptBeforeSend = config?.interruptBeforeSend !== false
  const warn = warnOnceFactory(ctx)

  /**
   * 子会话 scope 上 `stop_subagent` 的隐藏 disposer。
   *
   * B7：`subagent_fork` 没配 `agentPreset`，子会话走 `composeFrom` 继承黑猪 preset，
   * 于是子会话的工具表里也出现 `stop_subagent`，一调用就撞 coordinator-only 闸门 —— 白烧一步。
   * 最干净的做法是**不要把 `stop_subagent` 给队友**（`send_to_subagent` 则保留：
   * 队友要靠它给自己派出的直接子代理追加指令）。注册发生在 preset 层（一次），而隐藏是
   * **按 agent scope** 做的（`agent.ctx.tools.restrict({ deny })`），这正是 guard
   * 自己用的同一机制：restriction 过滤的是「继承来的」工具面，preset 层在子会话的祖先
   * 链上，所以只有该队友看不见，协调者不受影响。
   *
   * 失败取向：restrict 不可用 / 名字不可收紧时**只记一条 info**，回落到底下的
   * 结构化拒绝 —— 队友误调 `stop_subagent` 时「看得见但调不动、且有可读原因」，
   * 好过静默地什么都不做。
   */
  // ⚠️ 2026-11-02 改（简化审计发现 17）：原来是 `WeakMap<agent, disposer>`，
  // 注释说「保留 disposer 以防重装」。但实测量：`.get` 读取 **0 次** ——
  // 没有任何路径调用那个 disposer。而 WeakMap 的 key 是 agent，agent 释放时
  // 条目自动消失 → 那个 disposer **永远不会被调用**。所谓「保留」是不可达承诺。
  //
  // 实际行为本来就是这样：restrict 的 disposer 由 `agent.ctx` 的 effect 生命周期管理
  // （被委派 agent 释放时自动卸），不需要我们持有。所以改成 WeakSet —— 只记
  // 「这个 agent 处理过」，语义与 `.has` 完全等价，但不再存死引用。
  const memberHides = new WeakSet()

  /**
   * 记「这个 agent 的隐藏已经处理过」——成功、失败、或该 scope 根本没有 restrict。
   *
   * ⚠️ 失败也必须记账，否则每次 `agent/created` 都会重试并重复报警；而失败路径
   * 本来就有 execute 里的结构化拒绝兜底，不会漏。
   */
  const hideFromMember = (agent) => {
    if (memberHides.has(agent)) return
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      // 这个 scope 没有 restrict —— 只记一次 info，不报警（不是错误，是 composition 差异）。
      memberHides.add(agent)
      try {
        logInfo(
          ctx,
          `blackpig-subtalk: a delegated child scope exposes no tools.restrict(); ${INTERRUPT_TOOL_NAME} stays visible there and refuses with a reason when called`,
        )
      } catch {
        // 日志通道不可用不能反过来炸掉会话。
      }
      return
    }
    // ⚠️ 2026-11-06 通用化（与 guard-v10.mjs 的 restrict() 保护同一取向）：
    // `tools.restrict()` 对**当时还没注册**的工具名会直接抛错（宿主
    // dsh-tools/lib/index.js 的 restrict() 拿 restrictableNames 校验每个名字）。
    // 这里虽然已经包了 try/catch，但旧写法是「先抛再吞」：抛错本身在宿主那里
    // 可能带着副作用，而且日志只有 warn 级、不带被拒的名字列表。
    // 现在改成「先与 restrictableNames 求交，再提交」：
    //   · 求交后为空 → 不调用，记 error（不假装隐藏成功）；
    //   · 有未知名 → 记 error 列全名，只提交已知的那部分；
    //   · restrict() 本体仍包 try/catch，错误原文带 scope 与名单。
    // 无论成败都记账（memberHides.add），否则同一 agent 会反复重试、反复报警；
    // 失败时 execute 里的结构化拒绝仍然兜底，不会放行。
    const requestedDeny = [INTERRUPT_TOOL_NAME]
    // ⚠️ 2026-11-07 修（R18a2，BUG-2）：这里原来裸读 `agent.session.id`，没有兜错。
    // 它是 throwing getter 时，这一行在 tools.restrict() **之前**就抛：隐藏根本没提交
    //（只能靠 execute 里的结构化拒绝兜底），外层 catch 还会把一次「隐藏失败」报成
    // 含 scope=kid-... 的普通 warn，读起来像别的问题。改用本文件已有的
    // agentScopeKeyOf()：两次读取各自兜错，session 抛错时退回 agent.id，
    // 保证抛错也拿得到可用 scope、restrict() 仍被提交。正常路径取值不变。
    const memberScope = agentScopeKeyOf(agent)
    let restrictable
    try {
      const view = typeof tools.view === 'function' ? tools.view(agent) : undefined
      const names = view?.restrictableNames
      if (names !== undefined && names !== null && typeof names[Symbol.iterator] === 'function') {
        restrictable = new Set()
        for (const name of names) if (typeof name === 'string' && name !== '') restrictable.add(name)
      }
    } catch (error) {
      logError(
        ctx,
        `blackpig-subtalk: reading restrictableNames threw for member scope=${memberScope} ` +
          `(${error instanceof Error ? (error.stack ?? error.message) : String(error)}); ` +
          `falling back to the unvalidated path for ${INTERRUPT_TOOL_NAME}`,
      )
    }
    try {
      if (restrictable === undefined) {
        // 降级：当前版本没有 restrictableNames。照旧提交（旧宿主的行为），
        // 但把「这是未校验提交」说清楚，别让日志读起来像一次正常成功。
        logWarn(
          ctx,
          `blackpig-subtalk: restrictableNames is unavailable on this host; submitting the deny list for ` +
            `${INTERRUPT_TOOL_NAME} unvalidated (scope=${memberScope}). ` +
            'If the host rejects it, the catch below records the error and the structured refusal still applies.',
        )
        tools.restrict({ deny: requestedDeny })
      } else {
        const unknown = requestedDeny.filter((name) => !restrictable.has(name))
        const known = requestedDeny.filter((name) => restrictable.has(name))
        if (unknown.length > 0) {
          logError(
            ctx,
            `blackpig-subtalk: ${unknown.length} name(s) are not restrictable in member scope=${memberScope} ` +
              `and were dropped before restrict(): [${unknown.join(', ')}]; submitting [${known.join(', ') || '(none)'}]. ` +
              'That tool stays visible to the delegated child and will refuse with a reason when called.',
          )
        }
        if (known.length > 0) tools.restrict({ deny: known })
      }
      // disposer 由 agent.ctx 的 effect 生命周期管理（agent 释放时自动卸），
      // 本模块不需要持有它 —— 见上面 memberHides 的注释。
      memberHides.add(agent)
    } catch (error) {
      // 记账（见上），否则同一 agent 会反复重试、反复报警。
      memberHides.add(agent)
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      logError(
        ctx,
        `blackpig-subtalk: hiding ${INTERRUPT_TOOL_NAME} from a delegated child failed — ` +
          `scope=${memberScope}; deny=[${requestedDeny.join(', ')}]; raw error: ${detail}. ` +
          'That member still sees it, but the execute() path refuses with a structured reason.',
      )
    }
  }

  // 工具 1：send_to_subagent
  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Send a follow-up message to a worker you delegated in this mode with `subagent_preset`. ' +
        'Use the `childSessionId` that delegation returned as `agent_id`. ' +
        'Available to the coordinator and to any delegating agent: you can message a worker you delegated yourself (its `childSessionId` is its id). You cannot reach workers delegated by someone else, nor grandchildren — the host authorizes only direct parent-to-child. ' +
        'WHAT THE RETURN VALUE PROVES: `messageId` is the host\'s admission receipt — the message is in the ' +
        'child\'s inbox. Nothing here proves the child has STOPPED or READ it. ' +
        'With `interrupt=true` a cancel request is also handed to the host; the host exposes no receipt for that, ' +
        'so the result says `interruptRequested=true` and `interruptVerified=false`. Treat it as a request, not as ' +
        'confirmation the child stopped. ' +
        'TIMING: if the child is running when it is interrupted, the host delivers this message at the child\'s ' +
        'NEXT TURN, not at the nearest step boundary — so the action already in flight may still complete before ' +
        'your correction is read. Never assume the correction landed ahead of that action. ' +
        'Team members are NOT addressed here; use `send_message` for those.',
      // ⚠️ 2026-11-06 通用化：目标参数改成「两种名字都收」。
      //   · 旧宿主（rc.1 及以前）只有 agent_id（会话 id）；
      //   · 新宿主（master，预计 rc.2）改叫 agent 且语义变成**名字**。
      // 这个变换由 compat.mjs 的 applyToTools() 统一算，不在这里手写 required ——
      // 否则下一个工具还得再抄一遍，抄漏一次就是「参数校验先于解析失败」的静默错。
      parameters: applyToTools({
        type: 'object',
        additionalProperties: false,
        properties: {
          agent_id: {
            type: 'string',
            description: 'The `childSessionId` returned by `subagent_preset` when you delegated this worker.',
          },
          message: {
            type: 'string',
            description: 'The follow-up instruction or correction to deliver.',
          },
          interrupt: {
            type: 'boolean',
            description:
              'Default true. When true a cancel request is sent to the child before the message, so a CORRECTION ' +
              'is not stuck behind the long tool call it is currently running. The host gives no receipt: the child ' +
              'stops at its next observation of the signal, and a message sent while it is being interrupted is ' +
              'processed when its NEXT TURN starts. Pass false to ADD information while its current direction is ' +
              'still correct — then nothing is cancelled and the message is read at the next step boundary.',
          },
        },
        required: ['agent_id', 'message'],
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            messageId: { type: 'string' },
            refused: { type: 'boolean' },
            reason: { type: 'string' },
            interruptRequested: { type: 'boolean' },
            interruptVerified: { type: 'boolean' },
            targetState: { type: 'string', enum: ['running', 'idle', 'finished', 'unknown'] },
          },
          required: ['ok', 'refused', 'reason', 'interruptRequested', 'interruptVerified', 'targetState'],
        },
        // ⚠️ 字段必须**显式摊平进文本**。模型只看得见 render 的输出，读不到裸字段
        // （2026-10-30 端到端验收里模型明确报告「interrupted 字段不存在」）。
        // 同理，这里**不能**出现 `interruptVerified=true` 的字样 —— 宿主不给回执，
        // 那个值永远是 false，文案必须与它一致，否则又是一个「假装成功」。
        render: (args, value) => {
          // ⚠️⚠️ 2026-11-06（P1-2）：**不许裸调 `targetOf(args)`**。
          // `targetOf` 在两个参数都给了且值不一致、或一个都没给时**会抛错** ——
          // 而 `execute` 已经为同一份 args 抛过那条明确错误了。render 再抛一次，
          // 宿主会把「明确错误」显示成「渲染失败」，模型拿不到可改派的原因。
          // 这里兜住：拿不到就退化成一个可读的占位符，绝不二次抛错。
          const label = (() => {
            try {
              return targetOf(args)
            } catch {
              return args?.agent_id ?? args?.agent ?? '<unknown>'
            }
          })()
          return [
            {
              type: 'text',
              // ⚠️ 用 label（targetOf 的兜底包装）而不是 args.agent_id：新宿主传的是 args.agent，
              // 直接读 agent_id 会渲染成 "undefined" —— 一个看起来像成功的假回执。
              text: value?.refused === true
                ? `send_to_subagent did NOT deliver anything to ${label} | refused=true | reason=${value?.reason ?? '?'}`
                : `message accepted into the inbox of subagent ${label}` +
                  ` | messageId=${String((value && value.messageId) ?? '?')}` +
                  ` | targetState=${value?.targetState ?? 'unknown'}` +
                  ` | interruptRequested=${value?.interruptRequested === true ? 'true' : 'false'}` +
                  ` | interruptVerified=false (the host issues no interrupt receipt)` +
                  (value?.interruptRequested === true && value?.targetState === 'running'
                    ? ' | NOTE: because the child was running, this message is processed when its NEXT TURN starts — the action in flight may still finish first'
                    : '') +
                  (typeof value?.reason === 'string' && value.reason !== '' ? ` | note=${value.reason}` : ''),
            },
          ]
        },
      },
      async execute(args, exec) {
        const sender = exec?.agent
        if (sender === undefined || sender === null) {
          throw new Error('send_to_subagent requires a calling agent (exec.agent was undefined)')
        }
        const sub = subagentsOf(ctx)

        if (sub === undefined || typeof sub.sendMessage !== 'function') {
          throw new Error('send_to_subagent requires the subagents service, which is not available in this composition')
        }

        // 逐次可覆盖默认取向：
        //   · 默认（或显式 true）：**先请求中断再发送**。用于**纠错** —— 代理正按错误
        //     要求跑一个长工具调用，不打断它就会先跑完错的再读你的话。
        //   · 显式 false：**只投递、不打断**。用于**追加信息**（补一条路径、加一个约束）
        //     而当前工作方向是对的 —— 这时打断只会白丢一个正在进行的动作。
        const shouldInterrupt = args.interrupt === undefined
          ? interruptBeforeSend
          : args.interrupt === true

        // ⚠️ 2026-11-06 通用化：目标可以是 id，也可以是名字（新宿主）。
        // 解析**只做一次**，拿到 id 之后探查、中断、发送全部用同一个 id ——
        // 否则名字→id 的解析会做两遍，中间目标改名/消失就会让「中断的是 A、
        // 发送到的是 B」。
        const requestedTarget = targetOf(args)
        // ⚠️ 2026-11-07 修（R11）：`ctx.logger` 可能是 throwing getter（见文件头 :114 的威胁模型）。
        // 这里安全读一次，compat 内部还会 `opts.logger ?? ctx?.logger` 二次读 —— 见 compatViewOf()。
        const compatView = compatViewOf(ctx)
        const logger = compatView.logger
        const api = detectControlApi(compatView.ctx, { logger }).api
        const isKnownId = isKnownIdProbe(ctx, sub, sender, exec)
        const resolved = await resolveTargetId(compatView.ctx, requestedTarget, {
          sub,
          sender,
          signal: exec?.signal,
          isKnownId,
          api,
          logger,
        })
        const targetId = resolved.id

        // 先看清目标此刻是什么状态 —— 这既决定「要不要发中断」，也是返回值里唯一
        // 能被称为「观察」的东西（中断本身没有回执）。
        const target = await describeTarget(ctx, sub, sender, targetId, exec?.signal)

        // ⚠️ 2026-11-07 修（R11 / BUG-3）：**先校验入参，再发中断**。
        // compat.callSendMessage 对空串 / 纯空白 message 是**抛错**（compat.mjs:504-516），
        // 旧顺序却在它之前就发了 interrupt：一次注定失败的调用，代价是掐掉子代理正在跑的
        // 动作，而且什么都没送达。判据与 callSendMessage 同口径（只校验，不改要投递的正文）：
        // 不合法就直接返回拒绝，一个中断都不发。
        if (typeof args?.message !== 'string' || args.message.trim() === '') {
          return {
            ok: false,
            refused: true,
            reason:
              typeof args?.message !== 'string'
                ? 'the "message" must be a string; nothing was sent and no interrupt was issued'
                : 'callSendMessage rejected an empty or whitespace-only "message": it would put an empty ' +
                  'message in the inbox while the receipt claimed success; nothing was sent and no ' +
                  'interrupt was issued. Send non-blank text instead.',
            interruptRequested: false,
            interruptVerified: false,
            targetState: target.state,
          }
        }
        let interruptRequested = false
        let interruptReason = ''
        if (shouldInterrupt) {
          if (target.state === 'unknown' && target.looked) {
            // 宿主对不存在的目标是静默 no-op；再发一次中断只会制造「我打断了」的错觉。
            interruptReason = 'the target was not found, so no interrupt was attempted'
          } else if (target.state === 'unknown') {
            interruptReason = 'the target could not be checked, so no interrupt was attempted'
          } else if (target.state === 'finished') {
            // 已结束的目标不在 resident 表里，宿主的 interrupt 对它**保证**是空操作。
            // 发了也白发，而且会让调用方以为「打断过」—— 干脆不发，把话说清。
            interruptReason =
              'the target has already ended (absent from the live registry), so no interrupt was attempted; ' +
              'the host would treat one as a no-op. The message itself may still cold-resume it.'
          } else {
            const outcome = requestInterrupt(sub, ctx, sender, targetId)
            interruptRequested = outcome.requested
            if (!outcome.requested) interruptReason = outcome.reason ?? 'the host rejected the interrupt request'
          }
        }

        // 发送失败必须响亮：让调用方拿到原因，能改派。
        // 走 compat.callSendMessage：它是**唯一**的发送入口；这里已经有解析好的 id，
        // 用 resolvedId 交过去，避免二次解析（也避免新宿主下名字被当 id 直接发出去）。
        const sent = await callSendMessage(compatView.ctx, {
          target: requestedTarget,
          resolvedId: targetId,
          message: args.message,
          sender,
          signal: exec.signal,
          sub,
          isKnownId,
          logger,
        })
        const messageId = sent?.messageId
        if (sent?.ok === false || typeof messageId !== 'string' || messageId === '') {
          // compat.callSendMessage already validated the host receipt; respect that verdict
          // here instead of turning String(undefined) into an ok:true admission receipt.
          return {
            ok: false,
            refused: true,
            reason: typeof sent?.reason === 'string' && sent.reason !== '' ? sent.reason : 'message-id-missing',
            interruptRequested,
            interruptVerified: false,
            targetState: target.state,
          }
        }
        return {
          ok: true,
          messageId: String(messageId),
          refused: false,
          reason: interruptReason,
          interruptRequested,
          // 宿主 `interrupt()` 没有返回值、对不存在目标是静默 no-op —— 永远无法验证。
          interruptVerified: false,
          targetState: target.state,
        }
      },
    })
  } catch (error) {
    warn(
      `registering ${TOOL_NAME} failed: ${error instanceof Error ? error.message : String(error)} — the coordinator will not be able to follow up a one-shot child`,
    )
  }

  // 工具 2：stop_subagent（只停，不问）
  try {
    ctx.tools.register({
      name: INTERRUPT_TOOL_NAME,
      description:
        'Stop the current turn of a worker you delegated in this mode with `subagent_preset`, keeping its ' +
        'inbox and any descendants intact. COORDINATOR-ONLY: a delegated child cannot use this. ' +
        'WHAT THIS CANNOT DO: confirm the stop. The host issues a cancel request and returns nothing, and an ' +
        'interrupt of an unknown or already-ended target is a documented silent no-op — which is why this tool ' +
        'reports `stopRequested` and `verified=false` instead of claiming the child stopped. ' +
        'It checks whether the target exists first and refuses instead of faking success. ' +
        'Normally you do not need this: `send_to_subagent` requests an interrupt before it delivers. ' +
        'Use it when you want the child to stop WITHOUT sending it anything.',
      // 同 send_to_subagent：两种名字都收，由 compat.applyToTools 统一算 required。
      parameters: applyToTools({
        type: 'object',
        additionalProperties: false,
        properties: {
          agent_id: {
            type: 'string',
            description: 'The `childSessionId` returned by `subagent_preset` when you delegated this worker.',
          },
        },
        required: ['agent_id'],
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetState: { type: 'string', enum: ['running', 'idle', 'finished', 'unknown'] },
            stopRequested: { type: 'boolean' },
            verified: { type: 'boolean' },
            outcome: {
              type: 'string',
              enum: [
                'request-sent-unverified',
                'target-not-found',
                'target-not-checkable',
                'rejected-by-host',
                'coordinator-only',
              ],
            },
            detail: { type: 'string' },
          },
          required: ['targetState', 'stopRequested', 'verified', 'outcome', 'detail'],
        },
        // B1：`stopped === true ? 'sent' : 'no-op'` 让 no-op 分支永远不可达 ——
        // 旧实现无条件返回 `{ stopped: true }`，于是渲染永远是 "sent"。
        // 现在渲染只陈述**结果分类**，不再暗示「已停止」。
        render: (args, value) => {
          // ⚠️⚠️ 2026-11-06（P1-2）：同 send_to_subagent —— 绝不裸调 `targetOf(args)`。
          // 参数非法时 execute 已经抛过明确错误，render 再抛会把「明确错误」变成「渲染失败」。
          const label = (() => {
            try {
              return targetOf(args)
            } catch {
              return args?.agent_id ?? args?.agent ?? '<unknown>'
            }
          })()
          return [
            {
              type: 'text',
              text:
                // 同 send_to_subagent：新宿主给的是 agent（名字），不是 agent_id。
                `stop_subagent ${label}` +
                ` | outcome=${value?.outcome ?? '?'}` +
                ` | stopRequested=${value?.stopRequested === true ? 'true' : 'false'}` +
                ` | verified=${value?.verified === true ? 'true' : 'false'}` +
                ` | targetState=${value?.targetState ?? 'unknown'}` +
                (typeof value?.detail === 'string' && value.detail !== '' ? ` | ${value.detail}` : ''),
            },
          ]
        },
      },
      async execute(args, exec) {
        const sender = exec?.agent
        if (sender === undefined || sender === null) {
          throw new Error('stop_subagent requires a calling agent (exec.agent was undefined)')
        }
        if (isDelegatedChild(sender)) {
          return {
            targetState: 'unknown',
            stopRequested: false,
            verified: false,
            outcome: 'coordinator-only',
            detail:
              'stop_subagent is coordinator-only: a delegated child cannot stop other agents or its own parent. ' +
              'Nothing was stopped and no interrupt was issued.',
          }
        }
        const sub = subagentsOf(ctx)
        if (sub === undefined || typeof sub.interrupt !== 'function') {
          throw new Error('stop_subagent requires the subagents service, which is not available in this composition')
        }

        // ⚠️ 2026-11-06 通用化：目标可以是 id 也可以是名字，先解析成 id 一次。
        const requestedTarget = targetOf(args)
        const compatView = compatViewOf(ctx)
        const logger = compatView.logger
        const api = detectControlApi(compatView.ctx, { logger }).api
        const isKnownId = isKnownIdProbe(ctx, sub, sender, exec)
        const resolved = await resolveTargetId(compatView.ctx, requestedTarget, {
          sub,
          sender,
          signal: exec?.signal,
          isKnownId,
          api,
          logger,
        })
        const targetId = resolved.id

        // B1 的核心：**先确认目标存在**，再动手。旧实现直接转发给宿主的
        // interrupt()，而宿主对不存在 / 已结束的目标是静默 no-op，于是「没抛异常」
        // 被当成了「停掉了」。
        const target = await describeTarget(ctx, sub, sender, targetId, exec?.signal)

        if (target.state === 'unknown') {
          const looked = target.looked === true
          // 两个来源都不可用 → 老实说「没查成」，不冒充「不存在」，也不冒充「已停止」。
          const catalogMachineReadable = target.catalogUnavailable !== true
          return {
            targetState: 'unknown',
            stopRequested: false,
            verified: false,
            outcome: looked ? 'target-not-found' : 'target-not-checkable',
            detail: !looked
              ? 'neither the live agent registry (agents.get) nor the child catalog (subagents.listChildren) ' +
                'could be read, so this tool cannot tell whether the target exists — no interrupt was issued ' +
                'and the outcome is unknown, NOT a success'
              : catalogMachineReadable
                ? `no live agent has the id "${targetId}" and it is not in your durable child catalog ` +
                  `(looked via ${target.source}), so there is nothing to stop — no interrupt was issued`
                : `no live agent has the id "${targetId}" (looked via ${target.source}); the durable child ` +
                  'catalog could not be read, so this cannot rule out an earlier child with that id — but no live ' +
                  'target exists, so no interrupt was issued',
          }
        }

        // 已结束的目标不在 resident 表里 —— 宿主对它的 interrupt **保证**是静默
        // no-op（`if (activation === void 0) return;`）。所以先判，再决定要不要发。
        // 发了也白发，还会让调用方以为某件事发生了。
        if (target.state === 'finished') {
          return {
            targetState: 'finished',
            stopRequested: false,
            verified: false,
            outcome: 'target-not-found',
            detail:
              'this subagent already ended (it is in your durable child catalog but not in the live agent ' +
              'registry), so there was nothing to stop; no interrupt was issued and nothing changed',
          }
        }

        const outcome = requestInterrupt(sub, ctx, sender, targetId)
        if (!outcome.requested) {
          return {
            targetState: target.state,
            stopRequested: false,
            verified: false,
            outcome: 'rejected-by-host',
            detail: outcome.reason ?? 'the host rejected the interrupt request',
          }
        }
        return {
          targetState: target.state,
          stopRequested: true,
          // 宿主 `interrupt()` 返回 undefined，且对非 resident 目标静默 return。
          verified: false,
          outcome: 'request-sent-unverified',
          detail:
            'the cancel request was handed to the host; it issues no receipt, so whether the child has ' +
            'observed the signal is unverified — this result is the only evidence you get. This worker is NOT a ' +
            'Team member: `list_agents` never sees it; `wait_agent` reports on teammates only, so its result says nothing about this worker. ' +
            'Do not confirm its state with them. Judge it from a `send_to_subagent` reply (`targetState`) or from the ' +
            'host\'s completion notice.',
        }
      },
    })
  } catch (error) {
    warn(
      `registering ${INTERRUPT_TOOL_NAME} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // B7：把 `stop_subagent` 从**子会话**的可见面上摘掉（协调者不受影响）。
  // `send_to_subagent` 不摘 —— 子会话（尤其队友）需要它才能给自己派出的
  // 直接子代理追加指令、纠正方向；服务层 `sendMessage` 只允许「直接父 ↔ 直接子」，
  // 越界抛 UNAUTHORIZED，通路本身有硬边界。
  // 用 `agent/created` + agent 自己的 scope，理由见上面 `memberHides` 的注释。
  try {
    ctx.on('agent/created', (payload) => {
      // ⚠️ 2026-11-07 修（R15，BUG-1）：原先在参数位置解构 `({ agent }) =>`，而 try 在解构之后 ——
      // 宿主真给 undefined 时，解构本身先抛 `Cannot destructure property 'agent' of 'undefined'`，
      // 根本进不到 try。`agent/created` 走 `ctx.serial`、没有 per-listener try/catch，
      // 这一抛会截断后续监听（member-persona 的人格注入等）并回滚 agent 创建。
      // 现在先收整个 payload，在 try 内部取值、判空；正常载荷行为不变。
      // `ctx.logger?.error?.()` 也可能抛，所以吞在本层、记一条 warn、让链继续。
      // 与 member-persona.mjs 的 agent/created 回调同一取向。
      let scopeKey = '<unknown>'
      try {
        const agent = payload?.agent
        if (agent === undefined || agent === null) return
        scopeKey = agentScopeKeyOf(agent)
        if (!isDelegatedChild(agent)) return
        hideFromMember(agent)
      } catch (error) {
        warn(
          `hiding ${INTERRUPT_TOOL_NAME} from a delegated child on agent/created threw (scope=${scopeKey}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          scopeKey,
        )
      }
    })
    // 启动 / 恢复路径：本插件可能晚于已有 agent 装载，补一次。
    try {
      const agents = ctx.get('agents')
      if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
        // ⚠️ 2026-11-07 修（R14a2，BUG-A）：`agents.list()` 的返回值必须先判数组。
        // 旧实现直接 for...of，返回字符串 / null / 对象时抛 TypeError，被下面那个空 catch
        // 吞掉 → 该轮零隐藏、零日志。与 member-persona.mjs 的 R10#3 同一点同一改法：
        // 非数组按空列表处理，并明确 warn 实际类型；正常数组的行为逐字节不变。
        const listedAgents = agents.list()
        if (!Array.isArray(listedAgents)) {
          warn(
            `agents.list() returned ${listedAgents === null ? 'null' : typeof listedAgents} instead of an array ` +
              'during the startup backfill; no existing delegated child is being hidden',
          )
        }
        for (const agent of Array.isArray(listedAgents) ? listedAgents : []) {
          // ⚠️ 2026-11-07 修（R5）：单项失败（restrict 抛错，或 hideFromMember 内部的
          // `ctx.logger?.error?.()` 抛错）原来会冒到外层 catch 被静默吞掉 —— 该轮**剩余**
          // 已存在子会话就此不再被隐藏，且零日志。与上面 agent/created 同形：本项吞掉、
          // 记一条 warn（warnOnceFactory 自己已兜住 logger 抛错）、继续处理剩余项。
          // 隐藏语义不变：该隐藏的仍然要 hide。
          try {
            if (agent === undefined || agent === null) continue
            if (!isDelegatedChild(agent)) continue
            hideFromMember(agent)
          } catch (error) {
            const scopeKey = agentScopeKeyOf(agent)
            warn(
              `hiding ${INTERRUPT_TOOL_NAME} from an existing delegated child on startup threw (scope=${scopeKey}): ` +
                `${error instanceof Error ? error.message : String(error)}`,
              scopeKey,
            )
          }
        }
      }
    } catch (error) {
      // 取不到不是致命错误，但**不能静默**：没有日志的失败与成功无法区分。
      warn(
        `the startup backfill for hiding ${INTERRUPT_TOOL_NAME} from existing delegated children could not run: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } catch (error) {
    warn(`subscribing to agent/created failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
