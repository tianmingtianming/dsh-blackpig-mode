/**
 * blackpig-file-guard — 「同一个文件只许一个工人写」的写冲突守卫（自控实现，零第三方依赖）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 *
 * 黑猪模式里，大脑把活拆开派给多个 worker（`subagent_preset` / `send_to_subagent`）。
 * 两个 worker 被派到**同一个文件**时，宿主默认行为是「后写者无条件覆盖」：
 * `dsh-tool-fs` 的 write 调 `ctx.waterfall('fs/write-intent', target, exec, () => void 0)`，
 * 没有策略时返回 `undefined`，`dsh-fs` 的注释写明 "omission allows unconditional
 * overwrite"。两人各写一遍，先写的那份**静默消失**，而且两边都回报成功 ——
 * 大脑拿到两份「已完成」的回报，却只剩一份内容。这是黑猪模式下最容易发生、
 * 又最难在日常汇报里看出来的损坏。
 *
 * 本模块把「一个文件的写权归第一个开工的 worker」变成机制：第二个 worker 的
 * write / edit / apply_patch 在该文件仍被别人持有时被**拒绝**，错误文本告诉它
 * 该去找谁、怎么继续。
 *
 * ── 为什么挂在 `fs/write-intent` 上 ────────────────────────────────────────────
 *
 * 那是宿主为「写前意图」预留的唯一 waterfall（`dsh-fs/src/index.ts:58-95`），
 * write（`dsh-tool-fs/src/write.ts:121`）、edit（`edit.ts:133`）、apply_patch
 * （`patch/plan.ts:80-92`）三条路径都在真正落盘**之前**经过它。挂在这里能一次性
 * 覆盖全部三条，且不需要碰宿主任一字节。
 *
 * ── 两条硬规矩（照抄 workspace-changes 的范式）──────────────────────────────────
 *
 * ① **判定通过时必须 `return await next()` 的原值**。`undefined` 是宿主语义里的
 *    「无条件覆盖」；我们**绝不**自己合成 `{kind:'createIfAbsent'}` 之类的 intent ——
 *    那等于给每一次写入凭空加一层 CAS，会改变所有写入的语义（并发写同一文件会
 *    突然开始报 FS_STALE_VERSION），远超本模块该管的范围。守卫只做两件事：
 *    抛 `FsError`，或把下游原值原样交回。
 *
 * ② **先判定，再 `await next()`**。与 `workspace-changes`（`{prepend:true}` +
 *    `await next()` + 原样 return）的区别只在判定时机：`waterfall` 是链式的，
 *    不调 `next()` 即截断（`cordis/src/events.ts:246-261`）；我们要在**别的监听者
 *    跑之前**把冲突拦下来，因为 `workspace-changes` 的 `capture()` 会在 next() 之后
 *    访问文件内容。拦截时 `next()` 一次都不调 —— 这是**刻意的截断**，也是 cordis
 *    允许的唯一截断方式（每层 `next()` 至多一次，调两次直接抛错）。
 *
 * ── 状态放哪 ──────────────────────────────────────────────────────────────────
 *
 * `globalThis[Symbol.for('dsh-blackpig-mode:file-claims:v1')]`，进程内、不进磁盘。
 * 用 `globalThis` 而不是模块级变量：同一个进程里 preset scope 可能 apply 多次
 * （HMR / 多个 profile 共用进程），而「这个文件现在归谁」是**全局事实**，
 * 分裂成几份互相看不见的副本就等于守卫失效。用 `Symbol.for` 而不是普通属性名：
 * 不进 JSON、不会和其他插件的键撞名。
 *
 * ── 失败取向：守卫是保险，不是单点故障 ─────────────────────────────────────────
 *
 * `fs-observation-policy` 关闭时 `fs/write-intent` 上只有 `workspace-changes` 一个
 * 监听者；本模块一旦抛错就是**最后一次拦截机会**。所以任何内部异常（取 sessionId
 * 失败、agents 服务形状不符、Map 被外部改坏）都必须**放行**：`catch` 之后照常
 * `await next()` 并把下游原值交回，同时 `ctx.logger.warn` 记一行。守卫自己做错，
 * 代价只能是「这一次没拦住」，绝不能变成「这一次谁都不许写」。
 *
 * @module blackpig-file-guard
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-file-guard'

/**
 * 不 `inject` 任何服务。
 *
 * `agents` / `subagents` 只是**可选**信息源（用来判死活、认兄弟 worker）：取不到
 * 就退化成「不知道」，绝不能因为服务没就绪而让整行 waiting —— 那会让守卫在
 * 恰好最需要它的启动阶段缺席。与 `fs-observation-policy` 一样不 inject。
 */

