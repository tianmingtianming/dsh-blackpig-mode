/**
 * blackpig-ls — 一个**只列目录条目名**的只读工具（零文件内容）。
 *
 * ── 它为什么存在（能力边界是设计的核心，不是实现细节）───────────────────────────
 *
 * 黑猪模式的大脑不能读文件正文：留 `read` / `grep` 会诱发它「顺手自己去翻文件」，
 * 把过程数据全吃进主上下文。但大脑又确实需要**知道有哪些文件**，才能：
 *   列名 → 猜路径 → 用 `file_info` 验大小/存在性 → 真需要内容才派代理去读。
 *
 * 缺了「列名」这一环，大脑只能靠代理回报文件名，或盲猜。本工具补的就是这一环，
 * 而且**只补这一环**：
 *
 *   · 只回**直接子条目**的名字 + dir/file 类型 + 文件字节数（stat 元数据，不是正文）；
 *   · **绝不返回任何文件内容** —— 不 readFile、不 open 读正文、不 grep、不 glob；
 *   · **不递归**（`recursive` 参数保留但默认 false，且实现上永不递归）；
 *   · 输出硬顶：最多 200 条 / 8 KB，超出即截断并明示总数；
 *   · 路径不存在 / 不是目录 / 不可读 → 抛明确错误，不静默给空表。
 *
 * ── 为什么用 node:fs 而不是 ctx.fs ────────────────────────────────────────────
 *
 * 本工具是**发布要求**明确指定的实现：`node:fs` 的 `readdirSync(path,{withFileTypes:true})`
 * + `statSync` 取文件大小。两者都只取目录项与元数据，从不读正文，所以「绝不返回文件内容」
 * 这条边界由所用 API 本身保证。相对路径用宿主同源的 workingDirectory 投影解析（与
 * file-info.mjs 一致，`cd` 之后仍与 read/write/edit 对齐）。
 *
 * ── 为什么零第三方依赖 ──────────────────────────────────────────────────────
 *
 * 只用 node 内置模块，不 import 任何 `@deepseek-ai/*`：导入失败 = 整份 preset 挂载失败，
 * 这条硬约定本包其它模块也一样。
 *
 * @module blackpig-model/ls-tool
 */

import fs from 'node:fs'
import path from 'node:path'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-ls'

/**
 * `tools` 是硬前置；`workingDirectory` 用来把相对路径解析到会话当前 cwd。
 * 缺 tools 时本行会被挂住（mount 审计可见），好过注册一个必然失败的工具。
 */
export const inject = ['tools', 'workingDirectory']

/** 模型面工具名。必须与 guard-v10.mjs 的 DEFAULT_KEEP、cordis.patch.yml 的插件行逐字一致。 */
const TOOL_NAME = 'ls'

/** 单次最多列出的条目数硬顶。 */
const MAX_ENTRIES = 200

/** 单次输出文本硬顶（UTF-8 字节）。两个上限都生效，先到先截。 */
const MAX_BYTES = 8192

/** 装机后可供 grep 的固定标识（逐字 ASCII，不要改写或本地化）。 */
const ENGAGED = 'LS-ENGAGED'
const SKIPPED = 'LS-SKIPPED'

