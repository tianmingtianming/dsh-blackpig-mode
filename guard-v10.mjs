/**
 * blackpig-guard — 「大脑模式」的窄工具面守卫（自控实现，零第三方依赖）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 *
 * 大脑模式要求主对话（大脑）只做四件事：看懂需求、拆任务、派给队友、
 * 收结论并汇报。写文件、跑命令、搜索、抓网页这些会带来「过程数据」的工具不该出现在
 * 它的可见面里 —— 工具不在，就调不了，也就污染不了主上下文。
 *
 * 光靠人格指令做不到：模型仍会「顺手」跑一条命令。本模块把纪律变成机制：
 * 在**大脑自己的 agent scope** 上装一条 `tools.restrict({ deny })`（隐藏），
 * 再加一条 `tools.guard()`（真正拒绝执行）。
 *
 * ── 为什么限制大脑不会波及队友 ────────────────────────────────────────
 *
 * `dsh-subagent` 的 `applyChildComposition` 会让每个子会话加入**父级那一份 preset**
 * （`agentPresets.composeFrom(childCtx, parent.ctx)`），而注册表 `join()` 把 agent
 * scope 的父链绑到 preset 的 generation key 上 —— 于是大脑与队友是**同一个
 * generation key 下的兄弟，不是父子**。
 *
 * `dsh-tools` 的可见性只沿各自祖先链判定：
 *
 *     for (const [name, definition] of inherited) {
 *       if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
 *     }
 *     // 本层自己注册的工具无条件可见
 *     if (own !== void 0) for (...) visible.set(name, definition)
 *
 * 限制装在大脑自己的 layer 上，该 layer 不在队友祖先链里 → 队友不受影响。
 *
 * ── 为什么不写死黑名单 ──────────────────────────────────────────────────────
 *
 * `tools.restrict()` 对未知名字会抛错（拿 `restrictableNames` 校验，该集合 =
 * 全局层 + 祖先层，不含本层、不含 run_code）。所以反过来做：
 *
 *     deny = 该 scope 当前可见集 − 保留集
 *
 * 于是名单里每个名字都必然存在，`restrict()` 不会抛错；以后任何新插件注册的工具
 * 也默认对大脑关闭，无需改这个文件。
 *
 * ⚠️ 本层注册的工具（Agent Teams 的 9 个由 `tool-agent-team` 注册在 agent 自己的
 * scope 上）**restrict 摘不掉、也不能出现在 deny 里**，所以必须在保留集里。
 *
 * ── 顺序：卸 → 读 → 装 ──────────────────────────────────────────────────────
 *
 * `schemas(agent)` 返回的是**已过限制**的可见面；不先卸旧限制，重算只看得到上次
 * 留下的缝，新注册的工具永远补不进 deny 集。三步全同步，中间无 await 窗口。
 *
 * ── 时机在组装瀑布之外 ──────────────────────────────────────────────────────
 *
 * `SystemPrompt.assemble()` 先收集工具提供方、渲染 section，**然后**才跑
 * `system-prompt/assemble` 瀑布。在瀑布内部装限制改变不了它服务的那次请求。
 * 所以只在两个安全窗口装：`agent/created`（首次组装之前）与 `tools/post-execute`。
 *
 * ── 失败取向：放行而不是拦死，但要响亮 ──────────────────────────────────────
 *
 * 读不到工具面时宁可不装，也不装一条空限制（那会静默地「什么都没限制」）。
 * 任何失败都写一条警告（同因只报一次），不静默降级。
 *
 * ── 模式隔离 ────────────────────────────────────────────────────────────────
 *
 * 归属判据读**活绑定** `registry.composedPreset(agent.ctx)`（随切换改变），刻意不读
 * session header 的 `agentPreset`（那是创建时的值）。不属于本 preset 的会话一律
 * **卸掉**限制 —— 因为 restrict 记在 agent 自己的 layer 上，重绑父链不会让它消失。
 *
 * @module blackpig-guard
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'blackpig-guard'

/** 工具注册表必须先存在。 */
export const inject = ['tools']

/** 本守卫所属的 preset id。 */
const DEFAULT_PRESET_ID = 'blackpigmodel'

/**
 * 队友**绝不能有**的工具名。
 *
 * 为什么单列一条常量、而不是塞进某个名单（2026-11-02）：
 *
 *   这是一个**结构性**约束，不是收窄策略。`spawn_teammate` 会创建 Agent Teams 成员，
 *   而 Agent Teams 的宿主域层硬写着 `spawnAdmitted` 里 `role !== 'lead'` → 抛
 *   `TEAM_LEAD_REQUIRED`。也就是说队友调用它**必然失败**，唯一区别是失败前白付
 *   schema、白烧一轮。留它在工具表里，等于告诉模型"你可以派队友"然后让它撞墙 ——
 *   那是我们自己造的错误文档。
 *
 * 为什么只摘这一个、不连带摘别的：
 *   队友需要 write / edit / pwsh / search / subagent 等**干活工具**（他们有完整工具面
 *   是设计的一部分）。任何"顺手一起摘"都会让队友少干成事，违反 guard 的取舍原则：
 *   **拿掉它会不会让人少干成一件事？** 对 spawn_teammate 答案是不会 —— 它本来就干不成。
 *
 * 与 `DEFAULT_KEEP` 里 `spawn_teammate` 的关系：两个对象不同。
 *   · `DEFAULT_KEEP` 管**大脑**（大脑必须留着它，只有大脑能派队友）；
 *   · 本常量管**队友**（队友一律没有它，无论保留集写了什么）。
 *   同一行名字出现在两个语义相反的地方，所以各自单独定义、各自注释，不做成共享表。
 */
const TEAMMATE_FORBIDDEN_TOOL = 'spawn_teammate'

/** 「读不出事实」的独立取值，与「确定不属于任何 preset」（undefined）区分开。 */
const PRESET_UNKNOWN = Symbol('blackpigmodel/unknown-preset')

/**
 * 大脑保留的工具。
 *
 * 只列保留集；摘除面由「可见集 − 保留集」反推，绝不另写一张黑名单
 * （补进来没人会读，只会让后来者误以为摘除依据是那张表）。
 *
 * 这份表可以放心写宽：不在当前 roster 里的名字不会造成任何后果
 * （deny 只从「实际可见集」里取）。
 */
const DEFAULT_KEEP = [
  // ── 只读核对（2026-10-31 改：砍掉 read / grep）──
  //
  // 为什么砍（用户决定，情况 A）：
  //   · 大脑不需要**看内容**，它需要**核实交付**——而核实要的是字节数/存在性，
  //     不是正文。`file_info` 正是为此移植进来的（一次调用给一组路径 + 总字节数）。
  //   · 留 `read` 就必须留它那 10 处配套规则（limit≤60、每轮 3 次、累计 20 次软上限、
  //     重复查询闸门），**规则比功能还多**，而且模型总会忍不住自己上手。
  //   · 要看内容的正路是「派代理去看，要求带行号和原文」——这与 Claude Code
  //     Coordinator Mode 的「验证必须独立」一致。
  //   · `grep` 必须一起砍：留着它等于留半个 read（能搜内容），纪律不成立。
  //
  // `read_image` 保留：它返回图像块、不能进 spill、也不存在"自己调研"的歧义，
  // 而且大脑确实需要看参考图来判断视觉方向。
  'read_image',
  'working_directory',
  // 只读元数据：字节数 / 类型 / 存在性 / 一次多路径的总和。
  // 它是**砍掉 read 之后唯一的核实手段**，必须在这个保留集里。
  'file_info',

  // ── 与一次性代理继续对话（本层注册，restrict 摘不掉、必须进保留集）──
  // blackpig-subtalk 模块自己注册的工具。本层注册的工具:**restrict 摘不掉、
  // 也不进 deny**，所以必须写进保留集；否则 guard 的 keep 白名单兜底会把它自己拦掉
  // （run_code 那次踩过同样的坑）。
  'send_to_subagent',
  'stop_subagent',

  // ── 一次性代理（临时活派小弟干，干完即散）──
  // 与常驻队友并存：一个任务用谁，由大脑判断。
  //   · 需要协作/复用/任务板 → spawn_teammate
  //   · 干完就不要的一次性活 → subagent
  //
  // ⚠️⚠️ 2026-11-02 澄清一处容易读错的地方：这两个名字**留在保留集里，但大脑实际
  //     用不到它们** —— 生产 YAML 的 `extraDeny: [subagent, subagent_fork]` 有一票
  //     否决权（见 `isCoordinatorTool`：`keep.has && !extraDeny.has`）。
  //
  //     保留在 keep 里是**有意的**，作用是让「撤销 extraDeny」这条配置改动能自动
  //     把能力还回来，不必再改代码。代价是读到这一行的人会误以为大脑能用 subagent
  //     （第一版审计就在这里误判过：以为"保留"，实际生产上是被摘掉的）。
  //     所以这一行不是能力声明，是**配置开关的默认位**。
  //
  //     代理（= 被委派出去的子会话）确实拿完整工具面，但那是 `release()` 的效果
  //     （`isDelegatedChild` 分支早退，压根不走 keep 判定），与这两行无关。
  'subagent',
  'subagent_fork',

  // ── 跨模式派活（2026-10-31 新增）──
  // 由 blackpig-roster.mjs 注册，是本模块**唯一**能选模式的派活入口。
  //
  // ⚠️ 名字必须与 `blackpig-roster.mjs` 的 `export const TOOL_NAME` 逐字一致。
  // YAML 里也给 guard 传了同名 `keep` 项，但这里仍要写进默认表 —— 否则
  // 自检（DEFAULT_KEEP 与 KEEP 比对）覆盖不到它，两处漂了没人发现。
  //
  // ⚠️ blackpig-roster 的插件行必须排在 blackpig-guard **之前**：
  // keep 过滤用的是 guard 初始化时的 available 快照，排后面会被静默剔掉。
  'subagent_preset',

  // ── 团队协作（Agent Teams）──
  // ⚠️ 这 9 个由 tool-agent-team 注册在 agent 自己的 scope 上：
  //    restrict 既摘不掉、也不能写进 deny（会抛 unknown），必须在保留集里。
  'spawn_teammate',
  'send_message',
  'list_agents',
  'interrupt_agent',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',

  // ── 结果回收：后台任务的产出 ──
  'job_list',
  'job_output',
  'job_kill',

  // ── 交互与自我管理 ──
  'ask_user_question',
  'todo_write',
  'present',
  // `exit_plan_mode` 必须保留：preset 里挂了 planning 组，而计划模式一旦进入就必须
  // 能退出。若把它摘掉，用户把大脑切到计划模式后会被**永久困住**（进得去出不来）。
  'exit_plan_mode',

  // ── 长期目标（2026-10-31 加回，用户决定）──
  //
  // 三个工具实测 schema 成本：create_goal 577 B + get_goal 170 B + update_goal 984 B
  // = **1,731 B ≈ 433 token**。不算便宜，但换的是跨轮次的意图记忆：
  //   · 黑猪按任务书干活，一个任务常跨十几轮。没有 goal，它每轮只能从
  //     `todo_write` 和对话里推断「我们到底在做什么」；
  //   · `todo_write` 记的是**步骤**，goal 记的是**目的**。两者不重复。
  //   · 这三个由 `tool-goal` 插件提供，而那行本来就在 preset 里挂着（白装了很久），
  //     现在只是把它接上，不新增插件行。
  //
  // ⚠️ goal 三个都留（create/get/update）：只留 get/update 而不留 create，
  // 等于「能改不能立」，反而更难用。
  'create_goal',
  'get_goal',
  'update_goal',

  // ── `skill` 刻意**不在**保留集（2026-10-30 修正）──
  //
  // 原来保留它的理由是「技能正文是『怎么做』的操作手册，不是过程数据」。这个理由
  // 在「大脑只统筹、不干活」的前提下**是错的**：
  //   · 「怎么做」正是它不需要知道的东西 —— 它只该知道「要做什么、派给谁」。
  //   · 技能正文体量完全不可控：一份技能文档可能只有几 KB，
  //     也可能是一份几 MB 量级的大手册 —— 后者一次就吃掉整个上下文预算。
  //   · 它同时**不在** `TRIM_EXEMPT_TOOLS` 里，所以大 skill 会被头尾截断，
  //     把「后端清单 / 密钥位置 / 已知限制」这些关键段落整段删掉 —— 既没省下来，
  //     又给了半截错误手册，比不给更糟。
  //
  // 结论：把 skill 交给真正干活的代理（他们本来就有完整工具面），大脑不需要。
  // （评审意见已核实；但它建议「豁免裁剪」，那会让整份大手册全量进上下文，
  //   方向反了 —— 正确解是移出保留集。）

  // ── 记忆工具（第三方插件提供，经 `config.keep` 放行）──
  //
  // 为什么必须放行：记忆插件是 **host 层**插件，它无条件往系统提示里注入记忆协议
  // 与「记忆 VIEW TOOLS」能力清单。若这些工具被摘掉，等于**付了钱没有能力**：
  // 协议教模型用 recall/remember，工具却不在面上，模型照协议调必撞墙。
  //
  // ⚠️⚠️ 通用化现状：本文件**不写死任何第三方工具名**。`config.keep`（profile 的
  //      guard 配置行）里现在只留 `subagent_preset`；第三方插件（如记忆插件）的工具
  //      **不再写进 keep**，需要时由该部署的用户自行把精确工具名加进 `keep`。
  //
  //   原因（通用性审计 R1 的 S1/S2）：`dsh-mnemon` **不是 DSH 内置包**（实测：asar
  //   里搜不到它，它是 profile `package.json` 装的第三方依赖）。把它的工具名
  //   写死在这个文件里，就等于让模式认识**某一个部署装的那个记忆插件**：
  //     · 没装记忆插件的部署 → 那些行永不命中，纯污染；
  //     · 装了**另一个**记忆插件的部署 → 那个插件的工具进不了 keep，而宿主仍注入
  //       记忆协议 → 同一个"付了钱没有能力"的 bug 重现，且工具名全不一样，
  //       只能回来改这个代码文件。**这就是模式无法通用的具体形态。**
  //
  //   所以：模式代码只放**与项目无关**的通用名；任何"某个部署装的插件"的工具名，
  //   一律由该部署自己在 `config.keep` 里追加。`DEFAULT_KEEP` 只留通用面。
  //
  //   注意这与「保留集是白名单」不冲突：`config.keep` 本来就是给"某个部署要额外
  //   放行的工具"用的口子（`apply` 里 `for (const entry of config?.keep ?? [])`）。
  //   本项目的 guard `keep` 段现在只有 `subagent_preset` 一行，第三方工具一个都没有。
  //
  // ⚠️ 工具面不是固定的「几个」：实测真实 standard 子会话的工具面包含整套记忆工具，
  //   远不止 4 个 —— 记忆插件在 host 层无条件注入协议与能力清单，所以工具面会随
  //   该部署装了什么插件而变。这也是不能把工具名写死的直接原因。
  //
  // 运维参考（全历史大量会话、数十次第三方工具调用的实测分布，供部署决定要不要
  // 把这些名字追加进自己的 `config.keep`）：
  //   `runtime_memory` 26 次、`document_search` 11 次、`subagent_result` 6 次、
  //   `recall` 4 次（黑猪原来被拒 1 次）、`document_create` 2 次、其余 12 个 0 次。
  //   即：有 5 个真被用过，12 个从没用过。缺的却是「用到时才在」的能力
  //   （记忆空间管理、关系边、view 路由），模型想用就只能撞墙。
  //
  // schema 成本表（字节，实测，供运维层估算该部署要追加多少 keep 项）：
  //   runtime_memory 2517 / remember 1510 / recall 1289 / document_manage 1072 /
  //   related 1060 / document_search 936 / document_create 793 /
  //   memory_body_merge 776 / link 717 / view_route 543 / view_action 530 /
  //   forget 465 / memory_body_update 436 / memory_bodies 433 / body_create 1317 /
  //   status 334 / subagent_result 384
  //   17 个合计约 16 KB ≈ 4,070 token。
  //
  // ⚠️ 这 17 个名字**不在下面**：需要时由部署自己加进 `config.keep`。
]