/** 全局状态键。`Symbol.for` 让多个副本/多个 apply 共享同一份事实。 */
const STATE_KEY = Symbol.for('dsh-blackpig-mode:file-claims:v1')

/** 错误码：被别的 worker 持有。 */
export const FS_CLAIMED_BY_PEER = 'FS_CLAIMED_BY_PEER'

/** 默认占用 TTL：10 分钟。可用环境变量覆盖（验证时要调短，见 config.ttlMs 注释）。 */
export const DEFAULT_TTL_MS = 600000

/** 环境变量名（TTL 覆盖）。 */
export const TTL_ENV = 'DSH_BLACKPIG_FILE_CLAIM_TTL_MS'

/** `gone` 表最多留几条（只供文案用，防止无限增长）。 */
const GONE_CAP = 16

/**
 * 取（或建）进程内的占用表。
 *
 * 结构固定为 `{ claims: Map<targetKey, claim>, gone: Map<targetKey, tombstone> }`；
 * 若别处留下了形状不对的同名属性，一律重建 —— 半损坏的状态比空状态更危险
 * （可能让某个文件永远被判成「有主」）。
 */
function state() {
  const bag = globalThis
  let current = bag[STATE_KEY]
  if (
    current === undefined ||
    current === null ||
    typeof current !== 'object' ||
    !(current.claims instanceof Map) ||
    !(current.gone instanceof Map)
  ) {
    current = { claims: new Map(), gone: new Map() }
    bag[STATE_KEY] = current
  }
  return current
}

/**
 * 读一个 agent 的 sessionId（`actor.agent?.session?.id`，兜 `agent.id`）。
 *
 * 两次读取各自兜错：`session` 可能已被拆掉、`id` 可能是 throwing getter
 * （见 guard-v10.mjs `keyOf` 的同款教训）。取不到返回 `undefined` ——
 * 调用方必须容忍「没有 sessionId」（非 agent 上下文的直接调用）。
 */
