/**
 * blackpig-roster — 给大脑一张「代理名册」+ 跨模式派活工具。
 *
 * 起因：实测大量会话日志，协调者**从未**传过 `agent_preset`，于是全部落到
 * `agentPreset: "standard"`。而部署里装的专用模式（任何需要特殊工具面的模式）
 * 与 standard 都不同，活派给 standard 就干不了，白烧一轮且不报错。
 * 根因不是模型懒，是「不传也能成功」。所以本模块把「用哪个模式」变成必填参数。
 *
 * 名册数据源：**`preset-caps.json`（静态基准文件）**，不再在运行时从宿主动态推导。
 *
 *   ① 用户文件优先：`~/.dsh/blackpig-preset-caps.json`
 *   ② 回退包内默认：`<包目录>/defaults/preset-caps.json`
 *   ③ 都没有 → 明确回「未找到基准数据」，不编造模式、不猜能力。
 *
 * 为什么是静态文件（2026-11-14 简化，用户决定）：宿主能告诉名册的是「这个模式装载了
 * 哪些模块」，给不出**运行时真实可调用的工具名**（`definitions(scope)` 要求 scope 是
 * 活跃 Agent），而且工具集随插件增减而变 —— 官方原文：a tool schema is not statically
 * knowable。从模块推导出来的能力标签既不可靠又长，所以名册改为读一份人工跑出来的
 * 基准文件（跑法见 `docs/preset-bench.md`）。顺带砍掉了 `detail: true` / `ask: true`
 * 两条查询分支：名册本身已经写清「适合 / 不适合」，不需要再读声明或起 worker 自述。
 *
 * 派活（`delegate`）仍然走**活校验**：`registry.list()` 确认目标模式真实存在且没坏。
 * 基准文件只决定「名册怎么写」，不决定「能不能派」。
 *
 * @module blackpig-model/blackpig-roster
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-roster'

/**
 * 工具名 —— **单一权威来源**。
 *
 * `guard-v10.mjs` 的保留集必须含这个名字，否则工具注册成功也会被执行层拒绝
 * （模型连看都看不到）。两处硬编码过一次就会漂，所以从本模块导出。
 */
export const TOOL_NAME = 'subagent_preset'

/** 需要的能力：工具注册 + 代理服务（派活）+ 预设注册表（读名册）。 */
export const inject = ['tools', 'subagents', 'agentPresets']

/**
 * 「没有调用者」的统一拒绝文案。
 *
 * 2026-11-02（审计 R2 自查）：派活路径曾各写一遍这句话，一字不差。抽成常量有两个
 * 好处：改文案只改一处；用 `NO_CALLER_MESSAGE` 这个名字 grep 得到**全部**「必须有
 * caller」的前置点，以后新增路径时不会漏（漏了就是一次白烧的 startActivation）。
 */
const NO_CALLER_MESSAGE = 'This tool requires a calling Agent (exec.agent was undefined).'

/**
 * 工具输出契约。
 *
 * ⚠️ 宿主**强制**要求 `output: { schema, render }`，缺了 `ctx.tools.register()`
 * 会抛 TypeError，而本模块的 catch 会把它吞成一条 warn —— 工具静默注册不上。
 * 第一版就漏了这个字段，静态检查全绿但工具永远不可见（验证员 2026-10-31 抓到）。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'False when the call was refused; `reason` says why.' },
    presetId: { type: 'string', description: 'The preset actually requested, present when known.' },
    childSessionId: { type: 'string', description: 'Durable child session id, present only on a successful delegation.' },
    message: { type: 'string', description: 'The roster, the declaration, the confirmation, or the exact refusal.' },
    reason: { type: 'string', description: 'Machine-readable refusal code, present only when ok is false.' },
    stop: { type: 'boolean', description: 'True when the caller must not retry this call.' },
    nextAction: { type: 'string', description: 'What to do instead, when a refusal is recoverable.' },
    degraded: {
      type: 'array',
      items: { type: 'string' },
      description: 'Present ONLY when something degraded; absence means nothing degraded.',
    },
    evidence: {
      type: 'object',
      description: 'Provenance of the delegation claim. `level: mount-only` means: the preset was requested and the child was started, but the runtime mount was NOT independently observed — do not read this as proof the mode ran.',
    },
  },
  required: ['ok', 'message'],
}

/**
 * 渲染回执：以 `message` 为主体，只**追加**调用方必须看见的结构化信息。
 *
 * ⚠️ 2026-11-07 修（R11，BUG-2）：原来只渲染 `message`，把 `nextAction` / `stop` /
 * `degraded` / `reason` 全部丢掉。工具 description 却向模型承诺「`stop: true` 意味着
 * 不要重试」，而 `unknown-preset` 拒绝后**唯一可执行的路**（`nextAction` 里的候选 id）
 * 根本不可见。现在按固定顺序追加：reason → next → stop → degraded。只输出这几个必要
 * 字段，不把整个回执对象 JSON 倒出来（token 预算）；没有这些字段时输出与改前逐字节一致。
 *
 * ⚠️ 2026-11-15：名册字节硬顶**整体移除**（`ROSTER_HARD_CAP_BYTES` / `config.rosterMaxBytes`
 * / 码点安全截断全删）。`degraded` 列表因此**永远完整**输出 —— 名册不设任何字节上限。
 * 理由：模式数量天然有限（本部署 8 个，极端部署也就几十个），4,000 B 上限是为一个不存在的
 * 「几十上百模式」场景设防，代价却是把真实名册砍掉一半、模型看不到被丢的模式。
 */