/**
 * 绝不执行、也绝不放行的那批工具名 —— 见上方 `DEFAULT_KEEP` 的反向清单。
 *
 * ⚠️ 2026-11-03：原有一个 `KEEP_ALWAYS_ALLOWED = new Set()`（恒空集）用于
 * 「restrict 失效时也额外放行」的口子，从未有过成员，且唯一的使用点是
 * `isCoordinatorTool` 里的 `|| KEEP_ALWAYS_ALLOWED.has(name)` —— 一个**恒定 false**
 * 的分支。已删（定义 + 分支）。真需要开口子就加进 `config.keep`。
 */

// ── read / grep 的阈值与预算常量**已全部删除**（2026-10-31）──
//
// 删掉的是：`DEFAULT_READ_LIMIT_MAX`（60 行）、`DEFAULT_EXPLORE_BUDGET`（每轮 3 次）、
// `DEFAULT_EXPLORE_TOTAL_BUDGET`（累计 20 次）、`EXPLORE_TOOLS`、`isRepoWidePath()`。
//
// 原因：`read` 和 `grep` 已移出 keep —— 它们进 deny、进 withheld，执行层第一条判据
// 就把它们挡了，这些参数级规则**永远不会执行**。留着是死代码，而且会让后来者
// 以为「大脑还能查，只是有限制」。
//
// 核实手段换成 `file_info`（只读元数据：字节数/类型/存在性/一次多路径总和）。
// 要看内容就派代理，要求它带行号和原文回来。

/**
 * 计入「重复查询闸门」的工具。
 *
 * 这两个是实测的轮询大户（29 次 / 27 次），单次返回都不大，靠字节阈值裁不掉。
 * `wait_agent` 不在此列 —— 它本来就是用来等的。
 */
const POLLING_TOOLS = new Set(['list_agents', 'team_task_list'])

/**
 * 同一个查询重复出现的「冷却期」（毫秒）。
 *
 * 小于这个间隔、参数完全相同、且中间没有任何别的工具调用，就判定为「拿列表当等待用」。
 * 取 8 秒：正常的一次思考 + 一次有意义的复查不会这么快；而轮询式等待通常每 1–3 秒一次。
 */
const DEFAULT_POLLING_MIN_GAP_MS = 8000

/**
 * 单个轮询工具在**整个会话**里的调用上限。
 *
 * 为什么需要第二道闸：只看「同参数 + 8 秒」可以被**轮转 33 组以上不同参数**绕过 ——
 * 每组回到同一签名时都已超过 8 秒，槽位上限 32 又会淘汰最旧的那组，
 * 于是每次都是「第一次见」，全部放行。实测案例里 `list_agents` 29 次、
 * `team_task_list` 27 次，这个量级本身就该被拦。
 *
 * 20 的依据：正常编排里每个轮询工具每轮用 1–2 次，一轮算 2 次，10 轮才到 20；
 * 一个 10 轮以上的任务里查 20 次以上列表，说明它在拿列表当等待用。
 * （第 1 轮代码审计 2026-10-30 B-6，已核实它的绕过路径。）
 */
const DEFAULT_POLLING_BUDGET = 20

/**
 * 稳定序列化参数（键排序），用来判断两次调用是否「完全一样」。
 *
 * 直接 `JSON.stringify(args)` 会被键顺序影响 —— 模型两次调用可能只差键序，
 * 那是同一个查询，应该被认出来。
 */
function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`
}

/**
 * `grep` 的 pattern 里允许出现的「或」分支上限。
 *
 * 实测：大脑一条
 * `example-subproject-a|example-subproject-b|技能|skill` 的多分支 grep 在**执行前**
 * 就注定要回上百行。只限 path 限不住它 —— 得限住「一次搜几个词」。
 */

/**
 * 兜底裁剪的阈值，**单位是 UTF-16 字符数（`text.length`），不是字节**。
 *
 * ⚠️⚠️ 2026-10-30 修复（N2）：原来这里叫 `DEFAULT_MAX_RESULT_BYTES = 52000`，单位和
 * 宿主 spill 完全不同 —— spill 按 **token** 计价，而 token 的估算公式是
 * `estimateContent` = `Math.ceil(text.length / 4) + 4`（`dsh-token-meter/lib/types/estimate.js`），
 * `text.length` 是 **UTF-16 字符数**。所以 spill 的触发点对**任何字符**都是
 * ~49,985 字符（`ceil(L/4)+4 > 12500`）：
 *
 *   · ASCII  ≈ 49,985 B   （之前 guard 的 52,000 B 略高于它，看起来"刚好")
 *   · 中文   ≈ 149,955 B  （52,000 B 的 guard 阈值 = 17,333 字符 → **远早于 spill**）
 *   · emoji  ≈ 99,970 B
 *
 * 后果：中文 / emoji 结果在 52 KB~150 KB 这段区间里被 guard **先于 spill** 裁掉，
 * 而 spill 本可以无损落盘并给出路径。文字提示还指向 "read 带 offset 续读"，
 * 对 `team_task_list` 这类 JSON 根本没有 offset 可续 —— 提示是假的。
 *
 * 修法：量纲改成与 spill 一致的**字符数**，并把兜底阈值放到 spill 预算的 4 倍
 * （200,000 字符），即正常情况下**永不触发**；spill 完全缺席时才由下面的
 * `SPILL_FALLBACK_CHARS` 收紧（见 N2 的实测与注释）。
 */
const DEFAULT_MAX_RESULT_CHARS = 200000

/**
 * spill 的触发点（字符）：`ceil(L/4) + 4 > 12500` ⟺ `L >= 49,985`。
 * 取整到 50,000 作为"这条结果一定已经被 spill 处理过"的下界。
 */
const SPILL_TRIGGER_CHARS = 50000

/**
 * spill **完全缺席**（或它自己失败）时的收紧阈值（字符）。
 *
 * 为什么需要第二档：把兜底放到 200,000 字符后，如果 spill-policy 因任何原因没生效
 * （被禁用 / config 缺失 / `spillStore` 服务缺失 / 它自己 throw 后 "keeping the inline
 * content"），50,000~200,000 字符的结果就会**整块进上下文**。那是把 N1/N2 修成另一个洞。
 *
 * 所以加一条**可证伪的**判据：结果超过 spill 触发点、且**没有** spill 的落盘标记
 * （`Full formatted result stored at: <path>`）→ 说明 spill 没处理它 → 用本阈值收紧。
 * 有标记 → 说明 spill 已经处理过（内容已被它裁到 ~12,500 token ≈ 50,000 字符），
 * 用 200,000 的上限即可，guard 不会再动手。
 *
 * 这样答复「52 KB 的 ASCII 会不会再也不被裁」：spill 在 → 它在 49,985 字符处无损落盘
 * 裁短（guard 不插手）；spill 不在 → guard 在 52,000 字符处兜底。两条路都有上限。
 */
const SPILL_FALLBACK_CHARS = 52000

/**
 * spill 落盘通知的**严格**形态：`(... Full formatted result stored at: <locator>. ...)`。
 *
 * ⚠️ 刻意不用宽松的 `/stored at/`：那会把"grep 一段源码"的命中内容误判成
 * "spill 已处理"，从而把阈值放宽到 200,000 字符（数据里出现这五个词是常事）。
 * 带上 `: ` + 非空白字符 之后，只有真正的通知形态才命中。
 */
const SPILL_NOTICE_RE = /Full formatted result stored at: \S/

/**
 * 判断一条结果**是否真的被 spill 处理过**（N2/N7 的判据）。
 *
 * ⚠️ 为什么不能只搜一次正则：`spillHandled` 会把阈值从 52,000 放宽到 200,000 字符。
 * 只要结果里**碰巧**出现 `Full formatted result stored at: xxx`（例如 grep 命中一段
 * 讨论 spill 的源码、或日志里抄了这条通知），就会被误判成"已处理"，于是 150,000 字符
 * 的结果直接放过去。那是把一个洞换成另一个洞。
 *
 * 宿主 `dsh-spill-policy` 的真实形状（`formatSpillNotice`）：
 *
 *     (Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>)
 *
 * 它是**作为最后一个块**追加的（`...retained.tail, { type:'text', text: \`\n\n${footer.text}\` }`），
 * 而 `footer.text` 以 `(` 开头、以 `)` 结尾。所以两条一起判：
 *   ① 标记出现在**末尾 2,000 字符内**（正文中间提到它不算）；
 *   ② 整段文本去掉尾部空白后**以 `)` 收尾**（通知的闭合括号）。
 *
 * @param text - 已拼接的正文。
 * @returns 是否像 spill 的产物。
 */
function looksSpilled(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const tail = text.slice(-2000)
  if (!SPILL_NOTICE_RE.test(tail)) return false
  return text.replace(/\s+$/, '').endsWith(')')
}

/**
 * 不参与裁剪的工具。
 *
 * 判据：返回值本来就只有几十字节，裁了只会增加噪音；或者返回结构不是纯文本，
 * 按字节截断会破坏语义（`read_image` 返回的是图像块）。
 */
const TRIM_EXEMPT_TOOLS = new Set([
  'send_message', // 13 B
  'wait_agent', // 18 B
  'interrupt_agent',
  'job_kill',
  'todo_write', // 57 B
  'present', // 61 B
  'ask_user_question',
  'exit_plan_mode',
  'working_directory',
  'spawn_teammate', // 250 B 左右
  'read_image', // 图像块，按字节截断会毁掉它
  // ⚠️ `read` 的豁免条目**已删除**（2026-10-31）——`read` 已不在工具面上。
  // 原豁免理由（宿主 spill-policy 无条件跳过 read）仍然成立，但已无适用对象。
])

/** 任务板压缩后，单个 description 保留多少字符。 */

/**
 * 结果裁剪：**优先交给宿主的 spill 策略，只在它不可用时才自己动手**。
 *
 * 为什么改成这样（本轮最大的简化）：
 *
 * 宿主自带完整的 spill 三件套 —— `dsh-spill`（服务）、`dsh-spill-local`（私有
 * 落盘实现）、`dsh-spill-policy`（策略）—— 而且 `dsh-base` 里**默认就装着**：
 *
 *     - id: spill-local
 *       name: '@deepseek-ai/dsh-spill-local'
 *     - id: spill-policy
 *       name: '@deepseek-ai/dsh-spill-policy'
 *       config:
 *         maxInlineTokens: 12500
 *
 * 它做的事比我原来手写的 215 行**完整得多**：
 *   · 头 + 尾 + `[...]` 间隔（和我一样）；
 *   · **全文落盘**，并在通知里给出 `Full formatted result stored at: <路径>`
 *     —— 模型能拿回全文，我原来的截断拿不回；
 *   · **图像按真实 token 计价**（`calculator.priceImages`），正好补上
 *     `read_image` 这个「唯一不受控通道」的洞；
 *   · 能识别 `(Omitted N bytes)` 这类已存在的省略标记，不会二次裁剪。
 *
 * 所以本模块不再重复实现裁剪。保留的这个函数只做**最后一道保险**：
 * 当 spill-policy 因为任何原因没有生效（被禁用、config 缺失、服务缺失）时，
 * 仍然保证单次结果不会无限膨胀进上下文 —— 但阈值放宽到 spill 的同等量级，
 * 正常情况下永远不会触发。
 *
 * @param content - 内容块数组。
 * @param toolName - 工具名（仅用于提示文案）。
 * @param maxChars - 保险阈值，**单位 UTF-16 字符**（与 spill 的 `text.length` 同量纲）。
 * @returns `{ content, originalChars, originalBytes, keptChars, keptBytes }`，或
 *   `undefined`（不用裁），或 `{ skipped: 原因 }`（决定裁但不该裁/裁不了，**必须留痕**）。
 */

/**
 * 生成裁剪说明。文案**不臆测上游**（N7），也**不说谎**。
 *
 * 两条判据：
 *   · spill 已处理（`spillHandled`）→ 直说 guard 是在 spill 之后又裁了一次；
 *   · 其余（`team_task_list` 这类 JSON / 结构化结果）→ 指向"用对应工具的过滤参数单取，
 *     或派队友取"，绝不说 offset。
 *
 * ⚠️ 2026-11-03：原来还有一条「工具是 `read` 且内容像文本文件 → 用 read 带 offset 续读」
 * 的分支，**已删**。`read` 早已不在保留集里（大脑调不到它），那段分支永远不可达，
 * 留着只会让后来者以为大脑还能带 offset 续读。
 *
 * @param toolName - 工具名。
 * @param totalChars - 原始字符数。
 * @param maxChars - 阈值（字符）。
 * @param spillHandled - 上游是否已带 spill 落盘标记。
 * @param teamMode - 团队模式（决定「派队友」还是「派代理」）。
 */
function buildTrimNotice(toolName, totalChars, maxChars, spillHandled, teamMode = false) {
  // ⚠️ 默认 false（solo）：漏传时「派代理」在两种模式都成立，是安全侧。
  const head =
    `\n\n[blackpig-guard] 该 ${toolName} 结果共 ${totalChars} 字符，超过兜底上限 ${maxChars} 字符，` +
    '中间内容已省略。'
  const why = spillHandled
    ? '（上游 spill-policy 已经处理过一次，这是它之后的第二次裁剪。）'
    : '（这是 spill-policy 之后的第二道保险：这条结果的体量仍超过兜底上限。）'
  // ⚠️ 2026-11-03：原来的 `read` + `contentLooksLikeFile` 分支已删（`read` 不在保留集，
  // 那段是死代码）。现在只有一种文案：指向工具自己的过滤参数 / 派代理。
  const how =
    '要继续取，请用该工具自己的过滤参数单取（按 id / 按 path / 缩窄范围），或者把这件事写成任务书' +
    (teamMode ? '派队友去取。' : '派给代理去取。') +
    '这类结构化结果**没有 offset 可以续读**。'
  return `${head}${why}${how}\n\n`
}

/**
 * 按实际输出复算字符数，并用二分把 head/tail 收紧到 `keptChars <= maxChars`。
 *
 * ⚠️⚠️ N1（2026-10-30 修的严重 bug）：原实现在算完输出后有一句
 * `if (keptBytes >= total || keptBytes > maxBytes) return undefined`，也就是
 * 「不变量不满足就**整块放行**」。而 `sliceChars` 的尾部回退会把结束位置多留
 * 1~2 字节，于是 `keptBytes = maxBytes + 1` 时**整个裁剪被丢弃**，调用方
 * `if (trimmed === undefined) return decision` 原样透传全量。
 * 实测命中率：emoji 5001/5001（100%）、中英混排 319/319（100%）、中文 179/319（56%）、
 * ASCII 0/322 —— 多字节内容的裁剪**一半以上根本没发生，而且零日志**。
 *
 * 现在的语义：裁剪决定一旦做出就不再反悔。要么真的裁到上限内（二分收紧），
 * 要么明确返回 `{ skipped }` 让调用方用 `logger.error` 记录下来。
 */

/**
 * 在 UTF-8 字节串上取子串，切点必须落在字符边界（不会切出 U+FFFD）。
 *
 * UTF-8 续字节的形态是 `10xxxxxx`（`(b & 0xC0) === 0x80`）：
 *   · 头部切点若落在续字节上 → 往前退到起始字节；
 *   · 尾部切点同理 → 往前退到上一个完整字符之后。
 *
 * @param buf - 原始 UTF-8 字节。
 * @param from - 起始字节偏移。
 * @param to - 结束字节偏移（不含）。
 * @returns 落在字符边界上的子串。
 */
function sliceCharsUtf8(buf, from, to) {
  let a = Math.max(0, Math.min(from, buf.length))
  let b = Math.max(a, Math.min(to, buf.length))
  while (a > 0 && a < buf.length && (buf[a] & 0xc0) === 0x80) a -= 1
  while (b > a && b < buf.length && (buf[b] & 0xc0) === 0x80) b -= 1
  return buf.subarray(a, b).toString('utf8')
}

/**
 * 字符数 → 字节偏移的映射表：`cum[i]` = `text.slice(0, i)` 的 UTF-8 字节数。
 *
 * 为什么需要它：阈值现在的量纲是**字符**（与 spill 一致），但切点必须在字节上
 * 才对得齐 `sliceCharsUtf8`。原实现直接把"字符预算"当字节偏移用，中文/emoji
 * 会被砍到约 1/3（实测中文 52,005 字符、上限 52,000 → 输出只剩 17,468 字符）。
 * 有了这张表，`budget` 仍是字符数（与 `ok(x)` 的单调性一致），落地的却是正确字节。
 *
 * @param text - 原文字符串。
 * @returns 长度 `text.length + 1` 的递增数组。
 */
function byteOffsets(text) {
  const cum = new Uint32Array(text.length + 1)
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      // 高位代理：与其后的低位代理合成一个 4 字节码点。
      bytes += 4
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // 低位代理：字节数已由前一个高位代理计入。
      bytes += 0
    } else bytes += 3
    cum[i + 1] = bytes
  }
  return cum
}