function sessionIdOf(actor) {
  try {
    const agent = actor?.agent
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

/**
 * 读一个 agent 的显示名（派活时的 `description`）。
 *
 * `dsh-subagent` 把 `subagent_preset` 的 `description` 作为 `label` 冻进子会话的
 * `subagent/descriptor`（`dsh-tool-subagent/lib/index.js:470`），宿主自己的
 * `describe()` 也是从这个投影取 label 的。这里按同样路径读、全程兜错：
 * label 只是**给人看的补充信息**，读不到就退到 id 前缀，绝不因此影响判定。
 */
function labelOf(agent) {
  try {
    const projections = agent?.ctx?.get?.('sessionProjections')
    const projection = projections?.get?.('subagentIdentity')
    const state = projection?.stateOf?.(agent?.session)
    const label = state?.identity?.label
    if (typeof label === 'string' && label !== '') return label
  } catch {
    // 读不到就是没有：下面退到 id 前缀。
  }
  return undefined
}

/**
 * 四要素里的「持有者身份」。
 *
 * 有 label 给 label（人一眼认得）；没有就给完整 childSessionId —— 文案里的
 * `childSessionId=<全文>` 可原样粘进 `send_to_subagent` 的 `agent_id`，
 * 绝不是被截断的半个 id（截断的 id 不可复原、不可执行，等于没给）。
 */
function ownerIdentity(claim) {
  if (typeof claim.ownerLabel === 'string' && claim.ownerLabel !== '') return `"${claim.ownerLabel}"`
  return `childSessionId=${claim.ownerSessionId}`
}

/** 相对秒数（文案要素 c）。 */
function heldSeconds(claim, now) {
  const ms = Math.max(0, now - claim.at)
  return Math.round(ms / 100) / 10
}

/**
 * 组装拒绝文案（中文 —— 与包内现有对外文案语言一致：
 * `subtalk.mjs` 的模型可见错误是英文短句，但给人看的说明性文案一律中文，
 * 且中文版把「下一步怎么做」说全；此处是**给模型看的操作指令**，用中文）。
 *
 * 四要素缺一不可：
 *   (a) displayPath        —— 到底是哪个文件
 *   (b) 持有者身份          —— label 或可复原的 childSessionId
 *   (c) 持有起始时间（相对秒）
 *   (d) 具体可执行的下一步    —— 用 send_to_subagent 交给同一个 worker；或等它结束
 */
function refusalMessage(target, claim, now) {
  const displayPath = target?.displayPath ?? target?.targetKey ?? '<unknown>'
  const seconds = heldSeconds(claim, now)
  return (
    `cannot write "${displayPath}": file is claimed by another worker ` +
    `(${ownerIdentity(claim)}, holding for ${seconds}s). ` +
    `这个文件已被另一个 worker 占用：不要另派工人写同一文件，也不要覆盖它。` +
    `下一步二选一：① 用 send_to_subagent 把这次修改交给同一个 worker` +
    `（agent_id=${claim.ownerSessionId}）；② 等它结束后重试本次写入。`
  )
}

/** 放行：`await next()` 一次，原样交回下游值。任何情况下都不丢下游的 intent。 */
async function pass(next) {
  return await next()
}

/**
 * 判断一个 claim 是否已死（R3-prune）。
 *
 * ⚠️ 三态，不是两态：`agents` 服务**取不到 ≠ 已死**。取不到时返回 `'unknown'`
 * 并且**跳过释放** —— 否则守卫在服务未就绪的窗口里会把自己见过的所有占用全清掉，
 * 正好在最需要它的时刻失效。
 */
function livenessOf(ctx, ownerSessionId) {
  let agents
  try {
    agents = ctx.get?.('agents')
  } catch {
    return 'unknown'
  }
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return 'unknown'
  let live
  try {
    live = agents.get(ownerSessionId)
  } catch {
    return 'unknown'
  }
  return live === undefined || live === null ? 'dead' : 'alive'
}

/**
 * 释放一个 targetKey 的占用。
 *
 * 同时写一条 `gone` 记录（最多 16 条）：持有者结束后，文案里仍能说「刚才是谁
 * 写的」，模型重试时不会一脸茫然（这是 R3 的副产品，只供文案，不参与判定）。
 */
function release(stateBag, targetKey) {
  const claim = stateBag.claims.get(targetKey)
  stateBag.claims.delete(targetKey)
  if (claim !== undefined) {
    stateBag.gone.delete(targetKey)
    stateBag.gone.set(targetKey, { ownerSessionId: claim.ownerSessionId, at: Date.now() })
    while (stateBag.gone.size > GONE_CAP) {
      const oldest = stateBag.gone.keys().next()
      if (oldest.done === true) break
      stateBag.gone.delete(oldest.value)
    }
  }
}

/** 释放某个 session 持有的**全部**占用（R3-agent-disposed）。 */
function releaseAll(stateBag, ownerSessionId) {
  for (const [targetKey, claim] of [...stateBag.claims]) {
    if (claim.ownerSessionId === ownerSessionId) release(stateBag, targetKey)
  }
}

/** 解析 TTL：config 优先，其次环境变量，最后默认值。非法值一律回落（不因配置打错而抛）。 */
function resolveTtl(config) {
  const fromConfig = config?.ttlMs
  if (Number.isInteger(fromConfig) && fromConfig > 0) return fromConfig
  let raw
  try {
    raw = process.env?.[TTL_ENV]
  } catch {
    raw = undefined
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return DEFAULT_TTL_MS
}

/**
 * 当前调用方是否「确认存在兄弟 worker」（R5 的输入）。
 *
 * 只用宿主公开的 `agents.list()`（`dsh-agent/lib/index.js:727`）+ 每个 agent 的
 * `status`：除自己以外还有 `status === 'running'` 的 agent ⇒ 有兄弟。
 * 与 `dsh-subagent` 自己的 `runningDescendants`（`lib/index.js:515`）同一口径。
 *
 * 「取不到」返回 `'unknown'`，由调用方按 R5 选定的口径处理。
 */
function hasRunningPeer(ctx, selfSessionId) {
  let agents
  try {
    agents = ctx.get?.('agents')
  } catch {
    return 'unknown'
  }
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return 'unknown'
  let list
  try {
    list = agents.list()
  } catch {
    return 'unknown'
  }
  if (!Array.isArray(list)) return 'unknown'
  const peers = list.filter((agent) => agent !== undefined && agent !== null && agent.id !== selfSessionId)
  return peers.some((agent) => agent.status === 'running')
}

/**
 * 核心判定。**只做判定**，不做 I/O、不调用 next()；抛错即拒绝，正常返回即放行。
 *
 * 规则（每条都在这里实现，编号与需求一致）：
 *
 *  R4 自己放行 —— owner === 自己 ⇒ 刷新 `at` 后放行。续写自己的活不许锁死自己。
 *     刷新而不重置：TTL 是「这个人还活着」的兜底，一直刷新等于把兜底变成永不过期；
 *     但同一 worker 连续写同一文件本来就该续命，所以刷新（不是新建）是对的。
 *
 *  R2 拒绝    —— 有主 && owner ≠ 自己 && owner 仍存活 ⇒ throw FS_CLAIMED_BY_PEER。
 *     「仍存活」的判据是 R3 三路释放之后还剩下什么：prune 过、TTL 过、disposed
 *     过都已在前面被清掉，走到这里还在的表项就是活的。
 *
 *  R1 占用    —— 无主 ⇒ 登记当前 sessionId 与 label，放行。
 *
 *  R5 单人零登记（设计判断点，**选 A，总是登记、总是拒绝**）：
 *     理由 —— ① 判据可判：不需要依赖 `agents` 服务是否可用、`status` 字段是否
 *     存在，代码路径只有一条；② 不引入 false-negative：两个 worker「同时起步」
 *     时，谁都可能先被调用而彼时对方尚未 `running`，B 分支下双方都看到「没有
 *     兄弟」⇒ 双方都放行 ⇒ 守卫在最典型的撞车场景里恰好失效；③ 自锁死风险
 *     已被 R4 消掉（自己重入永远放行），单人残留的占用只可能由**别人**撞上，
 *     而单人不该有别人的写入；④ 残留必被清：`agent/disposed`（会话结束）与
 *     TTL（600 s 默认）两道，另有 liveness prune 兜底。
 *
 * 任何「拿不到 sessionId」的调用（非 agent 上下文）一律**放行**且不登记：
 * 没有身份就没有归属，登记一个不知属于谁的占用只会误拒后来者。
 */
function decide(ctx, stateBag, ttlMs, target, actor, now) {
  const targetKey = target?.targetKey
  if (typeof targetKey !== 'string' || targetKey === '') return // 放行：没有权威 key 就无法归属

  // ── R3-prune：先把已死的持有者清掉 ──
  for (const [key, claim] of [...stateBag.claims]) {
    if (now - claim.at >= ttlMs) {
      // TTL 兜底：持有者可能已崩、disposed 没到、agents 也查不到。
      release(stateBag, key)
      continue
    }
    if (livenessOf(ctx, claim.ownerSessionId) === 'dead') release(stateBag, key)
  }

  const selfId = sessionIdOf(actor)
  const existing = stateBag.claims.get(targetKey)

  if (existing !== undefined) {
    if (selfId !== undefined && existing.ownerSessionId === selfId) {
      // R4：自己续写自己的文件 —— 刷新时间后放行。
      existing.at = now
      return
    }
    // R2：别人持有且仍存活 —— 拒绝。文案四要素齐全。
    throw new FsError(refusalMessage(target, existing, now), FS_CLAIMED_BY_PEER)
  }

  // R1 / R5：无主 ⇒ 登记（R5 选 A：不因为「看起来是单人」就不登记、不因为单人而放宽）。
  if (selfId === undefined) return // 没有身份 ⇒ 无主可登记，放行（也永不拒绝）

  // 记下兄弟判定结果，只用于日志诊断（R5-A 下它**不改变**判定结果）。
  const peer = hasRunningPeer(ctx, selfId)
  stateBag.claims.set(targetKey, {
    ownerSessionId: selfId,
    ownerLabel: labelOf(actor?.agent),
    displayPath: target?.displayPath,
    at: now,
    ttlMs,
    // 诊断字段（只读，不参与判定）：登记当刻是否观察到其他 running agent。
    registeredWithRunningPeer: peer,
  })
}

/**
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行的 `config`（只认 `{ enabled, ttlMs }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`blackpig-file-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉写入语义（同 guard-v10 的 logError 取向）。
    }
  }

  const ttlMs = resolveTtl(config)

  // ── R3 路径一：agent 离开时释放它持有的全部占用 ──
  // `agent/disposed` 是 emit（不是 serial），监听器抛错只被宿主 warn 掉
  // （`dsh-agent/lib/index.js:673-686`），不会传染；这里仍整体包 try，
  // 因为 disposed 时 `session` 可能已被拆掉、我们的读路径必须容忍。
  // 注：黑猪的 `guard-v10.mjs:3406` 也监听同一事件，但管的是**它自己的**
  // GUARD_INSTALL_STATUS 表；本模块的占用表是另一份状态（globalThis 上的
  // Symbol 键），不能被它清掉，所以必须自己注册一份（不是重复注册同一份）。
  try {
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload?.agent
        const id = sessionIdOf({ agent })
        if (id === undefined) return
        releaseAll(state(), id)
      } catch (error) {
        warn(
          'releasing claims of a disposed agent threw — a stale claim may outlive the session. ' +
            'Underlying error: ' + (error instanceof Error ? error.message : String(error)),
        )
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/disposed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ── 三条写入口：write / edit / apply_patch 都经过各自的 intent waterfall ──
  // delete-intent 不挂：删除不是「覆盖冲突」这种损坏，且宿主对 delete 的语义
  // （整个文件消失）本来就该由调用方自己担责。
  const WATERFALLS = ['fs/write-intent', 'fs/edit-intent']

  for (const event of WATERFALLS) {
    try {
      ctx.on(
        event,
        async (target, actor, next) => {
          // ── 独立 try/catch：守卫自己出错 ⇒ 放行，绝不当单点故障 ──
          try {
            const now = Date.now()
            decide(ctx, state(), ttlMs, target, actor, now)
          } catch (error) {
            // 拒绝必须原样抛出（那是本模块唯一的产出）；其余异常一律放行。
            if (error instanceof FsError && error.code === FS_CLAIMED_BY_PEER) throw error
            try {
              warn(
                `${event} guard threw; allowing the write through. ` +
                  'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
              )
            } catch {
              // 连 warn 都炸：仍然放行。
            }
          }
          return await pass(next)
        },
        { prepend: true },
      )
    } catch (error) {
      warn(`could not subscribe to ${event}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 诊断出口（供离线验证脚本/日志读，不改判定）──
  try {
    ctx.effect(
      () => () => {
        // HMR / scope 卸载：清掉本进程的表，避免半旧的占用跨世代存活。
        try {
          state().claims.clear()
          state().gone.clear()
        } catch {
          // 清理失败不影响卸载。
        }
      },
      'blackpig-file-guard claim teardown',
    )
  } catch {
    // effect 不可用时不清理（进程退出即消失）。
  }
}

/**
 * 只读快照（诊断用）。返回深拷贝，调用方改不坏内部状态。
 *
 * @returns 当前占用与最近释放记录。
 */
export function fileClaimSnapshot() {
  try {
    const bag = state()
    const claims = {}
    for (const [key, claim] of bag.claims) claims[key] = { ...claim }
    const gone = {}
    for (const [key, entry] of bag.gone) gone[key] = { ...entry }
    return { claims, gone }
  } catch {
    return { claims: {}, gone: {} }
  }
}
