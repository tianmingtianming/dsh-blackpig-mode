/**
 * blackpig-watchdog — 父侧卡死看门狗：**四证判活，只有四证全空才计时**（自控实现，零第三方依赖）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 *
 * 黑猪模式里，大脑把活派给 worker（`subagent_preset`）后结束回合，等 worker 的
 * 完成通知。宿主没有任何子代理步数上限、空闲超时或看门狗：worker **静默卡死**
 * （反复改同一段、陷在构造里、工具永远不返回、模型调用永不结束）时，父会话什么
 * 都收不到，整个任务停在半空，界面上看不出异常。父侧必须自己计时，并在**确认
 * 真的没有活物**之后把它停掉 —— 停下会触发结算通知，卡死就从「静默」变成
 * 「可见」，大脑因此能在新回合里复查、换人。
 *
 * ── 为什么不能照抄 multitask 的 watchdog ──────────────────────────────────────
 *
 * `dsh-multitask/presets/multitask/subagent-watchdog.mjs` 只把 `tools/post-execute`
 * 当活动信号（`:506-514`），既不排除「工具在飞」也不排除「后台 job 在跑」，
 * 5 分钟一到就 `interrupt`（`:393-445`）。实测能稳定误杀 `job_output`：单次 wait
 * 默认 30 s、硬上限 10 min，期间**没有任何** `post-execute`，于是「一个正在等
 * 长命令的 worker」与「一个真卡死的 worker」在它的时间戳上长得一模一样。
 *
 * 本模块的判据与之相反：**只要有任何一条「它可能还在动」的证据，就刷新时间戳、
 * 绝不计时**。四条证据（任一为真即判活）：
 *
 *   ① `generating`   —— `agent/assistant-stream` 的 `start` 之后、`end` 之前。
 *                      那正是模型在生成（`dsh-agent-loop/src/agent.ts:486-503`
 *                      一拿到流就发 start，**不等首 token**）；长思考、长输出、
 *                      慢 TTFT 全都落在这段里，期间不会有任何工具事件。
 *   ② `openTools`   —— `tools/pre-execute` 已发、`tools/post-execute` 未到（同
 *                      `callId` 配对，`dsh-tools/src/events.ts:18/:41`）。一次长
 *                      `pwsh`、整树扫描、10 分钟的 `job_output` 都在飞。
 *   ③ running job   —— `ctx.jobs.list(childId)` 里有 `running` / `stopping`
 *                      （`dsh-jobs/src/index.ts:121`、`view.ts:19,80`）。worker
 *                      用 `job_*` 起后台命令后可以长时间**完全没有**工具事件。
 *   ④ 审批等待表     —— 若本进程有已注册的审批等待表（跨插件契约，见
 *                      `APPROVAL_WAIT_KEYS`），表里这个会话 `n > 0` 就算活着。
 *                      等审批时 worker 同样没有任何事件；不认这条就会**把它正
 *                      在等的那张卡静默丢弃**。表不存在时跳过这一条，不据此判死。
 *
 * `agent/status` 只有 `idle|running` 两态（`dsh-agent/src/runtime-types.ts:136`），
 * **不能细分**「在生成 / 在跑工具 / 在等审批」，所以它**不是判据**。本模块只用它
 * 做两件安全方向的事：`running` 时开始/继续监控，观察到 `idle` 就**暂停**监控
 * （回合已关的 worker 不可能是「卡住的回合」，停它没有意义）；缺这个事件时按
 * 「未知」照常按四证监控。
 *
 * ── 动作：唤而不杀（2026-11-27 用户裁定）──────────────────────────────────────
 *
 * 看门狗**不替协调者做决定**，也**从不**调用 `subagents.interrupt`：
 *
 *   · `interrupt` 只能杀，且 `aborted` 的结算正文宿主写死为 "was stopped before it
 *     finished."（`dsh-subagent/src/continuation-messages.ts:106-129`），插件改不了
 *     这句话 —— 父会话只会看到「被停」，看不到「为什么停、该不该重派」。
 *   · 正确的最小动作是**把卡死变成父会话里的一条消息**，让协调者自己决定继续等、
 *     追问还是放弃：
 *       `ctx.get('agents').get(parentId)` → `agent.followup(message)`。
 *     `followup` 的契约是 "Queue an ordinary follow-up turn and **wake the
 *     driver**"（`dsh-agent/src/runtime-types.ts:247-252`；实现
 *     `dsh-agent-loop/src/agent.ts:171-178, 235-257`，注释写明「idle 时的一次唤醒
 *     总会开一个回合边界」）。宿主自己就是这么唤父会话的：子代理结算
 *     （`dsh-subagent/src/manager.ts:675-687`）、job 完成
 *     （`dsh-tool-jobs/src/index.ts:398-401`）。
 *     ⚠️ 反例：`Session.append` / `agent.inject` **不唤醒** idle 会话
 *     （`runtime-types.ts:263-271` "without waking the driver"），只有 followup /
 *     steer 才唤 —— 所以这里只能用 followup。
 *
 *   节奏：**同一工人同一段静默期最多发 2 条 notice** ——
 *     第 1 条在 `lastEventAt + N1`（默认 10 min）；
 *     第 2 条在再静默 `2 × N1` 之后（合计 3 × N1）。
 *   期间只要监测到任何活动（四证任一为真，或任一事件把 `lastEventAt` 顶上去），
 *   计数立刻复位。notice 是 user 角色消息、**会占父会话上下文**，所以正文压到
 *   120 字以内，且不贴日志。
 *
 *   ⚠️ 不能反过来「给工人发提醒」：`send_message` 会 abort 对方当前回合
 *   （`dsh-multitask/presets/multitask/composition.mjs:324`），那本身就是打断。
 *   父会话取不到（`agents.get` 返回 `undefined`）时**只记日志、什么都不做** ——
 *   没有父会话就没有可唤醒的人。
 *
 * ── 失败安全（本模块最重要的性质）────────────────────────────────────────────
 *
 *   ① **证据源取不到 ⇒ 这个孩子永久退出监控**，记一次 `SKIPPED_MARKER` 日志：
 *      `jobs` 服务缺失 / `list()` 抛错 / 返回形状不对、`agents` 服务缺失。
 *      **绝不**退化成「按时间判死」—— 那正是最危险的误报。
 *   ② 本模块自身任何异常都在 `catch` 里吞掉并放行（`tools/*` 是瀑布，必须
 *      `return next()` 把下游值原样交回）。看门狗是保险，不是单点故障。
 *   ③ `post-execute` 缺失（宿主 pipeline 失败会绕过它）⇒ 该 `openTool` 永久
 *      在飞 ⇒ **永不触发 notice**。这是安全方向，接受。
 *
 * ── 状态放哪 ──────────────────────────────────────────────────────────────────
 *
 * `globalThis[Symbol.for('dsh-blackpig-mode:watchdog:v1')]`，进程内、不落盘：
 *   `{ watched: Map<childSessionId, entry>, skipped: Map<childSessionId, reason>, active }`
 *   `entry = { createdAt, lastEventAt, openTools: Map<callId, at>, generating,
 *              running, notices, parentId }`
 * 用 `Symbol.for`：不进 JSON、不与别的插件撞名；同一进程里 preset 可能装载多次，
 * 「谁在卡着」是全局事实，分裂成几份就等于看门狗失明。已注销的会话在
 * `agent/disposed` 处清掉，另有 `MAX_WATCHED` / `MAX_SKIPPED` 上限兜底。
 *
 * @module blackpig-watchdog
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-watchdog'

/**
 * 不 `inject` 任何服务。
 *
 * `jobs` / `agents` 都在**调用期**才去取，且**允许取不到**：声明注入
 * 会把这一行绑在宿主服务的就绪时机上，服务缺席时整行不装载 —— 而本行「取不到就
 * 永久跳过这个孩子」的取向恰恰相反（与 `blackpig-file-guard.mjs:64-70` 同一条取舍）。
 */
