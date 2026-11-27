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
 * ── 1.1.0（2026-11-25）：工具面改为**实测值** ──────────────────────────────
 * `tools.view(key).visible` 是该 scope 下**已注册**的工具集，不等于模型实际下发的工具表
 * （executor 类模式如 ptc 只把 `run_code` 下发，注册面里却是整套被代理的工具）。现在三级取数：
 *   ① ptc 特判 —— 挂载了 `@deepseek-ai/dsh-tool-executor-ptc` 的模式固定 `['run_code']`（不实测、不缓存）；
 *   ② 缓存命中 —— `~/.dsh/profiles/desktop/preset-tools-cache.json` 里该 preset 的最近实测值；
 *   ③ 当场实测 —— 派一个极短子代理跑完，再读它子会话的 `request/header.tools`（= 模型看到的真表）。
 * 实测拿不到时退回注册面并标 `~reg`，绝不把注册面伪装成实测值。
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

import { homedir } from 'node:os'
import { join } from 'node:path'

import { callSendMessage, callerSessionIdsOf, readCallerChildCatalog, resolveTargetId } from './compat.mjs'


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
 * 实测工具表缓存文件的**默认**位置（只在没配 `config.toolsCachePath` 时用）。
 *
 * ⚠️ 历史（2026-11-25 修，1.1.0 内部修订）：这里曾写死 `~/.dsh/profiles/desktop/...`。
 * 两个错：① `~` 由 `fsio.ts` 的 `expandHomePrefix()` → `os.homedir()` 展开，而 `homedir()`
 * **只看 USERPROFILE，与 `DSH_HOME` 无关**（`dsh-home-paths` 的 `resolveDshHome` 才读
 * `DSH_HOME`）⇒ 隔离实例（临时 DSH_HOME）会把缓存写进生产 profile，多 HOME 互踩；
 * ② `profiles/desktop` 是**本机**的 profile 名，别的部署未必叫这个。
 *
 * 现在：路径优先取 `config.toolsCachePath`（`cordis.patch.yml` 可配）；没配时**退化为
 * 「本次进程的 DSH_HOME + 本 profile 目录」**（见 `toolsCachePathOf()`），绝不写死机器路径。
 * 为什么不用 `resolveDshHome()` / `dshHomePath()`：这两个是 `@deepseek-ai/dsh-home-paths`
 * 的**裸模块导出**，不是 `ctx` 服务（本部署里 `@deepseek-ai` 只装了 `cosmokit` /
 * `schemastery`，宿主包在 app.asar 里，import 必 `ERR_MODULE_NOT_FOUND`）。
 */
const DEFAULT_TOOLS_CACHE_RELATIVE = join('profiles', 'desktop', 'preset-tools-cache.json')

/** 缓存文件结构版本；结构一变就 bump，读到旧版本按空缓存处理。 */
const TOOLS_CACHE_VERSION = 1

/** ptc 执行器插件名：挂载了它的模式，模型只直接看得见 `run_code`。 */
const PTC_EXECUTOR_PLUGIN = '@deepseek-ai/dsh-tool-executor-ptc'

/** ptc 模式暴露给模型的唯一工具。 */
const PTC_TOOL = 'run_code'

/** 当场实测时派给子代理的那一句：唯一的目的是让子会话发一次请求、留下 `request/header`。 */
const PROBE_PROMPT = 'reply OK'

/**
 * 从事件流里取最后一个请求头（`request/header`）—— 本包内的等价折叠实现。
 *
 * ⚠️ 为什么**不** `import { foldRequestHeader } from '@deepseek-ai/dsh-session'`：
 * 该裸包在本部署的两个解析根下都 `ERR_MODULE_NOT_FOUND`（实测 2026-11-25）——
 * profile 的 `node_modules\@deepseek-ai` 只有 `cosmokit` / `schemastery`，宿主包在
 * `resources\app.asar` 里。ESM 静态 import 在模块装载期解析，解析失败会让整个
 * `blackpig-roster` 起不来、工具与 `delegate` 一起静默消失（`inject` 也救不回来）。
 * `compat.mjs` 的「不深引宿主内部模块」纪律同理。所以这里自己折叠：
 * 遍历 events，取**最后一条** `request/header` 的 `data.header`。
 *
 * @param events - `sessionQuery.readSession()` 返回的事件数组（裸事件 `{ type, data }`）。
 * @returns 最后一个请求头，没有则 `undefined`。
 */
function foldLastRequestHeader(events) {
  if (!Array.isArray(events)) return undefined
  let last
  for (const item of events) {
    if (item === null || typeof item !== 'object') continue
    const type = item.type ?? item.value?.type
    if (type !== 'request/header') continue
    const header = item.data?.header ?? item.value?.data?.header ?? item.value?.header
    if (header !== undefined && header !== null) last = header
  }
  return last
}

/**
 * 读某子会话**真实下发**的工具表（模型可直接调用的那批）。
 *
 * 数据链：`sessionQuery.readSession(childId)` → `foldRequestHeader(events)` → `header.tools`。
 * 与 `tools.view(key).visible` 的区别：后者是该 scope 的**注册**面，executor 模式（ptc）
 * 注册一堆、只下发 `run_code`。想回答「这个模式真正能用什么」只能读请求头。
 *
 * @param ctx - 插件上下文。
 * @param childId - 子会话 id。
 * @returns 工具名数组；会话还没发过请求（无请求头）或任何异常 → `null`。
 */
async function readRealTools(ctx, childId) {
  if (typeof childId !== 'string' || childId.trim() === '') return null
  try {
    const sessionQuery = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (typeof sessionQuery?.readSession !== 'function') return null
    const session = await sessionQuery.readSession(childId)
    const header = foldLastRequestHeader(session?.events)
    // 新建会话还没发过请求 → 没有请求头 → 拿不到真实工具表（绝不是「零个工具」）。
    if (header === undefined || header === null) return null
    const tools = Array.isArray(header.tools) ? header.tools : []
    const names = tools
      .map((entry) => (typeof entry === 'string' ? entry : typeof entry?.name === 'string' ? entry.name : ''))
      .filter((entry) => entry !== '')
    return names
  } catch {
    return null
  }
}

