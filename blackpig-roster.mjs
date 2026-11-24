/**
 * blackpig-roster — 给大脑一张「代理名册」+ 跨模式派活工具。
 *
 * 起因：实测大量会话日志，协调者**从未**传过 `agent_preset`，于是全部落到
 * `agentPreset: "standard"`。而部署里装的专用模式（任何需要特殊工具面的模式）
 * 与 standard 都不同，活派给 standard 就干不了，白烧一轮且不报错。
 * 根因不是模型懒，是「不传也能成功」。所以本模块把「用哪个模式」变成必填参数。
 *
 * 名册完全 live：从活注册表派生（`agentPresets.acquireScope` + `tools.view` + `skills.list`）。
 * 不读任何基准文件；接口缺失时明确报 `live roster unavailable`，不编造模式、不猜能力。
 *
 * 派活（`delegate`）仍然走**活校验**：`registry.list()` 确认目标模式真实存在且没坏。
 *
 * ── 2026-11-24：可续 worker 复用硬判据 ──────────────────────────────────────
 * 当调用方存在 `mode === 'continuable'` 的直接子会话时，`delegate` 要求**显式二选一**：
 *   · `reuseId` —— 冷恢复既有 worker（走 compat.callSendMessage，不新建子会话）；
 *   · `fresh: true` —— 明确新开。
 * 两者都不传 → 结构化拒绝 `reusable-worker-exists`，只在被拒时附带 ≤3 个候选，
 * 正常路径零新增 token。名册来自 durable catalog 投影（compat.readCallerChildCatalog），
 * 不进每轮上下文、不判断 desc 相似（避开 I7：上下文重叠 ≠ 任务相似；I3 验证新实例例外）。
 *
 * @module blackpig-model/blackpig-roster
 */

import { callSendMessage, readCallerChildCatalog, resolveTargetId } from './compat.mjs'


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
/**
 * 当前工作目录 —— 技能枚举必须带 cwd，否则会漏掉项目级技能。
 *
 * @param ctx - 插件上下文。
 * @returns 非空字符串 cwd（取不到时退回 process.cwd()）。
 */
async function currentCwd(ctx) {
  try {
    const wd = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (wd !== undefined && wd !== null && typeof wd.ensure === 'function') {
      const current = await wd.ensure()
      if (typeof current === 'string' && current.trim() !== '') return current
      if (current !== null && typeof current === 'object' && typeof current.cwd === 'string' && current.cwd.trim() !== '') {
        return current.cwd
      }
    }
  } catch {
    // 服务缺失 / 抛错 → 退回 process.cwd()。
  }
  try {
    return process.cwd()
  } catch {
    return '.'
  }
}

/**
 * 从**活注册表**实时派生每个已安装模式的工具清单与技能清单。
 *
 * 每个模式通过 `agentPresets.acquireScope(id)` 拿到该 preset 的 ScopeKey，
 * 再用 `tools.view(key).visible.keys()` 取「已应用 restriction 的可见工具名」
 * （不用 definitions()/schemas()：前者多一次数组分配，后者深拷贝）。
 * 技能用 `skills.list({ cwd, scope: key })`。
 *
 * @param ctx - 插件上下文。
 * @param selfId - 本模式自己的 preset id（名册不列自己）。
 * @returns 行数组；接口缺失（老宿主）时返回 null（调用方改报 live roster unavailable）。
 *   单模式失败**不拖垮整体**：该行回填 `live:false` 与错误原因。
 */