export const inject = []

/** 全局状态键。`Symbol.for` 让同进程多份副本/多次 apply 共享同一份事实。 */
const STATE_KEY = Symbol.for('dsh-blackpig-mode:watchdog:v1')

/** 默认静默阈值 N1：10 分钟。长到不会误杀长工具/长生成/长命令，短到卡死不会拖整晚。 */
export const DEFAULT_SILENCE_MS = 600000

/** 环境变量名（覆盖 N1）。**优先级高于 config**：验证/排障要临时调短，而不该为此改包。 */
export const SILENCE_ENV = 'DSH_BLACKPIG_WATCHDOG_SILENCE_MS'

/** 默认巡检间隔：30 秒。 */
export const DEFAULT_TICK_MS = 30000

/** 环境变量名（覆盖 tick）。 */
export const TICK_ENV = 'DSH_BLACKPIG_WATCHDOG_TICK_MS'

/** 第 1 条 notice 的日志标记。 */
export const SILENT_MARKER = '[BLACKPIG-WATCHDOG-SILENT]'

/** 第 2 条 notice 的日志标记（第 1 条用 SILENT_MARKER）。 */
export const STALLED_MARKER = '[BLACKPIG-WATCHDOG-STALLED]'

/**
 * 发给父会话的 notice **正文开头**的标记（逐字要求，便于 grep 与模型识别）。
 * 与日志标记刻意不同：日志是给运维看的，notice 是给协调者看的。
 */
export const NOTICE_MARKER = '[WATCHDOG-STALLED]'

/** 每个工人每段静默期最多发几条 notice（第 1 条在 N1，第 2 条在再静默 2×N1 后）。 */
export const MAX_NOTICES_PER_STALL = 2

/** notice 正文字符上限：它是 user 角色消息，会占父会话上下文。 */
export const NOTICE_MAX_CHARS = 120

/** 这个孩子永久退出监控（证据源不可用），以及为什么。 */
export const SKIPPED_MARKER = '[BLACKPIG-WATCHDOG-SKIPPED]'

