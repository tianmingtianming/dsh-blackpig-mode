/**
 * blackpig-anchor — 锚点提醒模块（设计稿 v5 定稿的机器注入实现）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 *
 * 长会话中大脑普遍忘记复用既有 worker（session-24720769，758 turn 实测：
 * 61 次失败通知后冷恢复 0 次、同 desc 多开 22 次、同参连发 x5）。
 * 人格是静态前缀，注意力随历史稀释；本模块把高频失效条款在失效概率最高的时刻
 * 以「当轮消息末尾追加」的方式重新投递。
 *
 * 三层（全部 user 侧末尾追加，绝不碰 system 节点 —— 不破坏前缀缓存）：
 *
 *   · L2 事件窗口：当轮 claimed 消息里出现**失败**结算通知（宿主
 *     `createSettlementMessage` 产物，`dsh-subagent/lib/index.js:457-484`）
 *     或限流恢复（`agent/request-error` 的瞬态失败）后，连续 5 轮固定序列
 *     R1 → artifact → R1（保证 R1 占首轮与末轮）。
 *   · L3 周期锚定：每 50 轮注入一条，R1/R2/R3 轮流各注一次不重复。
 *   · L3+ 名册最小可见化：每 5 步对账一次名册（`listDescendants` + 目录投影 join），
 *     仅在名册发生变化时注一次短名册（worker 名字 + running/inactive 状态 + 可冷恢复标记），
 *     不注 description、不每轮注。**显示策略 2026-11-19 二次修订（按 N 分档）**：
 *     N ≤ 20 全列；N > 20 只列最近 8 个（`createdAt` 倒序）+ 截断提示。
 *
 * 同轮去重：一次 pre-step 最多追加一条，优先级 L2 > L3 > L3+。
 *
 * ── 设计原则（设计稿 §5.1，用户拍板）──────────────────────────────────────────
 *
 * 本模块**不提供任何启用/禁用开关** —— 提醒模块的意义正是不指望人去记；
 * 配置面越少越可靠。`apply()` 不读 config。
 *
 * ── 失败取向 ────────────────────────────────────────────────────────────────
 *
 * 任何异常都放行原 decision、绝不打断 waterfall（与 guard 的 post-execute 同一取向）；
 * 触发判据「宁漏不误」：漏触发只少一次提醒，误触发是给正常轮次塞噪音。
 * 结算通知识别只认宿主固定句式（`Background subagent <name> …`）的失败变体；
 * 完成类结算不触发窗口。
 *
 * ── 零第三方依赖 ────────────────────────────────────────────────────────────
 *
 * 只用 node 内置模块，不 import 任何 `@deepseek-ai/*`（换版即 ERR_MODULE_NOT_FOUND，
 * 这条硬约定本包其它模块也一样）。提醒消息按宿主 `createUserMessage` 的形状
 * 手构（`dsh-llm/lib/index.js:38-65`：`deepFreeze(structuredClone({…, id}))`）。
 *
 * @module dsh-blackpig-mode/blackpig-anchor
 */

import { createHash, randomUUID } from 'node:crypto'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-anchor'

/**
 * 需要的能力：`agent/pre-step` 的 payload 自带 agent（session/turn/step 都在
 * payload 上）；`subagents` 服务与 `agents` 注册表在运行期经 `ctx.get` 现取
 * （绑死在 inject 上会把本行挂死在宿主服务的就绪时机上 —— 与 subtalk.mjs:105
 * 的同一取向：工具在、服务缺时宁可每次显式失败，也不整行 waiting）。
 */
export const inject = ['agents']

/**
 * 设计稿 §5.1 钉死的常量措辞 —— 一字不改，禁止拼接动态内容（Cline Focus Chain 教训）。
 */
const R1_TEXT =
  '新开 worker 前先查既有 worker 能否冷恢复；失败/限流后第一动作是 `send_to_subagent` 冷恢复而非重开；失败当轮必须动作，不许空转收尾。'
const R2_TEXT =
  '派出后即报即停；`wait_agent` 不能代替完成通知，`list_agents` 不当轮询用。'
const R3_TEXT =
  'brief 要答案不要全文贴回；同参数不连发、同 desc 不多开。'
const ARTIFACT_TEXT =
  '无 artifact 不许断言内容完成：字节数收据≠内容完成，「已停/已完成」必须带收据原文。'