async function collectLive(ctx, selfId) {
  const get = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const presets = get('agentPresets')
  const tools = get('tools')
  if (typeof presets?.acquireScope !== 'function' || typeof tools?.view !== 'function') return null

  const skills = get('skills')
  const cwd = await currentCwd(ctx)
  let rows
  try {
    rows = await presets.list()
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null

  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.id === selfId) continue
    // broken 模式不许消失：仍出一行，写 — [unknown]。
    if (row.broken !== undefined) {
      out.push({
        id: row.id,
        tools: [],
        skills: [],
        live: false,
        broken: String(row.broken),
        error: 'broken: ' + String(row.broken),
      })
      continue
    }
    let lease
    try {
      lease = await presets.acquireScope(row.id)
      const names = [...tools.view(lease.key).visible.keys()]
      let skillNames = []
      try {
        if (skills !== undefined && skills !== null && typeof skills.list === 'function') {
          const listed = await skills.list({ cwd, scope: lease.key })
          if (Array.isArray(listed)) {
            skillNames = listed.map((entry) => String(entry?.name ?? '')).filter((entry) => entry !== '')
          }
        }
      } catch {
        // 技能枚举失败不影响工具名册。
      }
      out.push({ id: row.id, tools: names, skills: skillNames, live: true })
    } catch (error) {
      out.push({
        id: row.id,
        tools: [],
        skills: [],
        live: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // 必须释放：generation.users 不归零时该 preset 永不卸载。
      try {
        await lease?.[Symbol.asyncDispose]?.()
      } catch {
        // dispose 失败不改变名册结论。
      }
    }
  }
  return out
}


/** 三位补零编号。 */
const num3 = (n) => String(n).padStart(3, '0')

/** 把一组序号压缩成连续区间字符串：`[001-064]` 或碎段 `[012] [034]`。 */
function compressRuns(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return '[]'
  const sorted = nums.slice().sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0], prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i]
    else { ranges.push([start, prev]); start = prev = sorted[i] }
  }
  ranges.push([start, prev])
  return ranges.map(([a, b]) => a === b ? `[${num3(a)}]` : `[${num3(a)}-${num3(b)}]`).join(' ')
}

/**
 * 渲染全局编号表：按序号升序、`[NNN] 工具名` 逗号平铺、每行约 100 字符折行、绝不截断。
 *
 * 2026-11-24 索引命名空间折叠：`mcp__<server>__<tool>` 的**连续同 server 组**折成
 * 组头 `mcp__<server>__: ` + 组内 `[NNN] <tool>,`（去掉每项重复的 server 前缀）。
 * 编号本身不变（仍是首现发号）；单工具 server 不折叠（折叠不省字节）。
 *
 * @param numbering - 编号 Map（renderRows 现场计算）。
 * @returns 编号表文本（不含首尾空行）。
 */
function renderNumberedTable(numbering) {
  if (numbering.size === 0) return '  (empty)'
  const entries = [...numbering.entries()].sort((a, b) => a[1] - b[1])
  const MCP = /^mcp__([A-Za-z0-9_.-]+)__(.+)$/
  const lines = []
  let line = ''

  const pushPiece = (piece) => {
    if (line === '') {
      line = piece
      return
    }
    if (line.length + piece.length > 100) {
      lines.push(line.replace(/,\s*$/, ','))
      line = piece
      return
    }
    line += piece
  }
  const flush = () => {
    if (line.trim() !== '') lines.push(line.replace(/,\s*$/, ','))
    line = ''
  }

  let i = 0
  while (i < entries.length) {
    const [name, n] = entries[i]
    const match = MCP.exec(name)
    if (match === null) {
      pushPiece(`[${num3(n)}] ${name}, `)
      i += 1
      continue
    }
    const server = match[1]
    // 收集「连续同 server」的整段。
    const items = []
    let j = i
    while (j < entries.length) {
      const next = MCP.exec(entries[j][0])
      if (next === null || next[1] !== server) break
      items.push({ tool: next[2], n: entries[j][1] })
      j += 1
    }
    if (items.length < 2) {
      pushPiece(`[${num3(n)}] ${name}, `)
      i += 1
      continue
    }
    // 组：flush 当前普通行 → 组头 → 组内工具（续行缩进两格）→ flush。
    flush()
    line = `mcp__${server}__: `
    for (const item of items) pushPiece(`[${num3(item.n)}] ${item.tool}, `)
    flush()
    i = j
  }
  flush()
  return lines.join('\n')
}

/** 技能编号显示：01–99 补零两位，≥100 用 `s100` 形式。 */
const skillLabel = (n) => (n < 100 ? String(n).padStart(2, '0') : String(n))

/**
 * 把技能编号压成 `s[01-07]` / `s[02,04-07]`：连续段合并、散号单列，与工具区间同一套规则。
 *
 * @param nums - 该模式的技能编号数组。
 * @returns `s[…]` 文本。
 */
function compressSkillRuns(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 's[]'
  const sorted = [...nums].sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i]
      continue
    }
    ranges.push([start, prev])
    start = sorted[i]
    prev = sorted[i]
  }
  ranges.push([start, prev])
  const body = ranges.map(([a, b]) => (a === b ? skillLabel(a) : `${skillLabel(a)}-${skillLabel(b)}`)).join(',')
  return `s[${body}]`
}