/**
 * 审批等待表的候选键（跨插件契约，本模块只**读**、从不写）。
 *
 * 值类型固定是 `Map<sessionId, { n: number, at: number }>`，判据
 * `entry !== undefined && entry.n > 0`（与 `dsh-multitask` 的 `approval-gate.mjs`
 * 写入方逐字一致）。表不存在 / 类型不对 / 抛错一律「不知道」，**不判死**。
 */
const APPROVAL_WAIT_KEYS = ['dsh-multitask:approval-wait:v1']

/** 黑猪自己的审批等待表键（留给将来的插件登记，同样只读）。 */
const APPROVAL_WAIT_SYMBOL = Symbol.for('dsh-blackpig-mode:watchdog:approval-wait:v1')

/** 在册上限（防长进程里只增不减；正常会话树远小于它）。 */
const MAX_WATCHED = 256

/** 「永久跳过」名单上限（只留最近 64 条，够解释现象即可）。 */
const MAX_SKIPPED = 64

/**
 * 取（或建）进程内的看门狗状态。
 *
 * 形状不对就**整体重建**：半损坏的状态比空状态更危险（可能让某个孩子带着错的
 * `openTools` 永久活着，或让别处读到不存在的方法）。
 */
function state() {
  const bag = globalThis
  let current = bag[STATE_KEY]
  if (
    current === undefined ||
    current === null ||
    typeof current !== 'object' ||
    !(current.watched instanceof Map) ||
    !(current.skipped instanceof Map)
  ) {
    current = { watched: new Map(), skipped: new Map(), active: undefined }
    bag[STATE_KEY] = current
  }
  return current
}

