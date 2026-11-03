/**
 * blackpig-roster — 给大脑一张「代理名册」+ 跨模式派活工具。
 *
 * 起因：实测大量会话日志，协调者**从未**传过 `agent_preset`，于是全部落到
 * `agentPreset: "standard"`。而部署里装的专用模式（任何需要特殊工具面的模式）
 * 与 standard 都不同，活派给 standard 就干不了，白烧一轮且不报错。
 * 根因不是模型懒，是「不传也能成功」。所以本模块把「用哪个模式」变成必填参数。
 *
 * 名册数据源：`agentPresets.compositionInventory()`。它返回**已算好 enabled 的行**
 * （平台条件如 `disabled: !!js …` 已求值），不需要启动会话，也不需要自己解析 YAML。
 *
 * 名册**自身**拿不到的东西：某模式**运行时真实可调用的工具名** —— 宿主的
 * `definitions(scope)` 要求 scope 是活跃 Agent。这是真实缺口，名册不拿推测填补。
 *
 * 补这个缺口的办法是 `ask: true`（2026-11-02 加）：**起一个短代理问那个模式自己**
 * 「你能调哪些工具」。它拿到的仍是**被问方的自述**（`evidence.level: self-report`），
 * 所以与 `detail: true`（读到的 YAML 事实）严格区分，前者是提示、后者是事实。
 *
 * @module blackpig-model/blackpig-roster
 */

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

/** 名册硬顶（字节）。超了先折最长行，不按 preset 截断 —— 截断会丢掉整份模式。 */
const ROSTER_HARD_CAP_BYTES = 4000

/**
 * `detail: true` 单次注入的字节上限（默认 16 KB ≈ 4,000 token）。
 *
 * 2026-11-02 加（第四轮复核的自查发现）：原来没有上限，实测一个 33 KB 的声明会
 * 原样注入（≈8,000 token）。`detail` 的定位是「三步阶梯里第二步」，比 `ask`（几十
 * token）贵、比派真实任务便宜 —— 但没有上限时它可能比派任务还贵。
 *
 * 16 KB 的依据：本项目三个 preset 里两个是 3.4 KB（远低于上限，不受影响），
 * 只有 `blackpigmodel` 自己 33 KB 会被截 —— 而它是最不需要 detail 的那个
 * （大脑自己就是那个模式）。真要看全文的场景，回退手段写在截断提示里。
 *
 * 想调大：`config.detailMaxBytes`（正整数）覆盖。
 */
const DETAIL_MAX_BYTES = 16 * 1024

/**
 * 「没有调用者」的统一拒绝文案。
 *
 * 2026-11-02（审计 R2 自查）：`delegate()` 与 `ask:` 两条路径各写一遍这句话，
 * 一字不差。抽成常量有两个好处：
 *   · 改文案只改一处（两条路径语义相同，不该漂）；
 *   · 用 `NO_CALLER` 这个名字 grep 得到**全部**「必须有 caller」的前置点，
 *     以后新增第三条路径时不会漏（漏了就是一次白烧的 startActivation）。
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

/** 只渲染 `message`；结构化字段留给程序消费，重复贴一遍等于同一段字花两份 token。 */

function render(_args, value) {
  return [{ type: 'text', text: String(value?.message ?? '') }]
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

/** 按 UTF-8 字节量长度（中文字符不能按 .length 算）。 */
const bytes = (text) => Buffer.byteLength(String(text), 'utf8')

/**
 * 从一次 `caller` 交付的代理结果里抽出它的文本。
 *
 * 为什么需要它：`startActivation({ delivery: 'caller' })` 的结果形态是
 * `{ output, stopReason, ... }`，其中 `output` 是内容块数组（`[{ type: 'text', text }]`）。
 * 但不同 backend 的返回形状**没有统一契约**（上游注释只说"caller 交付时无通知"），
 * 所以这里做**宽进**：数组取 text 块、对象取 `.output`/`.text`/`.message`、
 * 字符串直接用。抽不出来就返回空串 —— 调用方据此报 `ask-empty`，不静默成功。
 *
 * @param value - `await activation.result` 得到的任意值。
 * @returns 文本；抽不出时为空串。
 */
function extractProbeText(value) {
  const fromBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return fromBlocks(value)
  if (value === null || typeof value !== 'object') return ''
  const direct = fromBlocks(value.output)
  if (direct !== '') return direct
  for (const key of ['text', 'message', 'content']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    const blocks = fromBlocks(candidate)
    if (blocks !== '') return blocks
  }
  return ''
}

/**
 * 读一个 preset 的原样声明（`detail: true` 用）。不压缩，成本 2.6–5.8 KB/次。
 *
 * 2026-11-02 通用化：递归闸删除后，`isDelegatedChild` 已无调用点（深度由宿主裁决）。
 * 函数体保留在原 `guard-v10` / `member-persona` 里各自独立实现，本模块不再需要它。
 */

async function readPresetDetail(registry, id, maxBytes = DETAIL_MAX_BYTES) {
  let document
  try {
    document = await registry.readDocument(id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'detail-unreadable', message: `Reading "${id}" failed: ${message}` }
  }
  const content = document?.content
  if (typeof content !== 'string' || content === '') {
    return { ok: false, reason: 'detail-empty', message: `"${id}" declares no plugins.` }
  }

  // ⚠️ 2026-11-02 加（第四轮复核点名要查的边界，实测发现）：原来这里**没有任何上限**，
  // 声明多大就注入多大。实测 26 KB 的声明原样返回（≈6,600 token）；而本项目自己的
  // `blackpigmodel` 声明是 **33 KB**（≈8,000 token）。这跟「三步阶梯按成本递增」
  // 的设计正好相反 —— `ask:true` 只要几十 token，`detail` 却可能吃掉近万。
  //
  // 现在加字节上限：超了截断，并在末尾**明确告知**（原件多大、只显示了前多少、
  // 剩下该用什么工具拿）。不静默截断 —— 静默会让模型以为声明就这么多。
  const fullBytes = Buffer.byteLength(content, 'utf8')
  if (fullBytes <= maxBytes) return { ok: true, text: content }

  // 按 **code point** 累加（不是按 UTF-16 码元），否则代理对会被算成 2 个字符、
  // 每个 3 字节（= 6 字节），而实际一个 emoji 只有 4 字节 —— 会少截近一半。
  // 实测：'🎬'.repeat(10)\ 限 12 字节，按码元迭代只给 2 个 emoji（应为 3 个）。
  // 用 Array.from 展开成 code point 序列，累计 UTF-16 长度用于 slice。
  let used = 0
  let cut = content.length
  let consumedUtf16 = 0
  for (const ch of Array.from(content)) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (used + chBytes > maxBytes) { cut = consumedUtf16; break }
    used += chBytes
    consumedUtf16 += ch.length
  }
  const kb = (n) => (n / 1024).toFixed(1)
  return {
    ok: true,
    text:
      content.slice(0, cut) +
      '\n\n[... truncated by blackpig-roster: this declaration is ' + kb(fullBytes) + ' KB; ' +
      'only the first ' + kb(used) + ' KB is shown. ' +
      "Use `ask: true` for a cheap capability answer, or read the mode's preset file directly if you need the rest.]",
  }
}
/**
 * 名册数据源：`compositionInventory()`。
 *
 * 相比读 `readDocument().content` 的两个好处：不用自己解析 YAML；
 * 平台条件行（`disabled: !!js …`）由宿主求值，名册里不会再有"不确定"。
 *
 * 拿不到 `config` 和**工具名** —— 名册只需要「哪些模块启用了」，不需要这两样。
 */


