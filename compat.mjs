/**
 * blackpig-compat — 委派控制接口（subagent control API）的版本兼容层。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 宿主把「跟一个已派出的代理说话」拆成了两层：
 *   · 工具层：send_message / interrupt_agent / list_agents（模型看见的 schema）
 *   · 服务层：ctx.subagents.sendMessage(sender, targetId, content, { signal })
 *
 * 这两层的入参在两代宿主之间同时变了，而且变的是不同的事：
 *
 *   当前 rc.1（已由安装包实物核实）：
 *     send_message / interrupt_agent 入参 = agent_id（会话 id）
 *     list_agents 入参 { scope: 'children' | 'descendants' }
 *     返回项 { kind: 'child' | 'diagnostic', id, label, status, parent?, depth? }
 *     SUBAGENT_CATALOG_VERSION = 0
 *
 *   master（未发版，预计 rc.2）：
 *     send_message / interrupt_agent 入参 = agent（名字，走 ctx.subagents.resolveName()）
 *     list_agents 入参 {}，总是列整棵树
 *     返回项 { name, status, description } —— 没有 id、没有 kind
 *     wait_agent 工具（timeout_ms 10000–3600000，默认 30000，输出 { timedOut } |
 *       noProgress{ reason, message }（无活跃队友时立即返回））
 *     SUBAGENT_CATALOG_VERSION = 3（v3 加了 name）
 *
 * 注意：上面两代 list_agents 的返回项只是宿主事实；本模块不消费这些返回行，
 * 也不做任何返回行状态归一化或可信度标记。它只探测控制 API 的形状
 * （detectControlApi 主判据：send_message 的 schema 里有无 agent 键），
 * 并把目标解析成可调用的 id。
 *
 * ── 设计原则 ──────────────────────────────────────────────────────────────────
 *
 * 1. 只有一个归一化点。所有判别与字段映射都只在本文件里写一次，调用点
 *    （subtalk.mjs 的 send_to_subagent / stop_subagent）只调这里的函数，
 *    不在各自的地方再判一遍版本 —— 两套判据必然漂移。
 *
 * 2. 探测失败不静默。判别不出来时按旧版走（旧版是当前已发布、已验证的那一套），
 *    但必须记一条 warn 说明「为什么判不出来」。绝不无声假设。
 *
 * 3. 不深引宿主内部模块。本包要发布给别人用，不能 import
 *    '@deepseek-ai/dsh-subagent/catalog' 之类的内部子路径（换版即 ERR_MODULE_NOT_FOUND）。
 *    SUBAGENT_CATALOG_VERSION 只做「能拿到就用」的辅助判据，拿不到就明说拿不到。
 *
 * @module blackpig-compat
 */

/** 旧版控制接口：入参是 agent_id（会话 id）。 */
export const CONTROL_API_OLD = 'old'

/** 新版控制接口：入参是 agent（名字，经 resolveName 解析）。 */
export const CONTROL_API_NEW = 'new'

/** 目标既不是已知 id、也无法按名字解析时抛出的错误名（便于调用方分类）。 */
export const UNRESOLVED_TARGET = 'BLACKPIG_UNRESOLVED_TARGET'

/**
 * 记一条 warn 级日志（同样带 console 兜底）。
 *
 * @param logger - 期望是 ctx.logger（可缺省）。
 * @param message - 完整消息。
 */
function emitWarn(logger, message) {
  try {
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
      logger.warn(message)
      return
    }
  } catch {
    // 落到 console。
  }
  try {
    console.warn(message)
  } catch {
    // 不允许抛。
  }
}

/**
 * 判别 parameters 是不是标准 JSON Schema 形状。
 *
 * 标准形状 = 带 `properties` 对象，或显式声明了 `type` 的 schema；
 * 其余一律按「摊平形状」（直接是属性表）处理。判别只看结构，不看 agent /
 * agent_id 是否存在 —— 摊平表里没有这两个键也是完整合法的参数表。
 *
 * @param parameters - 工具定义里的 parameters（可能 undefined）。
 * @returns {boolean}
 */
function isStandardParametersShape(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== 'object') return false
  const direct = parameters.properties
  if (direct !== undefined && direct !== null && typeof direct === 'object') return true
  return parameters.type === 'object'
}

