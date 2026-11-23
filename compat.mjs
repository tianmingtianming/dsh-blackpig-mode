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
 *     wait_agent 工具（timeout_ms 10000–3600000，默认 30000，输出 { timedOut }；
 *       rc.2 起官方移除 noProgress；本机 rc.5 无此返回）
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

/**
 * 控制接口**没探测出来**（v1.0.10 新增，取代原来复用 `CONTROL_API_OLD` 的做法）。
 *
 * 为什么单列一个值：1.0.9 的报错文本写 `control API: old`，而该字段**不参与任何
 * 分支**——它只出现在失败文案里。三个探针全失败时打 `old` 会让排查者误以为
 * 「宿主版本不对」，实际是「探针在这个 composition 里读不到」。如实写
 * `undetermined` 并附三个探针各自的失败原因，才指得动人。
 */
export const CONTROL_API_UNDETERMINED = 'undetermined'

/** 目标既不是已知 id、也无法按名字解析时抛出的错误名（便于调用方分类）。 */
export const UNRESOLVED_TARGET = 'BLACKPIG_UNRESOLVED_TARGET'

/**
 * childId 前缀容错的最低长度（v1.0.8）。
 *
 * 实测错误形态：大脑拿着截断/带修饰的 childId 来调 `send_to_subagent` /
 * `stop_subagent`（session-24720769 内 9 次工具名/截断 UUID 错误）。
 * 前缀最短取 8 位：4 位以下歧义率不可接受，8 位在会话级 worker 数（<100）下
 * 碰撞概率可忽略。宿主全量 childSessionId 是 `session-<36 位 UUID>` 形态，
 * 长度远超 8，任何 ≥8 位前缀都可安全区分。
 */
const ID_PREFIX_MIN_LENGTH = 8

/**
 * 完整 childSessionId 的两种形态（v1.0.10）。
 *
 * 宿主派工回执里的 `childSessionId` 实测有两种形态：裸 36 位 UUID
 * （如 `ed43bb07-b5ee-4f65-8924-a67af21ac1ee`）与带 `session-` 前缀的
 * （如 `session-24720769-a888-4e81-a7d9-fb18ea2b741f`）。**两种都必须认**，
 * 否则「完整 id 直通」这条 1.0.8 的可用路径会在其中一种形态上重新断掉。
 */
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_PREFIXED_FULL_UUID_RE =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 判一个目标是否**本身就是完整 childSessionId**（v1.0.10）。
 *
 * 这是 1.0.9 回归的修复判据：完整 id 不需要任何目录/名字解析，直接采信原值。
 *
 * @param target - 已 trim 的目标串。
 * @returns {boolean}
 */
export function isFullChildSessionId(target) {
  return typeof target === 'string' && (FULL_UUID_RE.test(target) || SESSION_PREFIXED_FULL_UUID_RE.test(target))
}

/** 读 durable 子会话目录时实际用到的宿主 API 名字（写进日志/报错，便于排查）。 */
export const DURABLE_CATALOG_SOURCE_QUERY = 'sessionQuery.subagentCatalog'
export const DURABLE_CATALOG_SOURCE_DESCENDANTS = 'subagents.listDescendants()'

/**
 * 从一次调用的入参里找出「看起来是 childId 前缀」的原始值（v1.0.8）。
 *
 * ⚠️ 2026-11-19：本函数当前**无调用方**——`resolveTargetId` 的前缀容错直接吃
 * 解析层拿到的 target 字符串（`looksLikeIdPrefix`），不需要再从 args 剥壳。
 * 保留导出仅为可测试性；若下个版本仍无调用方，按本包「删死代码比留注释可靠」
 * 的惯例整段删除。
 *
 * 只做形状识别，不做解析——解析必须走权威的目录/注册表（见 `resolveTargetId`）。
 * 识别范围：`agent` / `agent_id` 任一位置的字符串，剥掉引号/反引号/空白/
 * `childSessionId=` 之类的修饰后，长度 ≥ 8 且不含空白，即视为候选。
 *
 * @param args - 工具入参。
 * @returns {string|undefined} 剥壳后的候选前缀；没有像 id 的值时 undefined。
 */