/**
 * 模块名 → 能力标签的**默认**映射。**只映射对选人有信息量的模块**。
 *
 * 刻意不映射三类：① 每个模式都有的样板（persona 等）；② 内部机制（compaction、裁剪）；
 * ③ 子路径（`…/list-agents`，父模块已代表该能力）。
 * 未映射的模块**不会静默丢弃** —— 显示为 `?原名`，让调用方知道它存在。
 *
 * ⚠️ **这里面禁止出现任何项目专用模块**（2026-11-02 通用化）。
 *
 * 为什么：这份表跟着「黑猪模式」走，而插件的模块名是**项目/部署级**的事实。
 * 把 `dsh-example-plugin` 写死在这里，就等于让模式认识某一个项目的插件 ——
 * 换一个项目，它变成永不命中的死行；更要命的是**自检会硬断言它必须存在**，
 * 于是那份耦合删不掉，模式永远无法做成通用件。
 *
 * 项目专用标签由 **config.capabilityHints** 注入（见 `apply`），例如：
 *
 *     capabilityHints:
 *       'dsh-example-plugin': EXAMPLE
 *       'dsh-example-media': EXAMPLE_MEDIA
 *
 * 合并语义：config 覆盖默认（同名以 config 为准），未列出的默认项保留。
 */

const DEFAULT_CAPABILITY_HINTS = {
  // 干活能力
  'dsh-tool-fs': 'files',
  'dsh-tool-fs-search': 'search',
  'dsh-tool-pwsh': 'shell',
  'dsh-tool-bash': 'shell',
  'dsh-tool-bash-persistent': 'shell',
  'dsh-tool-pwsh-persistent': 'shell',
  'dsh-terminal': 'shell',
  'dsh-terminal-bash': 'shell',
  // ⚠️ 2026-11-02 删了三条**永不命中的死行**（用户要求逐条查清后清理）：
  //
  //   'dsh-terminal-pwsh'      → shell      ← 不是模块名，是 YAML 的 `id: terminal-pwsh`；
  //                                           真实 name 是 `@deepseek-ai/dsh-terminal-bash`
  //                                           （靠 shellDialect: pwsh 跑 PowerShell）
  //   'dsh-tool-pty'           → shell      ← 完全不存在（asar 里连 "tool-pty" 都是 0 次）；
  //                                           真实 pty 行是 name: `@deepseek-ai/dsh-terminal`
  //   'dsh-tool-subagent-fork' → CAN-SPAWN  ← 不是模块名，是 YAML 的 `id: tool-subagent-fork`；
  //                                           真实 name 还是 `@deepseek-ai/dsh-tool-subagent`
  //                                           （只是换了 config: provider=fork）
  //
  //   查证方法：对 asar 全文按 `name: "@deepseek-ai/<key>"` / `node_modules` 路径匹配。
  //   这三条命中 0。删除**不丢能力**：`dsh-terminal` / `dsh-terminal-bash` /
  //   `dsh-tool-subagent` 都已在上表，能力标注由它们承担。
  'dsh-tool-jobs': 'background-jobs',
  'dsh-tool-schedule': 'scheduled-tasks',
  'dsh-tool-web': 'web',
  'dsh-tool-skill': 'skills',
  'dsh-skill-filesystem': 'skill-pool',
  'dsh-tool-todo': 'todos',
  'dsh-tool-ask-user': 'ask-user',
  'dsh-tool-goal': 'goals',
  'dsh-command-goal': 'goals',
  'dsh-plan-mode': 'planning',
  'dsh-tool-present': 'present',
  'dsh-agent-tool-presentation': 'present',
  // 「能不能再往下派」：是否真的能派由宿主 maxDepth 决定，这里只标注"有委派工具"。
  //
  // ⚠️ 2026-11-02：**`workflow` 也算派活通道**，与 `subagent` 用同一个标记。
  //
  //   原理：`workflow` 工具的 `agent()` 钩子会起子代理（DSH 内置能力）。
  //   所以一个只装了 `workflow`、没装 `subagent` 的模式**同样能往下派**。
  //   名册原来只把它渲染成普通 `workflow` 标签，大脑据此会以为它不能再派活
  //   → 该派嵌套任务时不敢派、或派了却写一句工人手上没有的指令。
  //
  //   为什么**不**区分「workflow 一次性 vs subagent 可续话」：那需要自造词汇
  //   （`CAN-SPAWN-ONESHOT`），而 `CAN-SPAWN-SUBAGENTS` 是宿主契约里的说法。
  //   名册的读者是**大脑**，它只需要知道「能不能往下派」；「用哪个工具、能不能续话」
  //   是工人自己看工具面的事。为一条措辞引入新词 + 两个贯穿 4 个函数的字段，
  //   是拿通用性换精确度 —— 不值得（用户指出后已撤销那版实现）。
  'dsh-tool-subagent': 'CAN-SPAWN-SUBAGENTS',
  'dsh-tool-subagent-control': 'CAN-SPAWN-SUBAGENTS',
  'dsh-workflow-ptc': 'CAN-SPAWN-SUBAGENTS',
  'dsh-tool-workflow': 'CAN-SPAWN-SUBAGENTS',
  // DSH 内置的管理类能力（**不是项目专用**）：装它们的模式能改部署本体，
  // 名册需要把这件事显示出来，否则模型会以为那是普通代理能力。
  'dsh-tool-cordis': 'harness-dev',
  'dsh-plugin-manager/tools': 'plugin-admin',
  'dsh-plugin-market/tools': 'plugin-market',
}

/** 确定不显示的模块。用独立集合而不是映射成空串，避免和「映射失败」混淆。 */

const HIDDEN_MODULES = new Set([
  // ① 每个模式都有的样板
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  // ② 内部机制（上下文压缩/裁剪），与「能干什么活」无关
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
])

/**
 * 模块名 → 能力短标签。三态：`null`（刻意省略）/ 短标签（已识别）/ `?原名`（未映射）。
 *
 * ⚠️ 必须先剥 `@scope/` 前缀再判斜杠。第一版直接 `full.includes('/')`，
 * 而 `@deepseek-ai/` 自带斜杠 —— 所有模块都被当成子路径过滤，名册静默变空。
 *
 * @param moduleName - 模块全名（可带 `@scope/` 前缀）。
 * @param hints - 生效的映射表（默认表 + config 注入，见 `apply`）。
 * @returns 标签、`null`（隐藏）、或 `?原名`（未映射）。
 */

