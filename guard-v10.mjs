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

/**
 * 守卫安装状态表（可观测）—— sessionId -> 状态记录。
 *
 * ── 为什么必须存在这张表 ──────────────────────────────────────────────────────
 *
 * `tools.restrict()` 在**当时还没注册的工具名**上会直接抛错（宿主
 * dsh-tools/lib/index.js 的 restrict()：
 *   const known = this.view(scope).restrictableNames;
 *   const unknown = [...allow, ...deny].filter(name => !known.has(name));
 *   if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool ...`);
 * ）。历史上「改个 deny 列表插件就不启动」就是这个抛错把插件构造带崩了。
 *
 * 修法分两层，缺一不可：
 *   ① **不再让它抛**：调用前先与 `view(scope).restrictableNames` 求交，
 *      未知名单独记 error；外层再包 try/catch 兜住宿主未来的任何变化。
 *   ② **不许假装成功**：catch 住之后「守卫没装上」这个事实必须落到一个
 *      **可读的状态**里，而不是只打一条日志就过去 —— 日志是给人看的，
 *      状态是给程序用的（启动自检、诊断脚本都从这里读）。
 *
 * ⚠️⚠️ 2026-11-06（P0-1 / P0-3）：上面「Lead 首条上下文」那条通道**不可靠**。
 * 我们往 `decision.contexts` 追加的那条带 `required: true`，但宿主在 runtime-context
 * 被抑制时只保留**通过 `systemPrompt.context()` 注册**的项（按 `contextByName` 查名），
 * 我们那条不在该表里，会被整条过滤掉 —— 所以**不靠它**。
 * 现在每一条「守卫没装上」的早退路径（读不到工具面 / restrict 与 guard 双双失败）都
 *   · 写 `GUARD_INSTALL_STATUS`（`guardInstallStatus()` 可读），且
 *   · `logger.error` 一条带 **session id + agent id** 的日志。
 * 日志是不受上下文抑制影响的主通道；注入只是「没被抑制时」的额外提醒。
 *
 * 键用 sessionId（`agent.session.id ?? agent.id`），因为 resync 广播只带 id。
 * 用模块级 Map 而不是闭包内 Map：同一个进程里可能有多个 preset scope 各自
 * apply 一次，但「这个会话的守卫到底装上没有」是全局事实，不该按 apply 作用域
 * 分裂成几份互相看不见的副本。
 */
const GUARD_INSTALL_STATUS = new Map()

/** 一次守卫安装的结局分类。 */
export const GUARD_STATE_ENGAGED = 'engaged'
export const GUARD_STATE_DEGRADED = 'degraded'
export const GUARD_STATE_UNPROTECTED = 'unprotected'

/**
 * 读一个会话的守卫安装状态（深拷贝，调用方改不坏内部记录）。
 *
 * 供启动自检与诊断使用：`state !== 'engaged'` 就意味着该会话的隐藏层
 * **没有确认生效**，必须当作「无约束」对待。
 *
 * @param sessionId - 会话 id；缺省则返回整表快照。
 * @returns 单条记录或 { [sessionId]: record }。
 */
export function guardInstallStatus(sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    const record = GUARD_INSTALL_STATUS.get(sessionId)
    return record === undefined ? undefined : { ...record, deny: [...record.deny], unknownNames: [...record.unknownNames] }
  }
  const all = {}
  for (const [key, record] of GUARD_INSTALL_STATUS) {
    all[key] = { ...record, deny: [...record.deny], unknownNames: [...record.unknownNames] }
  }
  return all
}

/**
 * 写一条守卫安装状态（只由 sync 调用）。
 *
 * ⚠️ 2026-11-07 修（R17，BUG-2）：原来取不到 sessionId 时**静默 return**，调用方却
 * 在日志里写「Status recorded as ...」—— 状态表其实是空的，启动自检 / 首条上下文
 * 注入全都读不到，日志与实际相反。现在返回**是否真的写进去了**，调用方据此选文案，
 * 绝不宣称「已记录」一件没发生的事。安全取向不变：该会话仍按 unconstrained 对待。
 *
 * @param sessionId - 会话 id。
 * @param record - 状态记录。
 * @returns {boolean} true = 已写入状态表；false = 没有 session id，什么都没记。
 */
function recordGuardInstallStatus(sessionId, record) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  GUARD_INSTALL_STATUS.set(sessionId, record)
  return true
}

/**
 * 从 agent scope 读 `restrictableNames`（`restrict()` 校验名字时用的同一个集合）。
 *
 * 为什么不用别的来源：`view(scope).restrictableNames` 是**未经过滤**的完整继承集
 * （全局层 + 祖先层，不含本层），与 restrict() 内部校验逐字一致 —— 拿它求交，
 * 提交上去的名字就不可能触发 unknown 抛错。
 *
 * @param tools - agent.ctx.tools。
 * @param agent - 目标 agent（作为 view 的 scope）。
 * @returns Set<string> 或 undefined（当前版本没有这条路）。
 */