/** 任意抛出值 → 一行文本（不让 `String()` 自己再炸）。 */
function messageOf(error) {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/**
 * 读一个 agent 的会话 id（`agent.session.id`，兜 `agent.id`）。
 *
 * 两次读取各自兜错：`session` 可能已被拆掉、`id` 可能是 throwing getter
 * （与 `blackpig-file-guard.mjs:117-137` 同款写法）。取不到返回 `undefined`，
 * 调用方必须容忍「没有身份」。
 */
function sessionIdOf(agent) {
  try {
    let id
    try {
      id = agent?.session?.id
    } catch {
      id = undefined
    }
    if (id === undefined || id === null) {
      try {
        id = agent?.id
      } catch {
        id = undefined
      }
    }
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** 读一个 agent 的会话头（可能不存在 / 是 throwing getter）。 */
function headerOf(agent) {
  try {
    const header = agent?.session?.header
    return header !== undefined && header !== null && typeof header === 'object' ? header : undefined
  } catch {
    return undefined
  }
}

/**
 * 是不是被委派出来的子代理（与 `dsh-subagent` / `dsh-multitask` 的同名判据同形：
 * 三个信号任一成立）。父会话自己不满足，所以不会被本模块纳入在册。
 */
function isDelegatedChild(agent) {
  const header = headerOf(agent)
  if (header === undefined) return false
  if (header.origin === 'subagent') return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/** 父会话 id（`header.parentSession`）。读不到 ⇒ `undefined` ⇒ 永不杀。 */
function parentIdOf(agent) {
  const header = headerOf(agent)
  const id = header?.parentSession
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 读环境变量里的毫秒数。
 *
 * 解析失败一律回落（不因环境变量打错而抛）；`0` 与负数视为未设置 —— 允许 0 会让
 * 看门狗在第一个 tick 就把所有孩子判死，那是配置手滑，不该成为部署行为。
 */
function envMs(name, fallback) {
  let raw
  try {
    raw = process.env?.[name]
  } catch {
    raw = undefined
  }
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/**
 * 解析一个毫秒配置：**环境变量 > config > 默认值**。
 *
 * 顺序与 `blackpig-file-guard.mjs` 的 `resolveTtl()`（config 优先）**刻意相反**：
 * 包内 `cordis.patch.yml` 一旦写死 `silenceMs`，环境变量就永久失效，而验证与排障
 * 恰恰需要「不改包、只调短」；把环境变量放第一位是这个取舍的可验证形式。
 */
function resolveMs(configValue, envName, fallback) {
  const fromEnv = envMs(envName, undefined)
  if (fromEnv !== undefined) return fromEnv
  if (typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0) {
    return Math.floor(configValue)
  }
  return fallback
}

/** 秒数（一位小数），只用于文案。 */
function seconds(ms) {
  return Math.round(Math.max(0, ms) / 100) / 10
}

/**
 * 一条 job 的 owner 会话 id。
 *
 * 宿主对外投影是 `JobView.owner?: SessionId`（`dsh-jobs/src/view.ts:76`，普通字符串），
 * 而内部注册表按 `job.owner.id` 过滤（`dsh-jobs-local/src/index.ts:321-325`）。
 * 两种形态都认，认不出就当作「不是这个孩子的」（不参与判活）。
 */
function ownerIdOf(view) {
  try {
    const owner = view?.owner
    if (typeof owner === 'string' && owner !== '') return owner
    const nested = owner?.id
    return typeof nested === 'string' && nested !== '' ? nested : undefined
  } catch {
    return undefined
  }
}

/**
 * 证据 ③：这个孩子有没有在跑的后台 job。
 *
 * **三态**：`{ ok: true, running }` 表示查清了；`{ ok: false, why }` 表示查不了
 * （服务缺失 / 抛错 / 形状不对）。调用方对 `ok:false` 的唯一正确处置是**永久跳过
 * 这个孩子**，绝不能当成「没有 job」。
 *
 * 只认 `status === 'running' | 'stopping'`（`JobView.status` 的五态之一，见
 * `dsh-jobs/src/view.ts:19`）；`completed / killed / failed` 都是已结算。
 */
function probeJobs(ctx, childId) {
  let jobs
  try {
    jobs = ctx.get?.('jobs')
  } catch (error) {
    return { ok: false, why: `jobs service lookup threw: ${messageOf(error)}` }
  }
  if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') {
    return { ok: false, why: 'the jobs service is not available in this composition' }
  }
  let views
  try {
    // `list(caller)` 按 owner 过滤（`dsh-jobs-local/src/index.ts:321-325`）：返回这个
    // 孩子自己的 job + 无主 job。无主的不算「这个孩子在跑」，所以下面还要再筛 owner。
    views = jobs.list(childId)
  } catch (error) {
    return { ok: false, why: `jobs.list(${childId}) threw: ${messageOf(error)}` }
  }
  if (!Array.isArray(views)) {
    return { ok: false, why: `jobs.list(${childId}) returned ${typeof views} instead of an array` }
  }
  let running = 0
  let total = 0
  for (const view of views) {
    try {
      if (ownerIdOf(view) !== childId) continue
      total++
      if (view?.status === 'running' || view?.status === 'stopping') running++
    } catch {
      // 单条投影读炸不影响其余条目；读不到的那条按「不是这个孩子的」处理。
    }
  }
  return { ok: true, running, total }
}

/**
 * 证据 ④：这个孩子是不是正在等一张审批卡。
 *
 * 返回 `'waiting' | 'not-waiting' | 'unknown'`。`unknown`（表不存在 / 类型不对 /
 * 抛错）**不是**判死理由，只是这条证据缺席 —— 与另外三条独立。
 */
function probeApproval(childId) {
  const tables = []
  try {
    for (const key of APPROVAL_WAIT_KEYS) {
      const table = globalThis[key]
      if (table instanceof Map) tables.push(table)
    }
  } catch {
    return 'unknown'
  }
  try {
    const table = globalThis[APPROVAL_WAIT_SYMBOL]
    if (table instanceof Map) tables.push(table)
  } catch {
    // Symbol 键读不到就当没有这张表。
  }
  if (tables.length === 0) return 'unknown'
  for (const table of tables) {
    try {
      const entry = table.get(childId)
      if (entry !== undefined && entry !== null && typeof entry.n === 'number' && entry.n > 0) return 'waiting'
    } catch {
      return 'unknown'
    }
  }
  return 'not-waiting'
}

/** 读一个活的 agent（`agents` 是宿主面服务，`get(id)` 只读）。三态同 `probeJobs`。 */
function agentById(ctx, id) {
  let agents
  try {
    agents = ctx.get?.('agents')
  } catch (error) {
    return { ok: false, why: `agents service lookup threw: ${messageOf(error)}` }
  }
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    return { ok: false, why: 'the agents service is not available in this composition' }
  }
  try {
    return { ok: true, agent: agents.get(id) }
  } catch (error) {
    return { ok: false, why: `agents.get(${id}) threw: ${messageOf(error)}` }
  }
}

/** 四证状态的一行摘要（写进第一级日志，便于事后复盘为什么没杀 / 为什么杀）。 */
function evidenceText(entry, jobs, approval) {
  const jobsText = jobs.ok === true ? (jobs.running > 0 ? `running:${jobs.running}` : 'none') : 'unavailable'
  return (
    `generating=${entry.generating === true} ` +
    `openTools=${entry.openTools.size} ` +
    `jobs=${jobsText} ` +
    `approval=${approval}`
  )
}

/** 在册条目（不存在就返回 `undefined`）。 */
function entryOf(childId) {
  return state().watched.get(childId)
}

/** 刷新时间戳（证据为真 / 收到事件时）。 */
function touch(entry, at) {
  entry.lastEventAt = at
}

/**
 * 把一个孩子从在册里摘掉，并记下原因（已停 / 已结束的不必再解释，只留痕）。
 *
 * @param childId - 子会话 id。
 * @param reason - 为什么不再监控（写进快照，供事后复盘）。
 * @param at - 摘除时刻。
 */
function drop(childId, reason, at) {
  const bag = state()
  bag.watched.delete(childId)
  bag.skipped.delete(childId)
  bag.skipped.set(childId, { reason, at })
  try {
    while (bag.skipped.size > MAX_SKIPPED) {
      const oldest = bag.skipped.keys().next()
      if (oldest.done === true) break
      bag.skipped.delete(oldest.value)
    }
  } catch {
    // 超上限清不掉只是内存里多一条。
  }
}

/**
 * 让一个孩子**永久**退出监控，并记一行原因。
 *
 * 这是失败安全的主通道：任何证据源不可用都走这里，而不是让计时继续跑。
 */
function retire(warn, childId, reason, at) {
  drop(childId, reason, at)
  warn(`${SKIPPED_MARKER} child=${childId} — ${reason}；该子会话不再参与监控（不按时间判死）`)
}

/**
 * 纳入一个刚出现的 agent。
 *
 * 只纳入**被委派的子会话**；重复的 `agent/created`（启动 / 恢复两条路径都可能发）
 * 只刷新时间戳。已被判定「永久跳过」的 id 不再重新纳入 —— 证据源不会因为一条
 * 创建事件就变得可用。
 */
function watch(ctx, warn, agent, at) {
  if (agent === undefined || agent === null) return
  if (!isDelegatedChild(agent)) return
  const childId = sessionIdOf(agent)
  if (childId === undefined) return

  const bag = state()
  if (bag.skipped.has(childId)) return

  const existing = bag.watched.get(childId)
  if (existing !== undefined) {
    touch(existing, at)
    return
  }

  // 上限保护：超了就淘汰最早纳入的那条（并说明，不静默）。
  if (bag.watched.size >= MAX_WATCHED) {
    let oldestId
    let oldestAt = Infinity
    for (const [id, entry] of bag.watched) {
      if (entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt
        oldestId = id
      }
    }
    if (oldestId !== undefined) {
      retire(warn, oldestId, `watched table exceeded ${MAX_WATCHED} entries; the oldest child was evicted`, at)
    }
  }

  bag.watched.set(childId, {
    createdAt: at,
    lastEventAt: at,
    openTools: new Map(),
    generating: false,
    // `undefined` = 还没看到 `agent/status`：按「未知」照常按四证监控。
    running: undefined,
    // 这段静默期已经发过几条 notice（0 / 1 / 2）；活动一恢复就归零。
    notices: 0,
    // 「父 agent 取不到」这条日志已经打过一次（防止每 30 s 刷屏）。
    noParentNoted: false,
    parentId: parentIdOf(agent),
  })
}

/**
 * 核心判定：只做判定，不做 I/O 之外的副作用。
 *
 * 返回 `{ skip: true, why }`（证据源不可用 ⇒ 永久跳过）、`{ alive: true, ... }`
 * （有活物证据 ⇒ 刷新时间戳）、或 `{ alive: false, ... }`（四证全空 ⇒ 可以计时）。
 */
function probe(ctx, childId, entry) {
  if (entry.running === false) {
    // 回合已关（观察到 `agent/status: idle`）：不可能是「卡住的回合」，不计时。
    return { paused: true, alive: false, jobs: { ok: true, running: 0 }, approval: 'unknown' }
  }

  const jobs = probeJobs(ctx, childId)
  if (jobs.ok !== true) return { skip: true, why: jobs.why }

  const approval = probeApproval(childId)

  const alive =
    entry.generating === true ||
    entry.openTools.size > 0 ||
    jobs.running > 0 ||
    approval === 'waiting'

  return { alive, jobs, approval }
}

/**
 * 发给父会话的 notice 正文。
 *
 * 四要素（缺一不可）：`[WATCHDOG-STALLED]` 标记、childSessionId（完整、可原样粘进
 * `send_to_subagent` 的 `agent_id`）、静默秒数、四证全空的状态；再给协调者三个
 * **可执行**选项（继续等 / 追问 / 放弃）。
 *
 * 长度是硬约束：notice 是 user 角色消息，会占父会话的上下文 —— 正文封顶
 * `NOTICE_MAX_CHARS`。超了就先砍括号里的四证明细（保留「四证全空」这个结论），
 * 再砍选项里的括号说明，**绝不砍 id**（截断的 id 不可复原、不可执行）。
 *
 * @param childId - 子会话 id。
 * @param silentMs - 已静默毫秒数。
 * @returns 一条不超过 `NOTICE_MAX_CHARS` 个字符的正文。
 */
function noticeText(childId, silentMs) {
  const secs = Math.round(silentMs / 1000)
  const head = `${NOTICE_MARKER} 工人 ${childId} 静默 ${secs}s`
  // 一级：四证明细 + 三个完整选项（常规 id 都能进这一档）。
  const full = `${head}，四证全空(无生成/无在飞工具/无job/无审批)。可继续等/send_to_subagent 追问/stop_subagent 放弃。`
  if (full.length <= NOTICE_MAX_CHARS) return full
  // 二级：砍掉四证明细，保留结论与三个完整选项（id 很长时用这一档）。
  const compact = `${head}，四证全空。可继续等/send_to_subagent 追问/stop_subagent 放弃。`
  if (compact.length <= NOTICE_MAX_CHARS) return compact
  // 三级：只剩标记 + id + 秒数 + 三个动作（仍然可执行，只是没了工具名）。
  // 到这一档说明 childSessionId 本身已经几十个字符，任何写法都塞不进 120 字。
  return `${NOTICE_MARKER} 工人 ${childId} 静默 ${secs}s，四证全空。等/追问/放弃。`
}

/**
 * 构造一条合法的 user 角色消息（不 import 宿主包）。
 *
 * 本包在 profile 里**没有** `@deepseek-ai/*` 宿主包（它们都在 app.asar 里，见
 * `blackpig-roster.mjs` 里那段「本部署里 `@deepseek-ai` 只装了 cosmokit /
 * schemastery」的实测记录），所以这里不 `import { createUserMessage }`：
 * 宿主那个工厂做的只是 `structuredClone` + `randomUUID()` 赋 `id` + `deepFreeze`
 * （`dsh-llm/src/message.ts` 的 `createMessage()`），运行时形状就是
 * `{ id, role: 'user', content, source }`。这里按同一形状手搓，`id` 自己生成。
 *
 * `source.kind` 用 `'user'`：消息本来就是 user 角色（followup 的入参类型），用宿主
 * 没注册过的自定义 kind 只会让客户端渲染器多一条未知分支。
 *
 * @param text - 已压到上限内的正文。
 * @returns 一条可交给 `Agent.followup()` 的消息。
 */
function noticeMessage(text) {
  let id
  try {
    id = globalThis.crypto?.randomUUID?.()
  } catch {
    id = undefined
  }
  if (typeof id !== 'string' || id === '') {
    id = `bp-watchdog-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  }
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * 把一条卡死 notice 送进父会话（**只唤，不杀**）。
 *
 * 失败分支一律「什么都不做 + 记一行」，绝不升级成停人：
 *   · 父会话 id 读不到 ⇒ 永久跳过这个孩子（没有可唤醒的对象，留着只会每轮空转）；
 *   · `agents` 服务缺失 / 抛错 ⇒ 永久跳过；
 *   · 父 agent 已不在（`get` 返回 `undefined`）⇒ 只记一次日志、**不退休**：
 *     父会话可能只是还没注册完，下一轮再看；
 *   · 父 agent 没有 `followup`（旧宿主）⇒ 永久跳过（这个部署唤不醒人）。
 */
function notifyParent(ctx, warn, childId, entry, silentMs, evidence, at) {
  if (entry.parentId === undefined) {
    retire(warn, childId, 'the parent session id is unknown, so no coordinator can be woken', at)
    return false
  }
  const resolved = agentById(ctx, entry.parentId)
  if (resolved.ok !== true) {
    retire(warn, childId, resolved.why, at)
    return false
  }
  const parent = resolved.agent
  if (parent === undefined || parent === null) {
    // 只记一次：父会话不在了这件事不会因为再等 30 秒而改变。
    if (entry.noParentNoted !== true) {
      entry.noParentNoted = true
      warn(
        `${SKIPPED_MARKER} child=${childId} silent=${seconds(silentMs)}s ${evidence} — ` +
          `父 agent parent=${entry.parentId} 取不到（agents.get 返回 undefined），本轮不唤醒；不杀`,
      )
    }
    return false
  }
  if (typeof parent.followup !== 'function') {
    retire(warn, childId, 'the parent agent exposes no followup(), so a stalled worker cannot be surfaced', at)
    return false
  }

  const text = noticeText(childId, silentMs)
  try {
    // 「Queue an ordinary follow-up turn and wake the driver」
    // （`dsh-agent/src/runtime-types.ts:247-252`）—— idle 的父会话会因此开一个新回合。
    parent.followup(noticeMessage(text))
  } catch (error) {
    // 送不进去不是致命错误：最坏是这条卡死仍然静默，而不是把插件弄坏。
    retire(warn, childId, `followup to parent ${entry.parentId} was declined: ${messageOf(error)}`, at)
    return false
  }
  return true
}

/**
 * 巡检一次（由 `setInterval` 调用；测试用导出的 `watchdogTick()` 直接驱动）。
 *
 * 两层 `try`：单条孩子出问题只跳过它这一个 tick；整轮出问题只记一行 —— 绝不让
 * 看门狗自己把宿主弄坏。
 */
function tick(instance, now) {
  const { ctx, warn, silenceMs } = instance
  let bag
  try {
    bag = state()
  } catch {
    return
  }
  for (const [childId, entry] of [...bag.watched]) {
    try {
      const result = probe(ctx, childId, entry)

      if (result.skip === true) {
        retire(warn, childId, result.why, now)
        continue
      }
      if (result.paused === true) continue

      if (result.alive === true) {
        // 四证任一为真：只刷新时间戳，绝不计时；这一段的 notice 计数随之复位。
        entry.lastEventAt = now
        entry.notices = 0
        entry.noParentNoted = false
        continue
      }

      const silentMs = now - entry.lastEventAt
      if (silentMs <= silenceMs) {
        // 还没到 N1（通常是刚发生过活动）：同样复位，保证「活动一恢复就重新计数」。
        entry.notices = 0
        entry.noParentNoted = false
        continue
      }

      const evidence = evidenceText(entry, result.jobs, result.approval)

      // ── 第 1 条 notice：lastEventAt + N1 ──
      if (entry.notices === 0) {
        entry.notices = 1
        const sent = notifyParent(ctx, warn, childId, entry, silentMs, evidence, now)
        warn(
          `${SILENT_MARKER} child=${childId} silent=${seconds(silentMs)}s ${evidence} — ` +
            (sent
              ? `四证全空，已向父会话 parent=${entry.parentId} 发第 1 条 notice（最多 ${MAX_NOTICES_PER_STALL} 条，不杀）`
              : `四证全空，第 1 条 notice 未能送达（见上一行），不杀`),
        )
        continue
      }

      if (entry.notices >= MAX_NOTICES_PER_STALL) continue

      // ── 第 2 条 notice：第 1 条之后再静默 2 × N1（合计 3 × N1）──
      if (silentMs < silenceMs + 2 * silenceMs) continue

      entry.notices = 2
      const sent = notifyParent(ctx, warn, childId, entry, silentMs, evidence, now)
      warn(
        `${STALLED_MARKER} child=${childId} silent=${seconds(silentMs)}s ${evidence} — ` +
          (sent
            ? `仍四证全空，已发第 2 条（最后一条）notice；此后再不打扰（不杀）`
            : `第 2 条 notice 未能送达（见上一行），此后再不打扰（不杀）`),
      )
    } catch (error) {
      // 看门狗自己出错 ⇒ 这一轮放过这个孩子（安全方向：不杀）。
      warn(
        `inspecting child=${childId} threw; the child is left alone this tick. Underlying error: ${messageOf(error)}`,
      )
    }
  }
}

/**
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行的 `config`（只认 `{ enabled, silenceMs, tickMs, now }`；`now` 是离线单测用的时钟）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`blackpig-watchdog: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }

  const silenceMs = resolveMs(config?.silenceMs, SILENCE_ENV, DEFAULT_SILENCE_MS)
  const tickMs = resolveMs(config?.tickMs, TICK_ENV, DEFAULT_TICK_MS)
  // 时钟：唯一允许注入的非业务依赖（离线单测靠它把「15 分钟」压成一瞬间）。生产恒为 Date.now。
  const clock = typeof config?.now === 'function' ? config.now : Date.now
  const instance = { ctx, warn, silenceMs, tickMs, clock }

  // 供 `watchdogTick()` / `watchdogSnapshot()` 使用（测试与人工排障的入口）。
  try {
    state().active = instance
  } catch {
    // 挂不上就只能靠定时器。
  }

  // ── 纳入口 ①：会话创建 ──
  // `agent/created` 传的是 `{ agent, source }`（`dsh-agent/src/runtime-types.ts:291`），
  // 不是 agent 本身 —— 从对象上解构。
  try {
    ctx.on('agent/created', (payload) => {
      try {
        watch(ctx, warn, payload?.agent, clock())
      } catch (error) {
        warn(`handling agent/created failed: ${messageOf(error)}`)
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/created: ${messageOf(error)}`)
  }

  // ── 证据 ①：模型在生成（start 之后、end 之前）──
  // `agent/assistant-stream` 是 emit，payload 是 `{ agent, frame }`
  // （`dsh-agent/src/runtime-types.ts:400`、帧型 `:155-188`）。`chunk` 只当活动，
  // 不改变 generating；未知帧型一律忽略（不猜）。
  try {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const childId = sessionIdOf(payload?.agent)
        if (childId === undefined) return
        const entry = entryOf(childId)
        if (entry === undefined) return
        const type = payload?.frame?.type
        if (type === 'start') entry.generating = true
        else if (type === 'end') entry.generating = false
        else if (type !== 'chunk') return
        entry.lastEventAt = clock()
      } catch {
        // 刷新失败最多让一个活跃 worker 被多看一眼 —— 不该影响这次通知。
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/assistant-stream: ${messageOf(error)}`)
  }

  // ── 证据 ②：工具在飞（pre-execute 已发、post-execute 未到，同 callId）──
  // 两条都是**瀑布**：必须 `return next()` 把下游值原样交回。写成普通监听（返回
  // undefined）会让**每一次**工具调用拿到 undefined —— 表现为「工具全炸、动作却
  // 已经执行」（`dsh-multitask/.../subagent-watchdog.mjs:496-514` 的同款教训）。
  try {
    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        const childId = sessionIdOf(exec?.agent)
        if (childId !== undefined) {
          const entry = entryOf(childId)
          if (entry !== undefined) {
            const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
            if (callId !== undefined) entry.openTools.set(callId, clock())
            entry.lastEventAt = clock()
          }
        }
      } catch {
        // 记不上这一次调用最多让它被当成静默 —— 绝不让它影响调用本身。
      }
      return next()
    })
  } catch (error) {
    warn(`could not subscribe to tools/pre-execute: ${messageOf(error)}`)
  }

  try {
    ctx.on('tools/post-execute', (exec, _result, next) => {
      try {
        const childId = sessionIdOf(exec?.agent)
        if (childId !== undefined) {
          const entry = entryOf(childId)
          if (entry !== undefined) {
            const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
            if (callId !== undefined) entry.openTools.delete(callId)
            entry.lastEventAt = clock()
          }
        }
      } catch {
        // 同上。
      }
      return next()
    })
  } catch (error) {
    warn(`could not subscribe to tools/post-execute: ${messageOf(error)}`)
  }

  // ── 回合门（不是判据，只用于暂停监控）──
  // `agent/status` 只有两态（`dsh-agent/src/runtime-types.ts:136`），无法细分在生成 /
  // 在跑工具 / 在等审批，所以**不参与**判活。它只做两件事：
  //   running → 这个孩子有开着的回合，开始/继续按四证监控；
  //   idle    → 回合已关，暂停监控并清掉这一回合的「在飞工具」记录。清掉是必要的：
  //             回合关掉意味着所有工具都已结算，留着一条漏掉的 post-execute 会让
  //             这个孩子**本进程内**再也不可能有卡死判定。
  try {
    ctx.on('agent/status', (payload) => {
      try {
        const childId = sessionIdOf(payload?.agent)
        if (childId === undefined) return
        const entry = entryOf(childId)
        if (entry === undefined) return
        const status = payload?.status
        if (status === 'running') {
          entry.running = true
          entry.lastEventAt = clock()
        } else if (status === 'idle') {
          entry.running = false
          entry.generating = false
          entry.openTools.clear()
          // 回合已关：这一段的 notice 计数与「父会话取不到」的记录都作废。
          entry.notices = 0
          entry.noParentNoted = false
        }
      } catch {
        // 状态读不到就当未知，继续按四证监控。
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/status: ${messageOf(error)}`)
  }

  // ── 释放：孩子走了就从在册里删掉 ──
  try {
    ctx.on('agent/disposed', (payload) => {
      try {
        const childId = sessionIdOf(payload?.agent)
        if (childId === undefined) return
        state().watched.delete(childId)
        state().skipped.delete(childId)
      } catch (error) {
        warn(`releasing a disposed child failed: ${messageOf(error)}`)
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/disposed: ${messageOf(error)}`)
  }

  // ── 计时 ──
  // `unref()` 是必须的：没有 unref 的 `setInterval` 会让进程无法退出（测试脚本会挂到超时）。
  let timer
  try {
    timer = setInterval(() => {
      try {
        tick(instance, clock())
      } catch (error) {
        warn(`a watchdog tick threw and was contained: ${messageOf(error)}`)
      }
    }, tickMs)
    timer?.unref?.()
  } catch (error) {
    warn(`starting the watchdog timer failed: ${messageOf(error)}`)
    timer = undefined
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      if (timer !== undefined) clearInterval(timer)
    } catch {
      // 停不掉定时器不该让 dispose 抛错。
    }
    try {
      const bag = state()
      if (bag.active === instance) bag.active = undefined
      bag.watched.clear()
      bag.skipped.clear()
    } catch {
      // 清不掉只是内存里多几条。
    }
  }

  // 两条清理通道都挂上（`ctx.on('dispose')` 与 `ctx.effect`）；`stop` 幂等。
  try {
    ctx.on('dispose', stop)
  } catch {
    // 事件通道不可用还有下面那条。
  }
  try {
    ctx.effect(() => () => stop(), 'blackpig-watchdog teardown')
  } catch {
    // effect 不可用时不清理（进程退出即消失）。
  }
}

/**
 * 手动跑一次巡检（离线单测与人工排障入口；生产里只有 `setInterval` 调它）。
 *
 * @param now - 巡检时刻（默认 `Date.now()`；测试用假时间推进静默阈值）。
 * @returns 是否真的跑了一轮（没有已挂载实例时为 `false`）。
 */
export function watchdogTick(now) {
  const bag = state()
  const instance = bag.active
  if (instance === undefined) return false
  const at = now === undefined ? instance.clock() : now
  tick(instance, at)
  return true
}

/**
 * 只读快照（诊断用）。返回深拷贝，调用方改不坏内部状态。
 *
 * @returns `{ watched: { childId: entry }, skipped: { childId: reason }, active }`
 */
export function watchdogSnapshot() {
  try {
    const bag = state()
    const watched = {}
    for (const [childId, entry] of bag.watched) {
      watched[childId] = {
        createdAt: entry.createdAt,
        lastEventAt: entry.lastEventAt,
        silentMs: (bag.active === undefined ? Date.now() : bag.active.clock()) - entry.lastEventAt,
        generating: entry.generating === true,
        running: entry.running,
        notices: entry.notices,
        parentId: entry.parentId,
        openTools: [...entry.openTools.keys()],
      }
    }
    const skipped = {}
    for (const [childId, reason] of bag.skipped) skipped[childId] = { ...reason }
    return {
      watched,
      skipped,
      active: bag.active === undefined ? undefined : { silenceMs: bag.active.silenceMs, tickMs: bag.active.tickMs },
    }
  } catch {
    return { watched: {}, skipped: {}, active: undefined }
  }
}