/**
 * 参数 schema（**原始 JSON Schema**，直接交给 `register()`）。
 * `required: []`：`path` 与 `recursive` 都可选；`path` 缺省即会话 cwd。
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description:
        'Directory to list. Defaults to the session working directory. Relative paths are resolved against it. ' +
        'Returns the names of the immediate entries only, never their contents.',
    },
    recursive: {
      type: 'boolean',
      description:
        'Reserved and defaults to false. This tool deliberately never recurses: only the immediate entries of ' +
        'the given directory are ever listed, regardless of this value.',
    },
  },
  required: [],
}

/**
 * 输出值的 schema。
 *
 * `register()` 会用 `validateJsonSchemaValue(output.schema, value)` 校验 `execute` 的返回值
 * （多一个键就是 ToolOutputError），所以 `additionalProperties:false` 下列出的字段必须与
 * 返回值逐字一致。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'The resolved directory that was listed.' },
    entries: {
      type: 'array',
      description: 'Immediate entries, directories first then alphabetical by name. Names only - never content.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Entry name only (no path, no content).' },
          kind: { type: 'string', enum: ['dir', 'file'], description: 'Directory or file.' },
          sizeBytes: {
            type: 'integer',
            description: 'File byte count from stat metadata; 0 for directories (no meaningful content size).',
          },
        },
        required: ['name', 'kind', 'sizeBytes'],
      },
    },
    total: { type: 'integer', description: 'Total direct entries BEFORE any truncation.' },
    shown: { type: 'integer', description: 'How many entries are actually shown.' },
    truncated: { type: 'boolean', description: 'True when total > shown (cap hit).' },
    notice: { type: 'string', description: 'Truncation notice, or empty string when nothing was truncated.' },
  },
  required: ['path', 'entries', 'total', 'shown', 'truncated', 'notice'],
}

/** 属性值转义（名字里可能有引号 / 尖括号 / &）。 */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 由结构化值生成输出文本行。
 *
 * execute() 与 render() **共用**这个函数：execute 用它算字节数决定在哪里截断，
 * render 用它产出最终文本 —— 两者逐字一致，不会出现「值说没截断、文本却超长」。
 */
function buildLines(value) {
  const lines = [
    `<ls path="${esc(value.path)}" total="${value.total}" shown="${value.shown}" truncated="${value.truncated}">`,
  ]
  for (const entry of value.entries) {
    lines.push(`  <entry kind="${entry.kind}" name="${esc(entry.name)}" bytes="${entry.sizeBytes}"/>`)
  }
  if (value.notice !== '') lines.push(`  <notice>${esc(value.notice)}</notice>`)
  lines.push('</ls>')
  return lines
}

/** 一段文本的 UTF-8 字节数。 */
function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 把参数里的 `path` 解析成绝对目录。
 *
 * 优先级与 file-info.mjs 的 sessionCwd 一致：
 *   ① `ctx.workingDirectory.ensure(exec.agent, exec.signal)`（cd 之后仍是对的投影值）；
 *   ② `exec.agent.session.header.cwd`（启动快照，向后兼容）；
 *   ③ `process.cwd()`（探针 / 无服务时的最后兜底）。
 *
 * 每层都包 try：测试桩可以给出任意形状的 exec，绝不让取值炸掉工具。
 */
async function resolveDir(args, exec, ctx) {
  let cwd
  try {
    const wd = ctx?.workingDirectory
    if (wd && typeof wd.ensure === 'function') cwd = await wd.ensure(exec?.agent, exec?.signal)
  } catch {
    // 未注入 / 抛错 → 走兜底。
  }
  if (typeof cwd === 'object' && cwd !== null && typeof cwd.cwd === 'string') cwd = cwd.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    try {
      const headerCwd = exec?.agent?.session?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd.trim() !== '') cwd = headerCwd
    } catch {
      // ignore
    }
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') cwd = process.cwd()
  const raw = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : '.'
  return path.resolve(cwd, raw)
}

/**
 * 读取一个目录的直接条目并排序：目录在前、其余按名字字母序。
 *
 * 只调 readdirSync(withFileTypes) + statSync —— 两者都只取元数据 / 目录项，
 * **没有任何读取文件正文的调用**。stat 失败（如坏符号链接）时该文件大小记 0，
 * 不影响名字的列出。
 */
function listEntries(dir) {
  const dirents = fs.readdirSync(dir, { withFileTypes: true })
  const rows = []
  for (const dirent of dirents) {
    const isDir = dirent.isDirectory()
    let sizeBytes = 0
    if (!isDir) {
      try {
        const st = fs.statSync(path.join(dir, dirent.name))
        if (Number.isFinite(st.size) && st.size >= 0) sizeBytes = st.size
      } catch {
        // 取不到大小仍如实列名字，大小记 0（绝不编造、绝不读正文）。
      }
    }
    rows.push({ name: dirent.name, kind: isDir ? 'dir' : 'file', sizeBytes })
  }
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })
  return rows
}