function shortLabel(moduleName, hints) {
  const full = String(moduleName)

  // 先去 scope 前缀（`@deepseek-ai/`、`@dsh-external/`），再做其余判断。
  //
  // ⚠️⚠️ 必须先剥前缀再判斜杠。第一版直接 `full.includes('/')`，
  // 而 `@deepseek-ai/dsh-tool-fs` 里 `@deepseek-ai/` 本身就带斜杠 ——
  // 结果**所有被人维护的模块都被当成"子路径"过滤掉**，名册只剩几个漏网的 file: 模块。
  // 独立实测 2026-10-31：standard 的 tags 变成空数组，baseline 也随之变空，
  // 名册退化成「每个模式都没能力」。这是静默错误，不看真实输出根本发现不了。
  const bare = full.replace(/^@[^/]+\//, '')

  // 子路径模块（`dsh-tool-subagent-control/list-agents`）：父模块已代表该能力，跳过。
  // 用**剥掉 scope 之后**的字符串判断；两个真实例外（包名里带路径）单独放行。
  //
  // ⚠️ 2026-11-02 修（通用性审计 X1）：**先查 hints，再判子路径**。
  //
  // 原实现先判子路径、后查 hints，于是「装了带子路径工具模块的插件」那个项目的
  // 能力在名册里**连 `?` 都不显示** —— 而且 config 救不回来：capabilityHints 里
  // 写全名（`dsh-excel-plugin/tools`）也会在这里被提前 null 掉，写父名又与 bare 对不上。
  // 实测三种写法都是 `- finance-worker: files`（那部分能力彻底消失）。
  //
  // 现在的顺序：
  //   ① 全名命中 hints（运维显式声明「这个子路径代表某种能力」）→ 用它
  //   ② 才算「父模块已代表」的子路径 → 跳过
  // 这样默认行为不变（大多数子路径仍隐藏，因为没人为它声明），但**可配置可显**。
  const fullHit = hints[full]
  if (fullHit !== undefined) return fullHit

  if (bare.includes('/') && bare !== 'dsh-plugin-manager/tools' && bare !== 'dsh-plugin-market/tools') {
    return null
  }

  if (HIDDEN_MODULES.has(full)) return null

  const hit = hints[bare]
  if (hit !== undefined) return hit

  // 未识别：保留原名（去掉 dsh- 前缀），加 ? 表明「存在但我没映射过」。
  return '?' + bare.replace(/^dsh-/, '')
}

/**
 * 从 compositionInventory 的一项里提取能力标签。
 *
 * `canSpawn` 单独返回，因为它在名册里要特殊排版（选人时它和普通能力不是一类信息）。
 *
 * @param composition - `compositionInventory()` 的一项。
 * @param hints - 生效的能力映射表。
 */

function compositionToTags(composition, hints) {
  const rows = Array.isArray(composition?.rows) ? composition.rows : []
  const tags = []
  const seen = new Set()
  let canSpawn = false
  // 委派能力是否是「条件可用」（平台相关）。与 canSpawn 分开存，避免污染 label 比较。
  let canSpawnConditional = false
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue
    // ⚠️ 2026-11-02（第二轮复核抓到的 P2-1）：宿主 `compositionInventory()` 的
    // `enabled` 是**三态**（`true` / `false` / `'conditional'`）—— 见
    // `composition-inventory.js` 的 `definitionComposition(...)` 与 `disabledContribution`
    // 的 catch：平台条件求值失败、或该 preset 还没挂载时返回 `'conditional'`。
    //
    // 原实现 `!== true` 把 `'conditional'` 当「未启用」**静默跳过**，而名册顶部却向
    // 模型保证「平台条件已求值、这里没有任何 conditional」—— 文案与实现相反。
    //
    // 现在：`'conditional'` 的行**照常显示**，标签加 `/cond` 后缀，让模型知道
    // 「这个能力在本平台可能不在」。宁可比实际多报一个带标记的，也不要静默少报 ——
    // 静默少报会让大脑以为某个模式没那个能力，从而派错人。
    if (row.enabled !== true && row.enabled !== 'conditional') continue
    const conditional = row.enabled === 'conditional'
    const label = shortLabel(row.moduleName ?? row.entryId ?? "", hints)
    if (label === null) continue
    // 「能不能再往下派」是选人的关键信息：深度改成 2 之后，某些代理可以扇出。
    // 它排在最后单独标，避免混在能力列表里被忽略。
    //
    // ⚠️⚠️ 2026-11-02 修（第三轮复核抓到的 P2）：这里原来是无条件 `canSpawn = true`
    // 然后 `continue` —— 短路在 `conditional` 判定**之前**，于是委派模块是
    // `enabled:'conditional'` 时，`+CAN-SPAWN-SUBAGENTS` 仍被渲染成**确定可用**，
    // 而名册顶部刚刚承诺「条件行都带 /cond 后缀」。这是全名册里**唯一**漏掉条件标记
    // 的能力，偏偏又是选人最关键的那条（决定「这个模式能不能再派代理」）。
    //
    // 修法：把"条件"信息一并带进 canSpawn 的表示，渲染时据此加标记。
    // 用 `canSpawn`（布尔）+ `canSpawnConditional`（布尔）两个字段，而不是把字符串
    // 拼成 'CAN-SPAWN-SUBAGENTS/cond' —— 后者会污染下游的 `label ===` 比较。
    if (label === "CAN-SPAWN-SUBAGENTS") {
      canSpawn = true
      if (conditional) canSpawnConditional = true
      continue
    }
    const display = conditional ? label + '/cond' : label
    if (seen.has(display)) continue
    seen.add(display)
    tags.push(display)
  }
  return { tags, canSpawn, canSpawnConditional }
}
/** 渲染完整名册：每个模式列出它的能力标签，共有能力提到 baseline 一次。 */

/**
 * 渲染完整名册。
 *
 * @param registry - `agentPresets` 服务。
 * @param selfId - 本模式自己的 preset id（跳过它）。
 * @param warn - 记录器。
 * @param hints - 生效的能力映射表（默认表 + config 注入）。
 * @param capBytes - 名册字节硬顶（`config.rosterMaxBytes`，缺省 `ROSTER_HARD_CAP_BYTES`）。
 * @returns `{ text, degraded }`。
 *
 * ⚠️ 2026-11-02 通用化：**不再有任何白名单/黑名单**。
 *
 * 原设计有两层人工边界（`allowedPresets` 白名单 + `deniedPresets` 黑名单），
 * 全部删除。理由（用户定的设计原则）：
 *   · 模式是可独立安装的组件，黑猪模式不该替运维记「哪些模式允许被派」；
 *   · 名册已经把**能力**列出来了，选人是能力问题，不是名单问题；
 *   · 每加一个新模式就要改黑猪配置，等于模式不可通用。
 *
 * 危险模式（能改部署本体的）由**能力标签**暴露（`harness-dev` / `plugin-admin` /
 * `plugin-market`），由选人方自己判断 —— 名册只读 `registry.list()` 全展示，
 * 不做任何名单过滤。
 */