function restrictableNamesOf(tools, agent) {
  if (tools === undefined || tools === null || typeof tools.view !== 'function') return undefined
  let view
  try {
    view = tools.view(agent)
  } catch (error) {
    ctxSafeError(`reading tools.view(scope) threw: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const names = view?.restrictableNames
  if (names === undefined || names === null || typeof names[Symbol.iterator] !== 'function') return undefined
  const set = new Set()
  for (const name of names) {
    if (typeof name === 'string' && name !== '') set.add(name)
  }
  return set
}

/**
 * 在没有 ctx 的辅助函数里记 error（restrictableNamesOf 这类纯函数用）。
 *
 * 只写 console：这些函数可能在任何 ctx 之外被调用（启动自检、单测）。
 * 真实安装路径上的错误由调用方带 ctx.logger 再记一遍完整上下文。
 *
 * @param message - 完整消息。
 */
function ctxSafeError(message) {
  try {
    console.error(`blackpig-guard: ${message}`)
  } catch {
    // 不允许抛。
  }
}

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
  // 插件行顺序不影响工具面：旧版曾有「排后面会被静默剔掉」的机制，已随
  // pruneAbsentTeamTools() 改为只观察、不改 keep 而作废（见 cordis.patch.yml 更正段）。
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
  // `exit_plan_mode` is registered conditionally by dsh-plan-mode (only once plan mode
  // has been entered). Keeping it in the retain set does not make it appear — it only
  // prevents the guard from trimming it away in the steps where it IS registered.
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
// exit_plan_mode stays here even though it is conditionally registered: harmless today,
// and correct again if a future DSH registers it unconditionally.
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
      // 高位代理：其后紧跟低位代理时合成一个 4 字节码点；**孤立**高位代理由
      // `Buffer.from(str, 'utf8')` 编码成 3 字节 U+FFFD —— 不能记 4 字节。
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      bytes += next >= 0xdc00 && next <= 0xdfff ? 4 : 3
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // ⚠️⚠️ 2026-11-07 修（R11，BUG-2）：原来这里记 **0 字节**（以为字节数已由前一个
      // 高位代理计入）。可**孤立**低位代理由 `Buffer.from(str, 'utf8')` 编码成 3 字节
      // U+FFFD，于是 `cum[i]` 不再是真实字节偏移，`assembleTrim` 拿 `cum` 定位头尾
      // 就会切错（实测 120/40 预算产出 120/43 字节）。这里按 Buffer 的真实编码记 3 字节。
      // 可证伪判据：`byteOffsets('\uDC00abc')` 必须是 `[0,3,4,5,6]`（Buffer 为 6 字节）。
      // 注意：**成对**的低位代理字节数已由前一个高位代理计入，这里必须记 0；
      // 只有前面不是高位代理的**孤立**低位代理才记 3。
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0
      bytes += prev >= 0xd800 && prev <= 0xdbff ? 0 : 3
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
  // R11（BUG-1）：把两个切点的字节偏移一并带出，供调用方做**切点邻域**的 U+FFFD 检查
  // （不再扫输出全文 —— 扫全文会命中源文本自带的 U+FFFD）。
  return {
    text: out,
    chars: out.length,
    bytes: Buffer.byteLength(out, 'utf8'),
    headEndBytes: headBytes,
    tailStartBytes: tailBytesStart,
  }
}

/** 与 `cum` 配套的字符总数（`cum` 长度 − 1）。 */
function bufChars(cum) {
  return cum.length - 1
}

/**
 * ⚠️⚠️ 2026-11-07 修（R11，BUG-1）：判断**这次裁剪本身**是否在切点上切坏了字符。
 *
 * 原判据是 `out.text.includes('\uFFFD')` —— 扫**输出全文**。源文本自带 U+FFFD 时
 * （GBK/无效 UTF-8 有损解码、JSON 里的 `\ufffd`、上游 spill 已插的替换符）必然命中，
 * 于是整块放弃裁剪、原文放行，**硬顶被绕过**（实测 600001 字符、首字符 U+FFFD，
 * cap=52000 与 cap=200000 均 skipped）。而且文案把原因错报成「边界计算错误」。
 *
 * 现在只看**切点**本身，两条判据都不关心源文本里原本有没有替换符：
 *   · 切点字节若落在 UTF-8 续字节（`10xxxxxx`）上 → 真的切进了字符中间；
 *   · 被保留的字节解码后重新编码必须逐字节相等 → 解码没有丢字节/补替换符。
 *
 * 正常源文本（含自带 U+FFFD）两条都不成立，因此不再跳过、硬顶照常生效。
 *
 * @param buf - 原文 UTF-8 字节。
 * @param out - `assembleTrim` 的返回值（含 headEndBytes / tailStartBytes）。
 * @returns 这次的切点是否真的切坏了字符。
 */
function cutIntroducesReplacement(buf, out) {
  const headEnd = out.headEndBytes
  const tailStart = out.tailStartBytes
  const usedTail = headEnd < tailStart
  for (const at of usedTail ? [headEnd, tailStart] : [headEnd]) {
    if (at > 0 && at < buf.length && (buf[at] & 0xc0) === 0x80) return true
  }
  const keptBytes = usedTail
    ? Buffer.concat([buf.subarray(0, headEnd), buf.subarray(tailStart)])
    : buf.subarray(0, headEnd)
  const roundTrip = Buffer.from(keptBytes.toString('utf8'), 'utf8')
  return !roundTrip.equals(keptBytes)
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

  // ⚠️⚠️ 2026-11-07 修（R13，BUG-1）：混合内容**仍然不删块**，但**不能再跳过硬顶**。
  //
  // 上一版是 `if (hasNonText) return { skipped: ... }`。调用方拿到 skipped 只记一条
  // error 就 `return decision` —— **原文整块放行**。实测
  // `[{text:'a'*900000},{type:'image'}]`：0 字符被裁，900k 字符全量进上下文，
  // 硬顶对「含一个 image 块的大结果」完全失效（日志还看起来处理过了）。
  //
  // 现在的取向：
  //   · **只裁纯文本块，非文本块原位原样不动**（绝不删除、绝不移动 image 等块）；
  //   · 裁完仍超硬顶（或说明本身装不下）→ 退化为「保留非文本块 + 极短文本 +
  //     明确说明」，并**保证文本总量 ≤ maxChars**（字符量纲，与本模块一致）；
  //   · **绝不**再走「skipped → 原样放行全文」。
  // 正常路径（无超顶）与纯文本超顶路径都不经过这里，输出逐字节不变。
  if (hasNonText) {
    const textIndexes = []
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i]
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') textIndexes.push(i)
    }
    if (textIndexes.length === 0) return { skipped: '结果里没有可裁剪的文本块' }

    const mixedJoined = textIndexes.map((i) => content[i].text).join('')
    const mixedSpillHandled = looksSpilled(mixedJoined)
    const limit = Math.max(0, Math.floor(maxChars))
    const mixedNotice = buildTrimNotice(toolName, total, maxChars, mixedSpillHandled, teamMode)

    // 只取安全前缀：退掉被切开的**高位代理**，不新造替换符。
    const safePrefix = (text, count) => {
      let out = text.slice(0, Math.max(0, Math.floor(count)))
      if (out.length > 0) {
        const last = out.charCodeAt(out.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
      }
      return out
    }
    // 只取安全后缀：切点落在**低位代理**上时右移一位（宁可少留一个 code unit）。
    const safeSuffix = (text, count) => {
      let start = Math.max(0, text.length - Math.max(0, Math.floor(count)))
      if (start > 0 && start < text.length) {
        const unit = text.charCodeAt(start)
        if (unit >= 0xdc00 && unit <= 0xdfff) start += 1
      }
      return text.slice(start)
    }
    // 单个文本块按 allowance 保留「头 + … + 尾」；返回长度**必 ≤ allowance**。
    const trimOne = (text, allowance) => {
      const room = Math.max(0, Math.floor(allowance))
      if (room >= text.length) return text
      const SEP = '…'
      if (room <= SEP.length) return safePrefix(text, room)
      const body = room - SEP.length
      const head = Math.ceil(body * 0.75)
      return safePrefix(text, head) + SEP + safeSuffix(text, body - head)
    }

    // 说明 + 至少 1 字符正文都装不下 → 极简兜底：文本块清空，只留一条**截断到上限**的
    // 明确说明。文本总量 = 说明长度 ≤ maxChars，非文本块全部原样保留。
    if (mixedNotice.length >= limit) {
      const brief = safePrefix(
        `[blackpig-guard] 该 ${toolName} 结果共 ${total} 字符，超过 ${limit} 字符上限；` +
          '正文已省略，非文本块（如图片）原样保留。',
        limit,
      )
      const keptBlocks = content.map((block) =>
        block !== null && typeof block === 'object' && typeof block.text === 'string' ? { ...block, text: '' } : block,
      )
      keptBlocks.push({ type: 'text', text: brief })
      return {
        content: keptBlocks,
        originalChars: total,
        originalBytes: totalBytes,
        keptChars: brief.length,
        keptBytes: Buffer.byteLength(brief, 'utf8'),
        spillHandled: mixedSpillHandled,
      }
    }

    // 正文预算 = 上限 − 说明；按各文本块长度**按比例**分配（先到先得、剩余预算顺延），
    // 逐块只保留头尾。按**实际拼接长度**记账，因此总保留字符数必然 ≤ 预算。
    const bodyBudgetMixed = limit - mixedNotice.length
    const trimmedTexts = []
    let budgetLeft = bodyBudgetMixed
    let charsLeft = total
    for (const index of textIndexes) {
      const text = content[index].text
      const allowance = charsLeft > 0 ? Math.min(text.length, Math.floor((text.length * budgetLeft) / charsLeft)) : 0
      const trimmed = trimOne(text, allowance)
      trimmedTexts.push(trimmed)
      budgetLeft -= trimmed.length
      charsLeft -= text.length
    }

    let cursor = 0
    let keptChars = mixedNotice.length
    let keptBytes = Buffer.byteLength(mixedNotice, 'utf8')
    const keptBlocks = content.map((block) => {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') {
        const text = trimmedTexts[cursor]
        cursor += 1
        keptChars += text.length
        keptBytes += Buffer.byteLength(text, 'utf8')
        return text === block.text ? block : { ...block, text }
      }
      // 非文本块（image 等）**原位原样**保留，绝不删除、绝不移动。
      return block
    })
    keptBlocks.push({ type: 'text', text: mixedNotice })
    return {
      content: keptBlocks,
      originalChars: total,
      originalBytes: totalBytes,
      keptChars,
      keptBytes,
      spillHandled: mixedSpillHandled,
    }
  }

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

  // 正文预算 = 上限 − 说明。核算之后**不再反悔**：只允许裁得更狠，不允许放行原文。
  //
  // ⚠️⚠️ 2026-11-07 修（R10，#4）：原来写死 Math.max(64, …) 并以 <= 64 才放弃，
  // 把「说明 + 最小正文」真正装不下的判据误扩大到所有 budget <= 64 的中等 cap：
  // · maxChars=250、说明约 200 字符时明明装得下（正文预算约 50），却被判「塞不进」；
  // · maxChars=1 时 bodyBudget 被抬到 64，同样走进「整块放行原文」。
  // 现在按实际装配预算判定：说明 + 头/尾各至少 1 字符（MIN_BODY_CHARS = 2）装得下
  // 就正常裁；只有真的装不下才走极简兜底。
  // 注意：极简兜底也绝不把原文整块放行 —— 那会突破硬顶（短 cap 下尤其明显）。
  // 它按 maxChars 只取头尾、不塞说明，保证 out.chars <= maxChars；正常 cap 仍走原路径。
  const MIN_BODY_CHARS = 2
  const bodyBudget = maxChars - noticeChars
  if (bodyBudget < MIN_BODY_CHARS) {
    // 说明无论如何塞不进去。仍必须守住硬顶：只保留头尾（各取若干字符），不附说明。
    const tinyBudget = Math.max(0, Math.floor(maxChars))
    if (tinyBudget < 1) {
      return {
        skipped: `兜底上限 ${maxChars} 字符连一个字符都放不下，本次不做替换（原文超出硬顶 ${totalChars - maxChars} 字符）`,
        spillHandled,
      }
    }
    // maxChars 是 UTF-16 字符量纲：直接按 code unit 切，并退掉可能被切开的高位代理。
    let tinyText = joined.slice(0, tinyBudget)
    const lastUnit = tinyText.length > 0 ? tinyText.charCodeAt(tinyText.length - 1) : 0
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) tinyText = tinyText.slice(0, -1)
    // 注意：极端 cap（如 1）撞上开头是一个代理对（emoji）时，tinyText 可能为空 ——
    // 那也**不是**放弃的理由：放弃会让调用方原样放行全文，反而突破硬顶。
    // 此时返回空正文（长度 0 <= maxChars），宁可这一条什么都没留下，也不越过上限。
    // ⚠️⚠️ 2026-11-07 修（R11，BUG-1 同病）：这里原来还有 `|| tinyText.includes('\uFFFD')`。
    // 那判据扫的是**整段极简正文**而不是切点：源文本自带 U+FFFD（GBK/无效 UTF-8 有损解码、
    // JSON 里的 `\ufffd`、上游 spill 已插的替换符）必然命中 → 直接放弃极简裁剪、原文放行，
    // 短 cap（1/2/5/10/64/100/250）下的硬顶被整块绕过。
    // 极简裁剪只按 code unit 取前缀、并退掉被切开的高位代理，**不会**新造替换符；源自带的
    // U+FFFD 是数据本身的形状，不是「边界计算错误」，不能当放弃理由。现在只保留「没变小」。
    if (tinyText.length >= totalChars) {
      return {
        skipped:
          `裁剪说明本身就有 ${noticeChars} 字符，连 ${maxChars} 字符的兜底上限都装不下；` +
          '且极简裁剪也无法满足硬顶/变小不变量，本次不做替换',
        spillHandled,
      }
    }
    return {
      content: [{ type: 'text', text: tinyText }],
      originalChars: total,
      originalBytes: totalBytes,
      keptChars: tinyText.length,
      keptBytes: Buffer.byteLength(tinyText, 'utf8'),
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
    // ⚠️ R10 #4（同类固定下限）：二分下界原来写死 128。bodyBudget 较小时
    // （例如 maxChars=250、说明约 200 → 预算约 50），搜索区间 [128, 50] 为空，
    // best=127 < 128 直接判失败。这里把下界收敛：正常 cap（bodyBudget >= 128）
    // 仍是 128，输出逐字节不变；小 cap 从 MIN_BODY_CHARS 起真正开始收紧。
    const searchFloor = bodyBudget >= 128 ? 128 : MIN_BODY_CHARS
    const best = largestMonotonic(searchFloor, bodyBudget, (b) => {
      const probe = split(b)
      return assembleTrim(buf, cum, notice, probe.head, probe.tail).chars <= maxChars
    })
    if (best < searchFloor) {
      return {
        skipped:
          `把正文压到 ${searchFloor} 字符预算仍然超过 ${maxChars} 字符上限（说明文字占 ${noticeChars} 字符）`,
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
  // ⚠️⚠️ 2026-11-07 修（R11，BUG-1）：原来这里是 `out.text.includes('\uFFFD')`，
  // 扫的是**输出全文** —— 源文本自带 U+FFFD 时必然命中，整块放弃裁剪、原文放行，
  // 硬顶被绕过，文案还把原因错报成「边界计算错误」。现在只查切点（见
  // cutIntroducesReplacement）：源自带的 U+FFFD 照常裁，只有真把字符切开才处理。
  //
  // 真的切坏了也不能整块放行（那等于突破硬顶）：先换更短的安全切点重试，再退到
  // 「只留头部合法前缀」。只有连一个字符都放不下时才返回 skipped。
  if (cutIntroducesReplacement(buf, out)) {
    let safe = null
    for (let probe = Math.floor(budget / 2); probe >= MIN_BODY_CHARS; probe = Math.floor(probe / 2)) {
      const part = split(probe)
      const cand = assembleTrim(buf, cum, notice, part.head, part.tail)
      if (cand.chars <= maxChars && !cutIntroducesReplacement(buf, cand)) {
        safe = cand
        break
      }
    }
    if (safe === null) {
      // 最后一道：只保留头部合法前缀。`sliceCharsUtf8` 只会把切点退到字符边界，
      // 因此这条路径**不需要**再问切点判定 —— 也绝不能在这里回头 skip（skip 会让调用方
      // 原样放行全文，硬顶照样被突破）。宁可这条结果只剩一个短前缀，也不越过上限。
      const headOnly = Math.max(0, Math.floor(maxChars) - noticeChars)
      safe = assembleTrim(buf, cum, notice, headOnly, 0)
    }
    // 兜底路径同样必须自证「不超顶」：`cum` 在代理对中间的取值会落到整字符之后，
    // 头部按字符预算切出来可能比预算多 1 个 code unit。这里退到极简前缀（不附说明），
    // 与 `bodyBudget` 不足时的极简路径同口径 —— 绝不把这一步变成新的超顶通道。
    if (safe.chars > maxChars) {
      let prefix = joined.slice(0, Math.max(0, Math.floor(maxChars)))
      const lastUnit = prefix.length > 0 ? prefix.charCodeAt(prefix.length - 1) : 0
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) prefix = prefix.slice(0, -1)
      safe = {
        text: prefix,
        chars: prefix.length,
        bytes: Buffer.byteLength(prefix, 'utf8'),
        headEndBytes: 0,
        tailStartBytes: 0,
      }
    }
    out = safe
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
    // ⚠️ 2026-11-07 修（R9，#5）：原来是 `{ ...next, additionalContexts: extra }` ——
    // 只搬 additionalContexts，**上游 decision 的其余自有字段全部丢掉**。上游 accept 若还带
    // 第三个自有字段（别的插件挂在 decision 上的元信息），裁剪一次就静默消失。
    //
    // 现在反过来：以**上游 decision 为底**，只覆盖本模块真正动过的两把键 ——
    // `content`（裁过的正文）与 `kind`（沿用 next 的结论）。`additionalContexts` 随展开
    // 原样保留（`extra` 本来就是上游那个数组的引用），无需再写一遍。
    // 无额外 contexts 时仍原样返回 `next`，正常路径逐字节不变。
    return { ...upstream, kind: next.kind, content: next.content }
  }
  return next
}

/**
 * 一个**按作用域**只警告一次的记录器。
 *
 * ⚠️ 2026-11-07 修（R17，BUG-1）：去重键原来只有**整条消息串**，没有 agent 作用域。
 * 两个会话同因失败时消息文本一样 → 只留 1 条日志，第二个受害会话的失败被整条吞掉，
 * 而且那条 warn 也读不出受害者是谁。subtalk（R15）/ member-persona（R13b2）已修过
 * 同一个 bug，guard 这里补齐：
 *   · `scopeKey` 给定时（agent 相关告警传 `agentScopeKeyOf(agent)`），不同 agent 各一条；
 *   · `scopeKey` 缺省时（配置类 / 全局告警），行为与改前逐字节一致。
 * 同一个 agent 的重复故障仍只记一条，不会刷屏。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message, scopeKey) => {
    const key =
      scopeKey === undefined || scopeKey === null || scopeKey === ''
        ? message
        : `${scopeKey}\u0000${message}`
    if (seen.has(key)) return
    seen.add(key)
    try {
      ctx.logger?.warn?.(`blackpig-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 稳定的「这一个 agent」标识，用作 warnOnce 的去重作用域。
 *
 * 优先 `agent.session.id`（同一会话在整个生命周期里唯一），取不到再退 `agent.id`，
 * 都没有才回落到一个**不可能撞上真 id** 的占位串 —— 那种情况下宁可多记一条，
 * 也不要因为得到 `undefined` 把互不相干的 agent 合并进同一个桶。
 *
 * @param agent - 目标 agent。
 * @returns 非空字符串。
 */
function agentScopeKeyOf(agent) {
  try {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return `session:${sessionId}`
  } catch {
    // 读 session.id 抛错，继续试 agent.id。
  }
  try {
    const agentId = agent?.id
    if (typeof agentId === 'string' && agentId !== '') return `agent:${agentId}`
  } catch {
    // 连 agent.id 都读不出：只能退到占位串。
  }
  return 'agent:?'
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
      `could not read which preset an agent is composed with (scope=${agentScopeKeyOf(agent)}); falling back to the preset recorded when its session was created (the live binding is the authority)`,
      agentScopeKeyOf(agent),
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

  /**
   * 日志统一出口（2026-11-07 修 R6，B-5）。
   *
   * 本文件已经论证过「logger 可能恒抛」（见 warnOnceFactory 与 system-prompt 注入那两处），
   * 但此前只有那两处包了 try —— 其余调用点一旦 logger 抛错，会从 waterfall / 事件监听器
   * 里逃出去；更严重的是 `sync()` 里任何一条日志抛错都会在 `restrict()` / `guard()`
   * 安装**之前**中断 sync，留下 fail-open 且没有任何东西能记下来。
   *
   * 所以全文件的 `ctx.logger` 调用统一走这两个 helper：日志内容与触发时机不变，
   * 只保证日志失败绝不改变业务结论，也绝不打断 restrict/guard 的安装。
   */
  const logError = (message) => {
    try {
      ctx.logger?.error?.(message)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
  const logInfo = (message) => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      // 同上：日志失败不得影响业务结论。
    }
  }

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
    // ⚠️⚠️ 2026-11-07 修（R18a，BUG-1）：两次读取各自兜错，**绝不抛出**。
    // `session.id` 可能是 throwing getter（会话半拆 / 宿主实现变化），旧实现把两次读取
    // 放在同一个 `??` 表达式里 —— 第一段一抛，整个 sync() 就在装 restrict/guard **之前**
    // 中断，被 agent/created 的外层 catch 吞成一条 "NOT narrowed"，保护完全没装。
    // 与 `agentScopeKeyOf` / `statusKeysFor` / `resync` 同口径：抛错只影响这一个来源。
    let id
    try {
      id = agent?.session?.id
    } catch {
      // session.id 读不到 → 退到 agent.id（下面统一判空）。
      id = undefined
    }
    if (id === undefined || id === null) {
      try {
        id = agent?.id
      } catch {
        // 两个标识都读不到：返回 undefined，由调用方按「没有 session id」处理。
        id = undefined
      }
    }
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * ⚠️ 2026-11-07 修（R6，B-1）：记下**建状态时实际用的 key**。
   *
   * 只在 disposed 时重算 `keyOf` 不够：session 被拆掉后 `keyOf` 已退到 `agent.id`，
   * 再也算不出当初那个 `session.id`。所以写状态时就把 key 记账：
   *   · 按 agent 对象（WeakMap，不延长生命周期）；
   *   · 按 agent.id（Map；disposed 时清掉，只存字符串不会悬空）。
   * 这样即使 disposed 的事件载荷是另一个对象、只剩 id 相同，也能删到真正的状态键。
   */
  const statusKeysOfAgent = new WeakMap()
  const statusKeysOfAgentId = new Map()
  const rememberStatusKey = (agent, key) => {
    if (agent === undefined || agent === null || typeof key !== 'string' || key === '') return
    const add = (map, mapKey) => {
      let keys = map.get(mapKey)
      if (keys === undefined) {
        keys = new Set()
        map.set(mapKey, keys)
      }
      keys.add(key)
    }
    try {
      add(statusKeysOfAgent, agent)
    } catch {
      // WeakMap 只接受对象；agent 不是对象时按 id 记账即可。
    }
    try {
      const agentId = agent?.id
      if (typeof agentId === 'string' && agentId !== '') add(statusKeysOfAgentId, agentId)
    } catch {
      // 取不到 agent.id 不影响写状态。
    }
  }
  /** 写状态 + 记住这次用的 key（只用于 disposed 时精确回收）。 */
  const recordStatus = (agent, sessionId, record) => {
    const recorded = recordGuardInstallStatus(sessionId, record)
    rememberStatusKey(agent, sessionId)
    return recorded
  }
  /**
   * 收集「该 agent 在状态表里可能用过的全部 key」—— 释放 / 切走时精确删除条目用。
   *
   * ⚠️ 2026-11-07（R9，优化 6）：这段候选集逻辑原先在 `sync()` 的「切走 preset」分支
   * 与 `agent/disposed` 监听里**逐字重复**了两份（各自还带着一套几乎相同的注释）。
   * 任何一侧漏改都会让状态表留下删不掉的条目 —— R6 的 B-1 就是这么来的。抽成一份，两处同源。
   *
   * 四个来源各自独立、任何一步失败都不影响其它候选：
   *   ① 建状态时记下的那把 key（`statusKeysOfAgent`；会话被拆掉后只有它还知道原键）；
   *   ② `keyOf(agent)` 自己的结果（与它的语义保持同源）；
   *   ③ `agent.session.id`（会话还在时的首选键）；
   *   ④ `agent.id`（会话被拆掉后 `keyOf` 退化到的键）+ 按 id 记账的原键。
   * 按 id 记账的原键在收集后清掉，避免 `statusKeysOfAgentId` 无界增长。
   *
   * @param agent - 目标 agent（对象键记账不延长其生命周期）。
   * @returns {Set<string>} 候选状态键；所有来源都读不到时为空集。
   */
  const statusKeysFor = (agent) => {
    const statusKeys = new Set()
    try {
      // 建状态时记下的那把 key —— session 已被拆掉时，只有它还知道原键。
      for (const remembered of statusKeysOfAgent.get(agent) ?? []) statusKeys.add(remembered)
    } catch {
      // 记账读不到不影响清理。
    }
    try {
      // `keyOf` 自己的结果也收进来：语义与它保持同源。
      const keyed = keyOf(agent)
      if (keyed !== undefined) statusKeys.add(keyed)
    } catch {
      // 取不到不影响清理，下面几个候选继续尝试。
    }
    try {
      // 候选一：`keyOf` 的首选键 —— 会话还在时就是它。
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string' && sessionId !== '') statusKeys.add(sessionId)
    } catch {
      // 读 session.id 抛错不影响清理。
    }
    try {
      // 候选二：session 被拆掉后 `keyOf` 退化到的键。
      const agentId = agent?.id
      if (typeof agentId === 'string' && agentId !== '') {
        statusKeys.add(agentId)
        // 按 id 记账的原键也要删；记账本身随后清掉，避免无界增长。
        for (const remembered of statusKeysOfAgentId.get(agentId) ?? []) statusKeys.add(remembered)
        statusKeysOfAgentId.delete(agentId)
      }
    } catch {
      // 两个候选都取不到只意味着没有状态条目可删。
    }
    return statusKeys
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
    // ⚠️⚠️ 2026-11-06（P0-1）：session key 必须在这里就取好。
    // 下面有两处「守卫没装上」的早退点（读不到工具面 / restrict 与 guard 双双失败），
    // 它们都要往 GUARD_INSTALL_STATUS 写状态、打一条带 agent id 的 error 日志。原来 key
    // 只在成功路径末尾（旧 :2187）才计算，早退点根本拿不到它 —— 于是最该报警的那次反而静默。
    const key = keyOf(agent)

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
        logInfo(
          `blackpig-guard: released the restriction for a session of another mode (${owner}); its tool roster is left untouched`,
        )
      }
      // ⚠️⚠️ 2026-11-07 修（R8，B1）：切走 preset 时也要删掉状态表里本 agent 的条目。
      // 原来 `release(agent)` 之后直接 return，已写入的 degraded / unprotected 记录会一直留着：
      // system-prompt 注入那段只读表、不校验 owner，已切回其它 preset 的会话仍会收到一次
      // 「Black Pig guard is NOT fully engaged」，guardInstallStatus() 也仍返回旧记录。
      // 删除逻辑与 agent/disposed 同源：建状态时实际用的 key（记账）+ keyOf + session.id +
      // agent.id 多候选，各自有值就都删；只删本 agent 的键，别的会话不动。
      // ⚠️ 2026-11-07（R9，优化 6）：候选键的收集抽成 `statusKeysFor(agent)`，与
      // `agent/disposed` 那段同源（原先两处逐字重复）。删除动作仍在原来的位置。
      const statusKeys = statusKeysFor(agent)
      for (const statusKey of statusKeys) GUARD_INSTALL_STATUS.delete(statusKey)
      return
    }
    if (owner === undefined) {
      // 读不出归属，但这是大脑 scope（preset 行就装在这里）→ 保持收窄。
      warn(
        `could not determine which preset this session belongs to (scope=${agentScopeKeyOf(agent)}; composedPreset unreadable and the session ` +
          'header records no agentPreset); keeping the coordinator narrowing in place (fail-closed). ' +
          'If this session is actually another mode, its tools will be over-restricted until the preset is readable.',
        agentScopeKeyOf(agent),
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
        // ⚠️⚠️ 2026-11-07 修（R10，#2）：泄漏判据必须排除「本层注册、restrict 摘不掉」的工具。
        //
        // restrictableNames 的定义是「全局层 + 祖先层，不含本层」，而 visible 是包含本层的
        // （own.tools 无条件可见）。原来直接用 !keep.has(name) 判泄漏，于是一个注册在本层、
        // 又不在 keep 里的工具永远被判成泄漏 → leaked 恒非零 → 幂等永不成立 → 每次工具调用
        // 全量重算 + 每次 info 日志，healthy 永远用不上。
        //
        // 现在只有出现在 restrictableNames（继承层）里的名字才可能是泄漏：本层工具既进不了
        // deny，也不是 restrict 失效的证据。继承层里冒出来的名字仍必须过 isCoordinatorTool
        // （keep 且非 extraDeny），不通过就是真泄漏、照旧重算 —— 幂等没有因此变弱。
        // 读不到 restrictableNames 时不做任何跳过，落到下面重算（无法证明仍然正确）。
        let restrictableNow
        try {
          restrictableNow = restrictableNamesOf(agent?.ctx?.tools, agent)
          if (restrictableNow === undefined) {
            let registry
            try {
              registry = ctx.get('tools')
            } catch {
              registry = undefined
            }
            if (registry !== undefined && registry !== null) restrictableNow = restrictableNamesOf(registry, agent)
          }
        } catch {
          restrictableNow = undefined
        }
        const leaked = restrictableNow === undefined
          ? null
          : nowVisible.filter((name) => restrictableNow.has(name) && !isCoordinatorTool(name))
        if (leaked !== null && leaked.length === 0) {
          // ⚠️ 2026-11-01：提前返回前必须刷新 teamOn。团队 6 个都在 keep 里，
          // 晚注册时 leaked 仍为 0 → 若在这里 return，teamOn 会冻结成 solo，
          // 文案说「没有队友」而工具其实都在（逆向误导，无任何报错）。
          teamOn.set(agent, teamAvailable(new Set(nowVisible)))
          // 可见面恰好等于保留集 → 限制仍然正确，无需重装（避免装/卸振荡）。
          return
        }
        if (leaked !== null) {
          logInfo(
            `blackpig-guard: the visible surface changed since the last restriction (${leaked.length} unexpected tool(s): ${leaked.slice(0, 8).join(', ')}); recomputing`,
          )
        } else {
          // 读不到 restrictableNames = 无法证明可见面仍然正确 → 落到下面重算（安全方向），
          // 且保留一条诊断，避免「每次都重算」看起来像无原因的空转。
          logInfo(
            'blackpig-guard: could not read restrictableNames to verify the visible surface; recomputing (fail-safe)',
          )
        }
      }
      // 读不到可见面时不能证明「仍然正确」，落到下面重算（安全方向）。
    }

    // 计算 deny 必须用**未过滤的完整继承集**（restrictableNames），不能用 agent 的
    // 可见集（已被过滤），也不能用全局层 schemas()（会漏掉 preset 祖先层的 pwsh/write/edit）。
    const visible = fullToolNames(ctx, agent)

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
        logInfo(
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
    // ⚠️⚠️ 2026-11-07 修（R18a，BUG-2）：判据是「**能否读到完整工具面**」，不是「可见面是否为空」。
    //
    // 旧判据 `visible.length === 0 || agentVisible.length === 0` 把两件相反的事混成一件：
    //   · 可见面被 restrict 彻底清空（`agentVisible` 为空）—— 保护**完美生效**的典型结果；
    //   · 完整工具面也读不到（`visible` 也为空）—— 真正的故障。
    // 纯 deny 面（如 ['pwsh','write','edit'] 全不在 keep）时 restrict 把可见面清得一个不剩，
    // 于是每次 resync 都落进下面那条分支：追加一条 PROTECTION NOT ENGAGED error、
    // 状态打成 degraded、healthy 恒 false —— 而限制实际一直在生效。
    //
    // 这正是本文件 R16 / BUG-1 那段 fail-closed 自检（`const fullSurface = fullToolNames(ctx, agent)`）用过的
    // 同一条判据 —— 同一件事必须用同一个口径，这里把只修一半的那半补齐。
    //
    // 判据直接用 `visible`：它就是上面 `const visible = fullToolNames(ctx, agent)` 的结果（**未过滤**
    // 的完整继承集 + 全局层），也正是上述自检里拿来当旁证的那个集合。所以：
    //   · `visible` 非空 → 完整工具面读得到 ⇒ 空的 `agentVisible` 是限制清空的，保护生效，
    //     不进故障分支（继续走下面的重算 / 安装路径）；
    //   · `visible` 为空 → 完整工具面也读不到 → 才是真「读不到」，照旧报 PROTECTION NOT ENGAGED。
    // 这里**不**重复调一次 `fullToolNames()`：与上方「简化审计发现 7」那段同一条理由 —— 两次读之间没有
    // await、没有安装动作，纯读结果必然相同，再读一次只是好几十次 schema 深拷贝。
    // 真正的保护丢失不会因此被放行：可见面非空但限制没装上时，下方的
    // PROTECTION LOST / RE-INSTALL FAILED 判据照旧生效，且下方的 fail-closed 自检还会实测。
    if (visible.length === 0) {
      // ⚠️⚠️ 2026-11-07 修（R9，#4）：判据不能用 `live.has(agent)`。
      // :2164 的 PROTECTION LOST 分支同样会 `live.set(agent, {…, healthy:false})` —— 那是
      // 一条**占位**记录（disposer / liftGuard 显式写成 undefined），只是为了让下一次 sync
      // 不走幂等跳过。`live.has` 只回答「表里有这条」，不回答「有没有真的装成过」；于是
      // 「从未装成任何一层」的会话在又一次读不到工具面时会被记成 degraded，与事实不符。
      //
      // 现在按**真实安装记录**判（看 `live` 里那条记录的三条直接证据）：
      //   · `disposer` / `liftGuard` **只**在某一层确实装上时才被写成函数（成功路径的
      //     `live.set` 写的正是它们的返回值；占位记录里它们是显式 undefined）；
      //   · `healthy === true` 只在两层都通过装完后的 fail-closed 自检时才为真。
      // 三者全不成立 = 从未装成过任何一层 → UNPROTECTED；否则 → DEGRADED（旧保护仍在）。
      const liveRecord = live.get(agent)
      const alreadyLive =
        liveRecord !== undefined &&
        liveRecord !== null &&
        (liveRecord.healthy === true ||
          typeof liveRecord.disposer === 'function' ||
          typeof liveRecord.liftGuard === 'function')
      // ⚠️⚠️ 2026-11-07 修（R16，BUG-2）：读不到工具面时**绝不能**用空数组覆盖状态。
      //
      // 旧实现写 `deny: []` / `unknownNames: []`，而 detail 自己说「PREVIOUS restriction
      // is kept in place」—— 两处互相矛盾。`live` 里那份旧限制确实还在生效
      // （disposer / liftGuard 没被碰），但状态表被改成「什么都没隐藏」，于是 system-prompt
      // 注入读到 `deny.length === 0` → 告诉模型「Hidden tools: (none submitted)」，
      // 而 pwsh / write / edit 实际仍被隐藏。那是**假信息**，不是 fail-safe 文案。
      //
      // 现在：优先沿用**实际生效**的那一份 deny（旧状态记录，其次 live 里能读到的），
      // 确实取不到时才退到空数组，并让 detail 如实说明「无法读取当前隐藏集合」。
      // 同时把原来重复的 warn(detail) + logError(PROTECTION NOT ENGAGED ...) 合并成一条：
      // 同一件事只报一次，且仍带 session id + agent id。
      const liveSnapshot = live.get(agent)
      const readPreviousList = (field) => {
        const fromStatus = key === undefined ? undefined : GUARD_INSTALL_STATUS.get(key)
        for (const candidate of [fromStatus, liveSnapshot]) {
          if (candidate === undefined || candidate === null) continue
          if (!Array.isArray(candidate[field])) continue
          return candidate[field].filter((name) => typeof name === 'string' && name !== '')
        }
        return undefined
      }
      const previousDeny = readPreviousList('deny')
      const previousUnknown = readPreviousList('unknownNames')
      const keptDeny = previousDeny ?? []
      const keptUnknown = previousUnknown ?? []
      const denyUnreadable = previousDeny === undefined
      const denyNote = previousDeny !== undefined
        ? `the previous restriction is kept in place and still hides ${keptDeny.length} tool(s)`
        : 'the current hidden set could NOT be read (no previous record), so do not assume nothing is hidden'
      const detail = alreadyLive
        ? `no tool schemas were readable on a resync; ${denyNote} (failing safe, not open)`
        : 'no tool schemas were readable for a coordinator scope; the restriction is NOT engaged for this session yet (will retry on the next tool call)'
      // ⚠️⚠️ 2026-11-06（P0-1）：这是「守卫没装上」的真实失败路径之一，必须落状态表 +
      // 一条带 agent id 的 error 日志。日志通道不会被 runtime-context 抑制（见 P0-3）。
      const state = alreadyLive ? GUARD_STATE_DEGRADED : GUARD_STATE_UNPROTECTED
      const statusRecorded = recordStatus(agent, key, {
        state,
        healthy: false,
        restrictApplied: false,
        restrictVerified: false,
        guardVerified: false,
        deny: [...keptDeny],
        unknownNames: [...keptUnknown],
        // 为 true 时下游注入必须说「无法读取」，而不是假装「没有隐藏工具」。
        denyUnreadable,
        requestedScope: `agent:${key ?? '<no-id>'}`,
        error: detail,
        at: Date.now(),
      })
      // ⚠️ 2026-11-07 修（R17，BUG-2）：只有**真的写进状态表**才说 "Status recorded"。
      // 取不到 session id 时状态表里没有这一条，日志必须如实说「未能记录」。
      logError(
        `blackpig-guard: PROTECTION NOT ENGAGED for session ${key ?? '<no-id>'} ` +
          `(agent ${agent?.id ?? '<unknown id>'}) — ${detail}. ` +
          (statusRecorded
            ? `Status recorded as "${state}"; this session must be treated as unconstrained.`
            : 'The install status could NOT be recorded (no session id was available), so guardInstallStatus() ' +
              'has no entry for this session; this session must be treated as unconstrained.'),
      )
      // ⚠️⚠️ 2026-11-07 修（R8，B2）：状态表与 live 必须同时翻成「不健康」。
      // 原来只写状态表，live 里那条仍是 healthy=true → 下次 sync 若可见面恢复且 leaked===0，
      // 会在幂等早退处直接 return（既不 recordStatus，也不重做 fail-closed 自检），
      // 于是表停在 degraded、live 说 true，永久不一致。与 :2108 同形：
      // 刻意**不**覆盖 live（保住 disposer / liftGuard 的引用），只把 healthy 打成 false，
      // 让下一次 sync 继续重试。状态值的选择逻辑不变（仍由 alreadyLive 决定）。
      const previousLive = live.get(agent)
      if (typeof previousLive === 'object' && previousLive !== null) previousLive.healthy = false
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
      warn(
        `the agent scope exposes no tools.restrict() (scope=${agentScopeKeyOf(agent)}); this session keeps the full roster`,
        agentScopeKeyOf(agent),
      )
      // 注意：restrict 不可用时仍然继续往下装 guard —— 执行层的硬拦必须尽力而为。
      // 唯一的例外是 guard 也不可用（下面会再检查）。
    }

    /**
     * 装上 restriction —— **任何情况下都不许抛**，也**不许假装成功**。
     *
     * ── 改了什么（2026-11-06，通用化改造二）────────────────────────────────────
     *
     * 旧实现是「照着错误信息点名剔除后重试一次」：先让 restrict() 抛，
     * 再用正则解析 `names unknown global tool "a", "b"` 把名字抠出来、重试。
     * 这是**依赖宿主错误文案**的耦合 —— 宿主把这句话换一种说法（加个前缀、
     * 改成列表、本地化），正则就匹配不上，整条限制直接装不上，而日志只有一条
     * 泛泛的 warn。
     *
     * 新实现是「调用前先取交集」：
     *   ① `tools.view(scope).restrictableNames` 存在 → 与 deny 求交，只提交**已知**名字；
     *      被剔掉的未知名单独记一条 **error**（列出全部名字），因为那是真实异常：
     *      我们算出的 deny 里出现了宿主说它不存在的工具。
     *   ② `view()` 或 `restrictableNames` 不存在（旧宿主 / 未来版本改名）→ 走降级路径：
     *      不提交（提交了必然抛），记 error 说明降级原因，仍返回结构化失败。
     *   ③ 整个 restrict() 包 try/catch：catch 住**任何**异常，logger.error 带
     *      scope / deny 列表 / 原始报错全部原文，然后返回结构化失败 ——
     *      绝不让插件构造失败（历史上「改个 deny 列表插件就不启动」就是它）。
     *
     * 返回值语义：
     *   · `{ dispose, applied }` —— 成功，applied 是**真正下发**的 deny 集。
     *   · `{ applied: [], error, unknownNames, scope }` —— 失败或降级；
     *     调用方据此把「守卫未安装」写进 GUARD_INSTALL_STATUS 并在上下文里提示。
     *
     * @param names - 期望下发的 deny 列表。
     * @param requestedScope - 本次限制的 scope 标识（写进诊断/错误日志）。
     * @returns {{dispose?: Function, applied: string[], error?: string, unknownNames?: string[], scope?: string}}
     */
    const restrictWith = (names, requestedScope) => {
      const scopeLabel = String(requestedScope ?? '<unknown scope>')
      const requested = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n !== '') : []

      // ⚠️⚠️ 2026-11-07 修（R10，#8）：deny 本来就为空 ≠ restrict 失败。
      //
      // 极简「纯大脑」preset 下，继承面里每个工具都在 keep/extraDeny 里 → deny = []。
      // 原来的 known.length === 0 分支把它当成「求交后没有可限制的名字」记 error + degraded
      // + 注入 NOTICE，但事实是根本没有东西需要隐藏，guard 层也完全在拦。
      // 这里先按「请求列表本身为空」识别这种正常态：不调用 restrict（空 deny 是 no-op），
      // 用 `nothingToHide` 显式标记，让下游把它当作 restrict 层的成功（状态 engaged、
      // healthy=true、不注入 NOTICE）。不用 no-op disposer 冒充已装：状态里的
      // restrictApplied 仍如实写成 false（确实没有限制在生效，因为无需生效）。
      // 只有 requested 非空、却与 restrictableNames 求交后为空时，才是真失败（见下方）。
      if (requested.length === 0) {
        logInfo(
          `blackpig-guard: nothing to withhold for scope=${scopeLabel} — every visible tool is inside the ` +
            'coordinator keep-set, so restrict() is not needed (the guard layer still applies).',
        )
        return { applied: [], unknownNames: [], scope: scopeLabel, nothingToHide: true }
      }

      // ── 降级路径：先看当前版本有没有 restrictableNames ──
      let restrictable
      try {
        restrictable = restrictableNamesOf(tools, agent)
      } catch (error) {
        restrictable = undefined
        logError(
          `blackpig-guard: reading restrictableNames threw for scope=${scopeLabel} ` +
            `(${error instanceof Error ? error.stack ?? error.message : String(error)}); falling back to the degraded ` +
            'path — the restriction is NOT installed for this session and the coordinator keeps the full roster.',
        )
      }
      if (restrictable === undefined) {
        const message =
          `tools.view(scope).restrictableNames is unavailable on this host, so the deny list cannot be ` +
          `validated before submission; scope=${scopeLabel}, ${requested.length} name(s) withheld from restrict(): ` +
          `${requested.slice(0, 40).join(', ') || '(none)'}`
        logError(
          `blackpig-guard: ${message}. DEGRADED PATH: the restriction was NOT submitted (submitting unvalidated ` +
            'names would throw on hosts that validate them). The hard-deny guard is still installed as the last line.',
        )
        return { applied: [], error: message, unknownNames: [], scope: scopeLabel, degraded: true }
      }

      // ── 主路径：先求交，再提交 ──
      const unknown = requested.filter((name) => !restrictable.has(name))
      const known = requested.filter((name) => restrictable.has(name))
      if (unknown.length > 0) {
        // 这是**真实异常**：deny 是从「可见集 − 保留集」算出来的，宿主却说这些名字
        // 不在可限制集合里。要么可见集读错了，要么宿主的集合语义变了 —— 两种都要查。
        logError(
          `blackpig-guard: ${unknown.length} name(s) in the computed deny list are NOT restrictable on this host ` +
            `and were dropped BEFORE calling restrict() — scope=${scopeLabel}; unknown: [${unknown.sort().join(', ')}]; ` +
            `${known.length} known name(s) still submitted. ` +
            'This is not routine: deny is computed from the visible surface, so an unknown name means the visible ' +
            'set and restrictableNames disagree (host API change, or a listener registered/removed tools mid-sync).',
        )
      }

      // ⚠️ R10 #8：能走到这里说明 requested 非空 —— 求交后为空才是
      // 「预期要隐藏但一个都藏不成」的真失败，照旧报 error / degraded。
      if (known.length === 0) {
        const message =
          `no restrictable names left after intersecting with restrictableNames; scope=${scopeLabel}, ` +
          `requested=${requested.length}, unknown=${unknown.length}`
        logError(
          `blackpig-guard: ${message} — restrict() was NOT called (an empty deny is a no-op and would hide the ` +
            'failure). The hard-deny guard is still installed as the last line.',
        )
        return { applied: [], error: message, unknownNames: unknown, scope: scopeLabel }
      }

      // restrict 与它的 disposer 都同步发 tools/change，必须吞回声。
      return quietly(() => {
        try {
          const dispose = tools.restrict({ deny: known })
          return { dispose, applied: known, unknownNames: unknown, scope: scopeLabel }
        } catch (error) {
          // ⚠️ 这里**兜住一切**：插件构造绝不能因为宿主校验变严而失败。
          // 但也绝不当成功 —— 返回 error，由调用方写进 GUARD_INSTALL_STATUS。
          const message = error instanceof Error ? error.message : String(error)
          const stack = error instanceof Error ? (error.stack ?? '') : ''
          logError(
            `blackpig-guard: tools.restrict() threw even though every submitted name was present in ` +
              `restrictableNames — scope=${scopeLabel}; deny=[${known.join(', ')}]; unknown=[${unknown.join(', ')}]; ` +
              `raw error: ${message}` +
              (stack !== '' ? `\n${stack}` : ''),
          )
          return { applied: [], error: message, unknownNames: unknown, scope: scopeLabel }
        }
      })
    }

    // `tools.restrict` 不可用时（旧宿主 / 该 scope 没暴露）跳过隐藏层，
    // 但**必须继续装 guard** —— 执行层硬拦是最后一道防线，不能因为隐藏层缺失就不装。
    // ⚠️ R10 #8 的同类：`deny` 为空时「没有东西可隐藏」与「restrict API 不可用」是两件事。
    // 前者即使宿主没暴露 restrict 也是正常态（空 deny 本来就不需要调用它），不能记失败。
    const restrictScope = `agent:${keyOf(agent) ?? '<no-id>'}`
    const attempt = typeof tools?.restrict === 'function'
      ? restrictWith(deny, restrictScope)
      : deny.length === 0
        ? { applied: [], unknownNames: [], scope: restrictScope, nothingToHide: true }
        : {
            applied: [],
            error: 'tools.restrict() is not available on this agent scope',
            unknownNames: [],
            scope: restrictScope,
          }
    if (attempt.error !== undefined) {
      warn(
        `engaging the restriction failed (scope=${agentScopeKeyOf(agent)}): ${attempt.error} — falling back to the hard-deny guard only`,
        agentScopeKeyOf(agent),
      )
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
        warn(
          `installing the hard-deny guard failed (scope=${agentScopeKeyOf(agent)}): ${error instanceof Error ? error.message : String(error)}`,
          agentScopeKeyOf(agent),
        )
      }
    }

    // ⚠️⚠️ 2026-11-07 修（R14，BUG-2）：判「保护是否真的丢失」必须考虑**配置意图**。
    //
    // 旧判据是「restrict 没 disposer + guard 没装上 + withheld 为空」三者同时成立。
    // `hardDeny:false` + 可视面全在 keep 内（deny 为空、nothingToHide）时三者天然全空 ——
    // 但那是**正常态**：没有东西可隐藏，restrict 本就不该调用；执行层又是配置显式关掉的。
    // 旧判据于是把它误判成 PROTECTION LOST、写 unprotected、healthy 恒 false，
    // 每次 post-execute 都全量重装并重复报 error（与 :2638 起「hardDeny:false 时
    // restrict 层通过即健康」的契约直接矛盾）。
    //
    // 新判据按「本应装而没装上」判丢失：
    //   · restrict 层只为「有东西要隐藏」（deny 非空）而装；deny 为空 → 不要求它；
    //   · guard 层只为 `hardDeny:true` 而装；`hardDeny:false` → 不要求它；
    //   · 两层都不在位、且至少有一层本应装 → 才是真的没有任何保护的 PROTECTION LOST。
    // 反面情形仍会告警：`hardDeny:true` 且 guard 没装上、同时 restrict 也没装（或无可隐藏）
    // 时走本分支；只有其中一层真正装上时，走下面 :2520 起的 fail-closed 分档报错。
    const restrictProtectionEngaged = attempt.dispose !== undefined
    const guardProtectionEngaged = liftGuard !== undefined
    // ⚠️⚠️ 2026-11-07 修（R17，BUG-3）：`deny` 为空是「本来就没东西要隐藏」的正常态，
    // 不能因为它没有 disposer 就当成保护丢失。R14 只修了 `hardDeny:false` 那一半；
    // `hardDeny:true` + roster 全在 keep 内 + `guard()` 缺失/抛错时，旧判据仍会喊
    // "see and execute every tool" —— 那是**假失败**。现在把「有没有可隐藏的东西」
    // 与「执行层本应装却没装」分开判：
    //   · 有东西要隐藏、两层都没装上 → 仍是真正的 PROTECTION LOST（下方原分支，不放行）；
    //   · 没东西要隐藏、只是 guard 层没装上 → 走专用分支，如实说「执行层未装配」，
    //     绝不宣称「能看到并执行全部工具」，也不写 unprotected。
    // 「没东西要隐藏」不能只看 deny 为空：本层注册的工具不在 restrictableNames 里、
    // 因而进不了 deny。所以再用**实测可见面**复核一次 —— 只要可见面上真有 keep 外的
    // 工具，就仍然按真保护丢失处理，绝不放行。
    const visibleOutsiders = agentVisible.filter((name) => !isCoordinatorTool(name))
    const nothingToHide = attempt.nothingToHide === true && deny.length === 0 && visibleOutsiders.length === 0
    const protectionExpected = deny.length > 0 || hardDeny
    if (!restrictProtectionEngaged && !guardProtectionEngaged && protectionExpected && !nothingToHide) {
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
      // ⚠️⚠️ 2026-11-06（P0-1）：这是最严重的一条「守卫没装上」路径。两个 return
      // （有旧状态 / 首次安装就失败）都必须先写状态表，再打一条带 agent id 的 error。
      const failState = hadPrevious ? GUARD_STATE_DEGRADED : GUARD_STATE_UNPROTECTED
      recordStatus(agent, key, {
        state: failState,
        healthy: false,
        restrictApplied: false,
        restrictVerified: false,
        guardVerified: false,
        deny: [...withheld],
        unknownNames: Array.isArray(attempt?.unknownNames) ? [...attempt.unknownNames] : [],
        requestedScope: `agent:${key ?? '<no-id>'}`,
        error: attempt?.error ?? 'PROTECTION LOST: no restriction and no guard installed',
        at: Date.now(),
      })
      if (hadPrevious) {
        logError(
          `blackpig-guard: RE-INSTALL FAILED for session ${key ?? '<no-id>'} ` +
            `(agent ${agent?.id ?? '<unknown id>'}) — the new restriction and the new hard-deny guard both failed to install. ` +
            'The PREVIOUS protection is still in force (it was never released, because release now runs only after a ' +
            'successful install). The tool surface may be stale until the next successful sync.',
        )
        // ⚠️ 刻意**不**写 live：覆盖它就会丢掉旧 disposer 的引用，
        // 之后 release 卸不掉真正在生效的那一层（泄漏且无法回收）。
        // 只把 healthy 打成 false，让下一次 sync 继续重试。
        if (typeof previousState === 'object' && previousState !== null) previousState.healthy = false
        return
      }
      logError(
        `blackpig-guard: PROTECTION LOST for session ${key ?? '<no-id>'} (agent ${agent?.id ?? '<unknown id>'}) — ` +
          'this session never had a working restriction and installing one failed ' +
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

    // ⚠️⚠️ 2026-11-07 修（R17，BUG-3）：`deny` 为空（可隐藏集合是空集，上面已用实测
    // 可见面复核过「确实没有 keep 外的工具」）+ `hardDeny:true`，但执行层没装上
    // （`tools.guard()` 缺失，或调用时抛错）。这是**执行层缺失**，不是「全量暴露」：
    //   · 仍然如实告警（error 级，带 session / agent 标识）—— 执行层拦截确实不可用；
    //   · 状态写 degraded 而不是 unprotected —— restrict 层的命题（「withheld 的名字
    //     不可见」）在空集下为真，与 R10 #8 / R14 BUG-2 同一口径；
    //   · healthy=false，下一次 sync 继续重试安装 guard；
    //   · 文案只说「执行层未装配」，不说「能看到并执行全部工具」。
    if (nothingToHide && hardDeny && !guardProtectionEngaged) {
      const detail =
        'the execution layer (tools.guard()) is NOT installed even though hardDeny is on; deny is empty because ' +
        'every tool on this scope is inside the coordinator keep-set (the visible surface was re-checked: no tool ' +
        'outside the keep-set is present), so this is a missing enforcement layer rather than a full-roster ' +
        'exposure — but do not assume a call outside the keep-set would be denied'
      const hadPrevious = previousState !== undefined
      recordStatus(agent, key, {
        state: GUARD_STATE_DEGRADED,
        healthy: false,
        restrictApplied: false,
        // 空集下「withheld 的名字不可见」命题为真（同 R10 #8 的口径）。
        restrictVerified: true,
        guardVerified: false,
        deny: [...withheld],
        unknownNames: Array.isArray(attempt?.unknownNames) ? [...attempt.unknownNames] : [],
        requestedScope: `agent:${key ?? '<no-id>'}`,
        error: detail,
        at: Date.now(),
      })
      logError(
        `blackpig-guard: EXECUTION LAYER NOT ENGAGED for session ${key ?? '<no-id>'} ` +
          `(agent ${agent?.id ?? '<unknown id>'}) — ${detail}. ` +
          (hadPrevious
            ? 'The PREVIOUS protection is still in force (it was never released); the guard will retry on the next tool call.'
            : 'The guard will retry on the next tool call.'),
      )
      if (hadPrevious) {
        // 与下方 RE-INSTALL FAILED 同取向：保住旧 disposer / liftGuard 的引用，
        // 只把 healthy 打成 false，让下一次 sync 继续重试。
        if (typeof previousState === 'object' && previousState !== null) previousState.healthy = false
      } else {
        live.set(agent, {
          disposer: undefined,
          liftGuard: undefined,
          healthy: false, // ← 关键：让下一次 sync 不走幂等跳过，立刻重试
        })
      }
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
    //   ② 直接调 checkGuards 打一个必拒的工具，确认 guard 真的会拒（guard 生效的证据）
    // 两层都失效 → 这是**没有任何保护**的状态，用 error 级别喊出来，并记进保护状态。
    const protectedLayers = []
    if (attempt.dispose !== undefined || attempt.nothingToHide === true) protectedLayers.push('restrict')
    if (liftGuard !== undefined) protectedLayers.push('guard')

    let restrictVerified = false
    if (attempt.nothingToHide === true) {
      // R10 #8：本来就没有要隐藏的名字。restrict 层的目标是「withheld 里的名字不可见」，
      // 空集下该命题为真 —— 记为成功，而不是「restrict 失败」。真失败（requested 非空、
      // 求交为空）走不到这里，它在 restrictWith 里返回 error、不会带 nothingToHide。
      restrictVerified = true
    } else if (attempt.dispose !== undefined) {
      // ⚠️⚠️ 2026-11-07 修（R16，BUG-1）：判据是「**能否读到工具面**」，不是「读到的数量 > 0」。
      //
      // 旧判据 `after.length > 0 && leaked.length === 0` 把 restrict **生效**的典型结果
      // （可见面被清空、一个工具都不剩）误判成读失败 → restrictVerified=false →
      // healthy 恒 false → 每轮重装 + 打假 error（"...0 withheld tool(s) are STILL visible ()"）。
      // 保护越彻底越报错，而且与上面 `attempt.nothingToHide === true` 那档的语义
      // （**空集 = 命题为真**）正好相反 —— 同一件事必须用同一个口径。
      //
      // 现在分三种情况，都不放行真失败：
      //   · leaked 非空 → 真泄漏（restrict 返回了 disposer，但 withheld 仍可见）→ 失败；
      //   · after 非空 → 读到了可见面且 withheld 一个都不在 → 直接证据，成功；
      //   · after 为空 → 两种可能：「限制把可见面清空」（成功）或「工具面读不到」（失败）。
      //     用 `fullToolNames()`（未过滤的完整继承集）作旁证：它读得到 → 可见面确实被
      //     清空 = 成功；它也读不到 → 无法证明 = 失败。
      // 注意：restrict 抛错 / 没有 disposer 根本进不到本分支，仍走上面的失败档。
      const after = visibleToolNames(ctx, agent)
      const leaked = after.filter((name) => withheld.has(name))
      if (leaked.length > 0) {
        restrictVerified = false
        logError(
          `blackpig-guard: FAIL-CLOSED CHECK FAILED — restrict() returned a disposer but ${leaked.length} withheld tool(s) are STILL visible (${leaked.slice(0, 8).join(', ')}). The schema layer is not enforcing.`,
        )
      } else if (after.length > 0) {
        restrictVerified = true
      } else {
        const fullSurface = fullToolNames(ctx, agent)
        restrictVerified = fullSurface.length > 0
        if (!restrictVerified) {
          logError(
            'blackpig-guard: FAIL-CLOSED CHECK FAILED — restrict() returned a disposer but the tool surface is unreadable ' +
              '(both the visible set and the full inherited set came back empty). Cannot prove the restriction is hiding anything.',
          )
        }
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
        const reason = tools.checkGuards({ agent, callId: 'blackpig-guard-selfcheck', name: probeName, arguments: {} })
        guardVerified = typeof reason === 'string' && reason !== ''
        if (!guardVerified) {
          logError(
            `blackpig-guard: FAIL-CLOSED CHECK FAILED — the hard-deny guard is installed but did NOT deny the probe "${probeName}". Execution layer is not enforcing.`,
          )
        }
      } catch (error) {
        guardVerified = false
        logError(
          `blackpig-guard: FAIL-CLOSED CHECK FAILED — tools.checkGuards() threw while probing: ${error instanceof Error ? error.message : String(error)}`,
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
    const restrictLayerOk =
      attempt.nothingToHide === true || (attempt.dispose !== undefined && restrictVerified)
    // guard 层是否真的在拦：`guardVerified === true` 是**直接证据**。
    // （`guardVerified === null` 那一档已不可达，见上方 `probeName` 三级兜底的注释。）
    const guardLayerOk = guardVerified === true
    const nothingEnforcing = protectedLayers.length === 0 || (!restrictLayerOk && !guardOk && !guardLayerOk)
    if (nothingEnforcing) {
      logError(
        'blackpig-guard: ⚠️ THIS COORDINATOR SESSION IS RUNNING WITHOUT ANY ENFORCED TOOL RESTRICTION. ' +
          `Expected to withhold ${withheld.size} tool(s); layers installed: [${protectedLayers.join(', ') || 'none'}]. ` +
          'The model can reach the full roster. Treat every report from this session as unconstrained.',
      )
    } else if (!restrictLayerOk && guardLayerOk) {
      // N4 的正例：restrict 抛错但 guard 实测仍拒 pwsh → 不许喊 UNPROTECTED。
      logError(
        'blackpig-guard: restrict layer failed, guard layer still enforcing — ' +
          `the schema layer is NOT hiding anything (${attempt.error ?? 'restrict() returned no disposer'}), ` +
          `but the execution layer still denies every tool outside the keep-set (probe verified on "${probeName}"). ` +
          'The coordinator can see the full roster, but cannot execute it.',
      )
    } else if (restrictLayerOk && !guardLayerOk) {
      logError(
        'blackpig-guard: guard layer failed, restrict layer still hiding — ' +
          `the schema layer still withholds ${withheld.size} tool(s), but the execution layer could not be verified. ` +
          'A tool call that bypasses the schema list would not be denied.',
      )
    }

    // ⚠️⚠️ 2026-11-07 修（R13，BUG-2）：healthy 的判据必须与状态/日志**同源**。
    // `hardDeny:false` 时 `guard()` 根本不会安装（`:2201 if (hardDeny)` 是唯一安装点），
    // `guardVerified` 恒为 false。原来的 `&& guardVerified === true` 于是让 healthy
    // **恒假** → 幂等判据永不成立 → 每次 post-execute 都全量 release+restrict
    // （实测 restrict 调用 1→2→3→4、disposer 0→1→2→3），并每轮打一条
    // "guard layer failed, restrict layer still hiding" 的假 error。
    // 配置显式关掉执行层时，restrict 层通过自检就是健康；`hardDeny:true` 时本判据与
    // 原来**逐字等价**（`!hardDeny || guardVerified === true` 退化为 `guardVerified === true`）。
    const healthy = !nothingEnforcing && restrictVerified && (!hardDeny || guardVerified === true)

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
    if (key !== undefined) tracked.set(key, agent)

    // ── 把结局写进**可观测状态**（改造二第 2、3 条）──────────────────────────
    //
    // 为什么必须写：restrict() 的失败已经被 catch 住了，插件不会构造失败 ——
    // 但「没有构造失败」不等于「守卫生效」。如果只打日志，那么：
    //   · 启动自检读不到这份事实；
    //   · Lead 的首条上下文不会提醒模型「你现在能看到全套工具」；
    //   · 下一个读代码的人只会看到「插件起来了」，从而以为一切正常。
    // 所以这里把结局分类成三档写进模块级表，键是 sessionId（resync 只带 id）。
    //
    // 分类与日志里的判据严格同源（都用 restrictLayerOk / guardLayerOk）：
    //   · engaged    —— 隐藏层确认在挡（restrictVerified），且没有落进 UNPROTECTED；
    //   · degraded   —— 隐藏层没确认，但执行层确认在挡；
    //   · unprotected—— 一层都没确认在挡。
    // 刻意不把 degraded 写成 engaged：可以执行被拒、但模型仍能看见全套 schema，
    // 那是**能力泄漏**，必须让模型自己知道。
    const guardState = nothingEnforcing
      ? GUARD_STATE_UNPROTECTED
      : restrictLayerOk
        ? GUARD_STATE_ENGAGED
        : GUARD_STATE_DEGRADED
    if (key !== undefined) {
      recordStatus(agent, key, {
        state: guardState,
        healthy,
        restrictApplied: attempt.dispose !== undefined,
        restrictVerified,
        guardVerified: guardVerified === true,
        // 这份 deny 是**实际下发**的集合；restrict 失败时它可能是空的。
        deny: [...withheld],
        // 求交时被剔掉的未知名（正常应为空）。
        unknownNames: Array.isArray(attempt.unknownNames) ? [...attempt.unknownNames] : [],
        requestedScope: typeof attempt.scope === 'string' ? attempt.scope : `agent:${key}`,
        // 失败原因原文（成功时为 undefined）。
        error: attempt.error,
        at: Date.now(),
      })
    }
    // 无论有没有 sessionId，fail-open 的那一档都必须有一条 error 兜底 ——
    // 上面 nothingEnforcing 分支虽然已经喊过，但那条日志里没有 unknownNames 信息。
    if (guardState !== GUARD_STATE_ENGAGED && Array.isArray(attempt.unknownNames) && attempt.unknownNames.length > 0) {
      logError(
        `blackpig-guard: session ${key ?? '<no-id>'} is running at guard state "${guardState}" and ` +
          `${attempt.unknownNames.length} computed deny name(s) were rejected by the host before submission: ` +
          `[${attempt.unknownNames.join(', ')}]. They are NOT hidden from the coordinator.`,
      )
    }
    // `guardVerified` 只有 true/false（probeName 三级兜底保证永远探得到），故无 'n/a' 档。
    const guardLabel = guardVerified ? 'ok' : 'FAIL'
    logInfo(
      `blackpig-guard: coordinator scope engaged — total ${visible.length}, withheld ${withheld.size}` +
        `${attempt.dispose === undefined && attempt.nothingToHide !== true ? ' (restrict FAILED, hard-deny only)' : ''}` +
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
    for (const agent of [...tracked.values()]) {
      try {
        sync(agent)
      } catch (error) {
        // ⚠️ 2026-11-07 修（R10，#1）：批量重算必须逐项吞错。
        // tracked 里可能有多个大脑；一个 agent 的 sync 抛错（宿主 API 变化、
        // agent 已被半拆、属性 getter 抛错）不能让排在它后面的 agent 本轮全部跳过。
        // 取向与 subtalk 的单任务循环一致：吞在本项、带 agent 标识记一条 error、继续下一项。
        // 正常路径（sync 不抛）行为与此前完全一致。
        let agentId = '<unknown id>'
        try {
          const sessionId = agent?.session?.id
          if (typeof sessionId === 'string' && sessionId !== '') agentId = sessionId
        } catch {
          // session getter 本身可能就是抛错来源，退到 agent.id。
        }
        if (agentId === '<unknown id>') {
          try {
            const id = agent?.id
            if (typeof id === 'string' && id !== '') agentId = id
          } catch {
            // 两个标识都读不到：保留占位符，日志仍能说明是哪一个 tracked 项失败。
          }
        }
        logError(
          'blackpig-guard: resync of a tracked agent threw — this agent tool surface may stay stale until the next sync; ' +
            'the remaining tracked agents are still resynced. agent=' + agentId + '; underlying error: ' +
            (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
      }
    }
  }

  // ── 主路径：agent 一出现就装，赶在首次 prompt 组装之前 ──
  // payload 是对象，必须从 payload 里取 agent（把第一个参数当 agent 读会静默跳过）。
  //
  // ⚠️⚠️ 2026-11-06：这里**必须**整体 try/catch，理由是本条事件的分发方式：
  //
  //   dsh-agent/lib/index.js:703-719 的 announce() 调的是
  //   await this.ctx.serial(entry.carrier, "agent/created", {...})，而
  //   cordis/lib/index.js:873-879 的 serial 是**顺序 await 每个 listener、
  //   没有 per-listener try/catch**。所以本回调抛出的任何异常都会：
  //     · 终止整条 serial 链 → 排在后面的 listener 一个都不执行；
  //     · 冒到 announce → agents.register() 的 effect 里 → agent 注册失败。
  //
  // 本文件在 cordis.patch.yml 里**排在 member-persona 之前**（:295 vs :350 附近），
  // 所以一次未捕获异常 = **member-persona 的人格静默不注入**，连一条 warn 都没有。
  // 这是一个已经真实发生过的故障形态（有 Lead 会话人格回落成宿主默认），
  // 绝不能让本守卫成为它的放大器。
  //
  // 正确取向：**吞在这一层，但绝不静默** —— 记 error，写清「该 agent 的工具面
  // 未收窄」，带 agent id 与错误原文，让下次排查能直接定位。
  ctx.on('agent/created', (payload) => {
    // ⚠️ 2026-11-07 修（R14，BUG-1）：参数**不解构** —— 解构发生在 try 之外，
    // handler(undefined) 会抛 "Cannot destructure property 'agent' of 'undefined'"，
    // 这段保护根本兜不住，而且异常会截断整条 ctx.serial 链（含 member-persona 注入）。
    // 与 member-persona.mjs:352 的 R8#8 同源：先取 payload.agent、判空、再装。
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      sync(agent)
    } catch (error) {
      // ⚠️ payload / agent 的 getter 本身也可能是抛错来源 —— 取 id 必须再兜一层，
      // 否则 catch 里重新读 `payload.agent` 会把异常原样抛回 serial 链，等于没修。
      let agentId = '<unknown id>'
      try {
        const id = payload?.agent?.id
        if (typeof id === 'string' && id !== '') agentId = id
      } catch {
        // 读不到标识：保留占位符，日志仍能说明是哪条事件失败。
      }
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      logError(
        'blackpig-guard: syncing agent "' + agentId + '" threw — ' +
          'this agent tool surface was NOT narrowed. ' +
          'Contained here on purpose: agent/created is dispatched with ctx.serial(), which has no per-listener ' +
          'try/catch, so letting this escape would also skip every later listener (including member-persona). ' +
          'Underlying error: ' + detail,
      )
    }
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
      // 自愈重算。sync 失败绝不能打断这条 waterfall（下游还挂着宿主的 spill-policy、
      // repeat-tool-reminder、tool-fs-search 后处理）；吞在本层但记 error，不静默。
      try {
        sync(agent)
      } catch (error) {
        logError(
          'blackpig-guard: resync during tools/post-execute threw — this agent tool surface may stay stale until the next sync. ' +
            'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
      }

      const decision = await next()

      // ⚠️⚠️ 2026-11-07 修（R8，B3）：next() **之后**的裁剪段也必须整体包进 try/catch。
      // 此前只有 next() 之前的 sync 包了 try，之后的裁剪段整体裸露 —— 任何异常
      // （异常 result 结构 / content 里带抛错的 getter）都会 reject 整条 waterfall，
      // 连带打掉宿主的 spill-policy / repeat-tool-reminder 后处理，而且也不是「原样放行」。
      // 现在：异常一律 return decision（不裁剪、不改写），并用 logError 留痕（它自身不抛）。
      try {
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
            logError(
              `blackpig-guard: TRIM SKIPPED — a "${toolName}" result of ${sourceChars} chars exceeds the fallback limit ` +
                `${effectiveMax} chars, but it could not be trimmed: ${trimmed.skipped}. ` +
                `The FULL result is being passed through unchanged (${sourceChars} chars).`,
            )
          }
          return decision
        }

        // ⚠️ N7：文案不臆测上游。spill 处理过就直说"这是第二次裁剪"，
        // 没处理过才说"这是 spill 之后的第二道保险"。
        logInfo(
          `blackpig-guard: trimmed a "${toolName}" result from ${trimmed.originalChars} chars to ${trimmed.keptChars} chars ` +
            `(${trimmed.originalBytes} B → ${trimmed.keptBytes} B; limit ${effectiveMax} chars; ` +
            `${trimmed.spillHandled ? 'spill-policy had already retained it, this is the second trim' : 'no spill retention mark was found, this is the fallback path'})`,
        )
        return withAdditionalContexts({ kind: 'accept', content: trimmed.content }, decision)
      } catch (error) {
        // 裁剪失败的取向与上游 sync 失败一致：吞在本层、原样放行、但不静默。
        logError(
          'blackpig-guard: trimming a tool result in tools/post-execute threw — ' +
            'the upstream decision is passed through unchanged (no trim applied). Underlying error: ' +
            (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
        return decision
      }
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
      // ⚠️⚠️ 2026-11-07 修（R10，#7）：next() 之后的整段也必须包 try/catch。
      // 同文件下方（guard-status 注入）的 assemble 监听早就是这样做的，注释写明
      // 「注入失败不许打断组装」。这里原来只把 next() 放在外面，之后读 decision.tools
      // 或 tools 元素上的 getter 一旦抛错，就会 reject 整条 system-prompt/assemble
      // waterfall，而且零日志。现在：任何异常都原样返回 decision（不裁剪、不改写）
      // 并记一条 error。正常路径输出逐字节不变。
      // （try 内的原代码保持原缩进，便于与备份逐行对照。）
      try {
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
              logInfo(
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
        logError(
          'blackpig-guard: the delivery-layer trim would have emptied the tool list ' +
            `(${tools.length} tool(s) all outside the keep-set) — keeping the original list for this request`,
        )
        return decision
      }

      if (kept.length === tools.length) return decision

      // ⚠️ 兜底生效了 —— 说明主路径（restrict 视图层）这次没挡住。
      // 这条日志是**诊断信号**，不是常规信息：正常情况下永远不该出现。
      logInfo(
        `blackpig-guard: delivery-layer trim dropped ${tools.length - kept.length} tool schema(s) from this request (assembly.tools ${tools.length} → ${kept.length})`,
      )
      warn(
        `the delivery-layer trim (system-prompt/assemble) had to remove tool schemas from a request (scope=${agentScopeKeyOf(agent)}). ` +
          'That layer is only a FALLBACK: the host documents that listeners must not add or remove tools there, ' +
          'so a downstream listener may silently override it. The primary paths are tools.restrict() and ' +
          'tools.guard() — if this message appears, check whether the restriction actually installed for that session.',
        agentScopeKeyOf(agent),
      )
      return { ...decision, tools: kept }
      } catch (error) {
        // 投递层裁剪失败不许打断组装（与下方 guard-status 注入监听同一取向），但必须留痕。
        logError(
          'blackpig-guard: trimming the delivered tool list in system-prompt/assemble threw — ' +
            'the upstream decision is passed through unchanged (no trim applied). Underlying error: ' +
            (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
        return decision
      }
    },
    { prepend: true },
  )

  // ── 守卫未安装时：往 Lead 的首条上下文里放一条**有名字的**告警 ──────────────
  //
  // 改造二第 2 条要求「把守卫未安装这个事实写进一个可观测状态，供启动自检读取
  // 并在 Lead 首条上下文里提示」。上面 sync() 已经写进 GUARD_INSTALL_STATUS；
  // 这里把它变成模型**看得见**的一句话。
  //
  // 为什么必须让模型看见、而不只是写日志：guard 的 keep 白名单仍然在拒执行，
  // 但**schema 层没挡住**时模型会看到 pwsh / write / edit 这些工具。如果它以为
  // 「看得见 = 我可以用」，就会去调、被拒、然后按人格要求改派 —— 白烧一轮。
  // 提前告诉它「这份可见面不可信、这些工具调了会被拒」，它就不会试。
  //
  // 三条克制：
  //   · 只在 state !== 'engaged' 时注入（正常会话零额外 token）；
  //   · 只注给**大脑**（队友走早退，不进这条）；
  //   · 每个会话只注一次（用 WeakSet 记账，避免每轮重复刷上下文）。
  const guardNoticeShown = new WeakSet()
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      // ⚠️ waterfall 契约：必须先 await next()，再在它给的 decision 上叠加。
      const decision = await next()
      try {
        const agent = context?.agent ?? assembly?.agent
        if (agent === undefined || agent === null) return decision
        if (decision === undefined || decision === null || typeof decision !== 'object') return decision
        if (isDelegatedChild(agent)) return decision
        if (guardNoticeShown.has(agent)) return decision
        const id = keyOf(agent)
        if (id === undefined) return decision
        const record = GUARD_INSTALL_STATUS.get(id)
        if (record === undefined || record.state === GUARD_STATE_ENGAGED) return decision
        // ⚠️ 2026-11-07 修（R5）：这里原来就 `guardNoticeShown.add(agent)`（在注入之前记账）。
        // 记账已挪到注入成功之后（见下方 `injected` 之后那一处），此处不再记账。

        // ⚠️⚠️ 2026-11-07 修（R16，BUG-2）：读不到工具面时状态里可能没有 deny 记录，
        // 但那不等于「没有隐藏工具」。原来一律写 `(none submitted)`，是对模型的
        // 假信息（实际可能仍有旧限制在生效）。现在按状态里的显式标记分流。
        const list =
          record.deny.length > 0
            ? record.deny.slice(0, 12).join(', ')
            : record.denyUnreadable === true
              ? '(unknown — the current hidden set could not be read; do not assume nothing is hidden)'
              : '(none submitted)'
        const unknown = record.unknownNames.length > 0
          ? ' Names the host refused to restrict: ' + record.unknownNames.join(', ') + '.'
          : ''
        const text =
          `Black Pig guard is NOT fully engaged for this session (state: ${record.state}). ` +
          'The tool list above may therefore be larger than what you are allowed to use: ' +
          'tools outside the coordinator keep-list are still rejected at execution time, so do not try them — ' +
          'delegate that work instead. ' +
          `Hidden tools: ${list}.${unknown}` +
          (typeof record.error === 'string' && record.error !== '' ? ` Host error: ${record.error}` : '')
        const contexts = Array.isArray(decision.contexts) ? decision.contexts : []
        // ⚠️⚠️ 2026-11-06（P0-3）纠正这里原来的错误注释：`required: true` **不能**保证
        // 本注入在 runtime-context 抑制时存活。宿主实现是：
        //   const requiredContexts = new Set([...contextByName.values()]
        //     .filter(e => e.required === true).map(e => e.name))
        //   ... contexts: runtimeContextSuppressed
        //         ? transformed.contexts.filter(e => requiredContexts.has(e.name))
        //         : transformed.contexts
        // 而 `contextByName` 只含**通过 `systemPrompt.context()` 注册**的项；本注入直接追加进
        // decision.contexts，不在其中，抑制态下会被整条过滤掉。
        // 因此：**日志与 `guardInstallStatus()` 才是可观测性的主通道**，这条 context 只是
        // 「没被抑制时」的额外提醒，绝不能当成唯一报警。
        const entry = { name: 'blackpig-guard:install-status', order: 115, required: true, text }
        // ⚠️ 2026-11-07 修（R9，优化 7）：原来这里外面还套了一层 try/catch，是**死代码** ——
        // `logError` 自身已把 `ctx.logger?.error?.()` 包在 try/catch 里（见它的定义），
        // 不可能把异常抛回这里，那层 catch 永远走不到。保留调用，去掉外壳。
        logError(
          `blackpig-guard: injecting the guard-status notice into the Lead prompt for session ${id} (state=${record.state})`,
        )
        const injected = { ...decision, contexts: [...contexts, entry] }
        // ⚠️ 2026-11-07 修（R5）：记账必须在注入**确实成功之后**。原来它排在 logger 之前：
        // logger 抛一次就落进下面的 catch 返回原 decision，而 agent 已经记账 →
        // 该会话的「守卫未生效」提示**永不再注入**。现在失败不记账，下次 assemble 会重试。
        guardNoticeShown.add(agent)
        return injected
      } catch (error) {
        // 注入失败不许打断组装（那会让整轮请求失败），但必须响。
        // ⚠️ 2026-11-07 修（R9，优化 7）：原来这里又套了一层 try/catch，同属**死代码** ——
        // `logError` 自身已吞掉 logger 的任何异常（logger 恒抛也逃不出它），那层 catch
        // 永远走不到。去掉外壳、保留调用：日志失败照样不把异常带出 waterfall 监听器。
        logError(
          'blackpig-guard: failed to inject the guard-status notice into the prompt: ' +
            (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
        return decision
      }
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
    try {
      resync(sessionId)
    } catch (error) {
      logError(
        'blackpig-guard: resync on agent-preset/selected threw — the previous restriction state was kept as-is. ' +
          'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
    }
  })

  // ── 工具面变化：兜底重判（tools/change 无参、无 scope 过滤）──
  // 本模块自己造成的变更（restrict / disposer）会同步回声到这里，必须忽略，
  // 否则 sync 会自己触发自己。重入闸门见 `quietly` 的注释。
  ctx.on('tools/change', () => {
    if (echoing) return
    try {
      resync(undefined)
    } catch (error) {
      // tools/change 是无 scope 过滤的广播，抛错会波及所有监听者。
      logError(
        'blackpig-guard: resync on tools/change threw — restriction state may be stale until the next sync. ' +
          'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
    }
  })

  // ── 释放：agent 离开时必须卸掉限制（scope key 会被回收复用）──
  ctx.on('agent/disposed', (payload) => {
    // `GUARD_INSTALL_STATUS` 的键与 `release()` 用的是同一个 sessionId（见 `keyOf`）。
    // 会话结束后必须删掉**自己那一条**：否则 Map 随会话数无界增长，且 id 被复用时
    // `guardInstallStatus()` 会读到上一条 degraded/unprotected 记录，误判并永久注入
    // 「守卫未生效」提示。只删本 agent 的键，其他 agent 的状态不动。
    // ⚠️ 2026-11-07 修（R6，B-1）：`keyOf` 是 `agent.session.id ?? agent.id`，
    // 而 disposed 时 `session` 可能已被拆掉 → 取到的是 `agent.id`，删的是**另一个键**，
    // 建状态时用的 `session.id` 就永久留在模块级 Map 里（实测 STALE ENTRY REMAINS）。
    // 所以不能只删 `keyOf` 的结果：两个候选键各自有值就都删。
    // ⚠️ 2026-11-07（R9，优化 6）：候选键的收集抽成 `statusKeysFor(agent)`，与「切走
    // preset」那段同源（原先两处逐字重复）。先收集、再 release、最后删 —— 顺序不变。
    // ⚠️ 2026-11-07 修（R14，BUG-1）：同 agent/created —— 参数**不解构**，取 payload 与判空
    // 都放在 try 内；畸形载荷（undefined / null / {}）直接 return，绝不从这里抛出截断
    // ctx.serial 的后续监听（含 member-persona 的人格注入）。
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      const statusKeys = statusKeysFor(agent)
      try {
        release(agent)
      } catch (error) {
        logError(
          'blackpig-guard: releasing a disposed agent threw — a stale restriction may outlive the session. ' +
            'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
      }
      for (const statusKey of statusKeys) GUARD_INSTALL_STATUS.delete(statusKey)
    } catch (error) {
      logError(
        'blackpig-guard: handling agent/disposed threw — the disposed agent may keep a stale restriction or status entry. ' +
          'Underlying error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
    }
  })
}