function render(_args, value) {
  const message = String(value?.message ?? '')
  const extra = []
  if (typeof value?.reason === 'string' && value.reason !== '') extra.push('reason: ' + value.reason)
  if (typeof value?.nextAction === 'string' && value.nextAction !== '') extra.push('next: ' + value.nextAction)
  if (value?.stop === true) extra.push('stop: do not retry')
  const body = extra.length === 0 ? message : message === '' ? extra.join('\n') : message + '\n' + extra.join('\n')
  const degraded = Array.isArray(value?.degraded) ? value.degraded.map((item) => String(item)) : []
  if (degraded.length === 0) return [{ type: 'text', text: body }]
  // 无硬顶 → 完整列表原样追加（与改前「完整列表装得下」那条分支逐字节一致）。
  const degradedLine = 'degraded: ' + degraded.join(', ')
  return [{ type: 'text', text: body === '' ? degradedLine : body + '\n' + degradedLine }]
}

/**
 * 一次只警告一次的记录器。
 *
 * @param ctx - 插件上下文。
 * @returns 记录函数。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`blackpig-roster: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 基准文件名与查找顺序。
 *
 *   ① 用户文件优先：`~/.dsh/blackpig-preset-caps.json`（用户自己跑基准测试后的产物）
 *   ② 回退包内默认：`<包目录>/defaults/preset-caps.json`（只含 DSH 的 4 个内置模式）
 *
 * 两者都读不到时**不编造模式**：返回一条「未找到基准数据」的失败回执 + degraded。
 */
const CAPS_FILE_NAME = 'blackpig-preset-caps.json'
const CAPS_DEFAULTS_RELATIVE = ['defaults', 'preset-caps.json']

/** 本模块所在目录（= 包目录），用于定位 `defaults/preset-caps.json`。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * 读并解析一个候选文件。
 *
 * 不存在 / 读不动 / JSON 坏 / 结构不对都返回 `{ ok: false, reason, error }`，由调用方决定
 * 要不要继续试下一个候选 —— 单个候选失败不是致命错误（用户文件坏了还有包内默认兜着）。
 *
 * @param filePath - 候选文件的绝对路径。
 * @returns `{ ok: true, caps, source }` 或 `{ ok: false, reason, error }`。
 */
function readCapsCandidate(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'unreadable', error: error instanceof Error ? error.message : String(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: 'invalid-json', error: error instanceof Error ? error.message : String(error) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-shape', error: 'the top level is not a JSON object' }
  }
  const presets = parsed.presets
  if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) {
    return { ok: false, reason: 'invalid-shape', error: 'the presets field is missing or is not an object' }
  }
  return { ok: true, caps: parsed, source: filePath }
}

/**
 * 按「用户文件 → 包内默认」的顺序找基准数据。
 *
 * @returns `{ ok: true, caps, source }` 或 `{ ok: false, errors }`（每个候选一条原因）。
 */