/** L3 周期锚定：三条轮流，各注一次不重复。 */
const L3_SEQUENCE = [R1_TEXT, R2_TEXT, R3_TEXT]
/** L2 事件窗口：固定序列，5 轮内循环（R1 占首轮与末轮）。 */
const L2_SEQUENCE = [R1_TEXT, ARTIFACT_TEXT, R1_TEXT]

/** L3 锚点间隔（轮）。 */
const ANCHOR_INTERVAL_TURNS = 50
/** L2 窗口长度（轮，含触发当轮）。 */
const WINDOW_ROUNDS = 5
/** L3+ 名册对账间隔（步）。 */
const CATALOG_CHECK_EVERY_STEPS = 5
/**
 * L3+ 名册显示上限（行）。
 *
 * 2026-11-19 二次修订（用户拍板）：名册**不再固定只列 8 条**，改成按总量分档的混合制 ——
 * `N <= ROSTER_FULL_LIST_LIMIT` 全列，`N >` 该阈值只列最近 `ROSTER_MAX_LINES` 条。
 * 分档依据见 `docs/blackpig-anchor-reminder-design.md` 第十二节（session-24720769
 * 实测：注入只发生 8 次、每次 288 字符，全列的总成本远低于原先估计 —— 所以小名册
 * 不舍弃完整名单的价值；而 400+ 条时全列没有决策价值，只留最近的）。
 */
const ROSTER_MAX_LINES = 8
/** N 不超过此值 → 全部列出（不截断、不输出「另有 K 个」行）。 */
const ROSTER_FULL_LIST_LIMIT = 20
/**
 * L3+ 读目录投影时最多观察几个父会话（防树很深时把观察缓存打穿）。
 * 正常情况整棵树就是 1 个父会话（直接子会话全在一个 catalog 里）。
 */
const CATALOG_OBSERVE_LIMIT = 20

/** 注入消息的 source 归属（审计与验收判据：JSONL 里 grep 这个串）。 */
export const SOURCE_KIND = 'blackpig-anchor-reminder'

/** 装机后可供 grep 的固定标识（逐字 ASCII，不要改写）。 */
const ENGAGED = 'ANCHOR-ENGAGED'
const SKIPPED = 'ANCHOR-SKIPPED'

/**
 * 失败结算通知的判据（v1.0.9 放宽，两层）：
 *
 * 第 1 层（v1.0.8 原有）：宿主 `settlementSummary()`（`dsh-subagent/lib/index.js:433-445`）
 * 的**显式失败**变体 —— `failed before it finished` / `was stopped` / `ran out of room` /
 * `declined the task` / `ended abnormally`。
 *
 * 第 2 层（v1.0.9 新增）：completed 结算但**正文带明确失败证据**。实测依据（session-e66f6aa0）：
 * 4 条 subagent-settled 全部 stopReason=completed，其中探针子代理读不存在文件、正文含
 * `Error: cannot read "C:\__anchor_probe__\no-such-file.txt": not found`，但结算句是
 * "finished and will do no further work…" → 第 1 层全部漏判 → L2 窗口从未开启。
 *
 * ⚠️ 误报防护（这条是刻意的保守设计）：
 *   · 判据 A 要求「Error: 开头的行」——只匹配行首（正文里"某行写着 Error 示例"若出现在
 *     句中不会命中）；中文常见失败回显「命令失败」「失败（exit code: N）」也是整行/紧邻词匹配。
 *   · 判据 B 是宿主**结算通知首句**与失败词的组合——只有结算消息本体（以
 *     `Background subagent <name>` 开头）内出现 `is unavailable` 这类宿主级失败词才算，
 *     子代理转述别人错误的情况由判据 A 的行首约束兜住。
 *   · 已知残余误报面：子代理完整引用了一段以 "Error:" 开头的日志行作为**证据**回报
 *     （例如 grep 输出贴回）。这是有意接受的代价——那种情况下子代理的活确实带着
 *     失败上下文，多注一条提醒的代价（~50 token）远小于漏判（failure→新开 worker 的
 *     重放成本）；宁漏不误在这里反向为「宁多注不漏判」，由 lead 的实测数据定夺。
 */