/**
 * 生成裁剪说明（同时被两个上限触发时共用一个口径）。
 */
function truncationNotice(shown, total) {
  return `Showing ${shown} of ${total} entries; output truncated (cap ${MAX_ENTRIES} entries / ${MAX_BYTES} bytes). ` +
    'Use a narrower path, or dispatch a worker to enumerate more.'
}

/** 每种原因只警告一次的记录器（避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`blackpig-model/ls-tool: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 输出渲染：把结构化值还原成文本块。
 */
function render(_args, value) {
  return [{ type: 'text', text: buildLines(value).join('\n') }]
}

/**
 * 装载 ls 工具。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return
  const warn = warnOnceFactory(ctx)

  if (typeof ctx?.tools?.register !== 'function') {
    warn(
      `${SKIPPED} reason=no-tools — ctx.tools.register() is unavailable, so "${TOOL_NAME}" was NOT registered`,
    )
    return
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'List the names of the immediate entries in a directory only. Each entry reports its name, whether it ' +
        'is a dir or a file, and the file byte count. It NEVER returns file content: no reading, no grep, no ' +
        'glob, no recursion (the recursive parameter is reserved and never recurses). Output is capped at ' +
        `${MAX_ENTRIES} entries / ${MAX_BYTES} bytes and is truncated with the total when exceeded. ` +
        'A path that does not exist or is not a directory is a clear error. Use this to discover what exists, ' +
        'then file_info to verify sizes, and only dispatch a subagent when you actually need a file\'s content.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const dir = await resolveDir(args, exec, ctx)

        // 路径不存在 / 不是目录 → 明确错误，绝不静默回空表。
        let stat
        try {
          stat = fs.statSync(dir)
        } catch (error) {
          throw new Error(
            `ls: path does not exist or cannot be inspected: ${dir} (${error instanceof Error ? error.message : String(error)})`,
          )
        }
        if (!stat.isDirectory()) {
          throw new Error(`ls: not a directory: ${dir}`)
        }

        let all
        try {
          all = listEntries(dir)
        } catch (error) {
          throw new Error(
            `ls: cannot list directory: ${dir} (${error instanceof Error ? error.message : String(error)})`,
          )
        }

        const total = all.length

        // 硬顶 1：条目数。
        let kept = all.slice(0, MAX_ENTRIES)
        let truncated = total > kept.length
        let notice = truncated ? truncationNotice(kept.length, total) : ''

        // 硬顶 2：文本字节数。逐条回退，直到 buildLines 的字节数 ≤ MAX_BYTES。
        // 说明文字也计入预算，所以「值说没截断」与「文本确实没超长」永远一致。
        const fits = (entries, note) =>
          bytesOf(buildLines({ path: dir, entries, total, shown: entries.length, truncated: total > entries.length || note !== '', notice: note }).join('\n')) <= MAX_BYTES
        while (kept.length > 0 && !fits(kept, notice)) {
          kept = kept.slice(0, kept.length - 1)
          truncated = true
          notice = truncationNotice(kept.length, total)
        }
        // 极端情况：连一条 + 说明都装不下 → 只回一条极简说明（仍带总数）。
        if (kept.length === 0 && !fits(kept, notice)) {
          notice = `Output truncated (cap ${MAX_BYTES} bytes); ${total} entries exist. Dispatch a worker to enumerate them.`
        }

        return {
          path: dir,
          entries: kept,
          total,
          shown: kept.length,
          truncated,
          notice,
        }
      },
    })
  } catch (error) {
    warn(
      `${SKIPPED} reason=register-failed — ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  try {
    ctx.logger?.info?.(
      `blackpig-model/ls-tool: ${ENGAGED} — registered read-only name-only tool "${TOOL_NAME}"`,
    )
  } catch (error) {
    warn(
      `the read-only tool "${TOOL_NAME}" WAS registered, but the info log threw: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