function loadPresetCaps() {
  const home = typeof os.homedir === 'function' ? os.homedir() : ''
  const candidates = []
  if (home !== '') candidates.push(path.join(home, '.dsh', CAPS_FILE_NAME))
  candidates.push(path.join(MODULE_DIR, ...CAPS_DEFAULTS_RELATIVE))
  const errors = []
  for (const candidate of candidates) {
    const read = readCapsCandidate(candidate)
    if (read.ok) return read
    errors.push(candidate + ': ' + read.error)
  }
  return { ok: false, errors }
}

/** 工具数量的展示口径：优先 `toolCount`，否则数 `tools` 数组。 */
function toolCountOf(entry) {
  const declared = entry?.toolCount
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) return Math.floor(declared)
  return Array.isArray(entry?.tools) ? entry.tools.length : 0
}

/** 一行里的空白折成单个空格并去首尾空白（JSON 里的说明可能带换行）。 */
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()

/**
 * 渲染名册 —— **只读 `preset-caps.json`，不查注册表、不做能力推导**。
 *
 * 输出固定形状（每个模式最多三行），不带任何提示、阶梯说明或未列出的模式：
 *
 *     Agent modes with a benchmark entry (preset-caps.json) — installed modes missing from this list can still be dispatched if you know their id
 *
 *     - standard (33 tools)
 *       suitable: …
 *       not suitable: …
 *
 * `hidden: true` 的模式跳过（只在名册里隐藏，`delegate` 仍可派）；不在 JSON 里的模式
 * **不显示** —— 本模块不再自己推导模式表。自己（`selfId`）也跳过：派给自己会被
 * self-preset 拒，列出来只会误导。
 *
 * @param caps - 已解析的基准文件（`{ presets: { … } }`）。
 * @param selfId - 本模式自己的 preset id。
 * @returns `{ text, degraded }`。
 */
function renderRoster(caps, selfId) {
  const degraded = []

  const presets = caps?.presets ?? {}
  const ids = Object.keys(presets)
  if (ids.length === 0) {
    return { text: 'No preset baseline found: preset-caps.json declares no mode.', degraded: [...degraded, 'preset-caps-empty'] }
  }

  const lines = ['Agent modes with a benchmark entry (preset-caps.json) — installed modes missing from this list can still be dispatched if you know their id', '']
  let shown = 0
  for (const id of ids) {
    if (id === selfId) continue
    const entry = presets[id]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      degraded.push('invalid-entry:' + id)
      continue
    }
    if (entry.hidden === true) continue
    const count = toolCountOf(entry)
    lines.push('- ' + id + ' (' + count + (count === 1 ? ' tool)' : ' tools)'))
    const suitable = typeof entry.suitableFor === 'string' ? oneLine(entry.suitableFor) : ''
    const notSuitable = typeof entry.notSuitableFor === 'string' ? oneLine(entry.notSuitableFor) : ''
    if (suitable !== '') lines.push('  suitable: ' + suitable)
    if (notSuitable !== '') lines.push('  not suitable: ' + notSuitable)
    shown += 1
  }
  if (shown === 0) {
    return {
      text: 'No preset baseline entry is visible (every entry is hidden, or is this mode itself).',
      degraded: [...degraded, 'roster-empty'],
    }
  }
  return { text: lines.join('\n'), degraded }
}

/**
 * 可用模式 id 列表：排除非对象行、空 id、自己、以及 broken 行。
 *
 * `knownIds()` 与 `presetUnusable()` 原来各写一份逐字相同的 filter+map 链，抽成这一份。
 *
 * @param rows - `registry.list()` 的返回值。
 * @param selfId - 本模式自己的 id（列出自己没有意义）。
 * @returns `string[]`。
 */
function usableIds(rows, selfId) {
  return rows
    .filter((row) => row !== null && typeof row === 'object')
    .filter((row) => typeof row.id === 'string' && row.id !== '' && row.id !== selfId)
    .filter((row) => !(typeof row.broken === 'string' && row.broken !== ''))
    .map((row) => row.id)
}