const SETTLEMENT_FAILURE_RE =
  /^Background subagent .+?(failed before it finished|was stopped before it finished|ran out of room before it finished|declined the task|ended abnormally)/

/** 结算通知首句形态（completed/failed 都以它开头，`dsh-subagent/lib/index.js:433-434`）。 */
const SETTLEMENT_OPENING_RE = /^Background subagent .+/

/** 第 2 层：completed 结算正文里的**行首级**失败证据（`^` 配 m 标志 = 逐行行首）。 */
const EMBEDDED_FAILURE_RE = /^\s*(?:Error|ERROR)\s*[:：]/m

/** 第 2 层：宿主级失败词（只认结算消息本体的词形，不认转述）。 */
const SETTLEMENT_HOST_FAILURE_RE =
  /(?:^|\n)Background subagent [^\n]*?(?:is unavailable|cannot be resumed|not resumable)/

/** 中文环境常见失败回显（行首/紧邻形态，避免"示例中提到失败"误伤）。 */
const CN_FAILURE_LINE_RE = /(?:^|\n)\s*(?:命令失败|失败[^。\n]{0,12}exit code: [1-9]|exit code: [1-9]\d*\s*（?[^\n]*失败)/

/** 瞬态失败 code（限流/服务端/超时/传输）；quota 耗尽与结构性失败不触发窗口。 */
const TRANSIENT_FAILURE_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/**
 * 手构一条与宿主 `createUserMessage` 同形的 user 消息
 * （`dsh-llm/lib/index.js:38-43`：clone + id + freeze）。
 *
 * @param text - 已包好 `<system-reminder>` 的正文。
 */
function reminderMessage(text) {
  return Object.freeze(
    structuredClone({
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text }] },
      id: randomUUID(),
    }),
  )
}

/** 提醒正文统一包一层 `<system-reminder>`（宿主 runtime-context 的既有格式）。 */
function wrapReminder(text) {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

/**
 * 会话键：优先 `session.id`，退回 `agent.id`；两次读取各自兜错
 * （与 guard 的 keyOf 同口径 —— session 可能是 throwing getter）。
 *
 * @param agent - 目标 agent。
 * @returns {string|null} 非空键；两个标识都读不到时 null（放弃记账）。
 */
function sessionKeyOf(agent) {
  for (const read of [
    () => agent?.session?.id,
    () => agent?.id,
  ]) {
    try {
      const candidate = read()
      if (typeof candidate === 'string' && candidate !== '') return candidate
    } catch {
      // 该来源抛错，退到下一个候选。
    }
  }
  return null
}

/**
 * 会话状态（模块级 Map，按会话键记账；agent/disposed 时清理）。
 *
 * @typedef {object} AnchorState
 * @property {number} lastAnchorBucket  上次 L3 锚点触发时的 floor(turn/50)。
 * @property {number} anchorCursor      L3 轮换游标（R1/R2/R3）。
 * @property {{remaining: number, cursor: number, fresh: boolean}|null} window  L2 窗口。
 * @property {number} stepsSeen         已见过的 pre-step 步数（L3+ 对账节流）。
 * @property {string|null} catalogKey   上次名册快照 key（null = 从未对账）。
 * @property {boolean} catalogBroken    listDescendants 不可用（停试，避免 IO 空转）。
 */

/** 模块级状态表：sessionId -> AnchorState。 */
const STATES = new Map()

/** 取（或建）一个会话的状态。 */
function stateFor(sessionKey) {
  let state = STATES.get(sessionKey)
  if (state === undefined) {
    state = {
      lastAnchorBucket: 0,
      anchorCursor: 0,
      window: null,
      stepsSeen: 0,
      catalogKey: null,
      catalogBroken: false,
    }
    STATES.set(sessionKey, state)
  }
  return state
}

/** 日志 helper：logger 是不可信的（可能恒抛），任何日志失败都不影响业务。 */
function logInfo(ctx, message) {
  try {
    ctx?.logger?.info?.(`blackpig-anchor: ${message}`)
  } catch {
    // 日志通道不可用不能反过来炸掉会话。
  }
}

function logWarn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`blackpig-anchor: ${message}`)
  } catch {
    // 同上。
  }
}