async function renderRoster(registry, selfId, warn, hints, capBytes = ROSTER_HARD_CAP_BYTES) {
  const degraded = []

  // ── 主数据源：compositionInventory() ──
  // 它给**已经算好 enabled 的行**（平台条件已求值），不需要启动会话。
  let compositions
  try {
    if (typeof registry?.compositionInventory !== "function") {
      throw new Error("this deployment exposes no compositionInventory()")
    }
    compositions = await registry.compositionInventory()
  } catch (error) {
    warn("reading the composition inventory failed: " + (error instanceof Error ? error.message : String(error)))
    // 退回 list()：至少还能给出模式名与 broken 状态（但给不出能力）。
    try {
      const fallback = await registry.list()
      if (!Array.isArray(fallback) || fallback.length === 0) {
        return { text: "The preset roster is empty, so there is no mode to delegate to.", degraded: ["roster-empty"] }
      }
      const names = fallback
        .filter((r) => r !== null && typeof r === "object" && typeof r.id === "string" && r.id !== "" && r.id !== selfId)
        .filter((r) => !(typeof r.broken === "string" && r.broken !== ""))
        .map((r) => r.id)
      if (names.length === 0) return { text: "No usable agent mode was found.", degraded: ["roster-no-usable"] }
      return {
        text:
          "Installed agent modes (capability detail is unavailable in this deployment):\n  " +
          names.join(", ") +
          "\n\nPick by name only if you already know what the mode does; otherwise escalate to `detail: true`.",
        degraded: ["inventory-unavailable"],
      }
    } catch (listError) {
      warn("falling back to list() also failed: " + (listError instanceof Error ? listError.message : String(listError)))
      return { text: "The agent-preset roster is unavailable in this deployment, so no mode can be delegated to.", degraded: ["roster-unavailable"] }
    }
  }

  if (!Array.isArray(compositions) || compositions.length === 0) {
    return { text: "The preset roster is empty, so there is no mode to delegate to.", degraded: ["roster-empty"] }
  }

  const lines = []
  lines.push("Installed agent modes you can delegate to with subagent_preset({preset, prompt}).")
  lines.push("")
  // ⚠️ 2026-11-02（第二轮复核抓到的 P2-1）：原文写「nothing here is conditional」，
  // 而实现把宿主的 `enabled:'conditional'` 三态静默丢掉了 —— 文案与行为相反。
  // 现在如实说明：条件行会显示，但带 `/cond` 后缀。
  lines.push("Each mode lists the capabilities its enabled modules provide. Rows whose availability")
  lines.push("depends on the platform are shown with a /cond suffix — present on some platforms only.")
  lines.push("CAN-SPAWN-SUBAGENTS means that")
  // ⚠️ 2026-11-02（审计 R1 抓到的 P2）：原文把深度写死成 "delegation depth is 2"。
  //
  // 深度早在改动 #3 就已改成**跟随设置面板**（`resolveMaxDepth()` 无参调用），而宿主
  // 默认 `maxDepth` 是 1、本项目配的是 2。写死那句在任何非本项目配置下都是错的
  // （尤其宿主默认值 1 时，名册会让模型以为队友还能再派一层）。
  // 名册是模型判断能力的唯一事实来源，一句写死的数字会直接误导选人。
  // 改为**陈述机制而不给数字**：有委派工具 ≠ 一定能派，最终由部署的深度策略裁决。
  lines.push("mode has delegation tools — whether it can actually delegate further depends on this")
  lines.push("deployment's depth policy, not on this line. A \"subagent depth N exceeds maxDepth M\"")
  lines.push("error means the cap was reached, not that the mode lacks the tool. A leading ? marks an")
  lines.push("unrecognized module that is present but not mapped to a plain word.")
  lines.push("")

  let usable = 0
  // ── 两趟渲染：先算每个模式的能力集，再抽出「所有模式共有」的部分 ──
  //
  // 为什么：实测四个内置模式里，几乎一半模块是共有的（persona / 文件 / 压缩）。
  // 逐行重复列出来，既占预算又淹没真正的差异 —— 而差异才是选人的依据。
  //
  // 所以：共有能力只写一次作为 baseline，每个模式只写**它多出来的**。
  const ready = []
  for (const composition of compositions) {
    if (composition === null || typeof composition !== "object") continue
    const id = typeof composition.id === "string" ? composition.id : ""
    if (id === "") continue

    // 跳过自己：派给自己会被 self-preset 拒，列出来只浪费预算。
    if (id === selfId) continue

    // 挂不起来的模式直接标出来，别让大脑白派一轮。
    if (typeof composition.broken === "string" && composition.broken !== "") {
      ready.push({ id, broken: composition.broken })
      continue
    }

    const { tags, canSpawn, canSpawnConditional } = compositionToTags(composition, hints)
    if (tags.length === 0 && canSpawn === false) {
      degraded.push("no-enabled-modules:" + id)
      ready.push({ id, empty: true })
      continue
    }
    ready.push({ id, tags, canSpawn, canSpawnConditional })
  }

  const usableRows = ready.filter((r) => r.tags !== undefined)

  // baseline：**每个**可运行模式都有的标签。只有一个模式时不做 baseline
  // （否则等于把它的全部能力都写成"共有"，什么都没省）。
  //
  // ⚠️⚠️ 2026-11-02 修（第五轮复核抓到的 B1，P2）：**baseline 只能用"有普通标签"的行算**。
  //
  //   原来直接对 `usableRows` 求交集，而 `usableRows` 里可能存在**只有委派能力、
  //   没有普通标签**的行（`tags === []` 但 `canSpawn === true`，例如一个只装了
  //   `dsh-tool-subagent` 的模式）。它们的空数组参与交集后：
  //     `new Set([...baseline].filter(tag => [].includes(tag)))` → **恒为空集**
  //   于是整份名册的 baseline 压缩静默失效 —— 每个模式改为逐行重列全部能力。
  //
  //   实测后果：10 个模式 + 1 个 spawn-only → baseline 行消失、字节 1860→1980；
  //   60 个模式的真实规模下，**保留数从 54 掉到 46**（8 个模式被挤出截断预算，
  //   在大脑视野里直接消失）。一个模式污染了整份名册。
  //
  //   修法：只让"有普通标签的行"参与 baseline 计算。spawn-only 行照样显示
  //   （它的 `+CAN-SPAWN-SUBAGENTS` 是有效信息），只是不参与"共有能力"的求交。
  const baselineRows = usableRows.filter((r) => Array.isArray(r.tags) && r.tags.length > 0)
  let baseline = new Set()
  if (baselineRows.length >= 2) {
    baseline = new Set(baselineRows[0].tags)
    for (const row of baselineRows.slice(1)) {
      baseline = new Set([...baseline].filter((tag) => row.tags.includes(tag)))
    }
  }

  if (baseline.size > 0) {
    lines.push("- (every mode below): " + [...baseline].join(", "))
    lines.push("")
  }

  for (const row of ready) {
    if (row.broken !== undefined) {
      lines.push("- " + row.id + "  [CANNOT RUN: " + String(row.broken).split("\n")[0].slice(0, 100) + "]")
      continue
    }
    if (row.empty === true) {
      lines.push("- " + row.id + "  [no enabled modules visible]")
      continue
    }
    usable += 1
    const own = row.tags.filter((tag) => !baseline.has(tag))
    const parts = []
    // ⚠️⚠️ 2026-11-02 修（第六轮复核抓到的 BUG-2，P2）：**"nothing beyond the baseline"
    //    这句话原来在这三种情况下都是谎话**：
    //
    //   ① `row.tags` 为空（只有委派模块的 spawn-only 模式）：
    //      `own.length === 0` 成立 → 写"只有 baseline"，但它**连 baseline 里的能力都没有**。
    //      实测：baseline 是 `files, search`，而 dispatcher 只有 `dsh-tool-subagent`，
    //      却渲染成 `- dispatcher: nothing beyond the baseline +CAN-SPAWN-SUBAGENTS`。
    //      → 大脑会以为它能干 files 的活，实际派过去就失败。
    //
    //   ② 只有 1 个有标签模式（`baselineRows.length < 2` → baseline 是空集、**不渲染
    //      baseline 行**）：spawn-only 行仍写"nothing beyond the baseline" —— 指向一个
    //      名册里**根本不存在**的 baseline 行。
    //
    //   ③ 全部模式都是 spawn-only：同上，名册没有 baseline 行，每行都这么写。
    //
    //   根因：`own.length === 0` 把「tags 为空」与「tags 恰好全等于 baseline」混为一谈。
    //   修法：三种情况分开说清楚。**tags 空时不许提 baseline** —— 它压根没有能力标签。
    if (row.tags.length === 0) {
      // 完全没有普通能力标签（只有委派之类的特殊标记）。明说，不要假装它"标配"。
      parts.push("no capability labels")
    } else if (own.length === 0) {
      // 有标签，且全部等于 baseline —— 这才是真的"只有标配"。
      // 但如果根本没有 baseline 行（baseline 为空集），这句话同样会指向不存在的东西。
      parts.push(baseline.size > 0 ? "nothing beyond the baseline" : row.tags.join(", "))
    } else {
      parts.push(own.join(", "))
    }
    // ⚠️ 条件可用的委派能力也必须带 /cond 标记（否则名册顶部「条件行都带 /cond」的
    // 承诺在这里破功，而这条恰好是选人最关键的信息）。见 compositionToTags 的注释。
    //
    if (row.canSpawn) {
      parts.push(row.canSpawnConditional ? "+CAN-SPAWN-SUBAGENTS/cond" : "+CAN-SPAWN-SUBAGENTS")
    }
    lines.push("- " + row.id + ": " + parts.join(" "))
  }

  if (usable === 0) {
    return { text: "No usable agent mode was found.", degraded: ["roster-no-usable"] }
  }

  lines.push("")
  lines.push("Pick the SMALLEST mode that covers the job, not the most capable one.")
  // ⚠️ 2026-11-02（简化审计发现 21）：这里原来又解释了一遍 `?`（"A ? label is a
  // capability nobody mapped to a plain word"）—— 而顶部说明已经解释过 `?`，
  // 人格里还有第三份。同一图例三处重复，删掉这处（保留升级阶梯本身）。
  lines.push("To resolve a ? label, escalate in this order and stop as soon as one answers:")
  lines.push("  1. ask:true,preset:\"<id>\"   - ask that mode what it can do (one short worker run; self-report)")
  lines.push("  2. detail:true,preset:\"<id>\" - its full declaration (file facts; size varies with the mode)")
  lines.push("  3. delegate a small non-destructive task to the mode you think fits.")
  lines.push("Anything labelled harness-dev / plugin-admin / plugin-market can modify the harness")
  lines.push("or install plugins: that is an administration mode, not a worker for ordinary work.")

  let text = lines.join("\n")

  // 硬顶兜底：两段式。
  //   ① 先按模式整段丢（60 个模式时逐行砍根本收敛不了）；
  //   ② 还超就砍最长行。
  // 丢整块而不是半行，模型不会看到残句。
if (bytes(text) > capBytes) {
    degraded.push("roster-truncated")

    // ① 按模式截断：把行按"- "开头的**模式头**切成块。
    //
    // ⚠️⚠️ 2026-11-02 修（第二轮独立复核抓到的 P1-1，两个独立缺陷叠加）。
    //
    // 缺陷 A：**baseline 行也被当成了一个模式块**。
    //   第一个模式之前的"前言"是一个块（对），但 baseline 那行
    //   `- (every mode below): files, search, …` 也以 `- ` 开头 → 于是它被当成
    //   "第 2 个模式块"。后果：块数虚高，`blocks.length/2` 的起点偏移，
    //   而 baseline 本身是**必留**的，把它算进"可选保留的块"里毫无意义。
    //
    // 缺陷 B：**循环只减半、不回试**。
    //   起点 `floor(blocks.length/2)`，一旦这个起点恰好"已经塞得下"就 `break`，
    //   永远不去试更大的 keepCount。实测（3 模式 + 30 个未映射模块的真实规模）：
    //   起点 keepCount=2 只保住"前言 + baseline"= 701 B（占 4000 的 18%），
    //   而 keepCount=5（3686 B）其实**能装下 3 个模式** —— 算法却从没试过 5。
    //   结果：名册丢掉全部模式，大脑拿到"0 个模式"的名册，无法选人。
    //
    // 修法：
    //   · 把块分成"必有前缀"（前言 + baseline）与"模式块"两类；
    //   · 从**最大可能**的 keepCount 往下试（贪心装最多模式），而不是从一半往下减；
    //   · 这样预算利用率最大，且必然先试过所有能装下的数量。
    //
    // ⚠️⚠️ 2026-11-02 再修（第五轮复核抓到的 B4，P3）：**尾部指引要单独拎出来**。
    //
    //   原来的分块把「最后一个模式头之后的所有行」并入最后一个 modeBlock，而
    //   `Pick the SMALLEST mode` / `ask → detail` 阶梯 / `harness-dev 是管理模式`
    //   这三段告诫全在尾部 → 一旦最后一块被丢（截断时经常），指引一起静默消失，
    //   输出只剩 `(N more mode(s) omitted)`。
    //
    //   这不是小事：`harness-dev/plugin-admin` 那条是「删掉 allowedAgentPresets 白名单
    //   之后唯一的危险模式提示」。预算紧张时恰恰最需要它，而它最先被丢。
    //
    //   修法：把尾部队列切出来当 `tailGuidance`，**无论丢多少模式都保留**。
    //   预算是硬的 —— 若连"前缀 + 指引"都装不下，后面的"砍最长行"会继续压，
    //   但门槛是"先保指引，再保模式"（指引只有 6 行，模式可以很多）。
    const head = []
    const modeBlocks = []
    let tailGuidance = []
    {
      let current = []
      let seenMode = false
      for (const line of text.split("\n")) {
        // baseline 行是 `- (every mode below): …` —— 它不是模式，归前缀。
        const isBaseline = line.startsWith("- (every mode below)")
        const isModeHead = line.startsWith("- ") && !isBaseline
        if ((isModeHead || isBaseline) && current.length > 0) {
          if (seenMode) modeBlocks.push(current)
          else head.push(current)
          current = [line]
          if (isModeHead) seenMode = true
        } else {
          current.push(line)
        }
      }
      if (current.length > 0) {
        if (seenMode) modeBlocks.push(current)
        else head.push(current)
      }
    }

    // 把最后一个模式块里「模式行之后的部分」切出来当尾部指引。
    //
    // ⚠️⚠️ 2026-11-02 再修（第六轮复核抓到的 BUG-1，P2）：**不能用"从末尾往前找最近空行"**。
    //
    //   原来的写法假设"尾部指引是一段连续的行、且只以空行开头"。但指引**自身可能含空行**
    //   （运维往中间插一句 NOTE 是很自然的做法），那时从末尾往前找到的是**指引内部的**
    //   那个空行 → `tailGuidance` 只切到最后一段，而 `Pick the SMALLEST` / `ask:true`
    //   阶梯留在最后一个 modeBlock 里，跟着丢块一起消失。
    //
    //   实测（同一 cap=1583）：正常布局三项全在；指引中间加一个空行后 **三项全丢**。
    //   而那句 `harness-dev/plugin-admin 是管理模式` 是删掉 allowedAgentPresets
    //   白名单之后**唯一**的危险模式提示 —— 恰恰最不能丢。
    //
    //   修法：**按内容定位，不按空行猜**。尾部指引的第一行固定是
    //   `Pick the SMALLEST …`（renderRoster 里写死的那句），从后往前找**那一行**，
    //   它的位置就是切分点。这样指引内部有多少空行都不影响。
    if (modeBlocks.length > 0) {
      const last = modeBlocks[modeBlocks.length - 1]
      const GUIDE_START = 'Pick the SMALLEST'
      let cutAt = -1
      for (let i = 1; i < last.length; i++) {
        if (last[i].startsWith(GUIDE_START)) { cutAt = i; break }
      }
      if (cutAt > 0) {
        // 往前吃掉紧邻的空行（它们属于前一段的排版，不是指引的一部分）
        while (cutAt > 1 && last[cutAt - 1].trim() === '') cutAt -= 1
        tailGuidance = last.slice(cutAt)
        modeBlocks[modeBlocks.length - 1] = last.slice(0, cutAt)
      } else {
        // 兜底：找不到那行标记（名册格式变了）→ 退化为"从末尾往前找空行"，
        // 但仍要求切出的部分**至少 2 行**，避免只切到一句残句。
        let fallbackAt = last.length
        for (let i = last.length - 1; i >= 1; i--) {
          if (last[i].trim() === '') { fallbackAt = i; break }
        }
        if (fallbackAt < last.length && fallbackAt > 0 && last.length - fallbackAt >= 2) {
          tailGuidance = last.slice(fallbackAt)
          modeBlocks[modeBlocks.length - 1] = last.slice(0, fallbackAt)
        }
      }
    }

    if (modeBlocks.length > 0) {
      // 贪心：从"全部模式"往下试，第一个装得下的就是最优。
      // （块按模式顺序，保前面的模式 = 保最靠前的可用模式，符合名册排序语义。）
      //
      // ⚠️ `tailGuidance` 每次都拼上 —— 见上方 B4 的注释：那几行告诫必须活着。
      let best = null
      for (let keepCount = modeBlocks.length; keepCount >= 0; keepCount -= 1) {
        const kept = [...head.flat(), ...modeBlocks.slice(0, keepCount).flat()]
        const omitted = modeBlocks.length - keepCount
        const omissionNote = omitted > 0
          ? ["", "(" + omitted + " more mode(s) omitted to fit the size cap)"]
          : []
        const candidate = kept.concat(omissionNote, tailGuidance).join("\n")
        if (bytes(candidate) <= capBytes) {
          best = candidate
          break
        }
      }
      // 连 0 个模式都装不下 → 至少保住前缀 + 指引（后面的"砍最长行"会继续压）。
      if (best !== null) text = best
      else text = head.flat().concat(tailGuidance).join("\n")
    }

    // ② 还超就砍最长行。
    //
    // ⚠️⚠️ 2026-11-02 修（第六轮自查发现，B4 修复暴露出的连带问题）：
    //   **原来这个循环无法收敛到 cap 以下，硬顶上会被突破**。
    //
    //   原因：`keep = Math.max(20, …)` 给每行设了 20 字符地板。当 cap 很小、行数
    //   又不少时，每行压到 20+2 字符后就被 `endsWith('…')` 跳过，循环靠
    //   `guard < 500` 退出 —— 但那时**总量仍超 cap**。实测：cap=300 输出 700 B、
    //   cap=400 输出 667 B。
    //
    //   这不是边界洁癖：`capBytes` 是提示词预算的**硬顶**（可配，默认 4000）。
    //   突破它意味着「配置说 300、实际给了 700」，配置失去意义，而调用方是按它
    //   算预算的。
    //
    //   修法三阶段（每阶段只在上一阶段失败时才走）：
    //     ① 砍最长行（保留 20 字符的可读性地板 —— 砍成空白更没用）；
    //     ② 仍超 → **整行丢弃**（从后往前，跳过标题与尾部指引）；
    //     ③ 仍超 → 硬截第一行。保证绝不突破 capBytes。
    let guard = 0
    while (bytes(text) > capBytes && guard < 500) {
      const lines2 = text.split("\n")
      // ⚠️ 第一阶段就**跳过尾部指引行**：它们是决策信息，"砍半"会让语义损坏
      // （例如 "Anything labelled harness- …" 读不出意思）。宁可后面整段丢模式。
      const guideAt = lines2.findIndex((l) => l.startsWith("Pick the SMALLEST"))
      let idx = -1
      let size = 0
      for (let i = 0; i < lines2.length; i += 1) {
        if (lines2[i].endsWith("…")) continue
        if (guideAt >= 0 && i >= guideAt) continue // 保护区
        const s = bytes(lines2[i])
        if (s > size) { size = s; idx = i }
      }
      if (idx < 0) break // 全行都带 … 了（或只剩指引），进入第二阶段
      const keep = Math.max(20, Math.floor(lines2[idx].length / 2))
      lines2[idx] = lines2[idx].slice(0, keep) + " …"
      text = lines2.join("\n")
      guard += 1
    }

    // ②b 仍超 → 整行丢弃。**保护标题（第 1 行）与尾部指引**。
    //
    //     顺序很关键：**先丢模式行，最后才动指引**。指引只有 6 行，却是
    //     "危险模式警告 + 升级阶梯"这类决策信息，比任何单个模式都值钱。
    //     实现上用一个显式的「指引起始行号」标记，而不是靠 `最后 8 行` 猜。
    let dropGuard = 0
    while (bytes(text) > capBytes && dropGuard < 500) {
      const lines2 = text.split("\n")
      if (lines2.length <= 1) break
      // 指引起始行 = 第一行以 "Pick the SMALLEST" 开头的位置（那段固定这么起头）
      const guideAt = lines2.findIndex((l) => l.startsWith("Pick the SMALLEST"))
      let target = -1
      // ① 优先丢模式行（`- ` 开头、非 baseline、且位于指引之前）
      for (let i = lines2.length - 1; i >= 1; i -= 1) {
        const isMode = lines2[i].startsWith("- ") && !lines2[i].startsWith("- (every mode below)")
        const beforeGuide = guideAt < 0 || i < guideAt
        if (isMode && beforeGuide) { target = i; break }
      }
      // ② 模式行丢光了（或没有）→ 才丢指引段里的行（跳过第 1 行标题）
      if (target < 0) {
        for (let i = lines2.length - 1; i >= 1; i -= 1) {
          if (lines2[i].trim() !== "") { target = i; break }
        }
      }
      if (target < 0) break
      lines2.splice(target, 1)
      text = lines2.join("\n")
      dropGuard += 1
    }

    // ②c 最终地板：连一行都装不下（cap 极小）→ 硬截，**绝不突破硬顶**。
    //
    //     实测：②b 做完后这里通常是 no-op（整行丢弃已能收敛）。留着它是
    //     **防御性的第二道保险** —— ②b 的"可丢行"选择依赖行结构
    //     （`- ` 前缀 / 指引位置），若将来格式变化让它找不到可丢的行，
    //     ②c 仍能保证硬顶不被突破。
    //     变异测试确认：只删 ②c 不变红（②b 足够）；同时删 ②b+②c 变红
    //     （cap=80 时输出 927 B = 突破 11 倍）。
    if (bytes(text) > capBytes) {
      // ⚠️ BUG-A（第四轮复核抓到，P2）：**预留字节必须按实际后缀算**。
      //
      //   原来写 `capBytes - 2`，但追加的后缀 `" …"` 是 **4 字节**
      //   （空格 1 + U+2026 省略号 3）。于是 cap ∈ {3..44, 46..47} 时
      //   输出 `cap + 2` 字节 —— **硬顶被突破**。
      //
      //   R-7e 当时抽样的 [80,150,300,...] 恰好全部绕开这个区间，所以测试没抓到。
      //   现在：后缀字节数用常量算出来，且**后缀本身装不下时就不加后缀**
      //   （宁可输出空串/纯截断，也不突破硬顶 —— 硬顶是契约）。
      const SUFFIX = " …"
      const suffixBytes = bytes(SUFFIX)
      const budget = Math.max(0, capBytes - suffixBytes)
      let used = 0
      let cut = 0
      for (const ch of text) {
        const b = bytes(ch)
        if (used + b > budget) break
        used += b
        cut += ch.length
      }
      // 只有真的截出了内容、且后缀装得下时才加后缀。
      const suffix = cut > 0 && suffixBytes <= capBytes ? SUFFIX : ""
      text = text.slice(0, cut) + suffix
    }
  }

  return { text, degraded }
}