/**
 * 用给定的**字符**预算拼一次输出。head 从前往后、tail 从后往前。
 * @param buf - 原文 UTF-8 字节。
 * @param cum - `byteOffsets(joined)`。
 * @param notice - 说明文字。
 * @param headChars - 头部字符预算。
 * @param tailChars - 尾部字符预算。
 * @returns `{ text, chars, bytes }`。
 */
function assembleTrim(buf, cum, notice, headChars, tailChars) {
  const headBytes = cum[Math.max(0, Math.min(headChars, cum.length - 1))]
  const tailStartChars = Math.max(0, bufChars(cum) - tailChars)
  const tailBytesStart = cum[Math.min(tailStartChars, cum.length - 1)]
  // 头尾不重叠：头结束字节之后才开始取尾。
  const head = sliceCharsUtf8(buf, 0, headBytes)
  const tail = headBytes >= tailBytesStart ? '' : sliceCharsUtf8(buf, tailBytesStart, buf.length)
  const out = head + notice + tail
  return { text: out, chars: out.length, bytes: Buffer.byteLength(out, 'utf8') }
}

/** 与 `cum` 配套的字符总数（`cum` 长度 − 1）。 */
function bufChars(cum) {
  return cum.length - 1
}

/**
 * 二分收紧紧围绕：在 `[lo, hi]` 里找满足 `ok(x)` 的最大 x（`ok` 单调）。
 *
 * 用途：把 head/tail 预算一起按比例缩放，直到输出真的 ≤ 上限。
 * 原实现只做一次算术分配 + 一次边界回退，回退会**放大** 1~3 字节 —— 那正是 N1 的根。
 *
 * @param lo - 下界（含）。
 * @param hi - 上界（含）。
 * @param ok - 单调谓词。
 * @returns 满足条件的最大整数，或 lo-1（全都不满足）。
 */
function largestMonotonic(lo, hi, ok) {
  let low = lo
  let high = hi
  let best = lo - 1
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2)
    if (ok(mid)) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function trimContent(content, toolName, maxChars, teamMode = false) {
  if (!Array.isArray(content)) return undefined
  let total = 0
  let totalBytes = 0
  let hasNonText = false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') {
      total += block.text.length
      totalBytes += Buffer.byteLength(block.text, 'utf8')
    } else hasNonText = true
  }
  if (total <= maxChars) return undefined

  // ⚠️ 混合内容（含 image 等非文本块）**一律不裁**。
  //
  // 原实现只累加 text 块，然后把 `content` 替换成「只有 text」的新数组 ——
  // 结果是**图片块被静默删除**（独立审计实测：`[text3000, image, text4000]`
  // 输出只剩 text）。这比「不裁」危险得多：模型以为看到了完整结果。
  //
  // 而且图片的体量不该用字节衡量，该用 token 计价 —— 宿主 spill-policy 的
  // `priceImages()` 正是干这个的。所以这里直接退出，把决策权留给下游。
  //
  // ⚠️ 但不许**静默**退出（N1 的同一条原则）：返回 `skipped` 让调用方记一条日志。
  if (hasNonText) return { skipped: '结果里含非文本块（图片等），按字节截断会破坏语义' }

  const texts = content.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string')
  if (texts.length === 0) return { skipped: '结果里没有可裁剪的文本块' }

  const joined = texts.map((b) => b.text).join('')
  const buf = Buffer.from(joined, 'utf8')
  // 字符 → 字节偏移的映射（阈值量纲是字符，切点必须落在字节上，见 byteOffsets 的注释）。
  const cum = byteOffsets(joined)
  const totalChars = bufChars(cum)

  // spill 是否已经处理过这条结果：看上游 decision 的内容里有没有落盘通知。
  // （N7：原来不管 spill 处没处理，一律写 "spill-policy did not handle it first"，实测中文
  //  300 KB 时 spill 明明先落了盘 —— 文案是假的。）
  const spillHandled = looksSpilled(joined)

  const notice = buildTrimNotice(toolName, total, maxChars, spillHandled, teamMode)
  const noticeChars = notice.length

  // 正文预算 = 上限 − 说明。核算之后**不再反悔**：只允许"裁得更狠"，不允许"放行原文"。
  const bodyBudget = Math.max(64, maxChars - noticeChars)
  if (bodyBudget <= 64) {
    return {
      skipped:
        `裁剪说明本身就有 ${noticeChars} 字符，塞不进 ${maxChars} 字符的兜底上限；` +
        '为不丢信息本次放行原文，请调大 maxResultChars',
      spillHandled,
    }
  }

  const split = (budget) => ({ head: Math.max(1, Math.floor(budget * 0.75)), tail: Math.max(1, budget - Math.floor(budget * 0.75)) })

  // 第一次：按 3:1 分配。大部分情况这一步就够。
  let budget = bodyBudget
  let out = assembleTrim(buf, cum, notice, split(budget).head, split(budget).tail)
  if (out.chars >= totalChars) {
    // 连"变小"都做不到 —— 说明结果本来就在上限附近且说明文字把它撑回去了。
    return {
      skipped:
        `按 ${maxChars} 字符上限裁出来的结果（${out.chars}）并不比原文（${totalChars}）小，` +
        '为不制造"看起来裁过其实是全文"的假象，本次放行原文',
      spillHandled,
    }
  }
  if (out.chars > maxChars) {
    // ⚠️ 这里就是 N1 的原始现场：一次算术分配 + 边界回退会**放大**几个字节，
    // 原实现在这里直接 `return undefined`（整块放行）。现在改成**继续收紧**。
    // 预算单位是**字符**（与上限同量纲），落地时由 `cum` 换成字节偏移。
    const best = largestMonotonic(128, bodyBudget, (b) => {
      const probe = split(b)
      return assembleTrim(buf, cum, notice, probe.head, probe.tail).chars <= maxChars
    })
    if (best < 128) {
      return {
        skipped:
          `把正文压到 128 字符预算仍然超过 ${maxChars} 字符上限（说明文字占 ${noticeChars} 字符）`,
        spillHandled,
      }
    }
    budget = best
    out = assembleTrim(buf, cum, notice, split(budget).head, split(budget).tail)
  }

  // 硬不变量（此前一直是"若违反就整块放行"，现在是"若违反就是真 bug，必须留痕"）。
  if (out.chars > maxChars || out.chars >= totalChars) {
    return {
      skipped: `收紧后仍无法满足不变量（kept=${out.chars} chars, 上限=${maxChars}, 原文=${totalChars}）`,
      spillHandled,
    }
  }
  if (out.text.includes('\uFFFD')) {
    return { skipped: '切点产生了 U+FFFD（字符边界计算错误），本次放行原文', spillHandled }
  }
  return {
    content: [{ type: 'text', text: out.text }],
    originalChars: total,
    originalBytes: totalBytes,
    keptChars: out.chars,
    keptBytes: out.bytes,
    spillHandled,
  }
}

/**
 * 把本模块改写后的 decision 交回瀑布，同时**保留上游 decision 的 additionalContexts**。
 *
 * 宿主的 `postExecute` 会把 `decision.additionalContexts` 合并到结果上，供本轮的
 * active-batch FIFO 使用。`repeat-tool-reminder` 等插件正是靠这个字段注入提醒。
 * 我们替换 `content` 时若直接构造新对象，就会把那些上下文静默丢掉 ——
 * 这既是「注释说叠加、实现却替换」的矛盾，也是一个真实的 fail-silent。
 *
 * @param next - 本模块要返回的 decision（必须带 `kind: 'accept'` 与 `content`）。
 * @param upstream - `await next()` 拿到的上游 decision。
 * @returns 合并后的 decision。
 */
function withAdditionalContexts(next, upstream) {
  const extra = upstream?.additionalContexts
  if (Array.isArray(extra) && extra.length > 0) {
    return { ...next, additionalContexts: extra }
  }
  return next
}

/** 一个每次进程只警告一次的记录器。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`blackpig-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子会话（队友 / 普通代理）。
 *
 * 判据（与 subtalk.mjs 同口径，四信号）：header 的 `origin === 'subagent'`、`delegationDepth > 0`
 * （`dsh-subagent` 的 `childSessionMeta()` 写入）、`isSeeded` 取反排除、兜底的"有非空 `parentSession`"。
 * fork（`isSeeded: true` 且有 parentSession）**不算**子会话：它的 parentSession 是历史来源。
 * 判错代价很高：把代理当大脑，代理就没工具干活了。
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
 * 读一个 agent 的 **Team 成员身份**（权威判据，非抛错版）。
 *
 * 为什么用它、而不是继续看 preset 归属（2026-11-02 改）：
 *
 *   第一版投递层用的是「`isDelegatedChild` 且继承黑猪 preset」来认队友。那个判据
 *   当前恰好正确，但依赖宿主的隐含前提（`spawnTeammate()` 不传 `agentPreset`，
 *   所以队友必然继承父 preset）。宿主一旦允许「派出指定 preset 的队友」，那个队友
 *   就会带着 `spawn_teammate` 溜过去。
 *
 *   `agentTeams.tryMembership(agent)` 是宿主的**公开方法**（不抛错版，非队员返回
 *   `undefined`），返回 `{ root, id, role: 'lead' | 'teammate', name }`。
 *
 * ⚠️⚠️ **必须自己再判一次「是不是真的 leader」**（2026-11-02 审计 R2 抓到的 P1）。
 *
 * 宿主的 `tryMembership` 有三条返回 `role: 'lead'` 的路径，其中**两条是误判**：
 *
 *     if (parentId !== undefined) {
 *       const root = agents.get(parentId)
 *       if (root !== undefined) {
 *         const member = journal.state(root).members.find(m => m.id === agent.id)
 *         if (member active/provisioning) return { role: 'teammate', ... }
 *         if (subagentDescriptor(agent)) return undefined      // ← 正常子代理走这条
 *         return { root: agent, role: 'lead' }                 // ← ① 误判点
 *       }
 *     }
 *     if (subagentDescriptor(agent)) return undefined          // ← 正常子代理走这条
 *     return { root: agent, role: 'lead' }                     // ← ② 正常（root/无父）
 *
 * 也就是说：**一个子代理如果 `subagentDescriptor()` 读不到**（它的实现是
 * `foldSubagentDescriptor(snapshotEvents(inheritedEventCount)) !== undefined` ——
 * 会话事件读不全、冷恢复中途、descriptor 尚未落盘时都可能读到 undefined），
 * 它会拿到 `role: 'lead'`。宿主自己在 `spawnAdmitted` 里判 `role !== 'lead'` 时
 * 也会被这个误判坑到（那是宿主的问题），但**我们不能跟着错**。
 *
 * 实测后果（复现过）：一个**黑猪 preset 的子代理**（队友用 `subagent_preset` 派出的）
 * 若被误判成 lead，`guard` 的投递层会把它当大脑收窄 —— pwsh / write / subagent
 * 全被摘掉，代理直接干不了活，而且**它不能再派代理**（少了 subagent）。
 * 从 24 个工具掉到 16 个。
 *
 * 所以这里的判据是：**只有「role 是 lead 且确实是 root session（没有 parentSession）」
 * 才认作大脑**；其余情况（role 是 teammate，或 role 是 lead 但有 parentSession
 * —— 即上表的误判路径）都当作「不是大脑」处理。
 *
 * 这个判据更根本：**大脑的定义是「本会话的根」**，而 `parentSession` 是宿主自己写在
 * session header 里的、不可伪造的父子关系。用它比用 `role` 字符串稳。
 *
 * 失败取向：**取不到服务就返回 `undefined`（当作「不是大脑、也不是队友」，走代理分支）**。
 * 这样最坏结果是「队友的 spawn_teammate 没被摘掉」—— 回到改动前的状态，宿主仍会在
 * 调用时拒绝它。反过来（取不到就当大脑）会误收窄代理，那是不可接受的方向
 * （代理失去干活能力，且没有任何报错）。
 *
 * @param ctx - 插件上下文（沿父链上溯取服务）。
 * @param agent - 待判定的 agent。
 * @returns `{ role: 'lead', ... }`（真大脑）/ `{ role: 'teammate', ... }` / undefined。
 */