/**
 * 渲染技能索引：按编号升序、`[sNN] 名字` 逗号平铺、每行约 100 字符折行，绝不截断。
 *
 * @param numbering - 技能编号 Map。
 * @returns 技能索引文本（不含首尾空行）。
 */
function renderSkillTable(numbering) {
  const entries = [...numbering.entries()].sort((a, b) => a[1] - b[1])
  const lines = []
  let line = ''
  for (let i = 0; i < entries.length; i++) {
    const [name, n] = entries[i]
    const piece = `[s${skillLabel(n)}] ${name}` + (i < entries.length - 1 ? ', ' : '')
    if (line.length + piece.length > 100 && line !== '') {
      lines.push(line.replace(/,\s*$/, ','))
      line = piece
    } else {
      line += piece
    }
  }
  if (line !== '') lines.push(line.replace(/,\s*$/, ','))
  return lines.join('\n')
}

/**
 * 渲染名册（2026-11-24：完全 live 派生，不再读任何静态文件）。
 *
 * 输出形状：
 *
 *     Tool roster (A numbering: first-seen order across presets; installed modes missing here can still be dispatched if you know their id)
 *     Global tool index (N tools):
 *     [001] tool_a, [002] tool_b, …
 *
 *     - standard: [001-064]
 *     - minimal: [003-005] [015-032]
 *     skills: 12 installed — a, b, c; x only in modeA, modeB
 *
 * 规则：
 *   · 编号按 rows 顺序（registry 顺序）× 每个模式自己的工具顺序首现分配，绝不截断。
 *   · 每模式只用编号区间表达：不写 `(N tools)`、不写 suitable / notSuitable。
 *   · 取不到的模式行写 `— [unknown]`。
 *   · 技能只在 live 行里聚合；`only in …` 只列「不是所有 live 模式都有」的技能。
 *   · **不设字节上限**（`ROSTER_HARD_CAP_BYTES` 已整体移除，别加回来）。
 *
 * @param rows - `[{ id, tools, skills?, live }]`，顺序即 registry 顺序。
 * @returns `{ text, degraded }`。
 */
function renderRows(rows) {
  const degraded = []
  if (!Array.isArray(rows) || rows.length === 0) {
    return { text: 'No preset entry is visible.', degraded: ['roster-empty'] }
  }

  // A 规则编号：rows 顺序 × 每个模式的工具顺序，首现发号。
  const numbering = new Map()
  for (const row of rows) {
    for (const raw of Array.isArray(row?.tools) ? row.tools : []) {
      const name = String(raw)
      if (!numbering.has(name)) numbering.set(name, numbering.size + 1)
    }
  }

  const lines = [
    'Tool roster (A numbering: first-seen order across presets; installed modes missing here can still be dispatched if you know their id)',
    '',
    `Global tool index (${numbering.size} tools):`,
    renderNumberedTable(numbering),
    '',
  ]

  // 技能编号：rows 顺序 × 每模式技能顺序（skills.list() 返回序），首现发号。
  const skillRows = rows.filter((row) => row?.live === true && Array.isArray(row.skills))
  const skillNumber = new Map()
  for (const row of skillRows) {
    for (const raw of row.skills) {
      const name = String(raw)
      if (!skillNumber.has(name)) skillNumber.set(name, skillNumber.size + 1)
    }
  }
  if (skillNumber.size > 0) {
    lines.push(`Skill index (${skillNumber.size}):`)
    lines.push(renderSkillTable(skillNumber))
    lines.push('')
  }

  for (const row of rows) {
    const tools = Array.isArray(row?.tools) ? row.tools : []
    const nums = tools.map((tool) => numbering.get(String(tool))).filter((n) => typeof n === 'number')
    if (row.unknown === true || row.live !== true) {
      lines.push(`- ${row.id}: — [unknown]`)
      continue
    }
    const skillNums = row.live === true && Array.isArray(row.skills)
      ? row.skills.map((name) => skillNumber.get(String(name))).filter((n) => typeof n === 'number')
      : []
    const skillPart = skillNums.length > 0 ? ` | ${compressSkillRuns(skillNums)}` : ''
    lines.push(`- ${row.id}: ${compressRuns(nums)}${skillPart}`)
  }

  return { text: lines.join('\n'), degraded }
}