export function idPrefixCandidateOf(args) {
  for (const key of ['agent_id', 'agent']) {
    const raw = args?.[key]
    if (typeof raw !== 'string') continue
    // 剥掉常见修饰：引号/反引号、前后空白、"childSessionId="/"id=" 前缀、首尾省略号。
    const stripped = raw
      .trim()
      .replace(/^[`"']+|[`"']+$/g, '')
      .replace(/^(?:childSessionId|childId|id)\s*[:=]\s*/i, '')
      .replace(/\.{2,}|…$/g, '')
      .trim()
    if (stripped.length >= ID_PREFIX_MIN_LENGTH && !/\s/.test(stripped)) return stripped
  }
  return undefined
}
// 上一函数按「保留导出仅为可测试性」的注释维持；当前无调用方。


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

  // ── 判不出来：三种探针都没给出结论 ──
  // v1.0.10：这里原来打 `api: 'old'` 并说「回退 OLD (agent_id) 契约」。但 `api` 字段
  // 只进报错文本、不参与任何分支（见 CONTROL_API_UNDETERMINED 注释），写 "old" 会
  // 把「探针在本 composition 里读不到」误导成「宿主版本不对」。改为如实报告
  // undetermined + 三种探针各自的失败原因；调用侧行为完全不变（本来就不看这个值）。
  const why = []
  if (!signals.hasSendMessageDefinition) {
    why.push(
      'probe 1: ctx.tools.get("send_message") returned no definition (the tool may be shadowed by a same-named ' +
        'team-scoped tool or not registered yet)',
    )
  } else {
    why.push('probe 1: the send_message parameter schema declares neither "agent" nor "agent_id"')
  }
  why.push(
    signals.catalogVersion === undefined
      ? 'probe 2: SUBAGENT_CATALOG_VERSION was not reachable from any known handle'
      : 'probe 2: SUBAGENT_CATALOG_VERSION=' + signals.catalogVersion + ' is between 2 and 3 and gives no verdict',
  )
  why.push(
    signals.hasWaitAgent
      ? 'probe 3: wait_agent exists, but it is NOT discriminating (the rc.1 Agent Teams plugin registers it too), so it is ignored'
      : 'probe 3: no wait_agent definition was visible (also non-discriminating; recorded only)',
  )
  if (signals.probeError !== undefined) why.push('probe error: ' + signals.probeError)
  const reason = why.join('; ')
  emitWarn(
    logger,
    'blackpig-compat: could not determine which subagent control API this host exposes; no control-API ' +
      'verdict is used by any branch in this module, so nothing is degraded by this alone. Probes: ' +
      reason + '. ' +
      'If this host is actually the new one, send_message / interrupt_agent calls will fail loudly rather than silently.',
  )
  return { api: CONTROL_API_UNDETERMINED, detected: false, reason, signals }
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
    // v1.0.8：报错文本直接给出正确写法 —— 指出每个值各自是什么、该保留哪个，
    // 不让模型对着一句空洞的 "not both" 猜。
    throw new Error(
      'this tool takes either "agent" or "agent_id", not both with different values ' +
        '(agent=' + JSON.stringify(fromAgent) + ', agent_id=' + JSON.stringify(fromId) + '). ' +
        'Correct form: keep exactly ONE of them. ' +
        '"agent" must be the agent NAME (a name/path such as "reviewer/checker" — resolve names with list_agents first); ' +
        '"agent_id" must be the FULL childSessionId returned by subagent_preset — either the bare "<uuid>" form or the "session-<uuid>" form; both are accepted. ' +
        'These two values address different targets or one of them is malformed: re-check which worker you mean, ' +
        'then resend with only the correct parameter.',
    )
  }
  const target = fromAgent ?? fromId
  if (target === undefined) {
    throw new Error(
      'this tool requires a target: pass either "agent" (the agent NAME, new hosts; resolve names with list_agents first) ' +
        'or "agent_id" (the FULL childSessionId returned by subagent_preset — the bare "<uuid>" form or the "session-<uuid>" form; both are accepted). ' +
        'Neither was provided, so nothing was sent.',
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
 * v1.0.9（缺陷 A 实测反馈）：解析失败时列出**调用方可见名册里前缀最像的候选**
 * （最多 3 个，含完整 id 原文），模型可以直接复制正确写法——而不是对着一句
 * 空洞的 "unavailable" 重试同一个错。
 *
 * v1.0.10 两处改：
 *   · `tried` 只含**真正执行过**的解析来源（1.0.9 在调用前 push，导致没跑的
 *     「listChildren 前缀匹配」也出现在文案里）；
 *   · 候选带 **name + 完整 id**，且 0 命中时也按最长公共前缀给近似候选；
 *   · 会误导的 `control API: old` 从面向用户的报错里**去掉**（只保留在内部
 *     warn 日志里，见 detectControlApi）。理由：该字段不参与任何分支，写进
 *     报错只会让人误判成「宿主版本不对」，而真正的信息是「这三个来源都查不到」。
 *
 * 2026-11-19 修订（验收实测：传 `zzzzzzzz` 时只有 `0 candidate(s)`，一个候选都没列）：
 *   · 候选**真的被渲染出来**（1.0.10 的 `similarCandidates` 在 0 命中时按「与输入共享的
 *     最长前缀」打分，但 `filter(score > 0)` 会把「一个字符都不共享」的合法名册全滤掉，
 *     于是 409 条名册也可能一条候选都给不出 —— 见 `similarCandidates` 的注释）；
 *   · 每个候选带 **名字 + 完整 id + mode**（`[continuable]` / `[one-shot]` / `[external]`），
 *     模型能据此判断"这条还能不能续"；
 *   · 名册**读不到**时正文明确写 `catalog unavailable`，不假装有候选、也不留空。
 *
 * @param target - 用户给的目标。
 * @param tried - 已经**真正执行过**的解析来源描述。
 * @param api - 当前判定的控制接口版本（仅内部使用，不进报错正文）。
 * @param ctx - 插件上下文（读候选名册用）。
 * @param sub - subagents 服务（退路读名册用；取不到就跳过候选列举）。
 * @param sender - 调用方 agent（授权边界：只列自己的子会话）。
 * @param signal - 取消信号。
 * @returns {Promise<Error>}
 */
async function unresolvedTargetError(target, tried, api, ctx, sub, sender, signal) {
  let candidateNote = ''
  let candidates = []
  try {
    // ⚠️ similarCandidates 是 async：这里必须 await，否则 Promise 恒为 truthy、
    // `.length` 读 undefined → candidateNote 永远为空（首测 T2b 抓到）。
    const similar = await similarCandidates(ctx, sub, sender, target, signal)
    candidates = similar.rows
    if (!similar.searched) {
      // 名册读不到 → 明说，不假装「没有候选」。这是与「名册为空」必须区分的两种状态。
      candidateNote =
        ' Your durable child catalog is UNREADABLE in this composition (catalog unavailable: neither ' +
        'sessionQuery.subagentCatalog nor subagents.listDescendants() could be read), so no closest entries ' +
        'can be listed. Do not guess an id — copy the full childSessionId from the original subagent_preset receipt.'
    } else if (similar.exact.length > 0) {
      candidateNote =
        ' Your id prefix matched ' + similar.exact.length + ' of your children — it is ambiguous, so nothing ' +
        'was guessed. Candidates (copy one in full): ' + renderCandidates(similar.exact) + '.'
    } else if (candidates.length > 0) {
      candidateNote =
        ' No exact prefix match. Closest entries in YOUR durable child catalog (copy one in full): ' +
        renderCandidates(candidates) + '.'
    } else if (similar.total === 0) {
      candidateNote =
        ' Your durable child catalog was read successfully and is EMPTY — you have no child sessions in this ' +
        'conversation, so no candidate id exists to copy.'
    } else {
      candidateNote =
        ' Your durable child catalog was read (' + similar.total + ' entries) but none is close to this value; ' +
        'do not retry a truncated id — copy the full childSessionId from the original subagent_preset receipt.'
    }
  } catch {
    // 候选列举失败不影响主错误——文本保持可读即可（但要说清没列成，不让读者以为名册为空）。
    candidateNote = ''
  }
  const error = new Error(
    'cannot resolve agent target ' + JSON.stringify(target) + ': it is neither a known live/catalogued agent id ' +
      'nor a resolvable agent name (tried: ' + (tried.join(', ') || 'nothing') + '). ' +
      'Nothing was sent. ' +
      'Correct form: pass the FULL childSessionId — the exact UUID (or "session-<uuid>") string that ' +
      '`subagent_preset` returned in its childSessionId field — as agent_id. ' +
      'An abbreviated id (a prefix) is only accepted when it matches exactly one child of yours; ' +
      'if the value you hold is truncated or decorated, do not retry it: re-read the original dispatch ' +
      'receipt (your todo_write entry or the subagent_preset result) and copy the full id verbatim.' + candidateNote,
  )
  error.name = UNRESOLVED_TARGET
  error.code = UNRESOLVED_TARGET
  error.target = target
  error.tried = tried
  // 内部可用字段：不进正文，但调用方/测试可以读到探测结论。
  error.controlApi = api
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
 * 取调用方（sender）自己的会话 id 候选。
 *
 * 宿主的 agent id 与会话 id 一般同名，但根会话在目录里出现过 `session-<uuid>`
 * 前缀形态，所以两种都试（与 subtalk 历史口径一致：session.id / header.id / sender.id）。
 *
 * @param sender - 调用方 agent。
 * @returns 非空字符串 id 的数组（可能为空）。
 */
export function callerSessionIdsOf(sender) {
  const candidates = []
  for (const read of [
    () => sender?.session?.id,
    () => sender?.session?.header?.id,
    () => sender?.id,
  ]) {
    try {
      const id = read()
      if (typeof id === 'string' && id !== '' && !candidates.includes(id)) candidates.push(id)
    } catch {
      // 单个候选读不到就跳过（与 parentSessionIdsOf 同口径）。
    }
  }
  return candidates
}

/**
 * 读调用方自己的 durable 子会话目录（v1.0.10 重写）。
 *
 * ── 为什么整段重写（1.0.9 回归的第二层根因）──────────────────────────────────
 * 1.0.8/1.0.9 用的是 `sub.listChildren(parentId, signal)` —— 那个方法**在
 * DSH v0.2.1-rc.2 已被删除**（归档内 `dsh/docs/upgrade-guide/v0.2.1-rc.2/
 * subagent-service-methods/guide.zh.md:13` 明写移除 `drainChildren` /
 * `listChildren` / `list()`）。于是 1.0.9 的第三级前缀解析**恒失败**：
 * `typeof sub.listChildren !== 'function'` 直接 return。
 *
 * ── 现在用的两条路径（都在 rc.5 归档里核实过）──────────────────────────────
 * A. 主路径 `ctx.get('sessionQuery').observeSession(parentId, { signal })`
 *    → `observation.projections?.values.subagentCatalog`
 *    这正是宿主自己 `listChildren` 的内部实现（`dsh-subagent/lib/index.js:2444-2455`），
 *    升级指南 `:18` 也把这条列为官方迁移写法。投影行形状见 `dsh-subagent/lib/index.js:902-906`：
 *    `{ id, createdAt, mode, label, name? }`（`id` 即 childSessionId，`mode` 取
 *    'continuable'|'one-shot'|'external'|'unknown'，`name` 只有 v3 目录项才有）。
 *    observation 必须释放：优先 `observation[Symbol.dispose]()`（rc.5 的 lease
 *    就是 `using` 资源，`dsh-session-query/lib/index.js:504-509`）。
 * B. 退路 `sub.listDescendants(rootSessionId, signal)`（`dsh-subagent/lib/index.js:3153`）
 *    —— 它需要**树根** id，不是父 id，所以先 `sub.rootOf(sender)` 取根（`:3044`），
 *    再用行上的 `parentId` 过滤出「直接子会话」，语义与 A 等价（授权边界不变）。
 *
 * 两条都不可用 → `searched: false`（诚实地说没查成，不假装空名册）。
 *
 * @param ctx - 插件上下文。
 * @param sub - subagents 服务（可缺省）。
 * @param sender - 调用方 agent（授权边界：只查自己的直接子会话）。
 * ── 过滤规则（2026-11-19 补注释；session-24720769 409 条实证后确认**无需加新过滤**）──
 * 这条投影**本身就是按父会话分区的**：`subagent/catalog` 事件写在父会话自己的日志里
 * （`dsh-subagent/lib/index.js:934-943` `establishCatalogChild` 只 append 到 parent），
 * 所以 `observeSession(parentId).projections.values.subagentCatalog` 天然只有**这个父会话的
 * 直接子会话**，不混孙代理、不混别的父会话、也不含 trash（trash 是磁盘目录的事，
 * 与投影无关）。实测 session-24720769：411 条全部 `parentSession` 指向该根、全部
 * `delegationDepth=1`、全部 `mode=continuable`，磁盘目录 410/410 存在、trash 命中 0。
 * 因此这里**只做形状清洗**，不做语义过滤：
 *   · 非对象 / `id` 非非空字符串 → 丢（坏行）；
 *   · 同一 id 重复 → 只留第一条（多帧追加造成的重复事件）；
 *   · `mode === 'external'` **保留**（它是真实子会话，只是不可续；丢掉会让一个合法
 *     id 在前缀解析里变成"不存在"，把"不可续"误报成"没派过"）；
 *   · `mode === 'one-shot'` **保留**（同上；可续性由 mode 字段表达，不由本函数裁剪）。
 * 退路 B 额外按 `kind === 'child'` 且 `parentId ∈ 我的会话 id` 过滤（它返回的是整棵树）。
 *
 * @param signal - 取消信号。
 * @returns {Promise<{searched: boolean, rows: Array<{id: string, name?: string, label?: string, mode?: string, createdAt?: number, activity?: string}>, source: string}>}
 */
export async function readCallerChildCatalog(ctx, sub, sender, signal) {
  const result = { searched: false, rows: [], source: 'unavailable' }
  const parentIds = callerSessionIdsOf(sender)
  if (parentIds.length === 0) return result

  // ── A：sessionQuery 观察 → subagentCatalog 投影（宿主 listChildren 的同一条路）──
  let query
  try {
    query = ctx?.get?.('sessionQuery')
  } catch {
    query = undefined
  }
  if (query !== undefined && query !== null && typeof query.observeSession === 'function') {
    const seen = new Set()
    let searched = false
    for (const parentId of parentIds) {
      let observation
      try {
        observation = await query.observeSession(parentId, { signal })
        const entries = observation?.projections?.values?.subagentCatalog
        if (!Array.isArray(entries)) continue
        searched = true
        for (const entry of entries) {
          const id = entry?.id
          if (typeof id !== 'string' || id === '' || seen.has(id)) continue
          seen.add(id)
          result.rows.push({
            id,
            ...(typeof entry?.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
            ...(typeof entry?.mode === 'string' ? { mode: entry.mode } : {}),
            ...(typeof entry?.label === 'string' && entry.label !== '' ? { label: entry.label } : {}),
            ...(typeof entry?.createdAt === 'number' && Number.isFinite(entry.createdAt)
              ? { createdAt: entry.createdAt }
              : {}),
          })
        }
      } catch {
        // 换下一个候选 id；全都不行再走 B 或如实报 unavailable。
        continue
      } finally {
        // lease 必须释放，否则会把冷读的 Session 钉在观察缓存里（容量 5）。
        try {
          const dispose = observation?.[Symbol.dispose]
          if (typeof dispose === 'function') dispose.call(observation)
        } catch {
          // 释放失败不能影响解析结果。
        }
      }
    }
    if (searched) {
      result.searched = true
      result.source = DURABLE_CATALOG_SOURCE_QUERY
      return result
    }
  }

  // ── B：listDescendants(rootOf(sender)) → 过滤出直接子会话 ──
  if (sub === undefined || sub === null) return result
  if (typeof sub.listDescendants !== 'function' || typeof sub.rootOf !== 'function') return result
  let rootId
  try {
    rootId = sub.rootOf(sender)?.id
  } catch {
    rootId = undefined
  }
  if (typeof rootId !== 'string' || rootId === '') return result
  let rows
  try {
    rows = await sub.listDescendants(rootId, signal)
  } catch {
    return result
  }
  if (!Array.isArray(rows)) return result
  const parents = new Set(parentIds)
  const seen = new Set()
  for (const row of rows) {
    if (row?.kind !== 'child') continue
    if (!parents.has(row?.parentId)) continue
    const id = row?.id
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    result.rows.push({
      id,
      ...(typeof row?.name === 'string' && row.name !== '' ? { name: row.name } : {}),
      ...(typeof row?.mode === 'string' ? { mode: row.mode } : {}),
      ...(typeof row?.label === 'string' && row.label !== '' ? { label: row.label } : {}),
      ...(typeof row?.activity === 'string' ? { activity: row.activity } : {}),
    })
  }
  result.searched = true
  result.source = DURABLE_CATALOG_SOURCE_DESCENDANTS
  return result
}

/**
 * 把一个目标（id 或名字）解析成宿主服务层要的 id。
 *
 * 解析顺序（第一命中即返回）：
 *   0. **完整 childSessionId 直通（v1.0.10，最高优先）**：目标本身是完整 36 位
 *      UUID（裸形态或带 `session-` 前缀）时**直接采信原值**，不做任何探查 ——
 *      不调 isKnownId、不调 resolveName、不查目录。这是 1.0.8 的可用行为，
 *      1.0.9 把它改坏（见下方 1.0.9 回归注），1.0.10 恢复。
 *   1. 调用方给的 isKnownId(target) —— 通常是 subtalk 已有的 describeTarget()：
 *      它同时看活 agent 注册表与已落盘 catalog，是「这个 id 是不是我派出过的」
 *      的权威判据。把这一步委托出去而不是在这里重写，是为了不出现第二条
 *      互相矛盾的「目标存在性」判据。
 *   2. 新版接口下 ctx.subagents.resolveName(target) —— 名字 → id。
 *   3. childId 前缀容错（v1.0.8；v1.0.10 换用真实存在的读 API）：target 看起来
 *      是**截断的** childSessionId（≥8 位、无空白、但不是完整 UUID）时，在调用方
 *      自己的 durable 子会话目录里做前缀匹配 —— 恰好一个命中就解析为全量 id；
 *      零个或多个命中不猜（宁漏不误）。目录读法见 `readCallerChildCatalog()`。
 *   4. 都不行 → 抛 UNRESOLVED_TARGET（绝不把原字符串直接丢给服务层当成功）。
 *
 * @param ctx - 插件上下文。
 * @param target - id 或名字。
 * @param opts - { sub?, sender?, signal?, isKnownId?, api?, logger? }。
 * @returns {Promise<{id: string, how: 'full-id'|'known-id'|'resolveName'|'id-prefix', api: string, note?: string}>}
 *   `note` 只在**发生了转换**（`resolveName` / `id-prefix`）时出现，见 `resolutionNote()`。
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

  // ── 第 0 级：完整 childSessionId 直通（v1.0.10 回归修复）──────────────────
  // ⚠️ 1.0.9 的回归：L670 的条件 `if (id !== wanted || !looksLikeIdPrefix(wanted))`
  // 让**完整 UUID 在 resolveName 回弹后被拒**（id === wanted 且 looksLikeIdPrefix 为真
  // → 不采信）→ 落到第 3 级 → 而第 3 级依赖已被 rc.2 删除的 `sub.listChildren` → 恒失败。
  // 结果：1.0.8 明明可用的「传完整 childSessionId 冷恢复」在 1.0.9 全断。
  // 修法：完整 UUID 不需要任何解析，形状本身就是权威 —— 直接采信，连探测都不做。
  if (isFullChildSessionId(wanted)) return { id: wanted, how: 'full-id', api }

  if (typeof opts.isKnownId === 'function') {
    let known = false
    let probeError
    try {
      known = (await opts.isKnownId(wanted)) === true
    } catch (error) {
      probeError = error
      emitWarn(
        logger,
        'blackpig-compat: the caller isKnownId() probe threw for ' + JSON.stringify(wanted) + ' (' +
          (error instanceof Error ? error.message : String(error)) + '); continuing with name resolution',
      )
    }
    // v1.0.10：tried 只在**真正执行过**之后才记（1.0.9 是在调用前 push，
    // 于是「因 API 缺失根本没跑」的项也出现在报错里，误导排查）。
    tried.push('caller isKnownId()' + (probeError === undefined ? (known ? ' → hit' : ' → miss') : ' → threw'))
    if (known) return { id: wanted, how: 'known-id', api }
  }

  const sub = resolveSub(ctx, opts.sub)
  if (sub !== undefined && sub !== null && typeof sub.resolveName === 'function') {
    try {
      const resolved = await sub.resolveName(opts.sender, wanted, opts.signal)
      const id = typeof resolved === 'string' ? resolved : resolved?.id
      if (typeof id === 'string' && id !== '') {
        // ⚠️ v1.0.9 修（缺陷 A，session-e66f6aa0 实测）：宿主 `resolveName` 对**不含 "/"**
        // 的名字有一个回退分支——`resolveAgentPath` 查不到树内名字时**原样返回输入**
        // （`dsh-subagent/lib/index.js:3072-3079`：`if (name.includes("/")) throw …; return brandString(name)`）。
        // 8 位前缀（如 "ed43bb07"）恰好匹配宿主名字字符集 `[a-z][a-z0-9-]{0,31}`，于是
        // 走到这个回退：resolveName「成功」返回原值 → 本函数曾把它当解析成功的 id
        // 返回 → 前缀容错（第 3 级）**永远没机会跑** → 原值被当全量 id 交给服务层 →
        // 冷恢复时宿主 `restoreTarget` 报 `subagent "ed43bb07" is unavailable`（NOT_RESUMABLE，
        // `dsh-subagent/lib/index.js:2256/2300`）。
        //
        // 判据（1.0.10 保持）：**宿主返回的 id 与输入原样相同时不可采信**，落到第 3 级
        // 前缀容错；只有宿主返回了**不同于输入**的 id（真解析到树内名字）才直通。
        // 完整 UUID 在上面的第 0 级已经返回，走不到这里 —— 1.0.9 把「完整 id 也当回弹拒掉」
        // 才是回归本身。
        if (id !== wanted) {
          tried.push('subagents.resolveName() → ' + JSON.stringify(id))
          return {
            id,
            how: 'resolveName',
            api,
            note: resolutionNote('resolveName', wanted, id),
          }
        }
        tried.push('subagents.resolveName() → echoed the input back (not trusted)')
        emitWarn(
          logger,
          'blackpig-compat: subagents.resolveName(' + JSON.stringify(wanted) + ') echoed the input back ' +
            '(host fallback for non-slash names that match no tree entry); not trusting it — falling through to the id-prefix match',
        )
      } else {
        tried.push('subagents.resolveName() → no id')
      }
    } catch (error) {
      tried.push(
        'subagents.resolveName() → threw (' + (error instanceof Error ? error.message : String(error)) + ')',
      )
      emitWarn(
        logger,
        'blackpig-compat: subagents.resolveName(' + JSON.stringify(wanted) + ') threw (' +
          (error instanceof Error ? error.message : String(error)) + ')',
      )
    }
  }

  // ── 第 3 级：childId 前缀容错（v1.0.8 引入；v1.0.10 换真实可用的读 API）──
  // 触发条件：target 形如被截断的 id（≥8 位、无空白、非完整 UUID——完整 UUID 已在
  // 第 0 级返回）。名字（如 "reviewer/checker"）也可能满足这个形状，所以**恰好一个**
  // 命中才采信；零个或多个命中绝不猜（宁漏不误）。
  // 目录 = 调用方自己的直接子会话（`readCallerChildCatalog()`），授权边界不变。
  if (looksLikeIdPrefix(wanted)) {
    const matched = await matchIdPrefixInCallerCatalog(ctx, sub, opts.sender, wanted, opts.signal)
    if (matched.searched) {
      tried.push(
        'durable child catalog id-prefix match via ' + matched.source + ' → ' +
          (matched.exactlyOne
            ? JSON.stringify(matched.matches[0])
            : matched.matches.length + ' candidate(s)'),
      )
    } else {
      // 没查成才写「不可用」，且措辞明确区分「查了没有」与「没查成」。
      emitWarn(
        logger,
        'blackpig-compat: neither sessionQuery.subagentCatalog nor subagents.listDescendants() could read the ' +
          'caller durable child catalog, so the id-prefix fallback for ' + JSON.stringify(wanted) + ' did not run',
      )
    }
    if (matched.exactlyOne) {
      return {
        id: matched.matches[0],
        how: 'id-prefix',
        api,
        note: resolutionNote('id-prefix', wanted, matched.matches[0], matched.source),
      }
    }
    if (matched.searched) {
      emitWarn(
        logger,
        'blackpig-compat: id-prefix match for ' + JSON.stringify(wanted) + ' found ' +
          matched.matches.length + ' candidate(s) in the caller durable child catalog; not guessing',
      )
    }
  }

  throw await unresolvedTargetError(wanted, tried, api, ctx, sub, opts.sender, opts.signal)
}

/** 名册候选一行的人可读写法：`"name" = <完整 id> [mode]`（name 缺失时省略前半段）。 */
function candidateText(row) {
  const name = typeof row?.name === 'string' && row.name !== '' ? JSON.stringify(row.name) + ' = ' : ''
  const mode = typeof row?.mode === 'string' && row.mode !== '' ? ' [' + row.mode + ']' : ''
  return name + JSON.stringify(row.id) + mode
}

/** 把候选行渲染成一行逗号分隔的文案（调用方已保证 ≤3）。 */
function renderCandidates(rows) {
  return rows.map(candidateText).join(', ')
}

/**
 * 造一句「这次目标被转换过」的说明（2026-11-19 新增，缺陷 1）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 宿主 `sendMessage` 的回执只回显**调用方传进去的那个值**（实测 session-5c60e4d6：
 * 传 `{"agent_id":"0587566b"}` 成功，回执写 `message accepted into the inbox of
 * subagent 0587566b`）。而插件层在这里把它解析成了完整 id
 * `0587566b-e451-47be-b3d6-2510e2cc96b9` —— **回执里没有任何地方显示这个转换**。
 * 出问题时（发给了错的 worker、或前缀解析到了别的子会话）无从判断解析对不对。
 *
 * 取向：
 *   · **只在真的发生了转换时**给说明；`full-id`（原值就是完整 id）与 `known-id`
 *     （调用方权威核对过）是直通，不加 —— 否则每一条普通回执都多一段噪音；
 *   · 不改宿主文本本身（宿主返的是 messageId，回执正文由 subtalk 渲染），
 *     本函数只产出要拼进正文的那一段；
 *   · 说明里同时给**原值**与**解析结果**，两者都在才能人工复核。
 *
 * @param {string} how - `resolveTargetId` 返回的解析方式。
 * @param {string} from - 调用方 originally 给的目标串。
 * @param {string} to - 解析出的完整 id。
 * @param {string} [source] - 目录来源（仅 id-prefix 用）。
 * @returns {string|undefined} 要拼进回执正文的说明；无需说明时 undefined。
 */
export function resolutionNote(how, from, to, source) {
  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') return undefined
  if (from === to) return undefined
  if (how === 'id-prefix') {
    return (
      '(resolved ' + JSON.stringify(from) + ' → ' + to + ' via durable child catalog id-prefix match' +
      (typeof source === 'string' && source !== '' ? ' @ ' + source : '') + ')'
    )
  }
  if (how === 'resolveName') {
    return '(resolved ' + JSON.stringify(from) + ' → ' + to + ' via subagents.resolveName())'
  }
  return undefined
}

/**
 * 从调用方可见名册里挑最相似的候选（v1.0.9 起；2026-11-19 修订）。
 *
 * ── 打分规则（0 命中也要给出候选，这是设计稿的承诺）──────────────────────────
 * 1. **前缀命中优先**：`id.startsWith(输入)` 的全部算命中，按 id 升序取前 3。
 *    多于一个 = 歧义（调用方据此报 ambiguous，绝不猜）。
 * 2. 否则按「与输入共享的最长公共前缀长度」降序取前 3，**同分时按 id 升序**保证稳定。
 *
 * ⚠️ 2026-11-19 修（验收实测缺陷 2）：1.0.10 在这里写了 `.filter((entry) => entry.score > 0)`，
 * 于是「与输入一个字符都不共享」的候选被全部滤掉 → 传 `zzzzzzzz` 时名册 409 条也返回空
 * → 报错只剩 `0 candidate(s)`，`candidateNote` 整段为空。修法：**不再按 score>0 过滤**，
 * 名册非空就一定给前 3。这样「0 前缀命中」与「名册为空」是两种可区分的结果。
 *
 * 同分怎么排（409 条实测：`zzzzzzzz` 与任何 UUID 首字符都不共享 ⇒ 410 条全部同分 0）：
 *   `score` 降序 → **`createdAt` 降序（最近派出的排前面）** → `id` 升序（保证稳定）。
 * 为什么加「最近优先」：同分时按 id 字母序取前 3 等于随机取 3 条（真实名册里 410 条
 * 全同分，取到的就是 id 最小的 3 个 —— 那是会话最早期的子代理，最不可能是模型想找的）。
 * 长会话里模型要续的几乎总是**最近**那个 worker，所以同分按时间倒序才是有用的默认。

 * @param ctx - 插件上下文。
 * @param sub - subagents 服务。
 * @param sender - 调用方 agent。
 * @param prefix - 用户给的目标串（已 trim）。
 * @param signal - 取消信号。
 * @returns {Promise<{searched: boolean, source: string, total: number, exact: Array, rows: Array}>}
 *   searched = 名册真的读成了；total = 名册总条数；exact = 前缀命中（≤3）；
 *   rows = 近似候选（≤3，仅在 exact 为空时有意义）。
 */
async function similarCandidates(ctx, sub, sender, prefix, signal) {
  const catalog = await readCallerChildCatalog(ctx, sub, sender, signal)
  if (!catalog.searched) return { searched: false, source: catalog.source, total: 0, exact: [], rows: [] }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const exact = catalog.rows.filter((row) => row.id.startsWith(prefix)).sort(byId).slice(0, 3)
  if (exact.length > 0) {
    return { searched: true, source: catalog.source, total: catalog.rows.length, exact, rows: [] }
  }
  const scoreOf = (row) => {
    const text = row.id
    let score = 0
    while (score < text.length && score < prefix.length && text[score] === prefix[score]) score += 1
    return score
  }
  const createdAtOf = (row) => (typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : -1)
  const rows = catalog.rows
    .map((row) => ({ row, score: scoreOf(row), at: createdAtOf(row) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.at !== a.at) return b.at - a.at
      return byId(a.row, b.row)
    })
    .slice(0, 3)
    .map((entry) => entry.row)
  return { searched: true, source: catalog.source, total: catalog.rows.length, exact: [], rows }
}

/**
 * 判一个字符串是否「形如 childId 前缀」（≥8 位、无空白）。
 *
 * @param target - 已 trim 的目标串。
 * @returns {boolean}
 */
function looksLikeIdPrefix(target) {
  return target.length >= ID_PREFIX_MIN_LENGTH && !/\s/.test(target)
}

/**
 * 在调用方（sender）自己的 durable 子会话目录里做 id 前缀匹配（v1.0.10 重写）。
 *
 * 数据源改走 `readCallerChildCatalog()`（sessionQuery.subagentCatalog 主路径 +
 * listDescendants 退路），不再依赖 DSH v0.2.1-rc.2 已删除的 `sub.listChildren()`。
 *
 * @param ctx - 插件上下文。
 * @param sub - subagents 服务。
 * @param sender - 调用方 agent（授权边界：只查自己的子会话）。
 * @param prefix - ≥8 位的前缀。
 * @param signal - 取消信号。
 * @returns {Promise<{searched: boolean, matches: string[], exactlyOne: boolean, source: string}>}
 *   searched = 目录真的查到了；matches = 命中的全量 id；
 *   exactlyOne = 恰好一个命中（唯一可采信的解析结果）。
 */
async function matchIdPrefixInCallerCatalog(ctx, sub, sender, prefix, signal) {
  const catalog = await readCallerChildCatalog(ctx, sub, sender, signal)
  const matches = catalog.rows.filter((row) => row.id.startsWith(prefix)).map((row) => row.id)
  return {
    searched: catalog.searched,
    source: catalog.source,
    matches,
    exactlyOne: catalog.searched && matches.length === 1,
  }
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
 * @param opts - { target, message, sender, signal?, sub?, isKnownId?, resolvedId?, resolvedBy?, resolutionNote?, resolutionSource?, logger?, catalogVersion? }。
 * @returns {Promise<{messageId: string, targetId: string, resolvedBy: string, requested?: string, note?: string, api: string}>}
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
    ? { id: preResolved, how: opts.resolvedBy ?? 'caller-provided', api: detection.api }
    : await resolveTargetId(ctx, target, {
      sub,
      sender,
      signal: opts.signal,
      isKnownId: opts.isKnownId,
      api: detection.api,
      logger,
    })
  // 2026-11-19（缺陷 1）：回执要能看出「传进去的值 → 实际用的 id」这次转换。
  // 调用方（subtalk）解析过一次并把结论交回来时用它的 note；否则这里按同一判据补算。
  const note = typeof opts.resolutionNote === 'string' && opts.resolutionNote !== ''
    ? opts.resolutionNote
    : resolutionNote(resolved.how, typeof target === 'string' ? target.trim() : target, resolved.id, opts.resolutionSource)

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
      requested: typeof target === 'string' ? target : undefined,
      ...(note === undefined ? {} : { note }),
      api: detection.api,
    }
  }
  return {
    messageId,
    targetId: resolved.id,
    resolvedBy: resolved.how,
    requested: typeof target === 'string' ? target : undefined,
    ...(note === undefined ? {} : { note }),
    api: detection.api,
  }
}