/**
 * 装载本模块。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, selfPresetId, capabilityHints, rosterMaxBytes }`。
 * @returns void。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)
  const selfId = typeof config?.selfPresetId === 'string' && config.selfPresetId !== '' ? config.selfPresetId : 'blackpigmodel'

  /**
   * 名册字节硬顶：`config.rosterMaxBytes` 优先，缺省 4000。
   *
   * 2026-11-02 通用化（通用性审计 R1 的 S4）：原来只有写死的 `ROSTER_HARD_CAP_BYTES`。
   * 这个上限不是宿主的容量策略（`maxDepth` 那类），而是**提示词预算策略** ——
   * 但它同样不该由模式替部署决定：装了十几个模式的部署，4000 B 会把名册砍掉一半
   * （实测 60 模式丢 31 个、120 模式丢 92 个，模型看不到被丢的模式）。
   *
   * 所以给个 config 口子：默认值不变（4000），需要更大的部署自己调。
   * 非法值（非正整数）忽略并 warn，退回默认 —— 配置错误不该让名册直接坏掉。
   */
  const capBytes = (() => {
    const raw = config?.rosterMaxBytes
    if (raw === undefined || raw === null) return ROSTER_HARD_CAP_BYTES
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && Math.floor(raw) === raw) return raw
    warn('config.rosterMaxBytes must be a positive integer; falling back to ' + ROSTER_HARD_CAP_BYTES + ' (got ' + String(raw) + ')')
    return ROSTER_HARD_CAP_BYTES
  })()

  /** `detail: true` 的字节上限：`config.detailMaxBytes` 优先，缺省 `DETAIL_MAX_BYTES`。 */
  const detailMaxBytes = (() => {
    const raw = config?.detailMaxBytes
    if (raw === undefined || raw === null) return DETAIL_MAX_BYTES
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && Math.floor(raw) === raw) return raw
    warn('config.detailMaxBytes must be a positive integer; falling back to ' + DETAIL_MAX_BYTES + ' (got ' + String(raw) + ')')
    return DETAIL_MAX_BYTES
  })()

  /**
   * 生效的能力映射表 = 默认表 + `config.capabilityHints`。
   *
   * 2026-11-02 通用化：**项目专用的模块名不许写进代码**。默认表只含 DSH 内置模块；
   * 某个项目自己的插件（例如 `dsh-example-plugin`）由项目在自己的 preset 配置里声明：
   *
   *     capabilityHints:
   *       'dsh-example-plugin': EXAMPLE
   *
   * 合并语义：同名以 config 为准（可覆盖默认标签），未列出的默认项保留。
   * config 传了非对象值 / 空对象时等价于"没有注入"，不报错 —— 这是可选增强，不是必填。
   */
  const hints = { ...DEFAULT_CAPABILITY_HINTS }
  if (config?.capabilityHints !== null && typeof config?.capabilityHints === 'object' && !Array.isArray(config?.capabilityHints)) {
    for (const [moduleName, label] of Object.entries(config.capabilityHints)) {
      if (typeof moduleName !== 'string' || moduleName === '') continue
      if (typeof label !== 'string' || label === '') continue
      hints[moduleName] = label
    }
  }

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
      level: 'mount-only',
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
      const ids = await knownIds()
      return failure('preset-required', 'A `preset` id is required. Call with `list: true` to see the available ids.', {
        stop: true,
        nextAction: ids.length === 0 ? 'no mode is available; report to the user' : `choose one of: ${ids.join(', ')}`,
        degraded: ids.length === 0 ? ['no-usable-mode'] : undefined,
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
    // 现在：**名册列出全部模式，选人是能力问题**。危险模式（能改部署本体的）
    // 由能力标签（`harness-dev` / `plugin-admin` / `plugin-market`）暴露，选人方自己判断。
    // 名册只读 `registry.list()` 全展示，不做任何名单过滤。
    //
    // ⚠️ 2026-11-02（第二轮复核 P2-2）：存在性校验抽成了 `presetUnusable()`，
    //    `ask` 路径也调它 —— 两条路径必须共用同一份前置，不能各写一套。
    //    上面 self 那句保留（文案不同），其余三道由共享函数处理。
    const unusable = await presetUnusable(presetId, 'delegate')
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
    try {
      // ⚠️ 2026-11-02 通用化：**不传数字**（旧代码硬编码 1）。
      //
      // `resolveMaxDepth(configured)` 的语义：
      //   · 传数字 → 用它（本模块替调用方定深度，等于绕过面板）
      //   · **不传（undefined）** → 返回 `config.maxDepth.get()`，也就是**设置面板里的值**
      //   · `'provider-managed'` → undefined（让进程外 provider 自己管）
      //
      // 旧代码传 1，于是即使面板把 maxDepth 调到 2/3，本工具派出的代理仍只有 1 层预算，
      // 队友拿到的是「不能再往下派」的名册路径。现在跟随面板。
      const maxDepth = subagents.resolveMaxDepth?.()
      if (maxDepth !== undefined) request.maxDepth = maxDepth
    } catch {
      // 解析不了就不带，让服务用默认值。
    }

    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: typeof args?.description === 'string' && args.description !== '' ? args.description : `delegate to ${presetId}`,
        request,
        signal: exec?.signal,
        delivery: 'parent',
      })
      const childSessionId = typeof activation?.childId === 'string' ? activation.childId : null
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
          'This worker is NOT a Team member: `wait_agent` and `list_agents` do not see it and will ' +
          'report "no-active-peer" forever, so do not wait on it. Tell the user what you dispatched, ' +
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

  /** 读名册，失败返回空数组（不抛）。 */
  const safeList = async (registry) => {
    try {
      const rows = await registry.list()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** 当前可派活的 id 列表（排除自己、排除 broken；2026-11-02 起不再有任何名单过滤）。 */
  const knownIds = async () => {
    const registry = serviceOf('agentPresets')
    if (registry === undefined) return []
    const rows = await safeList(registry)
    return rows
      .filter((row) => row !== null && typeof row === 'object')
      .filter((row) => typeof row.id === 'string' && row.id !== '' && row.id !== selfId)
      .filter((row) => !(typeof row.broken === 'string' && row.broken !== ''))
      .map((row) => row.id)
  }

  /**
   * 「这个 preset 能不能用」的统一前置 —— `delegate` 与 `ask` **共用这一份**。
   *
   * ⚠️ 2026-11-02 新增（第二轮复核抓到的 P2-2）。
   *
   * 原来 `delegate()` 有三道前置（self → registry → known/broken），而 `ask` 分支
   * 只共用了 `no-caller` 一条，**没有存在性校验**。后果：
   *   · 问一个**不存在**的 preset → `ask` 真的 `startActivation` 一次（宿主先建子会话、
   *     setup 里 mount 预设才抛错）→ 白建一次子会话，然后拿回 `ask-failed`（stop:false）；
   *   · 问一个 **broken** preset → 同样先白建一次，而 `delegate` 能在**起会话之前**就给
   *     `preset-broken` + nextAction。
   *
   * `ask` 是用户定的「最便宜的第一步」，却是唯一会为坏/不存在 preset 白建会话的入口 ——
   * 这与它的定位相反。所以把三道前置抽成这一个函数，两条路径都先调它。
   *
   * @param presetId - 已 trim 过的 preset id。
   * @param stage - 用于文案：`'delegate'` 或 `'ask'`。
   * @returns `undefined`（可用）或一个结构化 failure（`{ ok:false, ... }`）。
   */
  const presetUnusable = async (presetId, stage) => {
    if (presetId === selfId) {
      return failure('self-preset', `"${presetId}" is this mode itself; ${stage === 'ask' ? 'ask your own tool list instead' : 'delegate from a parent or use a different mode'}.`, { stop: true, presetId })
    }
    const registry = serviceOf('agentPresets')
    if (registry === undefined || typeof registry.list !== 'function') {
      return failure('registry-unavailable', 'The agent-preset registry is unavailable, so no mode can be selected.', { stop: true, presetId })
    }
    const known = await knownIds()
    if (known.includes(presetId)) return undefined
    const rows = await safeList(registry)
    const brokenRow = rows.find((row) => row?.id === presetId)
    if (brokenRow !== undefined && typeof brokenRow.broken === 'string' && brokenRow.broken !== '') {
      return failure('preset-broken', `"${presetId}" exists but cannot compose a session: ${brokenRow.broken}`, {
        stop: false,
        nextAction: 'choose another mode from the roster',
        presetId,
        broken: brokenRow.broken,
      })
    }
    return failure('unknown-preset', `Unknown agent preset "${presetId}".`, {
      stop: false,
      nextAction: known.length === 0 ? 'no usable mode; report to the user' : `choose one of: ${known.join(', ')}`,
      presetId,
    })
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Delegate a self-contained task to a worker running under one specific installed agent mode (preset). ' +
        '`preset` is REQUIRED — there is no default, because the wrong default silently wastes a whole run. ' +
        'Call with `list: true` FIRST to read the roster: each mode lists the capabilities its ENABLED ' +
        'modules provide, so pick by capability, not by the mode name. ' +
        'When a capability label is not obvious to you, use `ask: true` with that preset ' +
        'BEFORE you delegate real work to it. ' +
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
            type: 'boolean',
            description: 'When true, return the roster of installed modes instead of delegating.',
          },
          detail: {
            type: 'boolean',
            description:
              'When true (together with `preset`), return that ONE mode\'s full declaration instead of delegating. ' +
              'It injects the mode\'s whole YAML declaration (size varies with the mode), so use it only when the roster was not enough to decide.',
          },
          ask: {
            type: 'boolean',
            description:
              'When true (together with `preset`), ASK THAT MODE ITSELF what it can do — it starts a throwaway worker ' +
              'and returns the worker\'s own answer (e.g. "list only the tool names you can call, no explanation"). ' +
              'This is the cheapest way to resolve an unclear capability label: one short worker run, ' +
              'cheaper than `detail: true` (which injects a whole declaration) and far cheaper than a wasted real delegation. ' +
              'It is the worker\'s SELF-REPORT, so treat it as a hint, not proof.',
          },
          probe_prompt: {
            type: 'string',
            description:
              'With `ask: true`, the exact question to send that mode. Defaults to a request for the tool names it ' +
              'can call directly. Keep it short and ask for facts, not prose.',
          },
        },
        required: [],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args?.list === true) {
          const registry = serviceOf('agentPresets')
          if (registry === undefined) {
            return failure('registry-unavailable', 'The agent-preset registry is unavailable, so the roster cannot be read.', { stop: true })
          }
          const rendered = await renderRoster(registry, selfId, warn, hints, capBytes)
          return {
            ok: true,
            message: rendered.text,
            ...rendered.degraded.length === 0 ? {} : { degraded: rendered.degraded },
          }
        }

        // `detail: true` —— 拿单个模式的原样声明。不派活。
        if (args?.detail === true) {
          const presetId = typeof args?.preset === 'string' ? args.preset.trim() : ''
          if (presetId === '') {
            return failure('preset-required', '`detail: true` needs a `preset` id.', { stop: true })
          }
          // 2026-11-02 通用化：`detail` 也**不再有名单检查**。
          //
          // 旧版本这里查过 `allowed`（防止"派活被拒但读声明放行"）和 `denied`
          // （不让模型看到危险模式的声明）。名单机制整体删除后，这两个检查失去依据：
          // 现在任何已安装模式都可选择、可读声明，读声明本就是**选人前的正常动作**。
          // 保留的只有"必须存在"校验 —— 由 `readPresetDetail` 自己负责（读不到就报错）。
          const registry = serviceOf('agentPresets')
          if (registry === undefined) {
            return failure('registry-unavailable', 'The agent-preset registry is unavailable, so no declaration can be read.', { stop: true })
          }
          const detail = await readPresetDetail(registry, presetId, detailMaxBytes)
          if (!detail.ok) {
            return failure(detail.reason, detail.message, { stop: false, presetId, nextAction: 'pick another mode from the roster' })
          }
          return { ok: true, presetId, message: detail.text }
        }

        // `ask: true` —— **问那个模式自己能干什么**（2026-11-02，用户要的三步选人最后一环）。
        //
        // 为什么需要它（这是用户原话的意思）：
        //   名册给的是「这个模式启用了哪些模块」，模块名一旦是 `?xxx`（未映射），
        //   模型就看不懂它是什么能力。这时**不该**直接派真实任务试错（那是浪费一整轮），
        //   而应该先用最低成本问一句「你能调哪些工具」。这是选人的第 2 步，
        //   第 3 步才是 `detail: true` 读 YAML 声明。
        //
        // 成本对比（这三步就是按成本递增排的）：
        //   ① list:true      —— 一份名册（几百字节）
        //   ② ask:true       —— 一次短代理运行（几十 token 输出）
        //   ③ detail:true    —— 2.6–5.8 KB 的 YAML 声明
        //   ④ 直接派真实任务  —— 一整轮真实工作（最贵，且失败要重来）
        //
        // ⚠️ 它返回的是**代理的自述**，不是事实。所以回执里必须写明这一点，
        // 否则模型会把「我说我能干 X」当成「它真的能干 X」。与 `detail`（读到的 YAML
        // 事实）严格区分开。
        //
        // ⚠️ 它**真起一个 worker**：会被 `maxActiveSubagents` 计入，也真的消耗 provider 额度
        // （但只是一次极短输出）。不碰付费接口、不写项目文件。
        if (args?.ask === true) {
          const presetId = typeof args?.preset === 'string' ? args.preset.trim() : ''
          if (presetId === '') {
            return failure('preset-required', '`ask: true` needs a `preset` id: that is the mode you are asking.', { stop: true })
          }
          // ⚠️ 2026-11-02（第二轮复核抓到的 P2-2）：这里原来**没有存在性校验**。
          //
          // `delegate()` 有三道前置（self → registry → known/broken），而本分支只共用了
          // `no-caller` 一条。后果：问一个不存在/坏掉的 preset 时，`ask` 会真的
          // `startActivation` 一次（宿主先建子会话、mount 时才抛错）—— **白建一次子会话**，
          // 然后拿回 `ask-failed`（stop:false）而不是可读的 `unknown-preset` / `preset-broken`。
          //
          // 而 `ask` 的定位恰恰是「最便宜的第一步」，为坏 preset 白建会话与那个定位相反。
          // 现在与 delegate 共用同一个 `presetUnusable()`：**起会话之前**就把不可用的挡掉。
          const unusable = await presetUnusable(presetId, 'ask')
          if (unusable !== undefined) return unusable

          // ⚠️ 2026-11-02 修（审计 R1 抓到的 P1）：这里原来**没有**调用者校验。
          //
          // 下面 `request.parent` 直接取 `exec?.agent`，而 `startActivation` 的
          // `request.parent` 是**必需**的（宿主 `startLocal` 里 `assertAdmitting(parent)`
          // 会立刻抛错）。原来 exec 缺 agent 时表现为 `ask-failed: parent is required`
          // —— 一次白烧的调用，错误信息还指向宿主内部，与 `ask` 语义无关，排查困难。
          //
          // 现在与 `delegate()` 同一条前置：先判调用者，缺了就结构化拒绝（stop:true，
          // 不许重试）。
          const parent = exec?.agent
          if (parent === undefined || parent === null) {
            return failure('no-caller', NO_CALLER_MESSAGE, { stop: true, presetId })
          }

          const subagents = serviceOf('subagents')
          if (subagents === undefined || typeof subagents.startActivation !== 'function') {
            return failure('subagents-unavailable', 'The subagent service is unavailable, so no mode can be asked.', { stop: true, presetId })
          }

          const probe =
            typeof args?.probe_prompt === 'string' && args.probe_prompt.trim() !== ''
              ? args.probe_prompt
              : 'List ONLY the tool names you can call directly. No explanation, no prose — one comma-separated line.'

          const request = { prompt: [{ type: 'text', text: probe }], parent, agentPreset: presetId }
          try {
            const maxDepth = subagents.resolveMaxDepth?.()
            if (maxDepth !== undefined) request.maxDepth = maxDepth
          } catch {
            // 解析不了就不带，让服务用默认值。
          }

          try {
            const activation = await subagents.startActivation({
              provider: 'spawn',
              label: `ask ${presetId} what it can do`,
              request,
              signal: exec?.signal,
              // ⚠️ `caller` 而不是 `parent`：这是一次**探测**，结果直接返回给调用方，
              // 不要给本次会话塞一条"代理完成了"的唤醒通知 —— 那会打断调用方的回合。
              delivery: 'caller',
            })
            // caller 交付时 result 是 promise，await 拿到代理输出。
            const raw = await activation?.result?.catch?.(() => undefined)
            const text = extractProbeText(raw)
            const childSessionId = typeof activation?.childId === 'string' ? activation.childId : null
            if (text === '') {
              return failure(
                'ask-empty',
                `Asked "${presetId}" what it can do, but it returned no text` +
                  (childSessionId === null ? '.' : ` (worker ${childSessionId}).`) +
                  ' Treat that as "cannot self-report"; fall back to `detail: true`.',
                { stop: false, presetId, nextAction: 'use detail: true to read the declaration' },
              )
            }
            return {
              ok: true,
              presetId,
              childSessionId: childSessionId ?? undefined,
              message:
                `SELF-REPORT from "${presetId}" (not verified facts — the mode described itself):\n\n${text}\n\n` +
                'If this still does not settle it, use `detail: true` for the declaration (file facts), ' +
                'or delegate a small non-destructive task.',
              evidence: {
                broken: null,
                presetId,
                childSessionId,
                level: 'self-report', // 与 mount-only 区分：这是被问方的自述，不是观测
              },
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            warn(`asking agent preset "${presetId}" failed: ${message}`)
            return failure('ask-failed', `Asking "${presetId}" what it can do failed: ${message}`, {
              stop: false,
              presetId,
              nextAction: 'use detail: true to read the declaration instead',
            })
          }
        }

        return delegate(args, exec)
      },
    })
  } catch (error) {
    warn(`registering "${TOOL_NAME}" failed: ${error instanceof Error ? error.message : String(error)} — cross-mode dispatching is unavailable`)
  }
}