/**
 * 判定一次模型请求失败是否「瞬态」（限流/服务端/超时/传输）。
 *
 * 判据：provider 给了 `Retry-After`（`failure.providerRetryAfterMs > 0`，
 * 与 `dsh-llm-retry/lib/index.js:177` 同判据）或 failure.code 命中瞬态集合。
 * quota 耗尽 / 结构性失败不触发窗口（OpenHands 分流先例）。
 * failure 的字段读取全部兜错（宿主对象可能是 frozen/带 getter）。
 *
 * @param failure - `agent/request-error` payload 里的 failure 对象。
 * @returns {boolean}
 */
function isTransientFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  try {
    const after = failure.providerRetryAfterMs
    if (typeof after === 'number' && Number.isFinite(after) && after > 0) return true
  } catch {
    // 读不到就试下一个判据。
  }
  try {
    const code = failure.code
    if (typeof code === 'string' && TRANSIENT_FAILURE_CODES.has(code)) return true
  } catch {
    // 两个判据都读不到 → 不触发。
  }
  return false
}

/**
 * 扫一轮 claimed 消息里有没有**失败**结算通知（v1.0.9 两层判据）。
 *
 * 第 1 层：结算首句是显式失败变体（v1.0.8 原有）。
 * 第 2 层：结算首句是结算形态（含 completed）但**同一块正文里**出现行首级失败证据
 * （`Error:` 行 / 宿主级失败词 / 中文失败回显）——见 SETTLEMENT_FAILURE_RE 注释的
 * 误报防护说明。
 *
 * 结算通知是投进 inbox 的 user 消息（首块文本以 `Background subagent <name> …` 开头）。
 * 自己的提醒消息（source.kind 同名）跳过；**要求判定与证据在同一块正文内**（结算消息
 * 是单块或多块文本，证据跨块不算——防止「结算 A + 早前别处失败文本 B」跨消息拼接误判）。
 *
 * @param messages - pre-step decision.messages（claimed inbox）。
 * @returns {boolean}
 */
