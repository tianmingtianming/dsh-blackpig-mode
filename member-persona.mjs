/**
 * blackpig-member-persona — 给「大脑模式」的队友换回干活的人格。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 子会话（队友 / 普通代理）会**继承父级那一份 preset**，因此也继承大脑的
 * 人格段落（「你不能写文件、不能跑命令，只能派活」）。那条人格对大脑是对的，
 * 对队友是**致命的误导**：它会让队友自我审查，明明有 write/pwsh 也不敢用。
 *
 * 所以本模块在**子会话自己的 scope** 上注册一份同名段落
 * （`deployment:persona-prefix`）把它盖掉。段落按 scope 层叠，子 scope 的更近，
 * 因此后者胜出 —— 这正是上游 `dsh-persona` 自己的覆盖机制。
 *
 * ── 为什么只能自己做，不能配在委派行上 ──────────────────────────────────────
 *
 * DSH 0.2.1-rc.2 删掉了 `dsh-tool-subagent` 的 `persona` 与 `toolFilter` 两个配置项，
 * 而且**配置里只要出现就抛错、整个 preset 挂载失败**（模式会从选择器里消失）。
 * 所以人格只能由插件自己按 agent scope 注册。
 *
 * ── 为什么按「是不是子会话」判，而不是按 provider 名 ────────────────────────
 *
 * 大脑模式只有一条委派路径（Agent Teams 的 `spawn_teammate`），它的 provider 是
 * `spawn`；这条路径创建的子会话 header 一定带 `parentSession`/`delegationDepth`。
 * 直接判「是不是子会话」比读 descriptor 的 provider 名更稳：不依赖未文档化的
 * `subagent/descriptor` 事件格式。
 *
 * @module blackpig-member-persona
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-member-persona'

/** 人格段落的固定名字（与上游 `dsh-persona` 一致，同名才能覆盖）。 */
const PERSONA_SECTION_NAME = 'deployment:persona-prefix'

/** 段落排序键（与上游一致；取不到就退到 0）。 */
const PERSONA_ORDER_KEY = 'DEPLOYMENT_PERSONA_PREFIX'