/**
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
   * 取调用方（sender）自己的 durable 子会话目录里的**可续** worker（mode === 'continuable'）。
   *
   * 数据源 = compat.readCallerChildCatalog()：主路径 sessionQuery.subagentCatalog 投影，
   * 退路 subagents.listDescendants()。这是**客观名册**，只在此刻的调用里读取，不进
   * 每轮上下文、不缓存进模型上下文。读不到（searched:false）时返回 null —— 与
   * 「名册为空」区分：读不到时不施加硬判据（宁可漏拦，不可把查询故障变成拒活）。
   *
   * @param sender - 调用方 agent。
   * @param signal - 取消信号。
   * @returns {Promise<Array|null>} 可续 worker 行数组（可能空）；null = 目录读不到。
   */
  const reusableChildrenOf = async (sender, signal) => {
    let sub
    try {
      sub = ctx.get?.('subagents')
    } catch {
      sub = undefined
    }
    const catalog = await readCallerChildCatalog(ctx, sub, sender, signal)
    if (catalog.searched !== true) return null
    return catalog.rows.filter((row) => row?.mode === 'continuable')
  }

  /**
   * 把可续 worker 渲染成 ≤3 个候选（只在拒绝回执里出现，正常路径零 token）。
   *
   * 每行给 id / name / mode，模型可直接复制完整 id 作 reuseId。
   *
   * @param rows - 可续 worker 行。
   * @returns {string[]}
   */
  const renderReuseCandidates = (rows) =>
    rows.slice(0, 3).map((row) => {
      const name = typeof row.name === 'string' && row.name !== '' ? `${row.name} = ` : ''
      return `${name}${row.id} [${row.mode}]`
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

    // ── 2026-11-24：可续 worker 复用硬判据（客观名册，二选一）──────────────────
    // 名册来自 durable catalog 投影，不进每轮上下文。只在检测到**存在可续 worker**时
    // 才要求显式选择；没有可续 worker 时保持原行为，零 friction。绝不判断 desc 相似
    // （I7：上下文重叠 ≠ 任务相似；I3：验证必须独立——新实例正好用来独立核对）。
    const reusable = await reusableChildrenOf(parent, exec?.signal)
    if (reusable !== null && reusable.length > 0) {
      const reuseId = typeof args?.reuseId === 'string' ? args.reuseId.trim() : ''
      const fresh = args?.fresh === true
      const hasReuse = reuseId !== ''
      const hasFresh = fresh

      // 两者都不传 → 硬拒；只在此刻回 ≤3 个候选（正常路径零 token）。
      if (!hasReuse && !hasFresh) {
        return failure(
          'reusable-worker-exists',
          `${reusable.length} reusable worker(s) exist in this conversation. Choose explicitly: pass ` +
            '`reuseId` (full childSessionId or unique prefix) to cold-resume one, or `fresh: true` to start a new worker. ' +
            'Candidates (copy a full id into reuseId): ' + renderReuseCandidates(reusable).join(', ') + '. ' +
            'No choice was made, so nothing was dispatched.',
          { stop: true, degraded: ['reuse-choice-required'] },
        )
      }
      // 两者都传 → 同样拒绝（不猜用户意图）。
      if (hasReuse && hasFresh) {
        return failure(
          'reuse-choice-conflict',
          'Pass either `reuseId` or `fresh: true`, not both.',
          { stop: true },
        )
      }

      if (hasReuse) {
        // 冷恢复：解析 reuseId（完整 id 直通 / 唯一前缀命中），再走 compat.callSendMessage
        // 把 brief 投递进既有 worker 的新一轮——绝不新建子会话。
        const sub = serviceOf('subagents')
        if (sub === undefined || typeof sub.sendMessage !== 'function') {
          return failure('subagents-unavailable', 'The subagents service is unavailable, so no worker can be resumed.', { stop: true })
        }
        const knownIds = new Set(reusable.map((row) => row.id))
        let resolved
        try {
          resolved = await resolveTargetId(ctx, reuseId, {
            sub,
            sender: parent,
            signal: exec?.signal,
            isKnownId: async (candidate) => knownIds.has(candidate),
            logger: ctx.logger,
          })
        } catch (error) {
          return failure(
            'reuse-id-unresolved',
            `reuseId ${JSON.stringify(reuseId)} could not be resolved to one of your reusable workers: ` +
              (error instanceof Error ? error.message : String(error)),
            { stop: true, degraded: ['reuse-id-unresolved'] },
          )
        }
        // 解析结果必须仍是可续 worker 之一（防止名字解析到别的子会话）。
        if (!knownIds.has(resolved.id)) {
          return failure(
            'reuse-id-unresolved',
            `reuseId resolved to ${resolved.id}, which is not a reusable worker of this conversation.`,
            { stop: true },
          )
        }
        try {
          const sent = await callSendMessage(ctx, {
            target: reuseId,
            resolvedId: resolved.id,
            resolvedBy: resolved.how,
            resolutionNote: resolved.note,
            message: prompt,
            sender: parent,
            signal: exec?.signal,
            sub,
            logger: ctx.logger,
          })
          if (sent?.ok === false || typeof sent?.messageId !== 'string' || sent.messageId === '') {
            return failure(
              'reuse-send-failed',
              'The worker was resolved but the resume message could not be confirmed: ' + (sent?.message ?? 'no message id from host'),
              { stop: false, presetId, degraded: ['reuse-send-unconfirmed'] },
            )
          }
          return {
            ok: true,
            presetId,
            childSessionId: resolved.id,
            message:
              `Reused existing ${presetId} worker ${resolved.id} (cold resume; no new worker started). ` +
              `The brief was delivered to its next turn; messageId=${sent.messageId}. ` +
              'Continue with `send_to_subagent` using this childSessionId.',
            evidence: { broken: null, presetId, childSessionId: resolved.id, level: 'resumed' },
          }
        } catch (error) {
          return failure(
            'reuse-send-failed',
            `Resuming worker ${resolved.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            { stop: false, presetId },
          )
        }
      }
      // hasFresh → 落到下面的新建逻辑。
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
    // 现在：名册只展示 live 里的模式；没显示的模式仍可派（delegate 走活校验）。
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
          'Record that id now (into `todo_write`): `send_to_subagent` takes it as `agent_id`, and also accepts this worker\'s agent name or an unambiguous id prefix. ' +
          'It is a continuable subagent in this tree, not a teammate: `list_agents` lists it as a row named by ' +
          'its path from the root, and a `running` row means it is working now. Tell the user ' +
          'what you dispatched, ' +
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
        'Delegate a task to a worker running under one specific installed agent mode (preset). ' +
        '`preset` is REQUIRED — there is no default, because the wrong default silently wastes a ' +
        'whole run. Call `list: true` first; pick by capability ranges, not mode name. An installed mode missing from the roster can still be dispatched if you know its id. ' +
        'When reusable workers already exist in this conversation you MUST choose explicitly: pass `reuseId` (a childSessionId from the roster or a prior receipt) to cold-resume one, or `fresh: true` to start a new worker; otherwise the call is refused with `reusable-worker-exists` and up to 3 candidates. When no reusable worker exists, neither is needed. ' +
        'A returned `degraded` field is absent when nothing degraded; `stop: true` means do not retry. The ' +
        'worker does not see this conversation. It starts in the background and this call returns its ' +
        'id immediately.',
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
            description: 'The complete, self-contained task. The worker runs under a DIFFERENT mode.',
          },
          description: {
            type: 'string',
            description: 'A short (3-5 word) label for display.',
          },
          list: {
            // `list` 是纯 boolean：`{ all: true }` 分支已于 2026-11-14 移除（只服务旧基准流程，且绕过 hidden 过滤）。
            type: 'boolean',
            description:
              '`true` returns the roster — a global numbered tool index plus per-mode tool-number ranges, ' +
              'and the installed skills.',
          },
          reuseId: {
            type: 'string',
            description:
              'Cold-resume an existing reusable worker instead of starting a new one: a full childSessionId ' +
              'or an unambiguous prefix. Required (or `fresh: true`) when reusable workers exist.',
          },
          fresh: {
            type: 'boolean',
            description:
              'Explicitly start a new worker even when reusable ones exist. Mutually exclusive with `reuseId`.',
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
          const live = await collectLive(ctx, selfId)
          if (live === null) {
            return {
              ok: true,
              message: 'live roster unavailable: agentPresets.acquireScope is missing',
              degraded: ['live-roster-unavailable'],
            }
          }
          const rendered = renderRows(live)
          return {
            ok: true,
            message: rendered.text,
            ...rendered.degraded.length === 0 ? {} : { degraded: rendered.degraded },
          }
        }

        // `list: { all: true }` 分支已整体移除；需要模式清单直接 `list: true`（Schema 只接受 boolean）。

        return delegate(args, exec)
      },
    })
  } catch (error) {
    warn(`registering "${TOOL_NAME}" failed: ${error instanceof Error ? error.message : String(error)} — cross-mode dispatching is unavailable`)
  }
}