function hasFailureSettlement(messages) {
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    try {
      if (message.source?.kind === SOURCE_KIND) continue
    } catch {
      // source 读不到就继续检查正文。
    }
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text
      // 必须先是结算通知（首句形态），否则普通用户消息里的 "Error:" 不触发。
      if (!SETTLEMENT_OPENING_RE.test(text)) continue
      // 第 1 层：显式失败变体。
      if (SETTLEMENT_FAILURE_RE.test(text)) return true
      // 第 2 层：completed 结算 + 同块内行首级失败证据。
      if (text.includes('finished')) {
        if (
          EMBEDDED_FAILURE_RE.test(text) ||
          SETTLEMENT_HOST_FAILURE_RE.test(text) ||
          CN_FAILURE_LINE_RE.test(text)
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 拉一张 `childSessionId → createdAt` 表（L3+ 排序键的唯一来源）。
 *
 * ── 为什么必须单独去投影里捞 createdAt（2026-11-19 核实）──────────────────────
 * 两个数据源各有各缺的字段，**必须 join**：
 *   · `listDescendants()` 的行**有** `activity`（'running'|'inactive'，
 *     `dsh-subagent/src/list-children.ts:124`），但**没有** `createdAt` ——
 *     它在 `:121` 显式解构掉了（`const { createdAt: _createdAt, ...identity } = entry`）。
 *   · `subagentCatalog` 投影行**有** `createdAt`（viewSchema 的 `createdAt:
 *     <mode>CatalogSchema.shape.childCreatedAt`，`src/projection-types.ts:37-45`；
 *     由 `subagentCatalogEntries()` 组装，`lib/index.js:898-908`），但**没有** `activity`
 *     （整个 viewSchema 无该字段；它是把 `subagent/catalog` 事件折叠出来的，
 *     而事件只有 version/childId/childCreatedAt/mode/label/name，`lib/index.js:934-943`）。
 * 所以「状态」只能从 listDescendants 来，「最近」只能从投影来，谁都不能替代谁。
 *
 * 读法与 `compat.mjs` 的 `readCallerChildCatalog()` 一致：`sessionQuery.observeSession(id)`
 * → `projections.values.subagentCatalog`，lease 必须 `[Symbol.dispose]()` 释放（观察缓存容量 5）。
 * 每个 id 只读一次，最多观察 OBSERVE_LIMIT 个父会话（正常树 = 1 个）。
 *
 * @param ctx - 插件上下文。
 * @param parentIds - 需要读投影的父会话 id（来自行上的 parentId）。
 * @param signal - 取消信号。
 * @returns {Map<string, number>} 只含读到 createdAt 的条目（读不到的不进表，下游标退化）。
 */
async function childCreatedAtMap(ctx, parentIds, signal) {
  const map = new Map()
  if (parentIds.length === 0) return map
  let query
  try {
    query = ctx.get('sessionQuery')
  } catch {
    return map
  }
  if (query === undefined || query === null || typeof query.observeSession !== 'function') return map
  let observed = 0
  for (const parentId of parentIds) {
    if (observed >= CATALOG_OBSERVE_LIMIT) break
    observed += 1
    let observation
    try {
      observation = await query.observeSession(parentId, { signal })
      const entries = observation?.projections?.values?.subagentCatalog
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const id = entry?.id
        if (typeof id !== 'string' || id === '') continue
        if (map.has(id)) continue
        const createdAt = entry?.createdAt
        if (typeof createdAt === 'number' && Number.isFinite(createdAt)) map.set(id, createdAt)
      }
    } catch {
      // 单个父会话投影读不到：继续下一个；整体读不到时 createdAt 表为空 → 退化排序。
      continue
    } finally {
      try {
        const dispose = observation?.[Symbol.dispose]
        if (typeof dispose === 'function') dispose.call(observation)
      } catch {
        // 释放失败不影响结果。
      }
    }
  }
  return map
}

/**
 * 把一行的状态渲染成方括号里那截文本（状态在前，模式在后）。
 *
 * 设计意图（2026-11-19 二次修订）：模型一眼要能看出「这条要不要冷恢复」。
 *   · `running`            → 直接 send 就行，**不需要**冷恢复（故不挂模式尾缀）。
 *   · `inactive/可冷恢复`   → 就是复用候选。
 *   · `inactive/不可续`     → 别拿它当复用候选（one-shot/external）。
 *   · `unknown/...`        → activity 取不到时**如实标 unknown**，绝不假装 running。
 *
 * @param worker - `{ activity, resumable }`。
 * @returns {string}
 */
function statusLabel(worker) {
  const activity = worker.activity === 'running' || worker.activity === 'inactive' ? worker.activity : 'unknown'
  if (activity === 'running') return 'running'
  return `${activity}/${worker.resumable ? '可冷恢复' : '不可续'}`
}

/**
 * 拉一次名册快照（L3+）。
 *
 * 数据源与宿主 `list_agents` 同链：`rootOf(agent)` → `listDescendants(rootId)`
 * （`dsh-subagent/lib/index.js:3152-3154`，实现 `:2471-2542`；只读、释放句柄），
 * 再用 `childCreatedAtMap()` 从目录投影 join 出 createdAt。
 *
 * ── 显示策略（2026-11-19 二次修订，按 N 分档的混合制）────────────────────────
 *   · N ≤ `ROSTER_FULL_LIST_LIMIT`(20)：**全部列出**，不截断、不输出「另有 K 个」行。
 *     依据：实测正常会话就 ~19 个，全列 605 字符（按 1.5 字符/token 的粗估 ≈400 token，
 *     按 CJK=1 + 非 CJK=4 字符/token 的细估 ≈207 token；名册行是 agent-N 这类 ASCII，
 *     真实值更接近后者），一次性、不重复，完整名单有决策价值。
 *   · N > 20：只列最近 `ROSTER_MAX_LINES`(8) 条（createdAt 倒序），
 *     并输出 `（完整名册用 list_agents；另有 K 个未列出，其中可冷恢复 J 个）`。
 *     依据：session-24720769 实测 403~415 条时，全列既无决策价值又白烧 token。
 *   · N == 0：`text = null`，**不注入**（空名册没有可提醒的内容；
 *     常驻的 L1/L3 文案已覆盖「先查名册」这一动作，注一句「名册为空」只是噪音）。
 *
 * @param ctx - 插件上下文。
 * @param agent - 当前 agent（用于定位树根）。
 * @param signal - 取消信号（透传）。
 * @returns `{ key, text }`；服务不可用/抛错返回 null（调用方置 catalogBroken 停试）。
 *   key = 名册身份串（含 id/activity/mode，见下）；text = 变化时要注入的短名册（0 worker 时为 null）。
 */
async function catalogSnapshot(ctx, agent, signal) {
  let sub
  try {
    sub = ctx.get('subagents')
  } catch {
    return null
  }
  if (sub === undefined || sub === null) return null
  if (typeof sub.listDescendants !== 'function' || typeof sub.rootOf !== 'function') return null
  let rootId
  try {
    const root = sub.rootOf(agent)
    rootId = root?.id
  } catch {
    return null
  }
  if (typeof rootId !== 'string' || rootId === '') return null
  let rows
  try {
    rows = await sub.listDescendants(rootId, signal)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null

  /** 本树全部 worker：id + 名字 + 状态 + 是否可冷恢复（mode === 'continuable'）。 */
  const workers = []
  const parentIds = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || row.kind !== 'child') continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '') continue
    // 名字优先级：`path`（含父路径，直接子会话时即 name）→ `name`（历史条目缺 path 时兜住）
    // → `id`。`name` 是 v3 目录项才有的可选字段（`lib/index.js:836-844`、`:902-906`），
    // 早期 worker（version 0/1）没有，退回 id 是**如实**显示「没名字」，不是臆造。
    const name =
      (typeof row.path === 'string' && row.path !== '' ? row.path : undefined) ??
      (typeof row.name === 'string' && row.name !== '' ? row.name : undefined) ??
      id
    workers.push({
      id,
      name,
      // activity 来自 listDescendants；读不到就是 undefined → 下游标 unknown。
      activity: typeof row.activity === 'string' ? row.activity : undefined,
      resumable: row.mode === 'continuable',
    })
    if (typeof row.parentId === 'string' && row.parentId !== '' && !parentIds.includes(row.parentId)) {
      parentIds.push(row.parentId)
    }
  }
  if (workers.length === 0) return { key: '', text: null }

  // ── 排序：createdAt 倒序（最近派出在前）──
  // createdAt 只能从目录投影 join（listDescendants 把它丢掉了，见 childCreatedAtMap 注释）。
  // 退化路径：**某一条读不到 createdAt** 时，它的键取 -Infinity（垫底），并退回按 id 升序稳定排序
  // ——只有「一行都读不到」时才会整表退化，此时全部按 id 升序（这就是原先的行为，注释留档）。
  const createdAt = await childCreatedAtMap(ctx, parentIds, signal)
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  workers.sort((a, b) => {
    const ca = createdAt.get(a.id)
    const cb = createdAt.get(b.id)
    if (ca === undefined && cb === undefined) return byId(a, b)
    const va = ca === undefined ? Number.NEGATIVE_INFINITY : ca
    const vb = cb === undefined ? Number.NEGATIVE_INFINITY : cb
    if (va !== vb) return vb - va
    return byId(a, b)
  })

  // ── 变化判据 key：**必须**含 activity ──
  // 旧 key 只有 [id, resumable]，running→inactive 时名册"没变"，于是不重注 —— 而这正是
  // 最该提醒的时刻（一个刚空出来的 worker 变成可复用候选）。key 现在把
  // [id, activity, mode] 稳定序列化后取 SHA-1：409 条名册下 key 仍只有 40 字符
  // （不用 raw JSON 是为了别让每条会话常驻一份几十 KB 的字符串）。
  const key = createHash('sha1')
    .update(JSON.stringify(workers.map((w) => [w.id, w.activity ?? null, w.resumable ? 'continuable' : 'other'])))
    .digest('hex')

  // ── 分区计数（两种档位都输出）──
  let running = 0
  let inactive = 0
  let resumable = 0
  for (const w of workers) {
    if (w.activity === 'running') running += 1
    else if (w.activity === 'inactive') inactive += 1
    // activity 两者都不是（取不到）→ 计入既不 running 也不 inactive，头部用 unknown 补出来。
    if (w.resumable) resumable += 1
  }
  const unknown = workers.length - running - inactive
  const counts =
    `running ${running} / inactive ${inactive}` +
    (unknown > 0 ? ` / unknown ${unknown}` : '') +
    ` / 可冷恢复 ${resumable} 个`

  // ── 列表：N ≤ 20 全列；N > 20 只列最近 8 条 ──
  const listed = workers.length <= ROSTER_FULL_LIST_LIMIT ? workers : workers.slice(0, ROSTER_MAX_LINES)
  const lines = listed.map((w) => `- ${w.name} [${statusLabel(w)}]`)
  const hidden = workers.length - listed.length
  if (hidden > 0) {
    let hiddenResumable = 0
    for (const w of workers.slice(listed.length)) if (w.resumable) hiddenResumable += 1
    lines.push(`（完整名册用 list_agents；另有 ${hidden} 个未列出，其中可冷恢复 ${hiddenResumable} 个）`)
  }

  const text =
    `现存 worker 名册已变化：共 ${workers.length} 个（${counts}）。\n` +
    `${lines.join('\n')}\n` +
    '续用 = send_to_subagent（agent_id 传完整 childSessionId）；新开前先确认没有可续的。'
  return { key, text }
}