function teamMembershipOf(ctx, agent) {
  if (agent === undefined || agent === null) return undefined

  const header = agent?.session?.header
  const hasParent =
    header !== undefined &&
    header !== null &&
    typeof header.parentSession === 'string' &&
    header.parentSession !== ''

  // ⚠️ 先按「有没有父会话」这条硬事实拦一道：有父会话的**通常是**子会话。
  // **例外是 fork / 种子会话**：它的 parentSession 只是历史来源，它是新的一条根
  // （见本文件 isDelegatedChild 里的 isSeeded 排除）。必须先把它排除，否则会被当成
  // 子会话丢进 tryMembership，误判成 teammate/lead。
  // 排除条件收窄为「种子会话 + 不是 subagent（无 origin）+ 无委派深度」：
  // 真队友即使 context:"fork"（isSeeded=true）也带 origin:'subagent' 且 delegationDepth>=1，
  // 不能被这条早退误伤（否则它会丢掉 spawn_teammate 的摘除）。
  if (header?.isSeeded === true && header?.origin !== 'subagent' &&
      !(typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) {
    return undefined
  }
  // 这样即使 agentTeams 服务整个不可用、或者宿主把 role 判错，也不会把子会话
  // 当大脑收窄。这是比 role 字符串更根本的一层。
  if (hasParent) {
    // 有父会话 = 通常是子会话（队友要摘 spawn_teammate，代理不动）；fork/种子会话已在上面早退。
    // 队友判定仍需要宿主的数据（谁是 team member 只有 Team journal 知道）。
    let teams
    try {
      teams = ctx.get('agentTeams')
    } catch {
      return undefined
    }
    if (teams === undefined || teams === null || typeof teams.tryMembership !== 'function') return undefined
    try {
      const m = teams.tryMembership(agent)
      if (m === null || typeof m !== 'object') return undefined
      // 只接受 teammate：宿主的 lead 分支对子会话来说必然是误判（见上方注释）。
      if (m.role !== 'teammate') return undefined
      return m
    } catch {
      return undefined
    }
  }

  // 到这里：没有父会话 = root session。它可能是大脑，也可能根本不是 Team 用户。
  let teams
  try {
    teams = ctx.get('agentTeams')
  } catch {
    return undefined
  }
  if (teams === undefined || teams === null || typeof teams.tryMembership !== 'function') return undefined
  try {
    const m = teams.tryMembership(agent)
    if (m === undefined || m === null || typeof m !== 'object') return undefined
    if (m.role !== 'lead') return undefined
    return m
  } catch {
    return undefined
  }
}

/**
 * 读一个 agent scope 当前**可见**的工具名（滤掉 `run_code`：PTC 保留传输名）。
 *
 * ⚠️⚠️ 性能（2026-11-03）：**必须走 `view(agent).visible`，不能用 `schemas(agent)`**。
 * 宿主 `schemas(scope)` = `[...view(scope).visible.values()].map(d => schemaOf(d, true))`，
 * 每个可见工具都要 `snapshotJsonValue` **深拷贝一遍 `parameters`**。而本函数在
 * `post-execute → sync()` 里跑（每次工具调用至少一次、重算路径两次）。
 * 名字集合与 `schemas()` **逐字等价**（它投影的就是这个 Map），只是零拷贝。
 *
 * 兜底：`view` 取不到 / 抛错（agent 已销毁等）时退回 `schemas()`，都取不到才返回
 * `[]` —— **任何情况下都不抛**。
 */
function visibleToolNames(ctx, agent) {
  const candidates = []
  const scoped = agent?.ctx?.tools
  if (scoped !== undefined && scoped !== null) candidates.push(scoped)
  try {
    const registry = ctx.get('tools')
    if (registry !== undefined && registry !== null) candidates.push(registry)
  } catch {
    // 取不到全局注册表不算致命。
  }

  for (const tools of candidates) {
    const names = visibleNamesOf(tools, agent)
    if (names.length > 0) return names
  }
  return []
}

/**
 * 从一个工具注册表读可见工具名（`visibleToolNames` 的单来源实现）。
 *
 * @param tools - 注册表（scoped 或全局）。
 * @param agent - 视角；`undefined` = 全局视角。
 * @returns 工具名数组；取不到时 `[]`（绝不抛）。
 */
function visibleNamesOf(tools, agent) {
  // 首选：`view(agent).visible` —— 与 `schemas()` 同一个 Map，但不深拷贝。
  try {
    const view = typeof tools?.view === 'function' ? tools.view(agent) : undefined
    const visible = view?.visible
    if (visible !== undefined && visible !== null && typeof visible.keys === 'function') {
      const names = []
      for (const name of visible.keys()) {
        if (typeof name !== 'string' || name === '') continue
        if (name === 'run_code') continue
        names.push(name)
      }
      if (names.length > 0) return names
    }
  } catch {
    // 落到下面的 schemas 兜底。
  }

  // 兜底：`schemas()` / `sdkSchemas()`（会深拷贝，仅在上面的路径取不到时走）。
  for (const method of ['schemas', 'sdkSchemas']) {
    if (typeof tools?.[method] !== 'function') continue
    try {
      const schemas = tools[method](agent)
      if (!Array.isArray(schemas)) continue
      const names = []
      for (const schema of schemas) {
        const toolName = schema?.name
        if (typeof toolName !== 'string' || toolName === '') continue
        if (toolName === 'run_code') continue
        names.push(toolName)
      }
      if (names.length > 0) return names
    } catch {
      // 换下一个来源。
    }
  }
  return []
}

/**
 * 读**未过滤的完整继承集**（全局层 + 祖先层，**不含本层**）。
 *
 * ⚠️⚠️ 这是本模块最重要的一处宿主耦合，写错会直接让整套限制失效：
 *
 * - `tools.schemas(agent)` 返回 `view(agent).visible` —— **已被 restriction 过滤**。
 *   用它算 deny，第一次装完后 deny 恒为空 → 限制在每次 sync 时被卸掉且不重装（振荡）。
 *
 * - `tools.schemas()`（不传 agent）只取**全局层**，**不含 preset 祖先层**。
 *   而 pwsh / write / edit / glob / web_* 恰恰注册在 preset 祖先层上 →
 *   用它会漏掉这些名字 → 既不在 deny 也不在 withheld → **两层都管不到 → 大脑可执行**。
 *   （这是修上一处振荡时引入的严重回归，第 2 轮源码审计指出后已核实。）
 *
 * - 正确来源是 `view(scope).restrictableNames`：它遍历 `this.layers.global.tools`
 *   **加上** chainLayers 里除 own 之外的每一层，且**不经过 admits 过滤**。
 *   这正是 `restrict()` 自己校验名字时用的同一个集合（宿主源码：
 *   `const known = this.view(scope).restrictableNames; ... throw unknown global tool`），
 *   所以用它算 deny 与 restrict 的语义天然一致 —— 不会多算、也不会漏算。
 *
 * @param ctx - 插件上下文。
 * @param agent - 目标 agent（用于取它自己的 scope 链）。
 * @returns 工具名数组（不含 run_code）。
 */
function fullToolNames(ctx, agent) {
  let registry
  try {
    registry = ctx.get('tools')
  } catch {
    return []
  }
  if (registry === undefined || registry === null) return []

  // 首选：restrictableNames（未过滤、含祖先层，与 restrict() 校验用同一集合）。
  try {
    const view = typeof registry.view === 'function' ? registry.view(agent) : undefined
    const restrictable = view?.restrictableNames
    if (restrictable !== undefined && restrictable !== null && typeof restrictable[Symbol.iterator] === 'function') {
      const names = []
      for (const name of restrictable) {
        if (typeof name !== 'string' || name === '') continue
        if (name === 'run_code') continue
        names.push(name)
      }
      if (names.length > 0) return names
    }
  } catch {
    // 落到兜底路径。
  }
  return fallbackToolNames(ctx)
}

/**
 * 兜底：`restrictableNames` 不可用时退到「全局层 schemas()」。
 *
 * ⚠️ 这条路径**会漏掉 preset 祖先层的工具**（pwsh/write/edit 等），
 * 所以它只能是最后手段。退化时 deny 变小 → withheld 也变小 → guard 的 ① 判据变弱，
 * 因此调用方必须把这次退化当作不健康状态（不设 healthy），让下次 sync 继续重试，
 * 并让 fail-closed 自检把问题喊出来。
 */
function fallbackToolNames(ctx) {
  let registry
  try {
    registry = ctx.get('tools')
  } catch {
    return []
  }
  if (registry === undefined || registry === null) return []
  for (const method of ['schemas', 'sdkSchemas']) {
    if (typeof registry?.[method] !== 'function') continue
    try {
      const schemas = registry[method]()
      if (!Array.isArray(schemas)) continue
      const names = []
      for (const schema of schemas) {
        const toolName = schema?.name
        if (typeof toolName !== 'string' || toolName === '') continue
        if (toolName === 'run_code') continue
        names.push(toolName)
      }
      if (names.length > 0) return names
    } catch {
      // 换下一个来源。
    }
  }
  return []
}

// `isRepoWidePath()` 与 `warnIsRepoWideLookupFailure()` 已随 `grep` 一起删除
// （2026-10-31）。它们只服务于「大脑自己 grep」这一条路，工具砍掉后是死代码。
// 想看文件在哪、有多大，用 `file_info`；想搜内容，派代理。


// `containsRealGlob()` 已随 `grep` 删除（2026-11-02）——
// 它唯一的调用点在 grep 的 path 判据里，而 grep 已于 2026-10-31 移出保留集。
// 留着它等于让下一个人以为「还有东西在做 glob 判据」。

// `warnIsRepoWideLookupFailure()` 已随 `grep` 删除（2026-10-31）——
// 它唯一的用途是提示「grep 的 cwd 判据失效」，而那条判据本身已经不在了。


/** 规范化 preset id：只接受非空字符串。 */
function normalizePresetId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 按会话 id 找回一个活着的 agent。 */
function agentById(ctx, id) {
  try {
    const agents = ctx?.get?.('agents')
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    return agents.get(id)
  } catch {
    return undefined
  }
}

/** 读 agent **当前实际所属**的 preset id（活绑定，随切换改变）。 */
function composedPresetId(ctx, agent) {
  const agentCtx = agent?.ctx
  if (agentCtx === undefined || agentCtx === null) return PRESET_UNKNOWN

  for (const carrier of [agentCtx, ctx]) {
    try {
      const registry = carrier?.get?.('agentPresets')
      if (registry === undefined || registry === null) continue
      if (typeof registry.composedPreset !== 'function') continue
      return normalizePresetId(registry.composedPreset(agentCtx))
    } catch {
      // 换下一个来源。
    }
  }
  return PRESET_UNKNOWN
}

/**
 * 判定一个 agent 该由哪一份 preset 收窄。
 * 第 1 层活绑定是权威；只有它读不出来时才退回 session header 的创建时值。
 */
function ownerPresetId(ctx, agent, warn) {
  const live = composedPresetId(ctx, agent)
  if (typeof live === 'string') return live
  if (live === PRESET_UNKNOWN) {
    warn(
      'could not read which preset an agent is composed with; falling back to the preset recorded when its session was created (the live binding is the authority)',
    )
  }
  return normalizePresetId(agent?.session?.header?.agentPreset)
}

/**
 * 装载守卫。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, presetId, keep, extraDeny, hardDeny }`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const presetId = normalizePresetId(config?.presetId) ?? DEFAULT_PRESET_ID
  const hardDeny = config?.hardDeny !== false

  // 保留集：默认表 + 配置追加。用 Set 便于 O(1) 判定。
  const keep = new Set(DEFAULT_KEEP)
  for (const entry of config?.keep ?? []) {
    if (typeof entry === 'string' && entry !== '') keep.add(entry)
  }

  /**
   * **团队工具在不在，是运行时才知道的**（2026-10-31 新增，用户选方案 C）。
   *
   * 背景：`spawn_teammate` / `wait_agent` / `team_task_*` 这 6 个只由
   * `@deepseek-ai/dsh-experimental-tool-agent-team` 注册。而 `send_message` /
   * `interrupt_agent` / `list_agents` 三个是**两个包都有**（团队包 + 宿主自带的
   * `dsh-tool-subagent-control`），所以它们永远在。
   *
   * 问题：`keep` 里写死了这 6 个名字。团队插件一关，它们就不存在了，而
   * `tools.restrict({ deny })` 会拿 `restrictableNames` 校验每个名字 ——
   * 未知名字直接抛错，整条限制装不上（黑猪是 fail-closed，会直接失去保护）。
   *
   * 解法：把 `keep` 先和 `restrictableNames` 求交，只保留**真实存在**的名字。
   *   · 团队在线 → 这 6 个在集合里 → 保留 → 大脑能用团队
   *   · 团队关闭 → 不在 → 自动剔掉 → restrict 不抛错 → 大脑自动 solo
   *
   * ⚠️ 为什么不能用「读 agent 可见集」来判断：可见集**已经被 restrict 过滤过**，
   * 用它做判据会得到「上次保留了什么」而不是「现在有什么」，形成自我强化的振荡。
   * `restrictableNames` 是未过滤的完整继承集，才是权威。
   *
   * ⚠️ 求交只对「团队工具」生效，不能对全表生效 —— 否则本层注册的工具
   * （`send_to_subagent` / `stop_subagent` / `file_info`）不在 `restrictableNames` 里
   * （那个集合不含本层），会被误删。
   */
  const TEAM_ONLY_TOOLS = new Set([
    'spawn_teammate',
    'wait_agent',
    'team_task_create',
    'team_task_get',
    'team_task_list',
    'team_task_update',
  ])

  /**
   * 报出「这一刻可见面上没有」的团队工具，**只记日志、不动 keep**。
   *
   * ⚠️ 2026-11-01：原实现会 keep.delete() —— tool-agent-team 在本守卫之后注册时，
   * 团队工具被永久剪掉，同一进程出现 29/23 两种工具面（实测）。keep 里多一个
   * 当前不存在的名字零代价：不存在就没人能调，且它们不进 restrictableNames，
   * restrict() 不会因未知名字抛错。
   */
  const pruneAbsentTeamTools = (available) => {
    const dropped = []
    for (const name of TEAM_ONLY_TOOLS) {
      if (keep.has(name) && !available.has(name)) dropped.push(name)
    }
    return dropped
  }

  /**
   * 团队通道当前是否可用。
   *
   * ⚠️ 2026-11-01：判据是**当前可见面**，不是 keep.has()。剪枝改为非破坏性后
   * keep 里永远有那 6 个名字，用 keep 判定会恒为 true，solo 会话也会说"团队在"。
   */
  const teamAvailable = (visibleNow) => {
    if (visibleNow === undefined || visibleNow === null) return false
    for (const name of TEAM_ONLY_TOOLS) {
      if (visibleNow.has?.(name) || (Array.isArray(visibleNow) && visibleNow.includes(name))) return true
    }
    return false
  }

  // 额外摘除：配置里点名的工具，即使出现在保留集里也要拿掉。
  const extraDeny = new Set()
  for (const entry of config?.extraDeny ?? []) {
    if (typeof entry === 'string' && entry !== '') extraDeny.add(entry)
  }

  /**
   * **唯一**的「这个工具对大脑是否可见/可执行」判据。
   *
   * ⚠️⚠️ 三个地方必须用同一个函数，不能各写一份：
   *   ① `deny` 计算（restrict 隐藏哪几个）
   *   ② 执行层 guard（拒绝哪几个）
   *   ③ 投递层裁剪（从 assembly.tools 里摘哪几个）
   *
   * 原来 ② 和 ③ 只查 `keep`，而 ① 还查 `extraDeny` —— 于是配置里一旦写了
   * `extraDeny: ['read']`，restrict 会隐藏 read、guard 会拒绝 read，但**投递层仍把
   * read 的 schema 发给模型**（模型看得到、调了才被拒）。三处判据漂移是这类
   * 「看起来装了、实际有缝」问题的根源。
   * （独立代码审计 2026-10-30 指出，已核实三处确实不一致。）
   *
   * @param name - 工具名。
   * @returns 是否允许大脑看到并执行。
   */
  const isCoordinatorTool = (name) => name !== 'run_code' && keep.has(name) && !extraDeny.has(name)

  const warn = warnOnceFactory(ctx)

  // ── 阈值解析：配置优先，否则用默认 ──
  // read / grep 的三条阈值（readLimitMax / exploreBudget / exploreTotalBudget）
  // 已随工具一起删除，理由见文件顶部那段注释。
  const pollingMinGapMs =
    Number.isInteger(config?.pollingMinGapMs) && config.pollingMinGapMs > 0
      ? config.pollingMinGapMs
      : DEFAULT_POLLING_MIN_GAP_MS
  const pollingBudget =
    Number.isInteger(config?.pollingBudget) && config.pollingBudget > 0
      ? config.pollingBudget
      : DEFAULT_POLLING_BUDGET
  const maxResultChars =
    Number.isInteger(config?.maxResultChars) && config.maxResultChars > 0
      ? config.maxResultChars
      : Number.isInteger(config?.maxResultBytes) && config.maxResultBytes > 0
        // 兼容旧配置名：写进日志说明单位已变，避免"配了 52000 却按字符算"的静默误解。
        ? (warn('config key "maxResultBytes" is deprecated and is now interpreted as a CHARACTER count (was bytes); use "maxResultChars"'),
          config.maxResultBytes)
        : DEFAULT_MAX_RESULT_CHARS

  /**
   * spill 两个阈值：`config.spillTriggerChars` / `config.spillFallbackChars` 优先。
   *
   * 2026-11-02 通用化（通用性审计 R1 的 S5）：这两个常量是从**宿主**的
   * `spill-policy.maxInlineTokens`（默认 12500）反推出来的：
   *   `ceil(L/4)+4 > 12500` ⟺ L ≥ 49,985，故取 50,000；兜底取 52,000。
   * 但代码**不读**那个宿主配置 —— 若某部署把 `maxInlineTokens` 调大，
   * spill 会在更大的结果上才触发，而本守卫在 50,000 就判"spill 没处理"并按
   * 52,000 硬裁 → **本该无损落盘+给路径的结果被提前砍掉**（中文内容砍得更狠）。
   *
   * 为什么不用 `ctx.get('spillPolicy')` 反算：那是新增服务依赖，取不到还要回退，
   * 逻辑复杂度上升而收益相同。给两个 config 口子更简单：知道自己在做什么的部署
   * 直接写值；不知道的用默认值（默认值对宿主默认策略是正确的）。
   */
  const spillTriggerChars =
    Number.isInteger(config?.spillTriggerChars) && config.spillTriggerChars > 0
      ? config.spillTriggerChars
      : SPILL_TRIGGER_CHARS
  const spillFallbackChars =
    Number.isInteger(config?.spillFallbackChars) && config.spillFallbackChars > 0
      ? config.spillFallbackChars
      : SPILL_FALLBACK_CHARS

  /**
   * 重入闸门。
   *
   * `tools.restrict()` 与它的 disposer 都会**同步**触发 `tools/change`
   * （`ScopedLayers.effect` 里 setup 与 teardown 各调一次 `onChange()`，而
   * `ctx.emit` 是同步分发）。本模块又监听 `tools/change` → `resync` → `sync` →
   * `restrict`，于是会自己触发自己。
   *
   * 实测语义（`cordis/lib/index.js` 的 `emit()`：`this.dispatch(...).map(cb => cb(...))`，
   * 无 await）确认这是**同步重入**，不是延后事件。不加闸门时，多 agent 场景下会
   * 指数级重算（每层都把别人的 sync 再跑一遍）。
   *
   * 所以：本模块自己造成的变更一律忽略回声。`capability-scope` 用的是同一手法
   * （它的 `quietly(fn)` + `restricting` 标志）。
   */
  let echoing = false
  const quietly = (fn) => {
    echoing = true
    try {
      return fn()
    } finally {
      echoing = false
    }
  }

  /**
   * 每个大脑的在线限制：agent -> { disposer, liftGuard, healthy }。
   *
   * `disposer` 是**单值**（2026-11-03 从恒 ≤1 项的数组收敛而来）：本模块在同一个
   * scope 上只装一条 restriction，别的插件的 disposer 不会进这里 —— 数组形态
   * 保护不了「多条限制互相覆盖」那个风险，只是多余的一层。
   */
  const live = new WeakMap()
  /** 正在收窄的 agent：sessionId -> agent（切换广播只带 id）。 */
  const tracked = new Map()

  /**
   * 该大脑**这一刻**有没有团队协作工具：agent -> boolean。
   *
   * 为什么单独存一张表，而不是让 guard 闭包捕获一个局部布尔：guard 是某一轮
   * `sync()` 装上去的，但它会在**之后每一轮**被执行。捕获局部变量等于把
   * 「装的那一刻」的判断冻住 —— 团队工具晚注册时，文案会一直说 solo；
   * 团队插件被关掉时，文案会一直说团队。读这张表就是读最新一次 sync 的结论。
   *
   * 读不到（没 sync 过 / 读不到可见面）时按 **solo 处理**：solo 文案只提
   * 「派代理」，那在两种模式下都成立，是安全的那一侧。
   */
  const teamOn = new WeakMap()

  // ⚠️ 2026-11-01 删除两处死代码（两个独立审计都指出）：
  //
  //   · `budget`（WeakMap）—— 它是 read/grep 每轮探查预算的存储。而那套机制
  //     已随 read/grep 一起整段删除（见上方「read / grep 的阈值与预算常量已全部删除」），
  //     这个表从删掉那天起**从未被 get 或 set 过一次**。
  //   · `currentTurn` + 下方的 `agent/pre-step` 监听 —— 那个监听唯一的目的就是
  //     喂 `currentTurn`，而它只写不读（预算没了，没人再关心 turn 号）。
  //
  // 留着它们的代价不是性能，是**误导**：后来者读到这里会以为「还有预算机制」，
  // 顺手往里加规则，然后发现规则永远不生效。删干净比留注释更可靠。
  /** 重复查询闸门的状态：agent -> Map<signature, lastAt>（按签名分槽，防交替绕过）。 */
  const polling = new WeakMap()
  /** 轮询频次计数：agent -> Map<toolName, count>（按工具聚合，防 33 组参数轮转绕过）。 */
  const pollingCount = new WeakMap()

  const keyOf = (agent) => {
    const id = agent?.session?.id ?? agent?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * 卸掉**指定的一份**旧状态（隐藏与硬拦一起卸）。
   *
   * ⚠️ 与 `release(agent)` 的区别：这里不动 `live` / `tracked`，调用方负责
   * 把新状态写进去。BUG-6 的修法需要"先装新的、再卸旧的"，中间不能有
   * 「旧已卸、新未装」的窗口。
   */
  const releaseState = (state) => {
    if (state === undefined) return false
    let ok = false
    // disposer 会同步发 tools/change；用 quietly 吞掉自己的回声。
    quietly(() => {
      try {
        state.liftGuard?.()
        ok = true
      } catch (error) {
        warn(`lifting the hard-deny guard failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        // 单值：本模块在同一个 scope 上最多只装一条 restriction（见 `live` 的注释）。
        if (typeof state.disposer === 'function') {
          state.disposer()
          ok = true
        }
      } catch (error) {
        warn(`lifting the restriction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return ok
  }

  /** 卸掉一个大脑的现行限制（隐藏与硬拦一起卸）。 */
  const release = (agent) => {
    const key = keyOf(agent)
    if (key !== undefined) tracked.delete(key)
    const state = live.get(agent)
    if (state === undefined) return false
    live.delete(agent)
    return releaseState(state)
  }

  /** 重算并装上限制（顺序「读 → 卸 → 装」，理由见下方注释）。 */
  const sync = (agent) => {
    if (agent === undefined || agent === null) return

    // 队友 / 代理走原路：他们必须有完整工具集来干活。
    if (isDelegatedChild(agent)) {
      release(agent)
      return
    }

    // 模式隔离：只接管属于本 preset 的会话。早退前先判，避免装错对象还卸不掉。
    //
    // ⚠️ 2026-11-01 修 fail-open：原判据 `owner !== presetId` 把「读不出归属」
    // 和「确证属于别的 preset」混为一谈，前者会导致彻底放开（可 pwsh/write）。
    // 三条可达路径：agentPresets 取不到 / composedPreset 抛错 / header 无 agentPreset。
    // 黑猪 fail-closed：读不出 → 保持收窄；只有确证是别的 preset 才放开。
    const owner = ownerPresetId(ctx, agent, warn)
    if (owner !== undefined && owner !== presetId) {
      const lifted = release(agent)
      if (lifted) {
        ctx.logger?.info?.(
          `blackpig-guard: released the restriction for a session of another mode (${owner}); its tool roster is left untouched`,
        )
      }
      return
    }
    if (owner === undefined) {
      // 读不出归属，但这是大脑 scope（preset 行就装在这里）→ 保持收窄。
      warn(
        'could not determine which preset this session belongs to (composedPreset unreadable and the session ' +
          'header records no agentPreset); keeping the coordinator narrowing in place (fail-closed). ' +
          'If this session is actually another mode, its tools will be over-restricted until the preset is readable.',
      )
    }

    // ⚠️⚠️ 关键陷阱：`tools.schemas(agent)` 返回的是 `view(scope).visible` ——
    // 也就是**已经被 restriction 过滤过**的可见集（宿主源码 dsh-tools/lib/index.js：
    // `schemas(scope) { return [...this.view(scope).visible.values()].map(...) }`，
    // 而 view() 里是 `if (layers.every(layer => layer.admits(name))) visible.set(...)`）。
    //
    // 所以「先读后卸」在这里是错的：限制一旦装上，后续每次 sync 读到的都只是保留集
    // 里那几个名字（2026-11-02：当前是 27 个，另加 config.keep 追加项）→ deny 恒为空
    // → 走下面的 `deny.length === 0` return，而那时旧限制已经被 release 掉了
    // → **限制装/卸振荡**，每调一次工具都会开一个「全部工具可见可执行」的窗口。
    //
    // 正确做法：**已经装好、而且「现在仍然正确」时才跳过（幂等）**。
    //
    // ⚠️ 不能只看 `healthy === true` 就跳过：那会让「以后新注册的工具自动进 deny」
    // 这条设计承诺整条失效 —— 新插件注册的 pwsh/write 之类既不在旧 deny 里、
    // 也不在 withheld 里，guard 的存在性判据也拦不住，大脑立刻就能用。
    // `forceRefresh` 从没有任何地方置 true（它原来只是注释里的空承诺）。
    //
    // 所以幂等判据改为「复核当前可见面」：把**当前真实可见集**与**上一次 withhold 之后
    // 应有的保留集**比对。相等才跳过；不等说明工具面变了（新注册 / 被别的插件放开），
    // 必须重算 deny。
    const state0 = live.get(agent)
    if (state0 !== undefined && state0.healthy === true) {
      const nowVisible = visibleToolNames(ctx, agent)
      if (nowVisible.length > 0) {
        const leaked = nowVisible.filter((name) => !keep.has(name) && !extraDeny.has(name))
        if (leaked.length === 0) {
          // ⚠️ 2026-11-01：提前返回前必须刷新 teamOn。团队 6 个都在 keep 里，
          // 晚注册时 leaked 仍为 0 → 若在这里 return，teamOn 会冻结成 solo，
          // 文案说「没有队友」而工具其实都在（逆向误导，无任何报错）。
          teamOn.set(agent, teamAvailable(new Set(nowVisible)))
          // 可见面恰好等于保留集 → 限制仍然正确，无需重装（避免装/卸振荡）。
          return
        }
        ctx.logger?.info?.(
          `blackpig-guard: the visible surface changed since the last restriction (${leaked.length} unexpected tool(s): ${leaked.slice(0, 8).join(', ')}); recomputing`,
        )
      }
      // 读不到可见面时不能证明「仍然正确」，落到下面重算（安全方向）。
    }

    // 计算 deny 必须用**未过滤的完整继承集**（restrictableNames），不能用 agent 的
    // 可见集（已被过滤），也不能用全局层 schemas()（会漏掉 preset 祖先层的 pwsh/write/edit）。
    const visible = fullToolNames(ctx, agent)

    // ── 团队工具的动态检测（方案 C，2026-10-31）──
    //
    // 目标：团队插件关掉时，`spawn_teammate` / `wait_agent` / `team_task_*` 这 6 个
    // 名字就不存在了，而 `restrict({deny})` 会拿 `restrictableNames` 校验，
    // 未知名字直接抛错 → 整条限制装不上（黑猪是 fail-closed，会失去保护）。
    // 所以要把 keep 里「当前 roster 不存在」的团队工具剔掉。
    //
    // ⚠️⚠️ 判据必须用 **agent 可见集**（`visibleToolNames`），**不能用**
    // `fullToolNames()` / `restrictableNames`。原因（2026-10-31 实测踩到）：
    //
    //   团队那 9 个工具由 `tool-agent-team` 注册在 **agent 自己的 scope 层**上，
    //   而 `restrictableNames` 的定义是「全局层 + 祖先层，**不含本层**」。
    //   所以 `spawn_teammate` **永远不在** `restrictableNames` 里 ——
    //   用它做判据会把团队工具**永远误判成"不存在"**，团队在线时也照样剔掉，
    //   结果大脑连 spawn_teammate 都用不了。
    //
    //   可见集（`schemas(agent)` → `view(agent).visible`）**包含本层**，
    //   所以团队在不在它都能如实反映。
    //
    // 那为什么不能一直用可见集算 deny？因为可见集**已被上次的 restriction 过滤**，
    // 用它算 deny 会得到「上次保留了啥」而非「现在有啥」（这是本模块另一处注释
    // 反复强调的振荡来源）。所以这里分工：
    //   · 判断「团队工具在不在」→ 用可见集（它含本层，且我们只关心这 6 个名字）
    //   · 计算 deny 的补集       → 仍用 restrictableNames（未过滤的权威集合）
    //
    // 幂等窗口已经保证「可见面变了才重算」，所以可见集被过滤这件事不会让判断
    // 停留在过期状态。
    //
    // ⚠️⚠️ 2026-11-01 修：这里**只观察、不改 keep**（原实现会 `keep.delete`）。
    // 破坏性剪枝把「注册顺序竞态」放大成「团队能力的永久丢失」：本守卫与
    // `tool-agent-team` 都挂在 `agent/created` 上，守卫先跑就看不见团队工具，
    // 一剪就再也回不来，而团队工具随后照常注册好（系统提示里仍有
    // `Agent Teams is available in this session`）。实测同一进程里两个黑猪会话
    // 一个 29 工具、一个 23 工具，差集恰好是这 6 个 —— 就是这个竞态。
    //
    // 现在：keep 里留着这 6 个名字，缺席只记日志。缺席时它们在可见面上不存在，
    // 谁也调不到；等团队装好后下一次 sync 自动可用。
    let seenForFaultCheck = null
    {
      const seen = visibleToolNames(ctx, agent)
      // 供下面「读不到任何工具面」的故障判定复用（见那里的注释）。
      seenForFaultCheck = seen
      const available = new Set(seen)
      // ⚠️ 这个结论要带进 guard 闭包：拒绝文案在 solo 模式下**不能**提
      // wait_agent / team_task_get —— 那些工具不存在，文案会指引模型去调它。
      // 写成 agent → boolean 的 WeakMap，而不是捕获局部变量：guard 是本轮 sync
      // 装的，但可能在之后任一轮执行时被调用，必须读**当前**那份判断。
      teamOn.set(agent, teamAvailable(available))
      const dropped = pruneAbsentTeamTools(available)
      if (dropped.length > 0) {
        ctx.logger?.info?.(
          `blackpig-guard: ${dropped.length} team-only tool(s) are not on the visible surface yet ` +
            `(${dropped.join(', ')}); they stay in the keep-list, so they become usable as soon as ` +
            'the Agent Teams plugin registers them (the coordinator always keeps send_message / ' +
            'interrupt_agent / list_agents, which the host also provides).',
        )
      }
    }

    // ⚠️ 2026-11-02（简化审计发现 7）：原来这里**又调了一次** `visibleToolNames(ctx, agent)`
    // 只为做「读不到任何工具面」的故障判定。而它与上面 L1487 那次之间**没有 await、
    // 没有注册动作**，`visibleToolNames` 是纯读 —— 两次结果必然相同。
    //
    // 每次调用宿主的 `schemas()` 会把每个可见工具的 parameters **深拷贝一遍**
    // （`schemaOf(definition, true)` → `snapshotJsonValue`），几十个工具就是几十次深拷贝，
    // 而这段代码在**每个工具调用后**都跑（post-execute → sync）。所以复用上面那次结果。
    //
    // 用 `seen`（上面的数组）而不是 `available`（Set）：Set 会去重，长度可能与数组不等，
    // 而这里的判据要的是「可见面是否为空」，数组更忠实。
    const agentVisible = seenForFaultCheck ?? []
    if (visible.length === 0 || agentVisible.length === 0) {
      const alreadyLive = live.has(agent)
      warn(
        alreadyLive
          ? 'no tool schemas were readable on a resync; the PREVIOUS restriction is kept in place (failing safe, not open)'
          : 'no tool schemas were readable for a coordinator scope; the restriction is NOT engaged for this session yet (will retry on the next tool call)',
      )
      return
    }

    // ⚠️⚠️ BUG-6（2026-10-30 修）：这里**不再先 `release(agent)`**。
    //
    // 原顺序是 `release(agent)` → 装新的。装失败时**旧保护已经没了**：
    // 审计实测——已装好的会话在一次重装失败后 `guardCount 1→0`、`pwsh` 变为可执行。
    // 只把 warn 升成 error 属于"认账不修"。
    //
    // 新顺序：**先算出要装什么 → 装新的 → 确认装上了 → 才卸旧的**。
    // 任何安装失败路径下都直接放弃，旧状态（`live.get(agent)`）**原封不动**，
    // 于是"旧保护仍然生效"是从代码结构上保证的，不是靠补丁。
    //
    // 旧状态先取出来存着，等新状态写进 `live` 之后再卸 —— 这样中间没有任何
    // 「两层都没了」的窗口。
    const previousState = live.get(agent)

    // ⚠️ `deny.length === 0` 时**不能直接 return**：那会连 guard 都不装，
    // read 的 limit 强制、grep 的 path 强制、预算、轮询闸门**全部消失**
    // （这是 fail-open 的一种形态：退化时静默地什么都没装）。
    // 参数类规则与「是否还有工具可摘」无关，必须独立生效。
    // （第 1 轮审计 B 条，已核实。）
    const deny = visible.filter((toolName) => !isCoordinatorTool(toolName))

    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      warn('the agent scope exposes no tools.restrict(); this session keeps the full roster')
      // 注意：restrict 不可用时仍然继续往下装 guard —— 执行层的硬拦必须尽力而为。
      // 唯一的例外是 guard 也不可用（下面会再检查）。
    }

    /**
     * `restrict()` 会拿 `restrictableNames`（全局层 + 祖先层，**不含本层**）校验每个
     * 名字，未知即抛错。而 `schemas(agent)` 返回的可见面**包含本层注册的工具**
     * （Agent Teams 的 9 个就在 agent 自己的层上）。所以补集里可能混进本层名字。
     *
     * 这里不猜，而是照着错误信息点名剔除后重试一次：错误原文形如
     * `names unknown global tool "a", "b"`。
     */
    const restrictWith = (names) => {
      // restrict 与它的 disposer 都同步发 tools/change，必须吞回声。
      return quietly(() => {
        try {
          return { dispose: tools.restrict({ deny: names }), applied: names }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const match = /unknown global tool[s]? ((?:"[^"]+"(?:, )?)+)/.exec(message)
          if (match === null) return { error: message }
          const offenders = new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
          const narrowed = names.filter((name) => !offenders.has(name))
          ctx.logger?.info?.(
            `blackpig-guard: ${offenders.size} name(s) in the complement are registered in this agent's own layer and cannot be restricted (Agent Teams tools are the expected case); retrying without them: ${[...offenders].sort().join(', ')}`,
          )
          if (narrowed.length === 0) return { applied: [] }
          try {
            return { dispose: tools.restrict({ deny: narrowed }), applied: narrowed }
          } catch (second) {
            return { error: second instanceof Error ? second.message : String(second) }
          }
        }
      })
    }

    // `tools.restrict` 不可用时（旧宿主 / 该 scope 没暴露）跳过隐藏层，
    // 但**必须继续装 guard** —— 执行层硬拦是最后一道防线，不能因为隐藏层缺失就不装。
    const attempt = typeof tools?.restrict === 'function'
      ? restrictWith(deny)
      : { applied: [], error: 'tools.restrict() is not available on this agent scope' }
    if (attempt.error !== undefined) {
      warn(`engaging the restriction failed: ${attempt.error} — falling back to the hard-deny guard only`)
    }

    const withheld = new Set(attempt.applied ?? [])

    let liftGuard
    if (hardDeny) {
      try {
        // restrict 只隐藏；guard 才是真正拒绝执行的那一层。
        // 注册在 agent.ctx 上 → 只作用于该 agent，不波及队友。
        // 判据用**实际下发的那份 deny 集**（而不是「不在保留集」）：本层注册的工具
        // （Agent Teams 的 9 个）永远不会进 deny，因此永远可以被放行执行。
        liftGuard = tools.guard((execution) => {
          const toolName = execution?.name
          if (typeof toolName !== 'string' || toolName === '') return undefined

          // ⚠️ 每次执行都**现取**模式，不捕获本轮 sync 的局部值。
          // guard 会在之后每一轮被执行；冻结住等于让文案永远停在装上时那一刻。
          // 读不到（没 sync 过）按 solo 算 —— solo 文案只提代理，两种模式下都成立。
          const teamMode = teamOn.get(agent) === true

          // ① 不在工具面上 → 拒。
          //
          // ⚠️ 外加一个**永远拒绝 run_code** 的硬判据：它是 PTC 保留传输名，
          // `restrict()` 明确拒绝它（宿主注释：per-agent restrictions must not remove it），
          // 而 `visibleToolNames` / `fullToolNames` 又把它滤出了 deny 计算，
          // 所以它既不在 deny 也不在 withheld —— **两层都管不到它**。
          // 一旦 PTC 模式把它放进可见面，大脑就能执行任意代码，整条「不能自己干活」失效。
          // （第 1 轮代码审计 2026-10-30 B-4，已核实：代码里没有任何一层会拦它。）
          if (toolName === 'run_code') {
            return (
              'blackpig mode: "run_code" 是 PTC 保留传输名，大脑模式下**永久禁止**。' +
              (teamMode
                ? '要执行代码请写成任务书交给队友（代理有完整工具面）。'
                : '要执行代码请写成任务书派给代理（subagent_preset，代理有完整工具面）。')
            )
          }
          // ① 不在保留集 → 拒。
          //
          // ⚠️⚠️ 判据必须用 **keep 白名单**，**不能只靠 `withheld`**。
          //
          // `withheld` 来自 `restrict()` 实际下发的 deny 集；一旦 restrict 抛错
          // （名字解析失败、宿主 API 变化、挂载顺序问题），`attempt.applied` 就是
          // undefined → `withheld` 为空 → `withheld.has(toolName)` 恒为 false →
          // pwhs/write/edit 在执行层**全部放行**，而 fail-closed 自检也只是喊了一声。
          // 这是最危险的 fail-open：日志看起来一切正常，实际是全开。
          // （第 2 轮源码审计 2026-10-30 C-1，已核实。）
          //
          // 用 `keep` 做判据还有第二个好处：它同时堵住「注册在 agent 自己 scope 层
          // 上的工具」这条绕过路径 —— 那类工具进不了 deny、也进不了 withheld，
          // 但如果它不在 keep 里，这里照样拒绝。
          // （第 2 轮审计 B-1 指出的同一个洞。）
          if (withheld.has(toolName)) {
            return `blackpig mode: "${toolName}" is not on the coordinator's tool surface (blackpig-guard)`
          }
          // 白名单兜底：即使 restrict 完全失效，这一层仍然拦住所有不该有的工具。
          //
          // ⚠️ 判据走 `isCoordinatorTool`，与 `deny` 计算、投递层裁剪**同源**。
          // 原来这里只查 keep、不查 extraDeny，于是 `extraDeny: ['read']` 时
          // guard 会放行 read（restrict 隐藏了它，但 guard 不认），三处判据漂移。
          if (!isCoordinatorTool(toolName)) {
            return (
              `blackpig mode: "${toolName}" is not on the coordinator's tool surface ` +
              '(blocked by the keep-list guard, which stays effective even when restrict() fails)'
            )
          }

          // ② `read` / `grep` 的专属规则**已整段删除**（2026-10-31，用户决定「情况 A」）。
          //
          // 删掉的不只是两个工具的规则，而是整套「怎么限制大脑自己查」的机械装置：
          //   · read 的 limit 强制（≤60 行）
          //   · grep 的 path 强制 + 全目录树判定（isRepoWidePath）
          //   · 每轮 3 次探查预算 + 累计 20 次软上限
          //   · 重复查询闸门（POLLING_TOOLS）
          //
          // 为什么能整段删：`read` 和 `grep` 已经不在 keep 里了 —— 它们进 deny、
          // 进 withheld、`isCoordinatorTool` 判 false，上面 ① 那三条判据就把它们挡住了。
          // **再留着这些参数级规则就是死代码**：永远不会被执行到。
          //
          // 为什么该删而不是留着当保险：这套规则的存在本身就是「大脑会自己查」这个
          // 假设的产物。砍掉工具之后假设不成立，规则留着只会让后来者以为「它还能查」。
          // 要看内容的正路是派代理，核实元数据的正路是 `file_info`。

          // ⑤ 重复查询闸门：同一工具 + 同一组参数，短时间内再查一次 → 拒。
          //    实测 session-00000000 里 list_agents 调了 29 次、team_task_list 27 次，
          //    单次都不大（最多数 KB），6000 B 阈值完全裁不掉它。
          //    ASTRA 评审第 3 条：这是**频次**问题，不是体量问题。
          //
          // ⚠️ 必须按 signature **分槽**记录，不能只记「上一次」。
          // 原来用 `{ last: {signature, at} }` 单槽，于是
          // `team_task_list({})` → `team_task_list({status:'all'})` → `team_task_list({})`
          // 这样交替两个参数集，每次 prev.signature 都不同，**全部放行**。
          // `list_agents` 无参数所以挡得住，`team_task_list` 有参数所以挡不住 ——
          // 而 27 次轮询里恰恰是后者。（deepseek 评审 2026-10-30 第 ⑤ 条，已核实。）
          if (POLLING_TOOLS.has(toolName)) {
            const signature = `${toolName}:${stableKey(execution?.arguments)}`
            const now = Date.now()
            let slots = polling.get(agent)
            if (slots === undefined) {
              slots = new Map()
              polling.set(agent, slots)
            }
            const prevAt = slots.get(signature)
            if (prevAt !== undefined) {
              const sinceMs = now - prevAt
              if (sinceMs < pollingMinGapMs) {
                // 保持"拒绝"，但把措辞改成**指向下一步动作**，而不是只报错。
                // （评审建议改成"返回上次结果 + unchanged"更省，但那需要在 guard 里
                //   持有上次结果 —— guard 是执行前同步钩子，拿不到结果，做不到。
                //   所以这里保留拒绝，但把话说清楚，避免模型重试同样的调用。）
                //
                // ⚠️ 2026-11-01 修：文案必须按模式分叉。solo 会话里没有
                // wait_agent / team_task_get，原来那句「要等队友就调用一次 wait_agent」
                // 会指引模型去调不存在的工具，撞一次错白烧一轮。
                return teamMode
                  ? (
                      `blackpig mode: ${Math.round(sinceMs / 100) / 10} 秒前你刚用完全相同的参数查过 ${toolName}，` +
                      '这中间没有任何变化，重查不会得到新信息。要等队友就调用一次 wait_agent；' +
                      '要查某个任务就用 team_task_get 按 id 单取。'
                    )
                  : (
                      `blackpig mode: ${Math.round(sinceMs / 100) / 10} 秒前你刚用完全相同的参数查过 ${toolName}，` +
                      '这中间没有任何变化，重查不会得到新信息。本会话没有任务板也没有队友：' +
                      '要等代理就用它的结算通知（会自动到），要更多信息就 send_message 追问它。'
                    )
              }
            }
            slots.set(signature, now)
            // 槽位自清理：只保留最近 32 个，防止长会话无限增长。
            if (slots.size > 32) {
              const oldest = [...slots.entries()].sort((a, b) => a[1] - b[1])[0]
              if (oldest !== undefined) slots.delete(oldest[0])
            }

            // ⚠️ 单靠「同签名 + 时间窗」还能被**轮转 33 组以上参数**绕过：
            // 每组参数回到同一签名时都超过 8 秒 → 全部放行，而槽位上限 32 会淘汰旧的。
            // 所以再加一道**按工具的频次计数**（与签名无关、与时间窗无关）：
            // 这是第 1 轮代码审计 2026-10-30 B-6 指出的绕过路径。
            const counters = pollingCount.get(agent) ?? new Map()
            pollingCount.set(agent, counters)
            const used = (counters.get(toolName) ?? 0) + 1
            counters.set(toolName, used)
            if (used > pollingBudget) {
              // ⚠️ 同上：solo 模式不得提 wait_agent / team_task_get。
              return teamMode
                ? (
                    `blackpig mode: 本会话你已经调了 ${used} 次 ${toolName}（上限 ${pollingBudget}）。` +
                    '查列表不是等待，也不该是主要工作 —— 用 team_task_get 按 id 单取，' +
                    '或者直接 wait_agent 等队友，把剩下的活写成任务书。'
                  )
                : (
                    `blackpig mode: 本会话你已经调了 ${used} 次 ${toolName}（上限 ${pollingBudget}）。` +
                    '查列表不是等待，也不该是主要工作 —— 本会话没有队友可等：' +
                    '把剩下的活写成任务书派给代理，或者直接结束这一轮等它的结算通知。'
                  )
            }
          }

          return undefined
        })
      } catch (error) {
        warn(`installing the hard-deny guard failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (attempt.dispose === undefined && liftGuard === undefined && withheld.size === 0) {
      // ⚠️⚠️ 安装失败路径 —— BUG-6 修完之后，这里**不再丢保护**。
      //
      // 旧实现：`sync()` 先 `release(agent)` 再重装，两层同时失败时旧保护已被卸掉，
      // 状态从「隐藏 N 个工具 + guard 1 层」退化成「隐藏 0 个 + guard 0 层」，
      // pwsh / write / edit **全部可执行**（审计实测 guardCount 1→0）。
      //
      // 现在：`release(agent)` 已经移到所有安装动作**之后**（见上面的 `previousState`）。
      // 走到这个分支意味着「新的两层都没装成」，此时 `live` 里还躺着**旧的那一份**，
      // 它对 pwsh / write / edit 的拦截**完全没被碰过**。所以：
      //   · 有旧状态 → 什么都不做，只记一条 error 说明"保留旧保护"，绝不覆盖 live；
      //   · 没有旧状态（首次安装就失败）→ 才是真的没有保护，喊 PROTECTION LOST。
      const hadPrevious = previousState !== undefined
      if (hadPrevious) {
        ctx.logger?.error?.(
          'blackpig-guard: RE-INSTALL FAILED — the new restriction and the new hard-deny guard both failed to install. ' +
            'The PREVIOUS protection is still in force (it was never released, because release now runs only after a ' +
            'successful install). The tool surface may be stale until the next successful sync.',
        )
        // ⚠️ 刻意**不**写 live：覆盖它就会丢掉旧 disposer 的引用，
        // 之后 release 卸不掉真正在生效的那一层（泄漏且无法回收）。
        // 只把 healthy 打成 false，让下一次 sync 继续重试。
        if (typeof previousState === 'object' && previousState !== null) previousState.healthy = false
        return
      }
      ctx.logger?.error?.(
        'blackpig-guard: PROTECTION LOST — this session never had a working restriction and installing one failed ' +
          '(no restriction, no guard). The coordinator can currently see and execute every tool. ' +
          'This happens when the host tool API changes; the guard will keep retrying on each tool call.',
      )
      live.set(agent, {
        disposer: undefined,
        liftGuard: undefined,
        healthy: false, // ← 关键：让下一次 sync 不走幂等跳过，立刻重试
      })
      return
    }

    // ── fail-closed 自检（ASTRA 评审 2026-10-30 第 2 条）──
    //
    // 原设计是「失败即放行」：restrict 装不上就只靠 guard，guard 也装不上就只靠 restrict，
    // 两个都装不上就只 warn 一句然后继续跑 —— 系统看起来正常，实际是全开。
    // ASTRA 的判据：模拟三种失败（restrict 不存在 / 抛异常 / 返回非预期值）后，
    // 若大脑仍能看到或执行 pwsh / write / edit，就没有 fail-closed。
    //
    // 这里做**装完之后的实测自检**，而不是相信「装的时候没报错」：
    //   ① 重读可见工具面，确认 denied 的名字真的不见了（restrict 生效的证据）
    //   ② 直接调 guardReason 打一个必拒的工具，确认 guard 真的会拒（guard 生效的证据）
    // 两层都失效 → 这是**没有任何保护**的状态，用 error 级别喊出来，并记进保护状态。
    const protectedLayers = []
    if (attempt.dispose !== undefined) protectedLayers.push('restrict')
    if (liftGuard !== undefined) protectedLayers.push('guard')

    let restrictVerified = false
    if (attempt.dispose !== undefined) {
      const after = visibleToolNames(ctx, agent)
      const leaked = after.filter((name) => withheld.has(name))
      restrictVerified = after.length > 0 && leaked.length === 0
      if (!restrictVerified) {
        ctx.logger?.error?.(
          `blackpig-guard: FAIL-CLOSED CHECK FAILED — restrict() returned a disposer but ${leaked.length} withheld tool(s) are STILL visible (${leaked.slice(0, 8).join(', ')}). The schema layer is not enforcing.`,
        )
      }
    }

    let probeName
    let guardVerified = false
    if (liftGuard !== undefined) {
      try {
        // ⚠️⚠️ N4 的根因就在这里：原来只用 `withheld[0]` 当探针。restrict 抛错时
        // `withheld` 为空 → 探针为 undefined → 下游判不出「guard 在不在拦」→
        // 打出假 UNPROTECTED，尽管 guard 实测仍在拒 pwsh。
        //
        // 现在按优先级挑探针：withheld 里的名字 → deny 集里的名字（restrict 失败时
        // 仍然算得出来）→ 最后兜底 `'pwsh'`（**必然不在保留集**，任何黑猪会话都会被拒）。
        // 三级兜底让 `probeName` **永远有值**。
        //
        // ⚠️ 2026-11-02（第二轮复核 P3-1）：正因为三级兜底，`guardVerified` 现在只有
        // `true` / `false` 两种值，**不可能**是 `null`。原来下游按「null = 不适用」
        // 写的三处逻辑（`guardOk` / `healthy` / `guardLabel`）与注释都已按**不可达**
        // 清理 —— 留着会教后来者「这里可能不适用」，而实际上永远适用。
        probeName =
          [...withheld][0] ??
          deny.find((name) => typeof name === 'string' && name !== '') ??
          'pwsh'
        const reason = tools.guardReason({ agent, callId: 'blackpig-guard-selfcheck', name: probeName, arguments: {} })
        guardVerified = typeof reason === 'string' && reason !== ''
        if (!guardVerified) {
          ctx.logger?.error?.(
            `blackpig-guard: FAIL-CLOSED CHECK FAILED — the hard-deny guard is installed but did NOT deny the probe "${probeName}". Execution layer is not enforcing.`,
          )
        }
      } catch (error) {
        guardVerified = false
        ctx.logger?.error?.(
          `blackpig-guard: FAIL-CLOSED CHECK FAILED — tools.guardReason() threw while probing: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // guard 层是否真的在拦：`guardVerified === true` 是**直接证据**（探针被执行层拒了）。
    //
    // ⚠️ 2026-11-02（第二轮复核 P3-1）：这里原来还写了 `|| (guardVerified === null &&
    // restrictVerified)` 那一档，前提是「没有可探的工具时 guardVerified 可能是 null」。
    // 但 `probeName` 现在有三级兜底（末级是必然被拒的 `'pwsh'`），**永远探得到**，
    // `guardVerified` 只能是 true/false —— 那一档是**恒假分支**，已删。
    const guardOk = guardVerified === true

    // ⚠️⚠️ N4（2026-10-30 修）：**只有两层都失效**才叫 UNPROTECTED。
    //
    // 原判据 `protectedLayers.length === 0 || (!restrictVerified && !guardOk)` 有个洞：
    // restrict 抛错（`attempt.dispose === undefined` → `protectedLayers = ['guard']`）
    // 且 `withheld` 为空时，`guardVerified` 被置成 `null` → `guardOk = null && false = false`
    // → `unprotected = true`。但实测 pwsh **仍然被 guard 拒绝**（keep 白名单兜底那一层在
    // 正常工作），于是日志打出「THIS COORDINATOR SESSION IS RUNNING WITHOUT ANY ENFORCED
    // TOOL RESTRICTION」—— **假告警**，会让人对着一条正常的会话查半天。
    //
    // 新判据分三档，各给精确文案：
    //   · 两层都失效（或什么层都没装上）→ UNPROTECTED（error，措辞最重）；
    //   · 只有执行层（guard）在拦 → "restrict layer failed, guard layer still enforcing"
    //     （error 但明确说还有一层在拦，可执行工具仍被拒）；
    //   · 只有隐藏层（restrict）在拦 → "guard layer failed, restrict layer still hiding"
    //     （error，说明 schema 层还在挡，但执行层不设防）。
    const restrictLayerOk = attempt.dispose !== undefined && restrictVerified
    // guard 层是否真的在拦：`guardVerified === true` 是**直接证据**。
    // （`guardVerified === null` 那一档已不可达，见上方 `probeName` 三级兜底的注释。）
    const guardLayerOk = guardVerified === true
    const nothingEnforcing = protectedLayers.length === 0 || (!restrictLayerOk && !guardOk && !guardLayerOk)
    if (nothingEnforcing) {
      ctx.logger?.error?.(
        'blackpig-guard: ⚠️ THIS COORDINATOR SESSION IS RUNNING WITHOUT ANY ENFORCED TOOL RESTRICTION. ' +
          `Expected to withhold ${withheld.size} tool(s); layers installed: [${protectedLayers.join(', ') || 'none'}]. ` +
          'The model can reach the full roster. Treat every report from this session as unconstrained.',
      )
    } else if (!restrictLayerOk && guardLayerOk) {
      // N4 的正例：restrict 抛错但 guard 实测仍拒 pwsh → 不许喊 UNPROTECTED。
      ctx.logger?.error?.(
        'blackpig-guard: restrict layer failed, guard layer still enforcing — ' +
          `the schema layer is NOT hiding anything (${attempt.error ?? 'restrict() returned no disposer'}), ` +
          `but the execution layer still denies every tool outside the keep-set (probe verified on "${probeName}"). ` +
          'The coordinator can see the full roster, but cannot execute it.',
      )
    } else if (restrictLayerOk && !guardLayerOk) {
      ctx.logger?.error?.(
        'blackpig-guard: guard layer failed, restrict layer still hiding — ' +
          `the schema layer still withholds ${withheld.size} tool(s), but the execution layer could not be verified. ` +
          'A tool call that bypasses the schema list would not be denied.',
      )
    }

    // `healthy` = 两层都真的在拦，且没有 unprotected 标记。
    // 只有 healthy 的会话才会在后续 sync 里被跳过（避免装/卸振荡）。
    // 任何一层失败 → healthy=false → 下次 sync 会重新尝试。
    // healthy = 两层都确认在拦，且没落到"什么都没装上"。
    // （原来的 `|| guardVerified === null` 一档已不可达，见上方 probeName 注释。）
    const healthy = !nothingEnforcing && restrictVerified && guardVerified === true

    // ⚠️ BUG-6 的最后一步：新状态**已经装好**（走到这里说明 restrict 或 guard 至少一层
    // 拿到了 disposer），现在才卸旧的那一份。这样一来：
    //   · 安装失败路径（上面已 return）永远碰不到旧状态；
    //   · 安装成功路径下，旧 disposer 在这里被回收，不会泄漏。
    if (previousState !== undefined) releaseState(previousState)

    live.set(agent, {
      disposer: typeof attempt.dispose === 'function' ? attempt.dispose : undefined,
      liftGuard,
      healthy,
    })
    const key = keyOf(agent)
    if (key !== undefined) tracked.set(key, agent)
    // `guardVerified` 只有 true/false（probeName 三级兜底保证永远探得到），故无 'n/a' 档。
    const guardLabel = guardVerified ? 'ok' : 'FAIL'
    ctx.logger?.info?.(
      `blackpig-guard: coordinator scope engaged — total ${visible.length}, withheld ${withheld.size}` +
        `${attempt.dispose === undefined ? ' (restrict FAILED, hard-deny only)' : ''}` +
        `, self-check: restrict=${restrictVerified ? 'ok' : 'FAIL'} guard=${guardLabel}` +
        `, healthy=${healthy}` +
        `${nothingEnforcing ? ' ⚠️ UNPROTECTED' : restrictLayerOk ? '' : ' (restrict layer down, guard layer live)'}: ${[...withheld].sort().join(', ')}`,
    )
  }

  /**
   * 处理「某个会话的 preset 可能变了」。两个无载体广播（tools/change、
   * agent-preset/selected）共用它 —— 会话切走后本守卫收不到它按 scope 过滤的事件，
   * 「最后一次 sync」永远不来，装错的限制会一直留着。
   */
  const resync = (id) => {
    if (typeof id === 'string' && id !== '') {
      const agent = tracked.get(id) ?? agentById(ctx, id)
      if (agent !== undefined) sync(agent)
      return
    }
    for (const agent of [...tracked.values()]) sync(agent)
  }

  // ── 主路径：agent 一出现就装，赶在首次 prompt 组装之前 ──
  // payload 是对象，必须解构（把第一个参数当 agent 读会静默跳过）。
  ctx.on('agent/created', ({ agent }) => {
    sync(agent)
  })

  // ── 自愈：每次工具调用结束后重算 ──
  // 同时做**结果裁剪**：read 的字节数由文件内容决定、grep 由命中数决定，
  // 光限行数/限 path 都拦不住体量（实测一次 grep 回数十 KB）。
  // 所以拿到 result 之后、进上下文之前，按 maxResultChars（字符）硬截。
  //
  // ⚠️ waterfall 语义（踩过的坑）：**必须先 `await next()`**，再在它给的 decision
  // 上叠加自己的裁剪。直接 return 一个 decision 等于**短路整条链** —— 后面还有
  // 宿主自己的 `spill-policy`（把超长输出落盘换引用）、`repeat-tool-reminder`、
  // `tool-fs-search` 的后处理，全都会被跳过。本仓库其余三处 post-execute 监听
  // 也一律是「先 next() 再加工」，这是该事件的正确契约。
  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const agent = exec?.agent
      sync(agent)

      const decision = await next()

      // 别人已经判定 block 时，原样交回，不参与裁剪。
      if (decision === undefined || decision === null || decision.kind !== 'accept') return decision

      // 只裁大脑自己的结果；队友的返回不受影响（他们要看到完整内容才能干活）。
      if (agent === undefined || agent === null || isDelegatedChild(agent)) return decision

      // ⚠️ 必须判归属：会话切出 producer 之后（比如用户把主线切回 standard），
      // 这个模块**仍然挂在这个会话上**（selftest D 组已证明 sync 会卸限制但不摘插件），
      // 而裁剪逻辑没有对应的卸载动作。若不判 owner，standard 会话的主对话
      // 会继续收到被压到 6000 B / 被改结构的结果 —— 静默数据丢失。
      // （第 1 轮代码审计 2026-10-30 A-2，已核实。）
      const ownerNow = ownerPresetId(ctx, agent, warn)
      if (ownerNow !== presetId) return decision

      const toolName = exec?.name
      if (typeof toolName !== 'string' || TRIM_EXEMPT_TOOLS.has(toolName)) return decision

      // `value`（结构化结果）优先级高于 `content`，且两者不能同时由 accept 给出；
      // 出现 `value` 说明下游已经重写过结果，交给它，不叠 content。
      if (Object.hasOwn(decision, 'value')) return decision

      const source = Object.hasOwn(decision, 'content') ? decision.content : result?.content

      // 任务板不再做结构化压缩。
      //
      // 原来这里有 146 行：把 team_task_* 的 JSON 按 description/prompt 逐级缩短，
      // 再按任务条数二分截断。删掉的理由：
      //   · 它解决的是「JSON 截断后不可解析」。但宿主 spill-policy 会**把全文落盘
      //     并在通知里给出路径** —— 大脑拿不回来的问题根本不存在，它随时能让
      //     队友去读那个文件，或者自己按 id 用 team_task_get 单取。
      //   · 那 146 行维护的是「一份没人读的散文该保留多少字」，而不是任何可测目标。
      //   · 任务板列表天然就小（实测最多次 KB，远低于阈值），这段代码几乎不触发。
      // → 统一交给下面的兜底裁剪（通常也不会触发，因为 spill 先处理了）。

      // ── 兜底裁剪：两档阈值（N2 的修法）──────────────────────────────────
      //
      // ① 结果**没有** spill 落盘标记、却已经超过 spill 的触发点 → spill 没处理它
      //    （被禁用 / config 缺失 / spillStore 缺失 / 它自己 throw 后 keeping inline），
      //    用 `SPILL_FALLBACK_CHARS`（52,000 字符）兜底。
      // ② 结果**有** spill 标记 → spill 已经把它无损落盘并裁到 ~12,500 token，
      //    用 `maxResultChars`（默认 200,000 字符），正常情况下永不触发。
      //
      // 这样既不会在 spill 之前抢裁（N2），也不会在 spill 缺席时开出 50K~200K 字符的
      // 裸奔通道。判据见 `looksSpilled()`：标记必须在**末尾**且整体以 `)` 收尾，
      // 防止"正文里碰巧出现这句话"把阈值放宽成一个新洞。
      const charsOf = (blocks) =>
        Array.isArray(blocks)
          ? blocks.reduce((sum, b) => sum + (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text.length : 0), 0)
          : 0
      const sourceChars = charsOf(source)
      const spillHandled =
        Array.isArray(source) &&
        looksSpilled(source.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string').map((b) => b.text).join(''))
      const effectiveMax = spillHandled
        ? maxResultChars
        : sourceChars > spillTriggerChars
          ? Math.min(maxResultChars, spillFallbackChars)
          : maxResultChars

      // ⚠️ 2026-11-01：把该会话的团队状态传进去 —— 裁剪说明里的「派队友去取」
      // 在 solo 会话里指向不存在的概念，必须换成「派代理」。
      const trimmed = trimContent(source, toolName, effectiveMax, teamOn.get(agent) === true)
      if (trimmed === undefined) return decision

      // ⚠️ N1：裁剪决定一旦做出就**不再静默反悔**。裁不了也要用 error 记账。
      if (trimmed.skipped !== undefined) {
        if (sourceChars > effectiveMax) {
          ctx.logger?.error?.(
            `blackpig-guard: TRIM SKIPPED — a "${toolName}" result of ${sourceChars} chars exceeds the fallback limit ` +
              `${effectiveMax} chars, but it could not be trimmed: ${trimmed.skipped}. ` +
              `The FULL result is being passed through unchanged (${sourceChars} chars).`,
          )
        }
        return decision
      }

      // ⚠️ N7：文案不臆测上游。spill 处理过就直说"这是第二次裁剪"，
      // 没处理过才说"这是 spill 之后的第二道保险"。
      ctx.logger?.info?.(
        `blackpig-guard: trimmed a "${toolName}" result from ${trimmed.originalChars} chars to ${trimmed.keptChars} chars ` +
          `(${trimmed.originalBytes} B → ${trimmed.keptBytes} B; limit ${effectiveMax} chars; ` +
          `${trimmed.spillHandled ? 'spill-policy had already retained it, this is the second trim' : 'no spill retention mark was found, this is the fallback path'})`,
      )
      return withAdditionalContexts({ kind: 'accept', content: trimmed.content }, decision)
    },
    { prepend: true },
  )

  // ── 投递层裁剪：**兜底**，不是主路径（2026-11-03 降级）────────────────
  //
  // ⚠️ 宿主文档明文：「Do not listen to `system-prompt/assemble` to add or remove
  // tools or text」。在这层裁 `assembly.tools` 依赖的是**未文档化行为**：只要下游在
  // `next()` 之后再加工一次，裁剪就会被静默覆盖且无报错。
  //
  // 定位：主路径是 `restrict()`（视图层）+ `guard()`（执行层），这里只是第三道防线。
  // **不许删** —— restrict 失效时它是最后一道防线，覆盖两个真实的洞：
  //
  //   ① **首次装配**：`assemble()` 先收集工具、渲染 section，**然后**才跑本瀑布，
  //      所以 `agent/created` 里装的 restriction 对**第一次**请求无效。
  //   ② **本层注册的工具**：`view()` 里 `own.tools` 无条件进 `visible`，restriction
  //      收不动它们（Agent Teams 那 9 个），而大脑必然是 `role: 'lead'` → 必装。
  //
  // （来源：dsh-agent-studio 的 apply.ts 也是「视图层 + 投递层 + 执行层」三层落实。）
  // 判据与 guard 的 keep 白名单**同源**，避免两处清单漂移。
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      const decision = await next()
      const agent = context?.agent ?? assembly?.agent
      if (agent === undefined || agent === null) return decision

      // 下游返回 undefined/非对象时**原样交回**，绝不「修补」。
      //
      // ⚠️ 独立审计实测：原实现 `return { ...decision, tools: kept }` 会在
      // decision 为 undefined 时造出 `{ tools }` 这个残废对象，把下游的软故障
      // 放大成硬崩溃 —— 宿主 `SystemPrompt.assemble()` 紧接着读
      // `transformed.sections` / `transformed.contexts`，缺字段直接 TypeError。
      // 我们没有资格替别人擦屁股。
      if (decision === undefined || decision === null || typeof decision !== 'object') return decision

      // ── 队友 / 代理：默认拿到完整工具面，但**队友要摘掉 spawn_teammate** ──
      //
      // 2026-11-02 新增（用户要求「队友不能派队友」的机制化）。
      //
      // 背景：`spawn_teammate` 由宿主 `tool-agent-team` 注册在**每个队友自己的
      // scope** 上，所以 `restrict()` 摘不掉它 —— 队友工具表里一直挂着一个
      // 「调用必被拒」的工具（宿主 `spawnAdmitted` 里 `role !== 'lead'` 直接抛
      // `TEAM_LEAD_REQUIRED`）。实测过若干队友、数百次调用、0 次成功。
      //
      // 代价：白付约 250 B schema / 每轮请求，且模型可能误试一次（白烧一轮）。
      // 收益：把「队友不能派队友」从**运行时拒绝**变成**结构上没有这个工具**。
      //
      // 为什么只能在这里做（投递层）：
      //   · `restrict()` 只动继承来的工具面，本层注册的名字摘不掉（已实测）；
      //   · 这就是本瀑布存在的理由 —— 它改的正是**送进请求的最终列表**。
      //
      // ⚠️⚠️ 判据是「**这个 agent 是不是 Team 的队友**」，不是「它继承哪个 preset」。
      //
      //   第一版用的是 `isDelegatedChild && ownerPresetId === presetId`（继承黑猪
      //   preset 的子会话）。那个判据**当前**恰好正确，但依赖一个宿主隐含前提：
      //   `spawnTeammate()` 不传 `agentPreset`，所以队友必然继承父 preset。一旦宿主
      //   允许「派出指定 preset 的队友」，那个队友就会带着 spawn_teammate 溜过去。
      //
      //   现在改用宿主的**权威判据**：`agentTeams.tryMembership(agent)`（公开方法，
      //   不抛错版，非队员返回 undefined），返回 `role: 'lead' | 'teammate'`。
      //   这正是宿主自己在 `spawnAdmitted` 里用的那一个 —— 同一份事实、同一个来源。
      //
      //   为什么不直接用 `ownerPresetId`（仍保留它的用途）：那个回答的是
      //   「谁的人格该生效」，不是「谁能派队友」。两个问题不该共用一个判据。
      const membership = teamMembershipOf(ctx, agent)
      if (membership !== undefined) {
        // 大脑（role: 'lead'）：**必须保留** spawn_teammate —— 只有它能派队友。
        // 大脑的其余收窄由下方原有的 keep/deny 逻辑处理（本分支只管队友）。
        if (membership.role !== 'teammate') {
          // 继续往下走原有的大脑收窄路径。
        } else {
          // 队友：只摘 spawn_teammate，其余全留。
          // 用单独的窄数组而不是复用 `isCoordinatorTool` —— 队友该有 write/pwsh/shell，
          // 那些正是他们干活的工具，绝不能碰。
          const tools = Array.isArray(decision.tools) ? decision.tools : Array.isArray(assembly?.tools) ? assembly.tools : undefined
          if (Array.isArray(tools) && tools.some((tool) => tool?.name === TEAMMATE_FORBIDDEN_TOOL)) {
            const kept = tools.filter((tool) => tool?.name !== TEAMMATE_FORBIDDEN_TOOL)
            // 下限保护：绝不允许裁成空（理论上不可能，但守住 guard 的同一条规矩）。
            if (kept.length > 0) {
              ctx.logger?.info?.(
                `blackpig-guard: a teammate's request dropped the "${TEAMMATE_FORBIDDEN_TOOL}" schema ` +
                  `(team=${String(membership.name)}; a teammate can never spawn teammates)`,
              )
              return { ...decision, tools: kept }
            }
          }
          return decision
        }
      } else if (isDelegatedChild(agent)) {
        // 不是 Team 成员的子会话 = 代理（standard preset 等）：完整工具面，不裁。
        // 代理本来就没有 spawn_teammate / team_task_*（它们的 preset 里没装团队工具），
        // 这里只是保持「代理工具面不受黑猪 guard 影响」这条既有契约。
        return decision
      }

      // 大脑（root，本 preset）：走原有收窄。

      // 只裁属于本 preset 的会话（切走的会话要立刻恢复全量，不能静默少工具）。
      const owner = ownerPresetId(ctx, agent, warn)
      if (owner !== presetId) return decision

      const tools = Array.isArray(decision.tools) ? decision.tools : Array.isArray(assembly?.tools) ? assembly.tools : undefined
      if (!Array.isArray(tools)) return decision

      const kept = tools.filter((tool) => {
        const name = tool?.name
        if (typeof name !== 'string' || name === '') return true
        // run_code 是 PTC 保留传输名，永不在白名单里但也不能裁（执行层会拒），
        // 所以 `isCoordinatorTool` 已经把它特判为 false —— 这里必须再放行一次。
        if (name === 'run_code') return true
        // ⚠️ 与 `deny` 计算、执行层 guard **同源**：三处都走 `isCoordinatorTool`。
        return isCoordinatorTool(name)
      })

      // **下限保护**：绝不允许把工具数组裁成空。
      //
      // 独立审计实测：`assembly.tools = [{pwsh}, {write}]` 时原实现返回 `[]` ——
      // 那次请求模型**一个工具都没有**（连 ask_user_question / send_message 都没），
      // 整轮瘫痪且没有告警。触发条件现实存在：插件重载、preset 切换中途的瞬时状态。
      // 宁可这一轮少裁几个，也不能让协调者变成哑巴。
      if (kept.length === 0) {
        ctx.logger?.error?.(
          'blackpig-guard: the delivery-layer trim would have emptied the tool list ' +
            `(${tools.length} tool(s) all outside the keep-set) — keeping the original list for this request`,
        )
        return decision
      }

      if (kept.length === tools.length) return decision

      // ⚠️ 兜底生效了 —— 说明主路径（restrict 视图层）这次没挡住。
      // 这条日志是**诊断信号**，不是常规信息：正常情况下永远不该出现。
      ctx.logger?.info?.(
        `blackpig-guard: delivery-layer trim dropped ${tools.length - kept.length} tool schema(s) from this request (assembly.tools ${tools.length} → ${kept.length})`,
      )
      warn(
        'the delivery-layer trim (system-prompt/assemble) had to remove tool schemas from a request. ' +
          'That layer is only a FALLBACK: the host documents that listeners must not add or remove tools there, ' +
          'so a downstream listener may silently override it. The primary paths are tools.restrict() and ' +
          'tools.guard() — if this message appears, check whether the restriction actually installed for that session.',
      )
      return { ...decision, tools: kept }
    },
    { prepend: true },
  )

  // ⚠️ 2026-11-01：`agent/pre-step` 监听已删除。
  //
  // 它唯一的作用是把 turn 号记进 `currentTurn`，供 read/grep 的「每轮探查预算」
  // 判断要不要重置。那套预算已随 read/grep 整段删除，`currentTurn` 只写不读，
  // 这个监听成了**纯粹的空转**（每轮多一次回调、多一次 WeakMap 写）。
  //
  // 删除不影响任何现行规则：轮询闸门（polling / pollingCount）按**时间窗与次数**
  // 计，本来就不看 turn。

  // ── 切换路径：会话换了 preset 立刻重判归属 ──
  ctx.on('agent-preset/selected', (sessionId) => {
    resync(sessionId)
  })

  // ── 工具面变化：兜底重判（tools/change 无参、无 scope 过滤）──
  // 本模块自己造成的变更（restrict / disposer）会同步回声到这里，必须忽略，
  // 否则 sync 会自己触发自己。重入闸门见 `quietly` 的注释。
  ctx.on('tools/change', () => {
    if (echoing) return
    resync(undefined)
  })

  // ── 释放：agent 离开时必须卸掉限制（scope key 会被回收复用）──
  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
  })
}