/**
 * 某 preset 是否由 ptc 执行器决定工具面（`run_code` 单工具，注册面不可信）。
 *
 * @param pluginNames - `agentPresets.plugins(id)` 回的插件名数组（读不到时为 `null`）。
 * @returns 是否按执行器口径处理。
 */
function isPtcexecutor(pluginNames) {
  return Array.isArray(pluginNames) && pluginNames.includes(PTC_EXECUTOR_PLUGIN)
}

/**
 * 缓存文件的绝对路径。
 *
 * 取法（按优先级，2026-11-25 实证，不写死任何机器路径）：
 *   1. `config.toolsCachePath` —— 部署方显式配置（`cordis.patch.yml` 可改），相对路径按 cwd 解析；
 *   2. `${DSH_HOME}/profiles/desktop/preset-tools-cache.json` —— 读**本次进程**的 `DSH_HOME`
 *      （与 `dsh-home-paths` 的 `resolveDshHome` 同一条环境变量，宿主自己也是这么定位 home 的），
 *      未设置时退回 `homedir()/.dsh`（与 `defaultDshHome()` 同口径）。
 * 不写 `~`：`fs.readText`/`resolve` 会经 `expandHomePrefix()` → `os.homedir()` 展开，
 * 而 `homedir()` 只看 USERPROFILE、与 `DSH_HOME` 无关 ⇒ 隔离实例会踩到生产 profile。
 *
 * @param ctx - 插件上下文。
 * @param config - 模块配置（`toolsCachePath` 可选）。
 * @returns 绝对路径；任何异常都退回默认推导（不抛）。
 */
function toolsCachePathOf(ctx, config) {
  try {
    const configured = typeof config?.toolsCachePath === 'string' ? config.toolsCachePath.trim() : ''
    if (configured !== '') {
      if (/[\\/]/.test(configured) || configured.startsWith('/')) return configured
      return join(currentProcessCwd(), configured)
    }
    const env = process.env
    const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
    return join(dshHome, DEFAULT_TOOLS_CACHE_RELATIVE)
  } catch {
    try {
      return join(homedir(), '.dsh', DEFAULT_TOOLS_CACHE_RELATIVE)
    } catch {
      return DEFAULT_TOOLS_CACHE_RELATIVE
    }
  }
}

/** `process.cwd()` 的兜底版本（cwd 被删时会抛）。 */
function currentProcessCwd() {
  try {
    return process.cwd()
  } catch {
    return '.'
  }
}

/**
 * 读缓存文件。返回内容与**那一次读到的版本令牌**（`fs.stat()` 的 `FsInfo.version`）。
 *
 * 宿主契约（`dsh-fs/src/types.ts`）：`FsInfo.version` 就是 `replaceIfVersion` 要的那个
 * 不透明令牌；`stat()` 是 `fs` 上的公开方法，不需要额外 import。
 * 版本令牌只能来自 `stat()`，**不许自己造**（`MUST NOT interpret this token`）。
 *
 * @param ctx - 插件上下文。
 * @param path - 缓存文件绝对路径。
 * @returns `Promise<{ presets, version }>`；任何失败都回 `{ presets: {}, version: undefined }`（不抛）。
 */
async function readToolsCache(ctx, path) {
  const empty = { presets: {}, version: undefined }
  try {
    const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
    if (typeof fs?.resolve !== 'function' || typeof fs?.readText !== 'function') return empty
    const target = await fs.resolve(path)
    let version
    try {
      const info = typeof fs.stat === 'function' ? await fs.stat(target) : undefined
      version = info !== undefined && info !== null ? info.version : undefined
    } catch {
      version = undefined
    }
    const text = await fs.readText(target)
    const parsed = JSON.parse(String(text))
    if (parsed === null || typeof parsed !== 'object') return empty
    if (parsed.version !== TOOLS_CACHE_VERSION) return empty
    const presets = parsed.presets
    if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) return empty
    return { presets, version }
  } catch {
    return empty
  }
}

/**
 * 写缓存文件（整体替换 + 乐观并发）。
 *
 * 写入意图按 `stat()` 的结果分三支（`dsh-fs/src/types.ts:117-125` 的定义）：
 *   · 文件存在且 `FsInfo.version` 可用 → `{ kind: 'replaceIfVersion', version }`；
 *   · 文件不存在（或 stat 读不到）→ `{ kind: 'createIfAbsent' }`；
 *   · create 撞上「已存在」→ 重来一次，这次落到上面两支之一。
 * 任何写入失败（含版本冲突 `FS_STALE_VERSION`）只 warn 一次，绝不影响当前这次 `list: true`：
 * 缓存是 best-effort，丢一次更新只是下次多实测一遍。
 *
 * @param ctx - 插件上下文。
 * @param path - 缓存文件绝对路径。
 * @param mutate - 收当前 presets 对象、就地修改。
 * @param warn - `warnOnceFactory(ctx)` 的记录函数。
 * @returns `Promise<void>`。
 */