/**
 * 从工具定义里取 parameters.properties（两种形状都吃）。
 *
 * 为什么两种都要吃：宿主 defineTool() 会把 author-facing 的
 * parameters: { agent_id: {...} } 编译成标准 JSON Schema
 * { type: 'object', properties: { agent_id: {...} }, required: [...] }；
 * 但也有实现直接把 properties 摊平在 parameters 上。标准形状直接读
 * `properties`；摊平形状 parameters 自己就是 property-map（即使里面没有
 * agent / agent_id 也算）。形状判别交给 isStandardParametersShape()，只认结构。
 *
 * @param definition - 工具定义（可能 undefined）。
 * @returns properties 对象或 undefined。
 */
function propertiesOfParameters(parameters) {
  if (parameters === undefined || parameters === null || typeof parameters !== 'object') return undefined
  if (isStandardParametersShape(parameters)) {
    const direct = parameters.properties
    return direct !== undefined && direct !== null && typeof direct === 'object' ? direct : {}
  }
  // 摊平形状：parameters 自己就是 property-map；`required` 是 schema 元数据，不是属性。
  return parameters
}

/**
 * 从一份**工具定义**里取 parameters.properties。
 *
 * 注意与 propertiesOfParameters() 的分工：那个吃的是 parameters 本身，这个吃的是
 * { parameters } 这层壳。两处都写成同一个函数会静默返回 undefined
 * （definition.parameters.properties 不存在），于是补出来的 schema 丢掉所有原属性 ——
 * 2026-11-06 的实现里正是踩了这一脚，由单元测试抓出。
 *
 * @param definition - 工具定义（可能 undefined）。
 * @returns properties 对象或 undefined。
 */
function parametersPropertiesOf(definition) {
  return propertiesOfParameters(definition?.parameters)
}

/**
 * 尽力读 SUBAGENT_CATALOG_VERSION（辅助判据，读不到就返回 undefined）。
 *
 * 刻意不 import '@deepseek-ai/dsh-subagent/catalog'：本包是发布件，深引宿主
 * 内部子路径会在换版时直接 ERR_MODULE_NOT_FOUND，那比「判不出来」更糟。
 * 这里只在几个已经拿在手上的对象上找，找不到就老实返回 undefined，
 * 由 detectControlApi 记 warn。
 *
 * @param ctx - 插件上下文。
 * @param override - 调用方明确知道版本时的覆盖值（优先）。
 * @returns {number|undefined} 版本号。
 */