/** 一个每次进程只警告一次的记录器。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`blackpig-member-persona: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子会话。
 * fork（`isSeeded: true` 且有 parentSession）**不算**子会话：它的 parentSession 是历史来源。
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
 * 装载本模块：给每个子会话换上干活的人格。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, text }`（人格文本由 composition 通过 config 传入）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  /** 本模块负责的 preset id。覆盖时用它判断"这个子会话是不是继承自我的"。 */
  const selfPresetId =
    typeof config?.presetId === 'string' && config.presetId !== '' ? config.presetId : 'blackpigmodel'

  /**
   * 读一个子会话**实际所属**的 preset id。
   *
   * 先要活绑定（`agentPresets.composedPreset(agent.ctx)`），读不到才退回 session header
   * 里创建时记下的值。读不到就返回 `undefined` —— 调用方据此**不覆盖**（宁可少改写一次，
   * 也不要把别人的人格改错）。
   *
   * @param agent - 目标 agent。
   * @returns preset id，或 undefined。
   */
  const ownerPresetIdOf = (agent) => {
    const agentCtx = agent?.ctx
    for (const carrier of [agentCtx, ctx]) {
      if (carrier === undefined || carrier === null) continue
      try {
        const registry = carrier?.get?.('agentPresets')
        if (registry === undefined || registry === null) continue
        if (typeof registry.composedPreset !== 'function') continue
        const live = registry.composedPreset(agentCtx)
        if (typeof live === 'string' && live.trim() !== '') return live.trim()
      } catch {
        // 换下一个来源。
      }
    }
    const fromHeader = agent?.session?.header?.agentPreset
    return typeof fromHeader === 'string' && fromHeader.trim() !== '' ? fromHeader.trim() : undefined
  }

  const warn = warnOnceFactory(ctx)

  const text = typeof config?.text === 'string' && config.text !== '' ? config.text : undefined
  if (text === undefined) {
    warn('no persona text was supplied; members keep the coordinator persona (set config.text)')
    return
  }

  /**
   * 每个 agent 的尝试账本。用 WeakMap：agent 回收后不该由本模块持有强引用。
   *
   * 去重仍然是必需的 —— `agent/created` 在启动 / 恢复路径上可能对同一个 agent
   * 触发两次，而同一 scope 里注册**同名** section 会被服务直接拒绝。
   *
   * ⚠️ 但账本必须记「**已经装成功**」，不能记「我试过了」。
   * 旧实现在拿 service **之前**就 `handled.add(agent)`，于是任何一次瞬时失败
   * （service 还没就绪、`getSectionOrder` 抛错、section() 抛错）都被永久记账，
   * 这个 agent 从此再也没有第二次机会 —— 而「晚一点再装」本来是完全可行的。
   * 现在只在 section 真正装上之后才记账，失败路径允许**有限次重试**。
   */
  const attempts = new WeakMap()

  /** 最多重试多少次（含第一次）。超过就放弃并**明确记一条日志**，不再静默。 */
  const MAX_ATTEMPTS = 5

  /**
   * 取这一层 scope 的 `systemPrompt` 服务。
   *
   * ⚠️ 两次取用**分开 try**。旧实现把 direct 与 `ctx.get` 包在同一个 try 里，
   * direct 取值抛错会连 fallback 一起绕过 —— 意图是「direct 没有就 fallback」，
   * 而不是「direct 抛错就整个放弃」。
   *
   * @param agent - 子会话 agent。
   * @returns `{ service }` 或 `{ failure }`（failure 是给人看的短句）。
   */
  const resolveService = (agent) => {
    let directOk = false
    let direct
    try {
      direct = agent?.ctx?.systemPrompt
      directOk = direct !== undefined && direct !== null
    } catch {
      directOk = false
    }
    if (directOk) return { service: direct }

    // direct 不可用（缺失**或**取值抛错）时才走 fallback，两个失败互不牵连。
    try {
      const viaGet = agent?.ctx?.get?.('systemPrompt')
      if (viaGet !== undefined && viaGet !== null) return { service: viaGet }
      return { failure: 'neither agent.ctx.systemPrompt nor ctx.get("systemPrompt") yielded a service' }
    } catch (error) {
      return { failure: `ctx.get("systemPrompt") threw: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const install = (agent) => {
    if (agent === undefined || agent === null) return

    // 硬前置：绝不作用于大脑自己（否则会改写大脑的人格，语义当场被反转）。
    if (!isDelegatedChild(agent)) return

    // ⚠️⚠️ 只覆盖**继承了本 preset** 的子会话，别动别人家模式的后代。
    //
    // 为什么必须有这道判断（2026-10-31 修，理由与具体项目无关）：
    //   `subagent_preset` 可以派给**任何别的 preset**（由部署自己安装，本模块不感知
    //   具体有哪些）。那些子会话有自己的、更专门的 persona（例如某个专用模式会声明
    //   "You are a <某种> worker…"）。而本模块原先只判「是不是子会话」，于是那些
    //   专用模式的会话也会被改写成「黑猪团队的队友」—— 它们不再知道自己该做什么。
    //
    //   换句话说：**判据必须是「归属」而不是「形态」**。这个错与部署装了什么模式无关，
    //   任何装了第二个模式的部署都会踩到。
    //
    // 判据用**活绑定优先、header 兜底**（与 guard 的 ownerPresetId 同源）：
    //   · `spawn_teammate` / `subagent_fork` 继承父 preset → agentPreset === 本 preset → 覆盖
    //   · `subagent_preset` 指定了别的 preset → agentPreset === 别人的 → 放过
    //
    // ⚠️ 「读不到归属」与「归属是别人家」是两件事，必须分开处理：
    //   后者是本模块**故意**放过（别人的模式有自己的 worker 人格，见上面那段），
    //   前者是**读不出来**（活绑定与 header 都为空）—— 这种情况下本模块静默 return，
    //   子会话就继续带着「你不能写文件、不能跑命令」的大脑人格去干活，
    //   而这正是本模块存在的理由。之前的写法两者共用一条 return、零诊断，
    //   于是「人格没被改写」这个最该被发现的故障，恰恰一声不响。
    //   所以：只给 `undefined` 补一条 warnOnce（只告警，判断结果不变 —— 读不到归属时
    //   仍然不覆盖，宁可少改写一次，也不要把别人的人格改错；见 ownerPresetIdOf 的注释）。
    const ownerPresetId = ownerPresetIdOf(agent)
    if (ownerPresetId === undefined) {
      warn(
        'cannot read this delegated child\'s preset ownership (neither the live binding nor the session header ' +
          'yielded a preset id), so its persona is NOT being overwritten and it keeps the coordinator persona ' +
          '— which tells it it cannot write files or run commands; it will look like a worker that refuses to work',
      )
      return
    }
    if (ownerPresetId !== selfPresetId) return

    const record = attempts.get(agent)
    // 已经装成功 → 不重复装（同名 section 会被服务拒绝）。
    if (record?.installed === true) return

    const attempt = (record?.count ?? 0) + 1
    if (attempt > MAX_ATTEMPTS) return

    const resolved = resolveService(agent)
    if (resolved.service === undefined) {
      attempts.set(agent, { installed: false, count: attempt })
      warn(
        `a member scope exposes no systemPrompt service (${resolved.failure}); it keeps the coordinator persona ` +
          `— retry ${attempt}/${MAX_ATTEMPTS}`,
      )
      return
    }
    const service = resolved.service
    if (typeof service.section !== 'function') {
      attempts.set(agent, { installed: false, count: attempt })
      warn(
        `a member scope's systemPrompt has no section() method; it keeps the coordinator persona ` +
          `— retry ${attempt}/${MAX_ATTEMPTS}`,
      )
      return
    }

    // ── 装 section 与写日志**分两个 try**（B5）──
    //
    // 旧实现把 `service.section(...)` 与 `ctx.logger?.info?.(...)` 放在同一个 try 里：
    // logger 抛错就会走 catch，打出「installing a member persona was declined」，
    // 而人格其实已经装成功了 —— 日志把一次成功报成了失败。
    // 现在的规则：**日志永远不能改变业务结论**。
    try {
      const order = typeof service.getSectionOrder === 'function' ? service.getSectionOrder(PERSONA_ORDER_KEY) : 0
      service.section({
        name: PERSONA_SECTION_NAME,
        order: Number.isFinite(order) ? order : 0,
        text,
      })
    } catch (error) {
      attempts.set(agent, { installed: false, count: attempt })
      warn(
        `installing a member persona was declined: ${error instanceof Error ? error.message : String(error)} — ` +
          `that member keeps the coordinator persona (retry ${attempt}/${MAX_ATTEMPTS})`,
      )
      return
    }

    // 装成功了：此刻才记账。之后再触发也不重复装。
    attempts.set(agent, { installed: true, count: attempt })

    try {
      ctx.logger?.info?.('blackpig-member-persona: installed the member persona for a delegated child [MEMBER-PERSONA-ENGAGED]')
    } catch {
      // ⚠️ 日志失败**不得**冒到上面那一层，更不得把已装好的结论翻成「被拒绝」。
      // 也不能在这里再调 warn()（那个通道同样可能抛），所以只静默吞咽。
    }
    if (attempt > 1) {
      warn(`the member persona for a delegated child installed on attempt ${attempt}/${MAX_ATTEMPTS} (earlier attempts failed)`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })

  // ⚠️ 重试必须挂在**会重复触发**的事件上，而且**必须正确透传 waterfall**。
  //
  // 只有 `agent/created` 的话，"失败后允许重试"是空承诺：这个事件对一个 agent
  // 只发一次，第一次取不到 systemPrompt 服务就再也没有下一次了 —— 行为与修复前的
  // 「一次失败永久放弃」完全等价，只是日志多了一句 retry n/5。
  // （Lead 复验实测：连发 5 次 agent/created 是假象；真实宿主只发 1 次。）
  //
  // `agent/pre-step` 每步都会来，且先于本轮 prompt 组装，所以在这里补装仍赶得上当前请求。
  // ⚠️ 它是 **waterfall**：必须 `return next()`。不调 next() 会截断整条链 ——
  // 那会让本轮 pre-step 的其它监听器（预算重置、上下文注入）全部被跳过。
  // 已装成功的 agent 由 `record.installed === true` 短路，不产生额外开销。
  const retryPending = (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    const record = attempts.get(agent)
    if (record?.installed === true) return
    install(agent)
  }
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      retryPending(payload)
    } catch (error) {
      // 补装失败绝不能打断 agent 的主循环。
      warn(`retrying a member persona threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 防御：万一这条事件在别处被当作普通 emit 调用（不带 next），也不能抛。
    return typeof next === 'function' ? next() : undefined
  })
  // 不再挂 `tools/post-execute`：它是 waterfall，且是本模块**不需要**参与的链路
  // （spill / 结果裁剪 / 重复提醒都在那条链上，多一个监听器就多一次短路风险）。
  // pre-step 的频次已经足够覆盖"创建时失败、下一轮补上"这个场景。

  // 启动 / 恢复路径：本插件可能晚于已有 agent 装载，补一次。
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
      for (const agent of agents.list()) install(agent)
    }
  } catch {
    // 取不到不是致命错误。
  }
}