async function writeToolsCache(ctx, path, mutate, warn) {
  const attempt = async () => {
    const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
    if (typeof fs?.resolve !== 'function' || typeof fs?.writeText !== 'function') return
    const target = await fs.resolve(path)
    const current = await readToolsCache(ctx, path)
    if (current.version === undefined && typeof fs.stat === 'function') {
      // 缓存文件还不存在（或 stat 不可用）→ 交给 createIfAbsent；已存在时它抛 FS_NOT_OBSERVED。
      const presets = current.presets
      mutate(presets)
      const body = JSON.stringify({ version: TOOLS_CACHE_VERSION, presets }, null, 2) + '\n'
      try {
        await fs.writeText(target, body, { kind: 'createIfAbsent' })
        return 'created'
      } catch {
        // 并发方刚创建了它 → 重读拿版本，再走一次带版本的替换。
        const retry = await readToolsCache(ctx, path)
        const nextPresets = retry.presets
        mutate(nextPresets)
        const nextBody = JSON.stringify({ version: TOOLS_CACHE_VERSION, presets: nextPresets }, null, 2) + '\n'
        if (retry.version === undefined) throw new Error('cache exists but fs.stat() gave no version token')
        await fs.writeText(target, nextBody, { kind: 'replaceIfVersion', version: retry.version })
        return 'replaced'
      }
    }
    const presets = current.presets
    mutate(presets)
    const body = JSON.stringify({ version: TOOLS_CACHE_VERSION, presets }, null, 2) + '\n'
    if (current.version === undefined) {
      // stat 不可用（老宿主）：不带意图做无条件覆盖 —— 宁可这次覆盖，也不要写入失败。
      await fs.writeText(target, body)
      return 'overwrote'
    }
    await fs.writeText(target, body, { kind: 'replaceIfVersion', version: current.version })
    return 'replaced'
  }
  try {
    await attempt()
  } catch (error) {
    warn('preset tool cache write failed (best-effort, the roster is unaffected): ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 等一次 `startActivation()` 的子会话真正跑完。
 *
 * ⚠️ 2026-11-25 新增（BUG1 根因）：宿主的 `activation.result` 是
 * `Promise.withResolvers()` 的 **resolver 对象**（`{ promise, resolve, reject }`），
 * **不是 thenable** —— `await` 它会在 0ms 返回（实测 elapsed=0），子会话根本没跑，
 * 于是请求头还没写出就读，`readRealTools()` 一律 null ⇒ 9 个模式全员 `~reg`。
 * 宿主真正暴露的等待入口是 `activation.result.promise`（`dsh-subagent/lib/index.js:2211`）。
 *
 * 三种形态都吃下，避免宿主换实现时静默退回「不等」：
 *   · thenable（直接可 await）→ await 它；
 *   · `{ promise }`（当前宿主）→ await `.promise`；
 *   · 两者都没有 → 立即返回（拿不到等待入口，本函数不制造假等待）。
 *
 * @param activation - `subagents.startActivation()` 的返回值。
 * @returns `Promise<void>`，子会话结束（或拿不到等待入口）时 resolve。
 */
async function awaitActivation(activation) {
  const result = activation?.result
  if (result === undefined || result === null) return
  const awaited = typeof result.then === 'function' ? result : result.promise
  if (awaited !== undefined && awaited !== null && typeof awaited.then === 'function') await awaited
}

/**
 * 从**活注册表**实时派生每个已安装模式的工具清单与技能清单。
 *
 * 每个模式通过 `agentPresets.acquireScope(id)` 拿到该 preset 的 ScopeKey，
 * 再用 `tools.view(key).visible.keys()` 取「已应用 restriction 的可见工具名」
 * （不用 definitions()/schemas()：前者多一次数组分配，后者深拷贝）；
 * 技能用 `skills.list({ cwd, scope: key })`。
 *
 * 1.1.0 起工具有三个来源（`source` 字段），行上的 `tools` 就是模型实际能直接调用的那批：
 *   · `executor`  —— ptc 执行器：固定 `['run_code']`，不实测、不缓存；
 *   · `captured`  —— 实测值（本次派出子代理读请求头，或缓存里的最近实测）；
 *   · `registered` —— 注册面回退（实测失败），渲染时标 `~reg`。
 *
 * @param ctx - 插件上下文。
 * @param selfId - 本模式自己的 preset id（名册不列自己）。
 * @param options - `{ capture, parent, cachePath, config }`：`capture` 允许当场派子代理实测
 *   （只有 `list: true` 传 true）；`parent` 是探针子会话的父 agent（取不到时跳过实测，
 *   走注册面回退）；`cachePath` / `config` 决定缓存文件位置。
 * @returns 行数组；接口缺失（老宿主）时返回 null（调用方改报 live roster unavailable）。
 *   单模式失败**不拖垮整体**：该行回填 `live:false` 与错误原因。
 */
async function collectLive(ctx, selfId, options = {}) {
  const capture = options.capture === true
  // 探针的 parent 必须用**调用方 agent**（`ctx.get('agent')` 在 `list: true` 的调用栈里
  // 是取不到的，实测 2026-11-25）—— 取不到时不派探针，直接走注册面回退。
  const parent = options.parent ?? null
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

  const warn = warnOnceFactory(ctx)
  const cachePath = options.cachePath ?? toolsCachePathOf(ctx, options.config)
  const cacheResult = await readToolsCache(ctx, cachePath)
  const cache = cacheResult.presets
  const cachedOf = (id) => {
    const entry = cache?.[id]
    return entry !== null && typeof entry === 'object' ? entry : undefined
  }

  /**
   * 找一个 preset 已结束、且比缓存新的子会话，回看它的请求头。
   *
   * 目的：把「上一次实测/派活」的子会话当成免费样本，避免每次 `list: true` 都新派一个探针。
   *
   * @returns `Promise<{ childId, tools } | null>`。
   */
  const latestChildCapture = async (presetId, cached) => {
    const subagents = get('subagents')
    if (typeof subagents?.listDescendants !== 'function') return null
    // ⚠️ 2026-11-25 修：宿主签名是 `listDescendants(rootSessionId, signal)`
    // （dsh-subagent/lib/types/list-children.js），**必须传根会话 id**。
    // 原来无参调用 ⇒ 每次都抛 SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE，被下面 catch 吞掉，
    // 「免费回看」这条路径等于不存在（不影响 liveCapture 兜底，但白丢唯一免派探针的机会）。
    const rootId = typeof parent?.id === 'string' && parent.id !== '' ? parent.id : null
    if (rootId === null) return null
    try {
      const listed = await subagents.listDescendants(rootId)
      if (!Array.isArray(listed)) return null
      const candidates = listed
        .filter((row) => row !== null && typeof row === 'object')
        .filter((row) => (row.agentPreset ?? row.presetId) === presetId)
        .filter((row) => typeof row.id === 'string' && row.id !== '')
        .filter((row) => row.mode !== 'running' && row.activity !== 'running')
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      for (const row of candidates) {
        const createdAt = Number(row.createdAt)
        if (Number.isFinite(createdAt) && createdAt > 0 && Number(cached?.capturedAt) >= createdAt) continue
        const real = await readRealTools(ctx, row.id)
        if (real !== null && real.length > 0) return { childId: row.id, tools: real }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 当场实测：派一个极短子代理、**等它跑完**，再读它的请求头。
   *
   * @returns `Promise<{ childId, tools } | null>`。
   */
  const liveCapture = async (presetId, parent) => {
    const subagents = get('subagents')
    if (typeof subagents?.startActivation !== 'function') return null
    try {
      const request = {
        prompt: [{ type: 'text', text: PROBE_PROMPT }],
        parent,
        agentPreset: presetId,
      }
      try {
        const maxDepth = subagents.resolveMaxDepth?.()
        if (Number.isInteger(maxDepth) && maxDepth >= 0) request.maxDepth = maxDepth
      } catch {
        // 解析不了就不带，让服务用默认值。
      }
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `probe ${presetId} tools`,
        request,
        ...request,
        // ⚠️ 2026-11-25 修（BUG1 真因）：这里原来漏了 `signal`。宿主
        // `SubagentActivationSpec.signal` 是**必填**，`manager.trackStartup()` 第一句就是
        // `signal.throwIfAborted()`（dsh-subagent/lib/manager.js:642）⇒ undefined 直接
        // TypeError，被本函数 catch 吞成 warn，9 个模式全部退回注册面并标 `~reg`。
        // delegate 路径（本文件 :1311）一直传 `signal: exec?.signal`，所以派活正常、只有探针挂。
        signal: options.signal,
        delivery: 'parent',
      })
      const childId = typeof activation?.childId === 'string' && activation.childId !== '' ? activation.childId : null
      if (childId === null) return null
      // 必须等它跑完：请求头只在子会话真的发出过一次请求之后才存在。
      //
      // ⚠️ 2026-11-25 修（BUG1，1.1.0 原地覆盖）：原来写的是 `await activation.result`，
      // 那**不会等**任何东西。宿主 `subagents.startActivation()` 回的 `activation.result`
      // 是 `Promise.withResolvers()` 的 **resolver 对象**（`{ promise, resolve, reject }`），
      // 不是 thenable —— `await` 一个普通对象在 0ms 内就返回（实测 elapsed=0）。
      // 后果：子会话刚创建、还没发出过任何请求，`readRealTools()` 读到的是「没有请求头」
      // → 返回 null → 每个模式都退回注册面并标 `~reg`（9 个模式全员 `~reg` 的真因）。
      // 宿主真正暴露的等待入口是 `activation.result.promise`（`dsh-subagent/lib/index.js:2211`）。
      try {
        await awaitActivation(activation)
      } catch {
        // 子会话失败也让下面的读取试一次：失败前可能已经记下请求头。
      }
      const real = await readRealTools(ctx, childId)
      if (real === null || real.length === 0) return null
      return { childId, tools: real }
    } catch (error) {
      warn(`capturing the real tool table of "${presetId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

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

      // ── 工具面三级取数 ────────────────────────────────────────────────
      const cached = cachedOf(row.id)
      let presetPlugins = null
      try {
        presetPlugins = await presets.plugins?.(row.id)
      } catch {
        presetPlugins = null
      }
      let toolNames
      let source
      if (isPtcexecutor(presetPlugins) || row.id === 'ptc') {
        // ① 执行器：注册面是整套被代理的工具，下发面只有 run_code。不实测、不缓存。
        toolNames = [PTC_TOOL]
        source = 'executor'
      } else if (Array.isArray(cached?.tools) && cached.tools.length > 0) {
        // ② 缓存命中。
        toolNames = cached.tools.map((entry) => String(entry))
        source = 'captured'
      } else {
        toolNames = []
        source = 'registered'
        if (capture) {
          // ③ 缓存未命中：先回看已结束的子会话（免费），再当场实测（派探针、等它跑完）。
          const found = (await latestChildCapture(row.id, cached)) ?? (parent === null ? null : await liveCapture(row.id, parent))
          if (found !== null) {
            toolNames = found.tools
            source = 'captured'
            await writeToolsCache(ctx, cachePath, (presetsOut) => {
              presetsOut[row.id] = { tools: found.tools, capturedAt: Date.now(), childId: found.childId }
            }, warn)
          }
        }
      }
      if (toolNames.length === 0) {
        toolNames = names
        if (source !== 'executor') source = 'registered'
      }
      out.push({ id: row.id, tools: toolNames, skills: skillNames, live: true, source })
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
 * ptc 行的说明文案（1.1.0 新增，2026-11-25 定稿）。
 *
 * ⚠️ 编号**不在这里**：`run_code` 与其他工具一样按首现发号，说明行里的编号从
 * `numbering` 取。改文案时必须避开 verify.ps1 的 persona 禁词（见该脚本末尾的断言表）。
 */
const PTC_EXPLANATION = [
  'Programmatic Tool Calling. Use it for bulk or repetitive work that',
  'would flood your context: you write a TypeScript program that calls tools via a',
  'generated SDK, so loops and batching run inside the program and only the final',
  'return value reaches you — intermediate results never enter the context window.',
  'Only run_code is directly callable.',
]

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
 *   · `source === 'registered'`（实测失败、退回注册面）的行在编号后标 ` ~reg`：
 *     那些编号是「注册了」而不是「模型真能直接调」，不许伪装成实测值。
 *   · ptc 这类挂了执行器的行，另出一段说明（编号取 `numbering`，不硬编码）。
 *   · 技能只在 live 行里聚合；`only in …` 只列「不是所有 live 模式都有」的技能。
 *   · **不设字节上限**（`ROSTER_HARD_CAP_BYTES` 已整体移除，别加回来）。
 *
 * @param rows - `[{ id, tools, skills?, live, source? }]`，顺序即 registry 顺序。
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
    const regPart = row.source === 'registered' ? ' ~reg' : ''
    // ⚠️ 2026-11-25 修（BUG2，1.1.0 原地覆盖）：执行器模式（ptc）**只出一行**。
    // 原来先无条件 push 一条 `- ptc: [058] | s[…]`（本行），下面又 push 一条
    // `- ptc: [058] — 说明…`，同一个模式出现两次（用户实测：`list:true` 里 ptc 有两行）。
    // 现在执行器分支接管这一行：编号 + 技能 + 说明写在同一行，说明的续行仍缩进两格。
    if (row.source === 'executor') {
      const n = numbering.get(PTC_TOOL)
      if (typeof n === 'number') {
        lines.push(`- ${row.id}: [${num3(n)}]${skillPart} — ${PTC_EXPLANATION[0]}`)
        for (const extra of PTC_EXPLANATION.slice(1)) lines.push(`  ${extra}`)
      } else {
        lines.push(`- ${row.id}: ${compressRuns(nums)}${skillPart}${regPart}`)
      }
      continue
    }
    lines.push(`- ${row.id}: ${compressRuns(nums)}${skillPart}${regPart}`)
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

// ── 批二①：brief 三段校验 ─────────────────────────────────────────────────────
//
// 为什么在工具入参处拦：`subagent_preset` 的 description 自己就写着「worker 看不到
// 本对话」，但模型仍会把「见上」「接着做」这种 brief 派出去 —— worker 拿一句无法执行
// 的话空烧一整轮，而大脑那边只看到「已派活」。三行标签的成本远低于一次白烧。
//
// 判据**故意宽**（宁漏不误杀）：正文里出现 TASK / INPUT / OUT 三个词（大小写不限，
// `TASK:` / `**TASK**` / `TASK<换行>` / `- TASK` / `## TASK` / `TASK：` 全部命中）
// 就算结构在。任何形状检查（必须独占一行、必须带冒号、必须按顺序）都会误杀真实
// brief —— 那是比漏拦更坏的错。

/** 三段标签的判据表：`[标签名, 宽松正则]`。 */
const BRIEF_LABELS = [
  ['TASK', /\bTASKS?\b/i],
  ['INPUT', /\bINPUTS?\b/i],
  ['OUT', /\bOUT(?:PUT)?S?\b/i],
]

/**
 * 缺哪几段。
 *
 * 纯函数、不读 ctx：`subagent_preset`（prompt）与 `send_to_subagent`（message）
 * 共用这一份判据，两处各写一个正则必然会漂。
 *
 * @param text - 要派出去的正文。
 * @returns {string[]} 缺的标签名（`[]` = 三段齐全）。
 */
export function briefGaps(text) {
  if (typeof text !== 'string') return BRIEF_LABELS.map(([label]) => label)
  return BRIEF_LABELS.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label)
}

/**
 * 三段校验的拒绝文案 + **可执行**修法（两处调用点共用，避免文案漂移）。
 *
 * @param missing - `briefGaps()` 的返回值。
 * @returns {{ code: string, message: string, nextAction: string }}
 */
export function briefRefusal(missing) {
  const list = Array.isArray(missing) && missing.length > 0 ? missing.join('、') : 'TASK、INPUT、OUT'
  return {
    code: 'brief-not-structured',
    message:
      `你的 brief 缺 ${list}。worker 看不到本对话，补三行：` +
      '`TASK:` 干什么 / `INPUT:` 读哪些文件（绝对路径）/ ' +
      '`OUT:` 要什么回来（写明「回 RESULT / EVIDENCE / FILES，EVIDENCE 给 path:line 或字节数」）。',
    nextAction:
      `把缺的 ${list} 段补进原 brief（一行一段），然后原样重发这次调用：` +
      '`TASK: <这件活要干什么>` / `INPUT: <要读的文件绝对路径，一行一个>` / ' +
      '`OUT: 回 RESULT / EVIDENCE / FILES，EVIDENCE 给 path:line 或字节数`。',
  }
}

// ── 批二②：`task` 标签 + 派发去重 ─────────────────────────────────────────────
//
// 「同一件事派两个工人」在黑猪里是最贵的一种重复：两份并行工作、两倍 token，
// 而汇报都写着完成。判据用**调用方给的标签**（`task`），不是语义相似度 ——
// 相似度判据（desc / prompt 像不像）已在 2026-11-24 的复核里被否掉
// （I7：上下文重叠 ≠ 任务相似），这里不重开那个口子。
//
// 状态放 `globalThis[Symbol.for(...)]`：进程内、不进磁盘。用 globalThis 是因为同一
// 进程里 preset scope 可能 apply 多次（HMR），而「这个 slug 现在归谁」是全局事实；
// 用 `Symbol.for` 是因为它不进 JSON、也不会和别的插件撞键。

/** 派活去重表的进程内键。 */
export const DISPATCH_CLAIMS_KEY = Symbol.for('dsh-blackpig-mode:dispatch-claims:v1')

/** 去重记录 TTL 兜底（默认 1 小时）：`agent/disposed` 漏了也不会永久占住一个 slug。 */
export const DEFAULT_DISPATCH_TTL_MS = 3600000

/** 需求原文用 `DASH_DISPATCH_TTL_MS` 指这个常量，保留同名导出以便对表。 */
export const DASH_DISPATCH_TTL_MS = DEFAULT_DISPATCH_TTL_MS

/** TTL 覆盖用的环境变量名（验证时调短）。 */
export const DISPATCH_TTL_ENV = 'DSH_BLACKPIG_DISPATCH_TTL_MS'

/** 归一化后的 `task` 标签长度上限。 */
export const TASK_SLUG_MAX = 64

/**
 * 取（或建）进程内的派活去重表。
 *
 * 形状固定 `{ claims: Map<key, { childSessionId, at, done }> }`；别处留下形状不对的
 * 同名属性就重建 —— 半损坏的状态比空状态更危险（可能让某个 slug 永远判成「有主」）。
 *
 * @returns {{ claims: Map<string, { childSessionId: string, at: number, done: boolean }> }}
 */
function dispatchClaimsState() {
  const bag = globalThis
  let current = bag[DISPATCH_CLAIMS_KEY]
  if (
    current === undefined ||
    current === null ||
    typeof current !== 'object' ||
    !(current.claims instanceof Map)
  ) {
    current = { claims: new Map() }
    bag[DISPATCH_CLAIMS_KEY] = current
  }
  return current
}

/**
 * 把 `task` 归一化成 tag 化 slug。
 *
 * 顺序固定：小写 → 空白换 `-` → 只留 `[a-z0-9._-]` → 去首尾 `-` → 截到 64。
 * 先换空白再过滤，`fix parser bug` 才得到 `fix-parser-bug` 而不是 `fixparserbug`。
 * 归一化后为空（全非法字符 / 只有空白的中文标签）由调用方拒 `task-invalid`。
 *
 * @param raw - 调用方给的 `task`。
 * @returns {string} slug；非法则为空串。
 */
export function normalizeTaskSlug(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, TASK_SLUG_MAX)
}

/**
 * 读一个 agent 的会话 id（`session.id`，兜 `agent.id`），全程兜错。
 *
 * 两次读取各自兜错：disposed 时 `session` 可能已被拆掉，`id` 也可能是 throwing getter。
 * 与 `subtalk.mjs` 的 `agentScopeKeyOf()` 同一口径（子会话里两者一般同名）。
 *
 * @param agent - 宿主 agent 对象。
 * @returns {string|undefined}
 */
function sessionIdOfAgent(agent) {
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
    // 连 agent.id 都读不出：调用方按「没有身份」处理。
  }
  return undefined
}

/**
 * 三态存活判定：`alive` / `dead` / `unknown`（与 `blackpig-file-guard` 的同名判据同取向）。
 *
 * `unknown`（agents 服务取不到 / 读抛错）**不据此释放** —— 服务未就绪就把整张表清掉，
 * 正好会让去重在最需要它的窗口里失效。
 *
 * @param ctx - 插件上下文。
 * @param id - childSessionId。
 * @returns {'alive'|'dead'|'unknown'}
 */
function livenessOf(ctx, id) {
  let agents
  try {
    agents = ctx.get?.('agents')
  } catch {
    return 'unknown'
  }
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return 'unknown'
  let live
  try {
    live = agents.get(id)
  } catch {
    return 'unknown'
  }
  return live === undefined || live === null ? 'dead' : 'alive'
}

/**
 * 解析去重 TTL：config 优先，其次环境变量，最后默认值。非法值一律回落（配置打错不抛）。
 *
 * @param config - `apply()` 收到的配置。
 * @returns {number} 毫秒。
 */
export function resolveDispatchTtl(config) {
  const fromConfig = config?.ttlMs
  if (Number.isInteger(fromConfig) && fromConfig > 0) return fromConfig
  let raw
  try {
    raw = process.env?.[DISPATCH_TTL_ENV]
  } catch {
    raw = undefined
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return DEFAULT_DISPATCH_TTL_MS
}

/**
 * 每次判定前 prune：**过期且确认已不在活注册表**才释放。
 *
 * 为什么活着就不清（哪怕已超 TTL）：TTL 是「disposed 事件漏了」的兜底，不是占用上限。
 * 一个还活着的工人占着 slug 正是这个机制要的效果 —— 清掉它等于允许再派一个同样的活。
 *
 * @param stateBag - `dispatchClaimsState()`。
 * @param ctx - 插件上下文。
 * @param ttlMs - 本次判定的 TTL。
 * @param now - 本次判定的时刻。
 */
function pruneDispatchClaims(stateBag, ctx, ttlMs, now) {
  for (const [key, claim] of [...stateBag.claims]) {
    const at = typeof claim?.at === 'number' ? claim.at : 0
    if (now - at < ttlMs) continue
    if (livenessOf(ctx, claim?.childSessionId) === 'alive') continue
    stateBag.claims.delete(key)
  }
}

/**
 * 释放某个 childSessionId 名下的**全部**去重记录（`agent/disposed` 用）。
 *
 * @param stateBag - `dispatchClaimsState()`。
 * @param childSessionId - 被释放的子会话 id。
 * @returns {number} 释放条数。
 */
function releaseDispatchClaimsOf(stateBag, childSessionId) {
  let released = 0
  for (const [key, claim] of [...stateBag.claims]) {
    if (claim?.childSessionId === childSessionId) {
      stateBag.claims.delete(key)
      released += 1
    }
  }
  return released
}

/**
 * 只读快照（诊断 / 离线单测用）。返回深拷贝，调用方改不坏内部状态。
 *
 * @returns {Record<string, { childSessionId: string, at: number, done: boolean }>}
 */
export function dispatchClaimsSnapshot() {
  try {
    const out = {}
    for (const [key, claim] of dispatchClaimsState().claims) out[key] = { ...claim }
    return out
  } catch {
    return {}
  }
}

/**
 * `duplicate-task` 的拒绝文案：说清是谁在做、做了多久、两条可执行出路。
 *
 * @param claim - 已有的去重记录。
 * @param slug - 归一化后的 task 标签。
 * @param now - 判定时刻。
 * @returns {string}
 */
function duplicateTaskMessage(claim, slug, now) {
  const id = typeof claim?.childSessionId === 'string' ? claim.childSessionId : '<unknown>'
  const at = typeof claim?.at === 'number' ? claim.at : now
  const seconds = Math.round(Math.max(0, now - at) / 100) / 10
  return (
    `\`task=${slug}\` 已由 worker ${id.slice(0, 8)} 在做（${seconds}s）。` +
    `要补充要求就 \`send_to_subagent(agent_id=${id})\`；` +
    '确实要另起一件不同的活，就换一个 task 标签。'
  )
}

/**
 * 读一个可复用 worker 的模式（preset id）。
 *
 * 三种来源，按「便宜且可信」排序：
 *   ① 可复用行自带的模式字段（有的宿主版本在投影行上带 `preset` / `agentPreset`）；
 *   ② 活 agent 的会话头 `session.header.agentPreset`（worker 还活着时最可靠）；
 *   ③ 已落盘会话头 `sessionQuery.observeSession(id).header.agentPreset`（冷 worker 用）。
 *
 * ⚠️ 绝不把可复用行上的 `mode` 当模式用：那个字段是**生命周期**
 * （`continuable` / `one-shot` / `external`），与 preset 无关 —— 拿它比对会把
 * 每一次复用都误拒成 `reuse-mode-mismatch`。
 *
 * 全取不到 → `undefined`：调用方**跳过校验并 warn**，宁可漏拦也不误拒。
 *
 * @param ctx - 插件上下文。
 * @param rows - `reusableChildrenOf()` 的行（已含 `mode === 'continuable'`）。
 * @param id - 解析出的 worker id。
 * @param signal - 取消信号。
 * @returns {Promise<string|undefined>}
 */
async function reuseModeOf(ctx, rows, id, signal) {
  const row = Array.isArray(rows) ? rows.find((item) => item?.id === id) : undefined
  for (const field of ['preset', 'agentPreset', 'presetId']) {
    const value = row?.[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  let agents
  try {
    agents = ctx.get?.('agents')
  } catch {
    agents = undefined
  }
  if (agents !== undefined && agents !== null && typeof agents.get === 'function') {
    try {
      const preset = agents.get(id)?.session?.header?.agentPreset
      if (typeof preset === 'string' && preset.trim() !== '') return preset.trim()
    } catch {
      // 读不到就换下一个来源。
    }
  }
  let query
  try {
    query = ctx.get?.('sessionQuery')
  } catch {
    query = undefined
  }
  if (query !== undefined && query !== null && typeof query.observeSession === 'function') {
    let observation
    try {
      observation = await query.observeSession(id, { signal, projectionMode: 'none' })
      const preset = observation?.header?.agentPreset
      if (typeof preset === 'string' && preset.trim() !== '') return preset.trim()
    } finally {
      // lease 必须释放，否则会把冷读的 Session 钉在观察缓存里（容量 5）。
      try {
        observation?.[Symbol.dispose]?.call?.(observation)
      } catch {
        // 释放失败不影响判定结论。
      }
    }
  }
  return undefined
}

/**
 * 装载本模块。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, selfPresetId, disabledPresets, toolsCachePath, ttlMs? }`。
 * @returns void。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)
  // 工具面缓存的绝对路径：优先 `config.toolsCachePath`，否则按本次进程的 DSH_HOME 推导。
  // 见 toolsCachePathOf()：**不写 `~`**（homedir() 与 DSH_HOME 无关，隔离实例会踩生产 profile）。
  const cachePath = toolsCachePathOf(ctx, config)
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

  // ── 批二②：派活去重表的释放路径 ────────────────────────────────────────────
  // 子会话结束 = 那个 slug 可以再派。`agent/disposed` 是 emit（不是 serial），监听器
  // 抛错只被宿主 warn 掉、不会传染；这里仍整体包 try —— disposed 时 `session` 可能
  // 已被拆掉，我们的读路径必须容忍读不到（读不到就什么都不做）。
  // 注：`blackpig-file-guard.mjs` 也监听同一事件，但它管的是**它自己的**文件占用表；
  // 去重表是另一份状态（globalThis 上的另一个 Symbol），不能被它清掉，所以要自己注册。
  try {
    ctx.on('agent/disposed', (payload) => {
      try {
        const id = sessionIdOfAgent(payload?.agent)
        if (id === undefined) return
        releaseDispatchClaimsOf(dispatchClaimsState(), id)
      } catch (error) {
        warn(
          'releasing dispatch claims of a disposed agent threw — a stale claim may outlive the session. ' +
            'Underlying error: ' + (error instanceof Error ? error.message : String(error)),
        )
      }
    })
  } catch (error) {
    warn(`could not subscribe to agent/disposed: ${error instanceof Error ? error.message : String(error)}`)
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

  /**
   * 把「这个 preset 跑在哪个子会话里」记进工具面缓存。
   *
   * 只写 `childId`（+ 时间），**不覆盖已有的 `tools`**：下次 `list: true` 可以回看该子会话，
   * 它若已结束且比缓存新就顺手刷新工具表，省掉再派一个探针。写缓存失败只 warn，不影响派活回执。
   *
   * @param presetId - 派活目标 preset。
   * @param childId - 子会话 id。
   * @returns `Promise<void>`。
   */
  const recordChildCapture = async (presetId, childId) => {
    await writeToolsCache(ctx, cachePath, (presets) => {
      const previous = presets[presetId] !== null && typeof presets[presetId] === 'object' ? presets[presetId] : {}
      presets[presetId] = {
        tools: Array.isArray(previous.tools) ? previous.tools : [],
        capturedAt: typeof previous.capturedAt === 'number' ? previous.capturedAt : 0,
        childId,
      }
    }, warn)
  }

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

    // ── 批二①：brief 三段校验（TASK / INPUT / OUT 三段缺一即拒）──────────────
    // 放在「有没有 prompt」之后、其余一切之前：这是纯入参检查，不读服务、不起会话，
    // 拒掉一次不合格 brief 的成本是一个回执，放过去的成本是 worker 空烧一整轮。
    const gaps = briefGaps(prompt)
    if (gaps.length > 0) {
      const refusal = briefRefusal(gaps)
      return failure(refusal.code, refusal.message, {
        stop: false,
        nextAction: refusal.nextAction,
        degraded: ['brief-not-structured'],
      })
    }

    // ── 批二②：`task` 必填 + 归一化 ────────────────────────────────────────────
    // `task` 是**调用方**给这件事起的唯一标签，同一件事必须用同一个标签 —— 去重键就
    // 建立在它上面。归一化不合法（空 / 全非法字符）时明确拒绝，而不是猜一个标签。
    const taskSlug = normalizeTaskSlug(args?.task)
    if (taskSlug === '') {
      return failure(
        'task-invalid',
        `\`task\` 必须是可用标签（收到 ${JSON.stringify(args?.task ?? null)}，归一化后为空）。` +
          `规则：小写、空格换成 \`-\`、只留 [a-z0-9._-]、最多 ${TASK_SLUG_MAX} 字符，` +
          '例如 `fix-parser` / `batch2.brief-check`。同一件事每次都用同一个标签。',
        {
          stop: false,
          presetId,
          nextAction: '给这次派活起一个稳定标签（只含 a-z 0-9 . _ -，≤64 字符，例如 `fix-parser`），填进 `task` 后原样重发。',
          degraded: ['task-invalid'],
        },
      )
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

        // ── 批二③：`reuseId` 的模式必须与本次 `preset` 一致 ──────────────────
        // 复用**不能改模式**：`send_to_subagent` 只在既有 worker 里加一轮，它的 preset
        // 是会话头里冻住的。模式不符时悄悄按旧模式跑，是「看起来派给了 B、其实还是 A」。
        // 取不到 worker 的模式 → **跳过校验并 warn**（宁可漏拦，不可误拒）。
        try {
          const workerMode = await reuseModeOf(ctx, reusable, resolved.id, exec?.signal)
          if (workerMode === undefined) {
            warn(
              `cannot determine the preset of reusable worker ${resolved.id} ` +
                '(no preset field on the catalog row, no live agent, no readable session header); ' +
                'skipping the reuse-mode check for this call',
            )
          } else if (workerMode !== presetId) {
            return failure(
              'reuse-mode-mismatch',
              `worker ${resolved.id} 的模式是 ${workerMode}，你传的是 ${presetId}。` +
                '`send_to_subagent` 不能改模式：要么 reuseId 指向 ' +
                `${workerMode} 的 worker，要么 \`fresh:true\` 新开一个 ${presetId}。`,
              {
                stop: false,
                presetId,
                nextAction:
                  `二选一：① 把 reuseId 指向 ${workerMode} 模式的 worker；` +
                  `② 传 \`fresh: true\` 新开一个 ${presetId} 的 worker（不要同时传 reuseId）。`,
                degraded: ['reuse-mode-mismatch'],
              },
            )
          }
        } catch (error) {
          // 失败安全：校验器自己炸了，绝不能堵死一次合法的复用。
          warn(
            'the reuse-mode check threw; allowing the resume. Underlying error: ' +
              (error instanceof Error ? error.message : String(error)),
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

    // ── 批二②：同一调用方 + 同一 `task`，只许一个工人在做 ──────────────────────
    // 走到这里 = 本次会**新建**子会话：`reuseId` 路径已在上面 return（复用同一个工人
    // 继续干活是合法的，不登记也不判重 —— 所以有 claim 的 worker 被 reuse 也不报错）。
    // 位置在 `presetUnusable()` 之后：模式本身不可用时先报那个，别拿「重复」盖住
    // 「这个模式根本派不了」。
    //
    // 失败安全：去重是省钱的保险，不是派活的前置条件 —— 任何内部异常都必须放行。
    // 只有「确定有活的重复」才拒（错误地拒死一次活的代价，远高于漏拦一次重复）。
    const callerSessionId = callerSessionIdsOf(parent)[0] ?? ''
    let dispatchKey = ''
    if (callerSessionId !== '') {
      try {
        const now = Date.now()
        const claims = dispatchClaimsState()
        pruneDispatchClaims(claims, ctx, resolveDispatchTtl(config), now)
        dispatchKey = `${callerSessionId}::${taskSlug}`
        const existing = claims.claims.get(dispatchKey)
        if (existing !== undefined) {
          return failure('duplicate-task', duplicateTaskMessage(existing, taskSlug, now), {
            stop: false,
            presetId,
            nextAction:
              `要给同一个工人补要求就用 \`send_to_subagent(agent_id=${existing.childSessionId})\`；` +
              '确实要另起一件不同的活，就换一个 `task` 标签。',
            degraded: ['dispatch-deduped'],
          })
        }
      } catch (error) {
        dispatchKey = ''
        warn(
          'the dispatch-dedup check threw; allowing the dispatch. Underlying error: ' +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }

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
      // 1.1.0：把这个 preset 的子会话 id 记进工具面缓存（只记 childId，不覆盖已有 tools）。
      // 下一次 `list: true` 就能回看该子会话拿实测工具表，不必再派探针。写失败只 warn。
      await recordChildCapture(presetId, childSessionId)
      // 批二②：**派发成功后**才登记去重记录 —— 失败 / 无 childId 不该占住 slug，
      // 否则一次失败的派活会把这件事永久锁死。登记失败只 warn（去重是尽力而为）。
      if (dispatchKey !== '') {
        try {
          dispatchClaimsState().claims.set(dispatchKey, {
            childSessionId,
            at: Date.now(),
            done: false,
          })
        } catch (error) {
          warn(
            'recording the dispatch claim failed; duplicate detection is best-effort for this call. ' +
              'Underlying error: ' + (error instanceof Error ? error.message : String(error)),
          )
        }
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
          'that writes different files (a peer write to a file another worker holds is rejected).',
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
        'Briefs must be structured, because the worker sees nothing of this conversation: `TASK:` what to do, `INPUT:` which files to read (absolute paths), `OUT:` what to return (say `RESULT / EVIDENCE / FILES`, and that EVIDENCE needs `path:line` or byte counts). A brief missing any of the three is refused with `brief-not-structured`. ' +
        '`task` is a stable slug for this one job: reusing the same tag while a worker is still on it is refused with `duplicate-task` (send that worker a follow-up instead, or pick a different tag). ' +
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
            description:
              'The complete, self-contained task, labelled `TASK:` / `INPUT:` / `OUT:`. ' +
              'The worker runs under a DIFFERENT mode and cannot see this conversation.',
          },
          description: {
            type: 'string',
            description: 'A short (3-5 word) label for display.',
          },
          task: {
            type: 'string',
            description:
              '这件事的唯一标签：同一件事用同一个标签（派过一次就别换写法），换一件事才换标签。' +
              '小写字母/数字/点/下划线/连字符，不超过 64 字符，例如 `fix-parser`。同一标签在同一个调用方下只允许一个活着的工人。',
          },
          list: {
            // `list` 是纯 boolean：`{ all: true }` 分支已于 2026-11-14 移除（只服务旧基准流程，且绕过 hidden 过滤）。
            type: 'boolean',
            description:
              '`true` returns the roster — a global numbered tool index plus per-mode tool-number ranges, ' +
              'and the installed skills. This branch needs neither `preset` nor `task`.',
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
        required: ['task'],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        // 2026-11-15：名册字节硬顶移除后，回执不再有任何预算收口 —— 原样渲染。
        render: (renderArgs, renderValue) => render(renderArgs, renderValue),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args?.list === true) {
          // 1.1.0：`list: true` 允许当场实测（派探针、**等它跑完**再读请求头），不设超时。
          const live = await collectLive(ctx, selfId, { capture: true, parent: exec?.agent ?? null, signal: exec?.signal, cachePath, config })
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