/**
 * 装载锚点提醒。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param _config - 不读：无开关是设计原则（设计稿 §5.1）。
 */
export function apply(ctx, _config) {
  const warn = (message) => logWarn(ctx, message)

  /**
   * L2/L3/L3+ 的唯一注入点。
   *
   * waterfall 契约（time-context 模板，`dsh-time-context/lib/index.js:249-282`）：
   * **先 `await next()`**，再在它的 decision 上叠加；异常一律放行原 decision。
   */
  const preStepHandler = async (payload, next) => {
    const decision = await next()
    try {
      if (decision === undefined || decision === null || typeof decision !== 'object') return decision
      if (decision.kind === 'reject') return decision
      const agent = payload?.agent
      if (agent === undefined || agent === null) return decision
      const signal = payload?.signal
      if (signal !== undefined && signal !== null && signal.aborted === true) return decision
      const sessionKey = sessionKeyOf(agent)
      if (sessionKey === null) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : null
      if (messages === null) return decision
      const turn = typeof payload?.turn === 'number' ? payload.turn : 0
      const step = typeof payload?.step === 'number' ? payload.step : 0
      const state = stateFor(sessionKey)

      // ── ① L2 触发检测：当轮 claimed 消息里出现失败结算通知 → 开窗（若未开）──
      if (state.window === null && hasFailureSettlement(messages)) {
        // fresh: true = 触发当轮立即注入第 1 条（此刻正是大脑选错的高危时刻）。
        state.window = { remaining: WINDOW_ROUNDS, cursor: 0, fresh: true }
      }

      // ── ② 选本步注入内容（一次最多一条；L2 > L3）──
      let injection = null
      if (state.window !== null && state.window.remaining > 0) {
        // 窗口轮次按 turn 计：触发当轮立即注（fresh），之后只在每轮首个 step 注。
        if (state.window.fresh === true || step === 1) {
          const text = L2_SEQUENCE[state.window.cursor % L2_SEQUENCE.length]
          state.window.cursor += 1
          state.window.remaining -= 1
          state.window.fresh = false
          injection = text
          if (state.window.remaining === 0) state.window = null
        }
      } else if (step === 1 && turn > 0) {
        // ── L3 周期锚定：floor(turn/50) 递增时触发，R1/R2/R3 轮流 ──
        const bucket = Math.floor(turn / ANCHOR_INTERVAL_TURNS)
        if (bucket > state.lastAnchorBucket) {
          state.lastAnchorBucket = bucket
          injection = L3_SEQUENCE[state.anchorCursor % L3_SEQUENCE.length]
          state.anchorCursor += 1
        }
      }

      // ── ③ L3+ 名册对账（每 5 步一次；变化才注；同轮去重：上面已注则跳过）──
      if (injection === null && state.catalogBroken !== true && turn > 0) {
        state.stepsSeen += 1
        if (state.stepsSeen % CATALOG_CHECK_EVERY_STEPS === 0) {
          const roster = await catalogSnapshot(ctx, agent, signal)
          if (roster === null) {
            // 服务/投影不可用：停试，避免每 5 步一次的无效 IO。日志留痕。
            state.catalogBroken = true
            logInfo(ctx, `catalog unavailable for session ${sessionKey}; roster snapshot disabled`)
          } else if (roster.key !== state.catalogKey) {
            state.catalogKey = roster.key
            injection = roster.text
          }
        }
      }

      if (injection === null) return decision
      // 末尾追加：前缀缓存全命中，仅新增 token 参与计算。
      return { ...decision, messages: [...messages, reminderMessage(wrapReminder(injection))] }
    } catch (error) {
      // 与 guard 的 waterfall 取向一致：吞在本层、原样放行、但不静默。
      logWarn(
        ctx,
        'pre-step injection threw and was skipped: ' +
          (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
      return decision
    }
  }

  /**
   * L2 辅触发：限流恢复。
   *
   * `agent/request-error` 是宿主公开的请求恢复扩展点（`dsh-llm-retry/lib/index.js:184-187`
   * 同型）。本监听**只观察**：瞬态失败 → 开窗；然后 `return next()` 原样交还 ——
   * 重试决策完全归下游（llm-retry），绝不短路恢复链。
   * 已有活跃窗口时不重开（不因连续失败无限续期）。
   */
  const requestErrorHandler = (payload, next) => {
    try {
      if (isTransientFailure(payload?.failure)) {
        const sessionKey = sessionKeyOf(payload?.agent)
        if (sessionKey !== null) {
          const state = stateFor(sessionKey)
          if (state.window === null) {
            // fresh: false = 本轮不立即注入；之后每轮首个 step 注入，直到 5 轮。
            state.window = { remaining: WINDOW_ROUNDS, cursor: 0, fresh: false }
          }
        }
      }
    } catch {
      // 观察失败绝不影响恢复链。
    }
    return next()
  }

  /**
   * 清理：agent 离开时删掉本会话的状态条目（不删会随会话数无界增长）。
   * 参数**不解构**、全 try/catch（agent/disposed 走 ctx.serial，抛错会截断
   * 后续监听 —— guard-v10.mjs:3494 的 R14 教训）。
   */
  const disposedHandler = (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      const sessionKey = sessionKeyOf(agent)
      if (sessionKey !== null) STATES.delete(sessionKey)
      try {
        const agentId = agent?.id
        if (typeof agentId === 'string' && agentId !== '' && agentId !== sessionKey) STATES.delete(agentId)
      } catch {
        // agent.id 读不到就只删 session 键。
      }
    } catch {
      // 清理失败不影响其它监听；最坏后果是一条残留状态（内存量级极小）。
    }
  }

  // ── 注册（各自兜错：单个 hook 不存在不让整个模块哑掉，但要响）──
  let engaged = 0
  let skipped = 0
  try {
    ctx.on('agent/pre-step', preStepHandler, { prepend: true })
    engaged += 1
  } catch (error) {
    skipped += 1
    warn(`registering agent/pre-step failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    ctx.on('agent/request-error', requestErrorHandler)
    engaged += 1
  } catch (error) {
    skipped += 1
    warn(`registering agent/request-error failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    ctx.on('agent/disposed', disposedHandler)
    engaged += 1
  } catch (error) {
    skipped += 1
    warn(`registering agent/disposed failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (engaged === 0) {
    warn(`${SKIPPED} reason=no-hooks — none of the hooks could be registered; no reminder will ever be injected`)
    return
  }
  logInfo(
    ctx,
    `${ENGAGED} — anchor reminders active (L2 window=${WINDOW_ROUNDS} rounds fixed R1→artifact→R1; ` +
      `L3 every ${ANCHOR_INTERVAL_TURNS} turns rotating R1/R2/R3; ` +
      `L3+ roster snapshot every ${CATALOG_CHECK_EVERY_STEPS} steps on change); no config switches by design` +
      (skipped > 0 ? `; ${skipped} hook(s) failed to register` : ''),
  )
}

/**
 * 诊断出口：当前状态表快照（深拷贝，调用方改不坏内部记录）。
 *
 * 供 `node -e` 探针与排查使用（与 guard 的 guardInstallStatus 同一取向）。
 *
 * @returns {object} { [sessionId]: AnchorState }。
 */
export function anchorDebugState() {
  const snapshot = {}
  for (const [key, state] of STATES) {
    snapshot[key] = {
      lastAnchorBucket: state.lastAnchorBucket,
      anchorCursor: state.anchorCursor,
      window: state.window === null ? null : { ...state.window },
      stepsSeen: state.stepsSeen,
      catalogKey: state.catalogKey,
      catalogBroken: state.catalogBroken,
    }
  }
  return snapshot
}