export function readCatalogVersion(ctx, override) {
  if (typeof override === 'number' && Number.isFinite(override)) return override
  // 每个探针记住「它是不是一个明确的 catalog 句柄」：泛名 `version` 只在这个句柄上采信。
  const probes = []
  const pushProbe = (probe, explicitCatalogHandle) => {
    if (probe === undefined || probe === null) return
    probes.push({ probe, explicitCatalogHandle: explicitCatalogHandle === true })
  }
  try {
    pushProbe(ctx?.subagents, false)
  } catch {
    // 忽略：取不到就算了。
  }
  try {
    pushProbe(ctx?.get?.('subagents'), false)
  } catch {
    // 忽略。
  }
  try {
    pushProbe(ctx?.get?.('subagentCatalog'), true)
  } catch {
    // 忽略。
  }

  // 只读**自有属性**：继承来的同名属性不是这个对象对 catalog 版本的声明。
  const ownVersion = (probe, key) => {
    try {
      if (!Object.hasOwn(probe, key)) return undefined
      const value = probe[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  for (const { probe, explicitCatalogHandle } of probes) {
    if (typeof probe !== 'object' && typeof probe !== 'function') continue
    for (const key of ['SUBAGENT_CATALOG_VERSION', 'catalogVersion']) {
      const value = ownVersion(probe, key)
      if (value !== undefined) return value
    }
    // ⚠️ 2026-11-07 修（R8，#7）：不再把 ctx.subagents 上的泛名 `version` 当 catalog 版本。
    // 实测 `ctx.get('subagents') = { version: 3 }` + 无 send_message 定义会被翻成 new/detected。
    // 泛名只在明确的 `subagentCatalog` 句柄上采信；显式键（含 SUBAGENT_CATALOG_VERSION）
    // 的行为与原来完全一致。
    if (explicitCatalogHandle) {
      const value = ownVersion(probe, 'version')
      if (value !== undefined) return value
    }
  }
  return undefined
}

/**
 * 探测当前环境走哪一套委派控制接口。
 *
 * 判据（按可信度排序）：
 *   1. ctx.tools.get('send_message')?.parameters?.properties 里有没有 agent 键
 *      —— 这是最直接的证据：schema 就是宿主对模型的承诺。
 *      有 agent → 新版；只有 agent_id → 旧版。
 *   2. SUBAGENT_CATALOG_VERSION（能拿到时）：>= 3 是新版（v3 加了 name），
 *      <= 1 是旧版。注意 rc.1 的本地 catalog 是 0，外部执行是 2，所以用 3 作阈值。
 *   3. ctx.tools.definitions(undefined) 里有没有 wait_agent —— 只作参考，不作判据。
 *      实测（rc.1 安装包 app.asar 内 dsh-experimental-tool-agent-team/lib/index.js）
 *      rc.1 的团队插件就已经注册了 wait_agent，所以它的存在与否在两代之间
 *      不具区分力。把它当判据会把 rc.1 误判成新版。
 *
 * 三个判据都给不出结论时：按旧版走，并记 warn 说明每个判据各自为什么失效。
 *
 * @param ctx - 插件上下文。
 * @param opts - { catalogVersion?, logger? }（catalogVersion 供明确知道版本的调用方覆盖）。
 * @returns {{ api: 'old'|'new', detected: boolean, reason: string, signals: object }}
 */
export function detectControlApi(ctx, opts = {}) {
  const logger = opts.logger ?? ctx?.logger
  const signals = {
    hasSendMessageDefinition: false,
    hasAgentParam: false,
    hasAgentIdParam: false,
    hasWaitAgent: false,
    catalogVersion: undefined,
    probeError: undefined,
  }

  // ── 判据 1：send_message 的参数 schema ──
  let definition
  try {
    definition = ctx?.tools?.get?.('send_message')
    signals.hasSendMessageDefinition = definition !== undefined && definition !== null
    const properties = parametersPropertiesOf(definition)
    if (properties !== undefined) {
      signals.hasAgentParam = Object.hasOwn(properties, 'agent')
      signals.hasAgentIdParam = Object.hasOwn(properties, 'agent_id')
    }
  } catch (error) {
    signals.probeError = error instanceof Error ? error.message : String(error)
  }

  // ── 判据 3：wait_agent 是否存在（只记录，不参与结论）──
  try {
    const definitions = ctx?.tools?.definitions?.(undefined)
    signals.hasWaitAgent =
      Array.isArray(definitions) && definitions.some((entry) => entry?.name === 'wait_agent')
  } catch (error) {
    if (signals.probeError === undefined) {
      signals.probeError = error instanceof Error ? error.message : String(error)
    }
  }

  // ── 判据 2：catalog 版本 ──
  signals.catalogVersion = readCatalogVersion(ctx, opts.catalogVersion)

  if (signals.hasAgentParam) {
    return {
      api: CONTROL_API_NEW,
      detected: true,
      reason: 'send_message declares an "agent" parameter (name-addressed control API)',
      signals,
    }
  }
  if (signals.hasAgentIdParam) {
    return {
      api: CONTROL_API_OLD,
      detected: true,
      reason: 'send_message declares an "agent_id" parameter (id-addressed control API)',
      signals,
    }
  }
  if (typeof signals.catalogVersion === 'number') {
    if (signals.catalogVersion >= 3) {
      return {
        api: CONTROL_API_NEW,
        detected: true,
        reason: 'SUBAGENT_CATALOG_VERSION=' + signals.catalogVersion + ' (>= 3 carries the child name)',
        signals,
      }
    }
    if (signals.catalogVersion <= 1) {
      return {
        api: CONTROL_API_OLD,
        detected: true,
        reason: 'SUBAGENT_CATALOG_VERSION=' + signals.catalogVersion + ' (pre-name catalog)',
        signals,
      }
    }
  }

  // ── 判不出来：按旧版走，但必须响 ──
  const why = []
  if (!signals.hasSendMessageDefinition) {
    why.push(
      'ctx.tools.get("send_message") returned no definition (the tool may be shadowed by a same-named ' +
        'team-scoped tool or not registered yet)',
    )
  } else {
    why.push('the send_message parameter schema declares neither "agent" nor "agent_id"')
  }
  if (signals.catalogVersion === undefined) why.push('SUBAGENT_CATALOG_VERSION was not reachable from any known handle')
  if (signals.hasWaitAgent) {
    why.push(
      'wait_agent exists, but it is NOT discriminating (the rc.1 Agent Teams plugin registers it too), so it is ignored',
    )
  }
  if (signals.probeError !== undefined) why.push('probe error: ' + signals.probeError)
  const reason = why.join('; ')
  emitWarn(
    logger,
    'blackpig-compat: could not determine which subagent control API this host exposes; ' +
      'falling back to the OLD (agent_id) contract. Reason: ' + reason + '. ' +
      'If this host is actually the new one, send_message / interrupt_agent calls will fail loudly rather than silently.',
  )
  return { api: CONTROL_API_OLD, detected: false, reason, signals }
}

/**
 * 取一次调用里的目标（agent 名字 或 agent_id id），两者都接受。
 *
 * 语义与宿主的 args.agent ?? args.agent_id 一致，但多两条保护：
 *   · 空串 / 纯空白不算给了值（否则会拿一个空 id 去问宿主）；
 *   · 两个都给且不一致时抛错 —— 静默挑一个等于猜用户的意图。
 *
 * @param args - 工具入参。
 * @returns {string} 目标字符串（已 trim）。
 */
export function targetOf(args) {
  const fromAgent = typeof args?.agent === 'string' && args.agent.trim() !== '' ? args.agent.trim() : undefined
  const fromId = typeof args?.agent_id === 'string' && args.agent_id.trim() !== '' ? args.agent_id.trim() : undefined
  if (fromAgent !== undefined && fromId !== undefined && fromAgent !== fromId) {
    throw new Error(
      'this tool takes either "agent" or "agent_id", not both with different values ' +
        '(agent=' + JSON.stringify(fromAgent) + ', agent_id=' + JSON.stringify(fromId) + '); pass exactly one of them',
    )
  }
  const target = fromAgent ?? fromId
  if (target === undefined) {
    throw new Error(
      'this tool requires a target: pass either "agent" (the agent name, new hosts) or "agent_id" ' +
        '(the session id, old hosts). Neither was provided, so nothing was sent.',
    )
  }
  return target
}

/**
 * 把工具的 parameters 规范化成「两种名字都接受」的形状。
 *
 * 规则（与宿主的 schema 子集兼容）：
 *   · agent 与 agent_id 都是可选 string；
 *   · message 若在 properties 里，则必填；
 *   · 其它 required 原样保留，但会把 agent / agent_id 从 required 里摘掉。
 *
 * 为什么集中在这里算而不是逐个改调用点：subtalk.mjs 里两个工具各自写着
 * required: ['agent_id', ...]，如果逐个手改，下一版再加一个工具就会漏掉一个。
 * 集中在这里算，调用点只包一层 applyToTools(...)。
 *
 * @param parameters - 原 parameters（JSON Schema 或摊平的 property-map）。
 * @param opts - { messageRequired?: boolean }。
 * @returns 新的 parameters 对象（不修改入参）。
 */
export function applyToTools(parameters, opts = {}) {
  const base = parameters !== undefined && parameters !== null && typeof parameters === 'object' ? parameters : {}
  const standard = isStandardParametersShape(base)
  const sourceProperties = propertiesOfParameters(base) ?? {}
  const properties = {}
  for (const key of Object.keys(sourceProperties)) {
    // 摊平形状里 `required` 是并列的 schema 元数据，不是属性；标准形状里它
    // 本来就不在 properties 中。这里显式排除，避免 properties.required 被复制。
    if (!standard && key === 'required') continue
    properties[key] = sourceProperties[key]
  }

  if (!Object.hasOwn(properties, 'agent')) {
    properties.agent = {
      type: 'string',
      description:
        'The agent NAME to address (newer hosts resolve it via subagents.resolveName()). ' +
        'Pass either this or agent_id; if both are given they must be equal.',
    }
  }
  if (!Object.hasOwn(properties, 'agent_id')) {
    properties.agent_id = {
      type: 'string',
      description:
        'The agent id (childSessionId) returned by delegation. ' +
        'Pass either this or agent; if both are given they must be equal.',
    }
  }

  const originalRequired = Array.isArray(base.required) ? base.required : []
  const required = []
  for (const entry of originalRequired) {
    if (entry === 'agent' || entry === 'agent_id') continue
    if (typeof entry === 'string' && entry !== '' && !required.includes(entry)) required.push(entry)
  }
  const messageRequired = opts.messageRequired !== false
  if (messageRequired && Object.hasOwn(properties, 'message') && !required.includes('message')) required.push('message')

  if (!standard) {
    // 摊平形状：required 只允许指向真实存在的属性，避免悬空必填。
    for (let index = required.length - 1; index >= 0; index -= 1) {
      if (!Object.hasOwn(properties, required[index])) required.splice(index, 1)
    }
    return {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    }
  }

  return {
    ...base,
    type: typeof base.type === 'string' ? base.type : 'object',
    additionalProperties: base.additionalProperties === undefined ? false : base.additionalProperties,
    properties,
    required,
  }
}

/**
 * 造一条「目标解析不了」的明确错误。
 *
 * 为什么单独造：调用方（subtalk）要把它原样抛给模型，让模型能改派；错误里必须
 * 同时带用户给的原值和我们已经查过哪些来源，否则模型只会看到一句空洞的
 * "failed"，然后重试同一个错。
 *
 * @param target - 用户给的目标。
 * @param tried - 已经试过的解析来源描述。
 * @param api - 当前判定的控制接口版本。
 * @returns {Error}
 */
function unresolvedTargetError(target, tried, api) {
  const error = new Error(
    'cannot resolve agent target ' + JSON.stringify(target) + ': it is neither a known live/catalogued agent id ' +
      'nor a resolvable agent name (control API: ' + api + '; tried: ' + (tried.join(', ') || 'nothing') + '). ' +
      'Nothing was sent.',
  )
  error.name = UNRESOLVED_TARGET
  error.code = UNRESOLVED_TARGET
  error.target = target
  error.tried = tried
  return error
}

/**
 * 取 subagents 服务：调用方给了就用给的，否则问一次 ctx（读抛错时按「没有」处理）。
 *
 * 原来 `resolveTargetId()` 与 `callSendMessage()` 各写一份逐字相同的 `let sub = opts.sub` 块；
 * 体原样搬到这里，调用点与时序不变（只在 `given === undefined` 时才读 ctx）。
 *
 * @param ctx - 插件上下文。
 * @param given - 调用方传入的 `opts.sub`。
 * @returns subagents 服务或 undefined。
 */
function resolveSub(ctx, given) {
  let sub = given
  if (sub === undefined) {
    try {
      sub = ctx?.get?.('subagents')
    } catch {
      sub = undefined
    }
  }
  return sub
}

/**
 * 把一个目标（id 或名字）解析成宿主服务层要的 id。
 *
 * 解析顺序（第一命中即返回）：
 *   1. 调用方给的 isKnownId(target) —— 通常是 subtalk 已有的 describeTarget()：
 *      它同时看活 agent 注册表与已落盘 catalog，是「这个 id 是不是我派出过的」
 *      的权威判据。把这一步委托出去而不是在这里重写，是为了不出现第二条
 *      互相矛盾的「目标存在性」判据。
 *   2. 新版接口下 ctx.subagents.resolveName(target) —— 名字 → id。
 *   3. 都不行 → 抛 UNRESOLVED_TARGET（绝不把原字符串直接丢给服务层当成功）。
 *
 * @param ctx - 插件上下文。
 * @param target - id 或名字。
 * @param opts - { sub?, sender?, signal?, isKnownId?, api?, logger? }。
 * @returns {Promise<{id: string, how: 'known-id'|'resolveName', api: string}>}
 */
export async function resolveTargetId(ctx, target, opts = {}) {
  const logger = opts.logger ?? ctx?.logger
  const api = opts.api ?? detectControlApi(ctx, { logger }).api
  const tried = []

  if (typeof target !== 'string' || target.trim() === '') {
    throw Object.assign(new Error('agent target must be a non-empty string; nothing was sent'), {
      name: UNRESOLVED_TARGET,
      code: UNRESOLVED_TARGET,
      target,
      tried,
    })
  }
  const wanted = target.trim()

  if (typeof opts.isKnownId === 'function') {
    tried.push('caller isKnownId()')
    let known = false
    try {
      known = (await opts.isKnownId(wanted)) === true
    } catch (error) {
      emitWarn(
        logger,
        'blackpig-compat: the caller isKnownId() probe threw for ' + JSON.stringify(wanted) + ' (' +
          (error instanceof Error ? error.message : String(error)) + '); continuing with name resolution',
      )
    }
    if (known) return { id: wanted, how: 'known-id', api }
  }

  const sub = resolveSub(ctx, opts.sub)
  if (sub !== undefined && sub !== null && typeof sub.resolveName === 'function') {
    tried.push('subagents.resolveName()')
    try {
      const resolved = await sub.resolveName(opts.sender, wanted, opts.signal)
      const id = typeof resolved === 'string' ? resolved : resolved?.id
      if (typeof id === 'string' && id !== '') return { id, how: 'resolveName', api }
    } catch (error) {
      emitWarn(
        logger,
        'blackpig-compat: subagents.resolveName(' + JSON.stringify(wanted) + ') threw (' +
          (error instanceof Error ? error.message : String(error)) + ')',
      )
    }
  } else {
    tried.push('subagents.resolveName() unavailable')
  }

  throw unresolvedTargetError(wanted, tried, api)
}

/**
 * 发一条消息给一个代理 —— 唯一的发送入口。
 *
 * 语义：
 *   · 新版的工具入参是名字，服务层要的是 id；所以这里先解析再调用服务层。
 *     解析成功时无论新旧都走同一条 ctx.subagents.sendMessage(sender, id, ...)，
 *     不去调那个可能被同名的团队版工具盖掉的 send_message 工具 —— 保持
 *     subtalk 原本的「绕开撞名」设计，不新建平行调用链。
 *   · 解析不出来 → 抛 UNRESOLVED_TARGET，不许把原字符串当成功往下传。
 *   · 发送失败 → 原样抛（这是宿主给的唯一回执，不能吞）。
 *
 * @param ctx - 插件上下文。
 * @param opts - { target, message, sender, signal?, sub?, isKnownId?, resolvedId?, logger?, catalogVersion? }。
 * @returns {Promise<{messageId: string, targetId: string, resolvedBy: string, api: string}>}
 */
export async function callSendMessage(ctx, opts = {}) {
  const logger = opts.logger ?? ctx?.logger
  const detection = detectControlApi(ctx, { logger, catalogVersion: opts.catalogVersion })
  const target = opts.target
  const message = opts.message
  if (typeof message !== 'string' || message === '') {
    throw new Error('callSendMessage requires a non-empty "message"; nothing was sent')
  }
  // ⚠️ 2026-11-07 修（R10，#6）：纯空白（"   " / "\n\t"）原来能通过上面那道判空，
  // 于是真的被投递进收件箱、还回 ok:true + messageId —— 收件箱里是一条空消息，回执却说成功。
  // targetOf() 对空白目标是拒的，两处判据必须同口径：trim() 后为空即拒绝。
  // 只加校验，不改动要投递的正文（正常消息逐字节不变；带首尾空格的正文也照原样发）。
  if (message.trim() === '') {
    throw new Error(
      'callSendMessage rejected a whitespace-only "message": it would put an empty message in the inbox ' +
        'while the receipt claimed success; nothing was sent. Send non-blank text instead.',
    )
  }
  const sender = opts.sender
  if (sender === undefined || sender === null) {
    throw new Error(
      'callSendMessage requires the calling agent (exec.agent) as "sender"; without it the host cannot ' +
        'authorise delivery and nothing was sent',
    )
  }
  const sub = resolveSub(ctx, opts.sub)
  if (sub === undefined || sub === null || typeof sub.sendMessage !== 'function') {
    throw new Error(
      'callSendMessage requires the subagents service (ctx.get("subagents").sendMessage), which is not ' +
        'available in this composition; nothing was sent',
    )
  }

  // 调用方可能已经解析过（例如必须先拿到 id 才能发 interrupt —— 见 subtalk 的
  // interrupt-before-send）。这种情况下不要重复解析：resolvedId 是**已经过本模块
  // 解析或调用方权威核对**的 id，直接采信，并把来源标成 caller-provided。
  const preResolved = typeof opts.resolvedId === 'string' && opts.resolvedId.trim() !== '' ? opts.resolvedId.trim() : undefined
  const resolved = preResolved !== undefined
    ? { id: preResolved, how: 'caller-provided', api: detection.api }
    : await resolveTargetId(ctx, target, {
      sub,
      sender,
      signal: opts.signal,
      isKnownId: opts.isKnownId,
      api: detection.api,
      logger,
    })

  const content = [{ type: 'text', text: message }]
  const messageId = await sub.sendMessage(sender, resolved.id, content, { signal: opts.signal })
  // ⚠️ 2026-11-07 修（R8，#6）：宿主返回 undefined 时原来 String(undefined) 会渲染成
  // messageId=undefined 的假成功回执。先校验，不满足就返回结构化失败。
  // rc.1 正常路径返回非空 string，字段与字节完全不变。
  if (typeof messageId !== 'string' || messageId === '') {
    return {
      ok: false,
      reason: 'message-id-missing',
      message:
        'The host admitted sendMessage but returned no usable message id (expected a non-empty string); ' +
        'the send cannot be confirmed.',
      targetId: resolved.id,
      resolvedBy: resolved.how,
      api: detection.api,
    }
  }
  return {
    messageId,
    targetId: resolved.id,
    resolvedBy: resolved.how,
    api: detection.api,
  }
}