/**
 * 把本部署的递归预算写进 `request`（`delegate()` 用它带上深度，深度本身由宿主裁决）。
 *
 * 判据（与上游 tool-subagent 同形）：只透传整数且 `>= 0` —— 0 是宿主「禁止再派」的硬顶，
 * 必须照传（旧 `> 0` 判据会把 0 当无值过滤掉，等于绕过调用方设定的递归硬顶）；
 * NaN / -1 / Infinity / 非数字不写进 request（宿主的 maxDepth=NaN 会被序列化成 null）；
 * undefined 不传，保持宿主默认。解析失败同样不带，让服务用默认值。
 *
 * @param request - 即将交给 `startActivation` 的请求对象（原地赋值）。
 * @param subagents - 带 `resolveMaxDepth()` 的服务。
 */
function applyMaxDepth(request, subagents) {
  try {
    const maxDepth = subagents.resolveMaxDepth?.()
    if (Number.isInteger(maxDepth) && maxDepth >= 0) request.maxDepth = maxDepth
  } catch {
    // 解析不了就不带，让服务用默认值。
  }
}

/**
 * 装载本模块。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, selfPresetId, disabledPresets }`。
 * @returns void。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)
  // ⚠️ 2026-11-07 修（R10，#5）：只判空串不 trim，配置写成 ' blackpigmodel ' 时 selfId 与
  // 名册里的 id 不相等 —— 名册把自己列出来、knownIds 不排除自己、presetUnusable 的
  // self-preset 闸也失效。guard-v10 的 normalizePresetId() 是 trim 后判空的，
  // 这里改成同一口径；正常无空格配置的取值逐字节不变。
  const configuredSelfId = typeof config?.selfPresetId === 'string' ? config.selfPresetId.trim() : ''
  const selfId = configuredSelfId !== '' ? configuredSelfId : 'blackpigmodel'

  /**
   * 彻底禁用的 preset id（`config.disabledPresets`）。
   *
   * 与基准文件里的 `hidden: true` **不是一回事**：
   *   · `hidden: true` 只让名册不显示它，`delegate` 仍能派（「我知道它，但别让大脑误选」）；
   *   · `disabledPresets` 是**派活的硬闸**，`delegate` 会回 `preset-disabled`（「这个部署不许用它」）。
   *
   * 只收非空字符串，其余丢弃并 warn 一次 —— 配置错误不该让整个工具坏掉。
   */
  const disabledPresets = (() => {
    const raw = config?.disabledPresets
    const picked = new Set()
    if (raw === undefined || raw === null) return picked
    if (!Array.isArray(raw)) {
      warn('config.disabledPresets must be an array of preset ids; it is ignored (got ' + typeof raw + ')')
      return picked
    }
    for (const item of raw) {
      if (typeof item !== 'string') {
        warn('config.disabledPresets contains a non-string entry; it is ignored (got ' + typeof item + ')')
        continue
      }
      const id = item.trim()
      if (id === '') continue
      picked.add(id)
    }
    return picked
  })()

  /**
   * 取服务。Cordis 的服务查找沿父链上溯，preset 内的 scope 也能取到宿主平面那一份。
   *
   * @param serviceName - 服务名。
   * @returns 服务实例或 undefined。
   */
  const serviceOf = (serviceName) => {
    try {
      const service = ctx.get?.(serviceName)
      if (service !== undefined && service !== null) return service
    } catch {
      // 取不到不是致命错误，调用方会给出可读的拒绝。
    }
    return undefined
  }

  /** 统一失败回执：`stop:true` 表示别重试，`nextAction` 给可恢复的替代路径。 */

  const failure = (reason, message, options = {}) => ({
    ok: false,
    reason,
    message,
    stop: options.stop === true,
    ...options.nextAction === undefined ? {} : { nextAction: options.nextAction },
    ...options.presetId === undefined ? {} : { presetId: options.presetId },
    evidence: {
      // 2026-11-02：`inAllowed` 已删除。它是白名单时代的字段，恒为 true 后
      // 变成一个永远说不成任何话的字段（"没有被名单拦住"在名单不存在时无意义）。
      broken: options.broken ?? null,
      presetId: options.presetId ?? null,
      childSessionId: null,
      // 只声明**真的验证过什么**。没回读子会话事件，就不要用 mounted / presetEventSeen
      // 这种"看起来验过"的字段 —— 它们恒为初始值，会误导调用方。
      //
      // 2026-11-07 修（R9，#6）：OUTPUT_SCHEMA 没有为 level 定义枚举，只定义了
      // mount-only 的含义（preset 被请求**且子会话已启动**）。failure() 的
      // childSessionId 恒为 null，所以这里不能再用 mount-only 冒充「已挂载」。
      // 不造 schema 外的枚举值：level: null = 没有层级声明，mounted: false = 明确未挂载。
      level: null,
      mounted: false,
    },
    ...options.degraded === undefined ? {} : { degraded: options.degraded },
  })

  /**
   * 派活给某个模式。
   *
   * @param args - 工具参数。
   * @param exec - 执行上下文（含 `agent` / `signal`）。
   * @returns 回执对象。
   */
  const delegate = async (args, exec) => {
    const presetId = typeof args?.preset === 'string' ? args.preset.trim() : ''

    // ★ 必填：把「忘传」从静默降级变成可见失败。
    if (presetId === '') {
      const known = await knownIds()
      return failure('preset-required', 'A `preset` id is required. Call with `list: true` to see the available ids.', {
        stop: true,
        // 2026-11-07 修（R9，#5）：读失败必须与「真空名册」给出不同回执。
        nextAction: known.ok
          ? (known.ids.length === 0 ? 'no mode is available; report to the user' : `choose one of: ${known.ids.join(', ')}`)
          : `the agent-preset registry could not be read (${known.error}); this is a registry read failure, NOT "no mode is available" — report it to the user`,
        degraded: known.ok
          ? (known.ids.length === 0 ? ['no-usable-mode'] : undefined)
          : ['registry-unreadable'],
      })
    }

    const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
    if (prompt.trim() === '') {
      return failure('prompt-required', 'A non-empty `prompt` is required: the worker does not see this conversation.', { stop: true })
    }

    const parent = exec?.agent
    if (parent === undefined || parent === null) {
      return failure('no-caller', NO_CALLER_MESSAGE, { stop: true })
    }

    // ── 递归闸：**由宿主 maxDepth 决定，本模块不硬编码**（2026-11-02 通用化）──
    //
    // 旧实现直接拒绝「任何子会话」，那是一道与本模块无关的硬编码规则：
    //   · 委派深度是宿主的策略（设置面板里可改），本模块不该替它拿主意；
    //   · 旧闸与宿主检查**重复**，而且宿主那层才是权威。真超深度时
    //     `startActivation` 会抛 `subagent depth N exceeds maxDepth M`，本模块
    //     把那条错误原样带回给调用方即可（见下方 catch）。
    //   · 更要紧的是：旧闸让**队友**（depth 1）完全用不了按模式派活的能力，
    //     只能走宿主的 `subagent`（固定 standard），等于能力被砍掉一半。
    //
    // 现在的规则：**放行所有调用者，深度由宿主裁决**。改面板即改行为，代码不动。
    //
    // ⚠️⚠️ 但有一条**必须写在这里的后果**（2026-11-02 审计 R1 抓到的 P2）：
    //
    //   宿主 `maxDepth` 的**默认值是 1**（`z.number().default(1).volatile()`，
    //   见 `@deepseek-ai/dsh-subagent` 的 Config）。本项目 YAML 显式写成 2。
    //   因此：
    //
    //   · 面板 maxDepth = 1  → 队友（depth 1）派出的子会话 depth = 2 > 1
    //                          → 宿主抛 `subagent depth 2 exceeds maxDepth 1`
    //                          → **队友完全不能派代理**（不只是不能派队友，是连代理都派不了）
    //   · 面板 maxDepth = 2  → 队友能派一代代理（本项目当前值）
    //   · 面板 maxDepth ≥ 3  → 代理还能继续往下派
    //
    //   即：**「队友能派代理」这个能力依赖 maxDepth ≥ 2**。这不是 bug（深度本就该由
    //   面板决定），但如果把面板调到 1，就会与「队友可以派代理」的角色定义冲突 ——
    //   改面板的人必须知道这件事。代码不做本地兜底（兜底=绕过面板，那正是旧闸的错）。
    //
    // 兜底：如果调用方确实是子会话，这里只**读一次**深度用于日志/回执（不拦），
    // 便于排查「为什么被拒」时能对上号。

    if (presetId === selfId) {
      return failure(
        'self-preset',
        `"${presetId}" is this mode itself. Dispatching to it would create a sub-coordinator that cannot dispatch.`,
        { stop: true, presetId },
      )
    }

    // ── 2026-11-02 通用化：白名单/黑名单全部删除 ──
    //
    // 原设计有两层人工边界（`allowedPresets` / `deniedPresets`），都已删除：
    //   · 白名单让「装新模式」必须回来改黑猪配置，模式不可通用；
    //   · 黑名单是白名单的补丁，同样是替运维记「哪些模式可以派」。
    // 现在：名册只列 `preset-caps.json` 里有的模式，选人是「这份基准说明覆盖不覆盖」的问题；
    // 没基准的模式不显示但仍可派（delegate 走活校验）。危险模式靠基准文件的
    // suitableFor / notSuitableFor 文字和工具清单暴露，不再有能力标签。
    //
    // ⚠️ 2026-11-02（第二轮复核 P2-2）：存在性校验抽成了 `presetUnusable()`，
    //    统一处理「不存在 / broken / self」三道前置，任何派活路径都先过它。
    const unusable = await presetUnusable(presetId)
    if (unusable !== undefined) return unusable

    const subagents = serviceOf('subagents')
    if (subagents === undefined || typeof subagents.startActivation !== 'function') {
      return failure('subagents-unavailable', 'The subagent service is unavailable, so no mode can be dispatched to.', { stop: true, presetId })
    }

    // 与上游 `tool-subagent` 同形：可选字段只在有值时才写，避免显式 undefined 顶掉后端默认。
    const request = {
      prompt: [{ type: 'text', text: prompt }],
      parent,
      agentPreset: presetId,
    }
    applyMaxDepth(request, subagents)

    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        // ⚠️ 2026-11-07 修（R16b，BUG-C）：原来只判空串、不 trim，`description: "   "` 会把
        // 一串空白当成 label（名册/回执里出现一个看不见的标签）。同文件 :1375/:1394/:1800 与
        // file-info 的 parsePaths 都是 trim 后判空的口径，这里对齐：空白走默认 label。
        // 非空 description 仍**原样**返回（不 trim —— 标签里的空格是调用方内容）。
        label:
          typeof args?.description === 'string' && args.description.trim() !== '' ? args.description : `delegate to ${presetId}`,
        request,
        ...request,
        signal: exec?.signal,
        delivery: 'parent',
      })
      // 2026-11-07 修（R9，#3）：空串不是 child id。只采信非空字符串，
      // 否则走已有的 no-child-id 失败分支，不能回 ok:true 带一个空 id。
      const childSessionId = typeof activation?.childId === 'string' && activation.childId !== '' ? activation.childId : null
      if (childSessionId === null) {
        return failure('no-child-id', `Dispatching to "${presetId}" returned no subagent id.`, { stop: false, presetId })
      }
      return {
        ok: true,
        presetId,
        childSessionId,
        message:
          `Started a "${presetId}" worker: ${childSessionId}. ` +
          'Record that id now (into `todo_write`): it is the only handle `send_to_subagent` accepts. ' +
          'This worker is NOT a Team member: `list_agents` never sees it and `wait_agent` returns noProgress ' +
          'immediately for it, so never wait on it. Tell the user what you dispatched, ' +
          'then either end your turn (its completion notice will wake you) or do independent work ' +
          'that touches different files.',
        evidence: {
          broken: null,
          presetId,
          childSessionId,
          level: 'mount-only',
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`dispatching to agent preset "${presetId}" failed: ${message}`)
      return failure('start-failed', `Dispatching to "${presetId}" failed: ${message}`, { stop: false, presetId })
    }
  }

  /**
   * 读名册。成功返回 { ok: true, rows }；失败返回 { ok: false, rows: [], error }（不抛）。
   *
   * ⚠️ 2026-11-07 修（R8，#1）：原来失败直接 `return []`，把「注册表读取失败」伪装成
   * 「一个预设都没有」—— 调用方随后把一个真实存在的 preset 报成 `unknown-preset`，且 0 条 warn。
   * 现在失败必须带回原因，让调用方能区分「列表为空」与「列表读取失败」。
   */
  const safeList = async (registry) => {
    try {
      const rows = await registry.list()
      if (!Array.isArray(rows)) {
        return { ok: false, rows: [], error: 'registry.list() returned a non-array value' }
      }
      return { ok: true, rows, error: null }
    } catch (error) {
      return { ok: false, rows: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 当前可派活的 id 列表（排除自己、排除 broken；2026-11-02 起不再有任何名单过滤）。 */
  const knownIds = async () => {
    const registry = serviceOf('agentPresets')
    // 2026-11-07 修（R9，#5）：返回结构带 ok，不再把「读失败」塌成 []。
    // 读失败与「真空名册」对调用方必须是两种状态。
    if (registry === undefined) return { ok: false, ids: [], error: 'the agent-preset registry is unavailable' }
    const listed = await safeList(registry)
    if (!listed.ok) {
      // 读不到 ≠ 不存在：必须响，否则上层会把故障当成「没有可用模式」。
      warn('reading the agent-preset registry failed: ' + listed.error + ' — this is NOT the same as "no preset exists"')
      return { ok: false, ids: [], error: listed.error }
    }
    return {
      ok: true,
      ids: usableIds(listed.rows, selfId),
      error: null,
    }
  }

  /**
   * 「这个 preset 能不能用」的统一前置 —— `delegate` 唯一的存在性/可用性闸。
   *
   * ⚠️ 2026-11-02 新增（第二轮复核抓到的 P2-2）：原来 `delegate()` 把 self → registry
   * → known/broken 三道前置散在函数体里，别的路径复用不到。抽成一个函数后，任何新增
   * 派活路径都先过它：不存在 / broken / self 在**起会话之前**就给出结构化回执，
   * 不白建子会话。
   *
   * @param presetId - 已 trim 过的 preset id。
   * @returns `undefined`（可用）或一个结构化 failure（`{ ok:false, ... }`）。
   */
  const presetUnusable = async (presetId) => {
    if (presetId === selfId) {
      return failure(
        'self-preset',
        `"${presetId}" is this mode itself; delegate from a parent or use a different mode.`,
        { stop: true, presetId },
      )
    }
    // 部署级硬闸：`config.disabledPresets` 里的 id 一律不许派。
    if (disabledPresets.has(presetId)) {
      return failure(
        'preset-disabled',
        `"${presetId}" is disabled in this deployment (config.disabledPresets of blackpig-roster).`,
        { stop: true, presetId, nextAction: 'pick a mode that is not disabled' },
      )
    }
    const registry = serviceOf('agentPresets')
    if (registry === undefined || typeof registry.list !== 'function') {
      return failure('registry-unavailable', 'The agent-preset registry is unavailable, so no mode can be selected.', { stop: true, presetId })
    }
    // ⚠️ 2026-11-07 修（R8，#1）：只读一次注册表，并且**先分清**「读失败」与「读到了但没这个 id」。
    const listed = await safeList(registry)
    if (!listed.ok) {
      warn('reading the agent-preset registry failed while checking "' + presetId + '": ' + listed.error + ' — this is NOT the same as "unknown preset"')
      return failure(
        'registry-unreadable',
        `The agent-preset registry could not be read, so "${presetId}" cannot be checked for existence. ` +
          `This is a registry read failure, not proof that the preset does not exist: ${listed.error}`,
        { stop: true, presetId },
      )
    }
    const rows = listed.rows
    const known = usableIds(rows, selfId)
    if (known.includes(presetId)) return undefined
    const brokenRow = rows.find((row) => row?.id === presetId)
    if (brokenRow !== undefined && typeof brokenRow.broken === 'string' && brokenRow.broken !== '') {
      return failure(
        'preset-broken',
        `"${presetId}" exists but cannot compose a session: ${brokenRow.broken}`,
        {
          stop: false,
          nextAction: 'choose another mode from the roster',
          presetId,
          broken: brokenRow.broken,
        },
      )
    }
    return failure(
      'unknown-preset',
      `Unknown agent preset "${presetId}".`,
      {
        stop: false,
        nextAction: known.length === 0 ? 'no usable mode; report to the user' : `choose one of: ${known.join(', ')}`,
        presetId,
      },
    )
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Delegate a self-contained task to a worker running under one specific installed agent mode (preset). ' +
        '`preset` is REQUIRED — there is no default, because the wrong default silently wastes a whole run. ' +
        'Call with `list: true` FIRST to read the roster: it is rendered from the static preset benchmark ' +
        '(preset-caps.json) and states, per mode, how many tools it holds and what it is / is not suitable for. ' +
        'Pick by that suitability, not by the mode name. ' +
        'The roster only shows modes that were benchmarked. ' +
        'A returned `degraded` field is absent when nothing degraded; `stop: true` means do not retry. ' +
        'The worker does not see this conversation, so the brief must be self-contained. ' +
        'It starts in the background and this call returns its id immediately.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: {
            type: 'string',
            description: 'Exact agent-preset id from the roster. Required. Call with `list: true` if you do not know the ids.',
          },
          prompt: {
            type: 'string',
            description: 'The complete, self-contained task. The worker runs under a DIFFERENT mode and cannot see this conversation.',
          },
          description: {
            type: 'string',
            description: 'A short (3-5 word) label for display.',
          },
          list: {
            // 2026-11-14 第三轮：`list: { all: true }` 已移除，参数回到纯 boolean。
            //
            // 为什么删（两条理由都经代码核查）：
            //   ① 只服务基准测试，日常无用 —— 黑猪日常只需 `list: true`（读 preset-caps.json）+ `delegate`；
            //   ② 它绕过 hidden 过滤 —— `renderAllPresetIds()` 完全不读 `preset-caps.json`、不判 hidden，
            //      而 `renderRoster()` 有两道过滤（跳过 self、跳过 `hidden: true`）。留着 `all: true`
            //      等于开一条「名册不显示、但能列出来」的后门。
            // 替代：基准测试第 1 步改成「派一个 standard worker 读 cordis.patch.yml 列 preset id」
            // （depth 仍为 2，不超 maxDepth；worker 有 read/grep），见 docs/preset-bench.md 第三节。
            type: 'boolean',
            description:
              '`true` returns the capability roster rendered from preset-caps.json: per mode, how many tools ' +
              'it holds and what it is / is not suitable for. Leave it out to delegate.',
          },
        },
        required: [],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        // 2026-11-15：名册字节硬顶移除后，回执不再有任何预算收口 —— 原样渲染。
        render: (renderArgs, renderValue) => render(renderArgs, renderValue),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args?.list === true) {
          const loaded = loadPresetCaps()
          if (!loaded.ok) {
            return failure(
              'preset-caps-missing',
              'No preset baseline data found (未找到基准数据). Looked for ' +
                '~/.dsh/blackpig-preset-caps.json and <package>/defaults/preset-caps.json:\n  ' +
                loaded.errors.join('\n  ') +
                '\n\nRun the preset benchmark once and write the result to ~/.dsh/blackpig-preset-caps.json ' +
                '(see docs/preset-bench.md). Until then the roster cannot be rendered; `delegate` still works ' +
                'for any mode id you already know.',
              {
                stop: false,
                nextAction: 'create ~/.dsh/blackpig-preset-caps.json (see docs/preset-bench.md)',
              },
            )
          }
          const rendered = renderRoster(loaded.caps, selfId)
          return {
            ok: true,
            message: rendered.text,
            ...rendered.degraded.length === 0 ? {} : { degraded: rendered.degraded },
          }
        }

        // ── 2026-11-14 第三轮：`list: { all: true }` 分支已整体移除 ──────────────
        //
        // 原来这里有一段「`args.list` 是对象且 `all === true` → 走 registry.list() 只回 id」
        // 的逻辑（外加 `all: false` 回落名册的兼容分支）。两条理由删掉它：
        //   ① 只服务基准测试，日常只用 `list: true` + `delegate`；
        //   ② 它绕过 hidden 过滤（`renderAllPresetIds()` 不读 preset-caps.json、不判 hidden，
        //      而 `renderRoster()` 会跳过 self 与 `hidden: true`）。
        // Schema 也已回到纯 boolean，所以对象形态会被宿主直接拒绝，不需要在代码里兜。
        // 基准测试要「有哪些 id」改为派 worker 读 cordis.patch.yml（见 docs/preset-bench.md）。

        return delegate(args, exec)
      },
    })
  } catch (error) {
    warn(`registering "${TOOL_NAME}" failed: ${error instanceof Error ? error.message : String(error)} — cross-mode dispatching is unavailable`)
  }
}
