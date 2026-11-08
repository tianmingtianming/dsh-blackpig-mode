# 无记忆新对话冷启动接手文档 —— dsh-blackpig-mode

> **读者**：完全没有本会话记忆、第一次接触本插件的新对话（AI 或人）—— **这是维护者交接手册**。
> **只想安装使用的读者**：请直接看 `README.md` 的「安装」章节；本文其余部分（开发流程、发布步骤、维护者本机排查记录）可以完全忽略。
> **目的**：让你在动手之前就建立正确认知，不重复历史上踩过的坑。
> **定位**：接手手册 / 认知基线，不是设计说明书，不是安装说明的复制品。事实以本仓库当前源码为准；凡标注「实测/历史」的结论来自长期实战纠正，很多**不在代码里**，务必连同结论一起记住。
> **唯一权威**：`cordis.patch.yml`（preset 定义 + 两份人格都在里面）。本文只是指针与纠正记录，**不产生第二份权威**。

---

## 0. 结论先行（先背这十条）

1. 这是发布到 GitHub 的 **DSH agent preset bundle**（npm 包名 `dsh-blackpig-mode`，当前 `package.json` version = **1.0.4**），架构是「**一个大脑 + 队友/子代理**」：大脑只判断、拆任务、派活、汇总；动手（读写 / 跑命令 / 搜索）全部下放。版本历史见文末「版本历史」一节；以 `package.json` 实测为准。
2. **唯一权威是 `cordis.patch.yml`**：preset 声明、`persona.prefix`（大脑人格）、`member-persona.text`（队友人格）都在这一个文件里。README 是给人看的说明，不是权威。
3. **三个词必须精确**：`helper` = 泛指派活对象（队友或子代理）；`subagent` = `subagent_preset` 派出的、跑指定 preset 的一次性代理；`teammate` = `spawn_teammate` 创建的具名常驻成员。历史把 worker/subagent/teammate/helper 混着用，导致大量理解错误。
4. **收窄只作用于大脑，不作用于队友/子代理——这是设计，不是 bug**：guard 的 `sync()` 对 `isDelegatedChild` 直接 `release()` 早退。
5. **两条通道 / 两套目标绝对不能混**：团队工具（`send_message` 等）只认 **roster 名字**（队友 + lead）；`send_to_subagent` / `stop_subagent` 是本插件 `subtalk.mjs` **自造**的工具（DSH 里搜不到这俩名字）：`send_to_subagent` 底层 `ctx.subagents.sendMessage`，`stop_subagent` 底层 `ctx.subagents.interrupt`。**授权边界是版本相关的**：本机 rc.1 是「直接父 ↔ 直接子」（越界 `belongs to another parent session`），master 放宽为「同树任意成员互发」——见 D / G 节，别串台。
6. **团队模式的官方唯一判据是「需不需要共享任务板」**（`packages/team/agent-team/README.md:38,42`），不是「任务大不大 / 跨多少轮」。
7. **团队工具按产品线分**：本机 rc.1（experimental 包）仍有 `spawn_teammate` + 共 **9 个**团队工具；**master 才删成只剩 4 个 `team_task_*`**、身份层合并进子代理。`compat.mjs` / `blackpig-roster.mjs` 已做跨代兼容，但要用「能力存在性探测」而非版本号判断；master 结论**未生效**，别套到 rc.1。
8. **绝对红线**：只改本插件自己的 `src\`。绝不碰 `app.asar`、`@deepseek-ai/*`、`~/.dsh/` 下配置、desktop profile 的 `cordis.patch.yml`、`node_modules` 运行副本、任何其他第三方插件。**上次曾把 DSH 弄崩溃过。**
9. **发布状态**：v1.0.4 已发布到 GitHub（源码与 Release 资产同源），安装后以 `node_modules` 里的运行副本为准。`send_to_subagent` 放开给队友后的三条通路仍待实测；注意 master 的授权放宽会改变其中两条的预期结果（见 D / G 节）。
10. 本文档首次落地时只写了文档 + README 一行指针；此后多轮审计已改动 guard-v10 / subtalk / blackpig-roster / member-persona / README 等文件，详见 README 变更记录。

---

## A. 这是什么 / 文件清单

`dsh-blackpig-mode` 是一个 **DSH agent preset bundle**，通过 `package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"` 向 profile 的 Cordis 树插入一行 `preset-blackpigmodel`（preset id = `blackpigmodel`，显示名「黑猪模式」）。`main` 与 `exports["."]` 都指向 `guard-v10.mjs`；`exports["./*"] = "./*"` 让 `dsh-blackpig-mode/xxx.mjs` 子路径能解析到包内（**不能删**）。

`package.json` 的 `files` 白名单当前 **10 项**：`cordis.patch.yml`、`file-info.mjs`、`blackpig-roster.mjs`、`guard-v10.mjs`、`compat.mjs`、`member-persona.mjs`、`subtalk.mjs`、`check.ps1`、`verify.ps1`、`README.md`。注意 `LICENSE` 未列在 `files` 里，但 npm 会强制包含 `LICENSE*` 与 `README*` 前缀文件（见 I 节）。

逐个文件的职责（以当前源码为准）：

| 文件 | 职责 |
| --- | --- |
| `package.json` | 包名/版本（1.0.4）、`main`、`exports` 子路径映射、`files` 打包白名单、`dsh.bundle.patch` 挂载点。 |
| `cordis.patch.yml` | **唯一权威**。1 个 `- insert:`，`config.plugins:` 下 **25 行顶层插件行**（另有 2 个 `cordis:group`，组内 4 行，共 30 个 `- id:`；其中 2 处 `!!js` 平台判断）。内联 `persona.prefix`（大脑人格）与 `member-persona.text`（队友人格）。还含 `blackpig-guard` 的 `keep: [subagent_preset]` 与 `extraDeny: [subagent, subagent_fork]`。 |
| `guard-v10.mjs` | 「大脑工具面收窄」守卫：在**大脑自己的 agent scope** 装 `tools.restrict({deny})`（隐藏）+ `tools.guard()`（硬拒执行）。`deny = 可见集 − 保留集`。`DEFAULT_KEEP` 实测 **27** 个名字。`sync()` 对 `isDelegatedChild` 早退 `release()`。另含 `restrict()` 失败保护（先与 `restrictableNames` 求交、try/catch、`guardInstallStatus()` = engaged/degraded/unprotected）。 |
| `blackpig-roster.mjs` | 注册 **`subagent_preset`**（`TOOL_NAME = 'subagent_preset'`）——大脑**唯一**跨模式派活入口，`preset` 必填、无默认值；支持 `list` / `ask` / `detail` 查模式名册。数据源 `agentPresets.compositionInventory()`。`startActivation` 用「超集入参」`{ request, ...request, ... }` 兼容新旧两代（见 G 节）。 |
| `subtalk.mjs` | 注册 **`send_to_subagent`** 与 **`stop_subagent`** 两个自造工具（见 D 节）。`send_to_subagent` 对所有 agent 可用；`stop_subagent` 只给大脑，在子会话 scope 上被 `tools.restrict({deny})` 摘掉。发送走 `compat.callSendMessage`，解析走 `compat.resolveTargetId`。默认 `interruptBeforeSend: true`（YAML 配置）。 |
| `compat.mjs` | 委派控制接口版本兼容层。当前导出：`CONTROL_API_OLD` / `CONTROL_API_NEW` / `UNRESOLVED_TARGET` / `readCatalogVersion` / `detectControlApi` / `targetOf` / `applyToTools` / `resolveTargetId` / `callSendMessage`。**注意：`normalizeAgents` 当前不在源码里**（见文末「附：当前状态速查」）。 |
| `member-persona.mjs` | 子会话人格覆盖：在**继承本 preset 的子会话自己的 scope** 上注册同名 `deployment:persona-prefix` 段，盖掉大脑「你不能动手」的人格。判据是 **归属**（`presetId: blackpigmodel`）而非形态，避免把别 preset 的 worker 人格改错；`isDelegatedChild` 判定 fork/种子会话不算子会话。 |
| `file-info.mjs` | 注册 **`file_info`**：只读元数据工具，`ctx.fs.resolve()+stat()`，一次可查一组路径，报 `status` / `sizeKnown` / `sizeBytes`（大小未知时该键整个缺席，绝不报 0）/ 总 `bytes` 与 `unknownSizes`。`isConcurrencySafe: () => true`。大脑被砍掉 read/grep 后**唯一**的核实手段。 |
| `check.ps1` | **装前**只读检查（**6 项编号检查**；`-DryRun` 才额外打印装包影响范围，**不编号**，`Report` 编号最大只到 `6/7`，默认不跑），查同名 `blackpigmodel` 声明/残留/`extraDeny` 是否禁了 `subagent_preset` 等。退出码：0 READY / 1 NEEDS-CLEANUP（有残留 / 冲突，先清理）/ 2 BLOCKED（环境不满足，或关键输入读不到、无法判断：无 `dsh.cmd`、profile 目录不存在、`package.json` 读不到，或 `cordis.patch.yml` patch 读不到、未通过 `check.ps1` 的轻量语法健全性检查（tab 缩进 / 引号成对 / 冒号后空格 / 括号配平 / 顶层结构可识别；**不是完整 YAML 解析**））。**装完之后再跑通常仍返回 0（READY）**：第 4 项把「已含包名」判为 INFO（正常升级态），不计入 WARN；**只有另有需要清理的项（例如旧名 `dsh-blackpig-model` 残留）才返回 1（NEEDS-CLEANUP）**。UTF-8 **BOM**。 |
| `verify.ps1` | **装后**生效验证（编号 0/5–4/5；无 5/5，结论行不编号）：包落盘（**缺件仍判 FAIL**）+ 内置字节表（**默认只作参考、不计入 exit code**；加 `-StrictSizes` 才按字节判 WARN；`README.md`/`check.ps1`/`verify.ps1` 三个 `[SKIP]`）、`dependencies`/`optionalDependencies` 与 `dsh.profile.bundles` 登记、残留旧声明、`dsh --dump-config` 退出码，及 `preset-blackpigmodel` 命中次数以 **1 + 3/5 已报的残留条数** 为上限：超出上限判 FAIL，落在 1 与上限之间只记 WARN（同一根因不二次判死）。`desktop` profile 用 `%TEMP%` 影子 profile 绕开 `--dump-config` 硬拒。UTF-8 **BOM**。 |
| `README.md` | 给人看的说明（安装/验证/已知限制/变更记录/致谢），**不是权威**。末尾有一行指向本文档。 |
| `LICENSE` | MIT 许可证全文（在包内；npm 强制包含）。 |

**两份人格的位置与当前条数**（实测，见文末「附」节）：
- `persona.prefix`（`cordis.patch.yml` 的 `prefix: |-` 块）= **大脑人格**，英文，12 个非空行 / 11 个以 `**加粗**` 开头的段落（第 1 行是导语、无加粗；**11 是加粗段落数，不是非空行数**），开头 `This session runs in Black Pig mode: you are the brain...`。（2026-11-08 复核：仍是 12 / 11，未增删段落；v1.0.4 只**改写**了其中 `Pick the mode by capability` 那一段，前缀字节 7,289 → 7,719 B。）
- `member-persona.text`（`cordis.patch.yml` 的 `text: |-` 块）= **队友人格**，英文，23 个非空行 / 9 个加粗段落（其中最后一个 `**Every report must carry these four parts, in this order.**` 就是 4 条编号「报告四段」的标题，那 4 条不另计加粗段），开头 `You are a TEAMMATE on a work team...`。**已不含 `You are a WORKER`**。

### A.1 人格设计原则（收敛口径，别再逐工具复述）

- 人格**不逐工具写**说明与适用范围：工具描述（description）是运行时权威、随版本更新、会漂移，人格抄一份就是第二份权威；工具面以「Your actual tool list is the authority」为准。
- 人格团队段**不整段压缩成「遵循系统注入的 TEAM_POLICY」**：rc.1 注入的是 experimental 包自己 `teamPolicy()`（同名同 order 600、但文本与 master 的 TEAM_POLICY 不同），只在 Team 成员 scope 注入、无 `when:`、抑制态仍在；master 是正式包 global section + `enabled(agent)` 条件返空文本。压成指针会用「条件注入、两代不同、可能为空」的隐式依赖换掉稳定自足的工具概要，更脆弱。与官方段/工具描述重复的概要保留即可（它们稳定、非完整副本），黑猪特有的关系与例外必须留。
- 一律**用能力存在性探测**（如 `if team_task_create is present`）而非版本号判断。
- 人格只承载**跨工具关系与少数例外**（两条通道两套目标、收窄只作用大脑、自造工具、rc.1 授权边界、wait_agent 硬规则），不复述单个工具参数。

---

## B. 三个词，必须精确（最容易被搞混）

历史把 `worker` / `subagent` / `teammate` / `helper` 混着用，导致大量理解错误。**统一术语如下，不许再混**：

- **helper（泛指）**：你派活给的**任何一方** = 队友或子代理。当区别不重要、或一句话要同时覆盖两者时用它。人格文本里 `helper` 就是这个意思。
- **subagent（子代理）**：用 **`subagent_preset`** 派出的，跑**指定 preset**（`preset` 必填），干完回报即散，可**冷恢复复用**（`childSessionId` 是唯一句柄）。persona.prefix 明确：`subagent_preset` 是大脑**唯一**跨模式派活工具；`subagent` / `subagent_fork` 被 `extraDeny` 从大脑面上摘掉（前者固定回落 `standard` 会白烧一轮且不报错，后者根本不支持选模式）。
- **teammate（队友）**：用 **`spawn_teammate`** 创建的**具名常驻成员**，占名册名额，**继承大脑的 preset（不能选模式、没有 `preset` 参数）**，但**不受大脑的工具收窄**——因此拿到该 preset 的**完整工具面**（例外：`spawn_teammate` 被 guard 按 `TEAMMATE_FORBIDDEN_TOOL` 从队友工具面摘除、`stop_subagent` 被 subtalk 在子会话 scope 上按 `hideFromMember` / `requestedDeny` 摘除（由 `agent/created` 监听触发）——是结构约束，不是收窄，展开见下文 C 节），能读写、跑命令、自己再派子代理、用任务板、彼此按名字发消息。队友结束也不释放名额（`inactive` 仍占槽，满额报 `TEAM_MEMBER_LIMIT`，以运行时错误为准）。

一句话记法：**helper 是伞；subagent 按 preset 派、用 `childSessionId` 找；teammate 按 roster 名字找、没有 preset 参数、工具面全开。**

---

## C. 三套工具面（实测数字；区分「配置面」与「实际下发」）

> 下面是**实测数字**，不是从配置推出来的理论值。配置面按 `DEFAULT_KEEP` / `extraDeny` 算；实际下发的工具表由宿主在运行时决定（条件注册、平台 `!!js`、团队插件是否开、guard 的 `restrict()` 是否成功都会影响）。

- **大脑（root，`blackpigmodel`）**：
  - 配置面：`DEFAULT_KEEP` = **27** 个名字（实测：`read_image, working_directory, file_info, send_to_subagent, stop_subagent, subagent, subagent_fork, subagent_preset, spawn_teammate, send_message, list_agents, interrupt_agent, wait_agent, team_task_create, team_task_list, team_task_get, team_task_update, job_list, job_output, job_kill, ask_user_question, todo_write, present, exit_plan_mode, create_goal, get_goal, update_goal`），减去 `extraDeny: [subagent, subagent_fork]` = **25**。`config.keep` 另追加 `subagent_preset`（已在默认表里，重复无害）。
  - 当前 **DSH 0.2.2-rc.1 实测 24**：宿主因**未进入 plan mode** 把 `exit_plan_mode` 条件摘掉了（`dsh-plan-mode` 是 DSH 内置包，0.2.2 起 `exit_plan_mode` 改成「进 plan mode 才注册」）。**这是官方行为，不是 guard 的问题**（见 F-7）。
  - 大脑**没有** `read` / `write` / `edit` / `pwsh` / `grep` / `glob` / `web_search` / `web_fetch`；只剩 `file_info` + `read_image` 两类核实手段，且**证明不了文件里写了什么**。
- **队友**：实测 **64 个工具**，full tool surface（含 `read`/`write`/`edit`/`pwsh` + 团队工具 + `subagent_preset`）。
- **minimal 子代理**：**35 个**（无 `read`/`write`，只有 `pwsh`/`read_image`/`working_directory` + mnemon/remote 等）。
- **standard 子代理**：**64 个**。
- **关键结论**：**「收窄只作用于大脑，不作用于队友/子代理」是设计，不是 bug**。源码证据：`guard-v10.mjs` 的 `sync()` 里 `if (isDelegatedChild(agent)) { release(agent); return }`（`sync()` 的早退分支）先 `release(agent)` 再 return；`isDelegatedChild()`（函数本体）用 `origin === 'subagent'` / `delegationDepth > 0` / `isSeeded === true → false` / `parentSession` 兜底判定。多处投递层/裁剪层也都有 `isDelegatedChild → return decision`（不裁队友结果）。`DEFAULT_KEEP` 里保留 `subagent`/`subagent_fork` 只是「撤销 `extraDeny` 即自动恢复」的配置开关默认位，**不是大脑能用它们的声明**。注意队友面另有两处结构性摘除（不是收窄），实现见 B 节 teammate 条：`spawn_teammate` 由 guard 的 `TEAMMATE_FORBIDDEN_TOOL` 摘除逻辑摘掉、`stop_subagent` 由 subtalk 的 `hideFromMember`（`requestedDeny`）对 `isDelegatedChild` 摘掉。
- **P0-3 澄清（guard 注入 / runtime context 抑制态）**：本机 `cordis.patch.yml` 的 persona 行未写 `includeRuntimeContext`（默认 true），当前默认配置**不在抑制态**，故宿主在未抑制态会提前返回、跳过后续过滤，guard 那条「守卫未装」注入实际能进 prompt；但「抑制态下被 requiredContexts 过滤」是条件成立的，日志 + `GUARD_INSTALL_STATUS` 状态表仍是不依赖配置的主通道，P0-3 结论不变。

---

## D. 两条通道 / 两套目标（极易混）

**通道 1 —— DSH 团队插件（roster 名字）**：`send_message` / `interrupt_agent` / `list_agents` / `wait_agent`（以及 `spawn_teammate`、`team_task_*`）。
- **只认 roster 里的名字（队友 + lead）**，**不认子代理**。把 `childSessionId` 传给 `send_message` 会报 `active teammate not found`。
- 队友之间、队友 ↔ lead 用这条。`interrupt_agent` 收**队友名字**停其当前轮次。

**通道 2 —— 本插件自造（`subtalk.mjs`）**：`send_to_subagent` / `stop_subagent`。
- **DSH 里搜不到这俩名字**，是本包注册的。
- **起因**：`dsh-tool-subagent-control` 把 `send_message(agent_id)` 注册在**全局层**，`dsh-tool-agent-team` 把同名 `send_message(target)` 注册在**每个 agent 自己的层**；宿主 `view()` 规则是本层无条件覆盖继承层，于是团队版盖掉代理版——**大脑拿不到按 id 寻址的 `send_message`**。本模块用**不同名字**封一层，直接调 `ctx.subagents.sendMessage(sender, targetId, content, {signal})` 绕开撞名，纯增量、不改任何现有工具。
- **底层授权（⚠️ 这是「本机 DSH 0.2.2-rc.1」当前行为，不是两代通用事实）**：rc.1 的 `ctx.subagents.sendMessage` 只允许「**直接父 ↔ 直接子**」，越界抛 `belongs to another parent session` / `authorizeLineage`（rc.1 asar `dsh-subagent/lib/index.js:1544-1557, 1665-1668`）。**master 已放宽**：`authorizeLineage` 与那串报错全库搜不到，`manager.ts:561-577` 改成「同一棵子代理树里任意成员互发」，`list-agents.ts:50` 明写 "You can message any other agent in the subagent tree"，配合 `resolveName` 可解析 lead / 全名 / 任意 session id。**届时本节「reach is one level / 发不到孙代理、发不到别人派的」以及两份人格里同类限制会失效，必须复核人格与文案再上线**——不要拿 master 的依据来改当前 rc.1 代码，也不要拿 rc.1 的限制当 master 的永久事实。
- **`send_to_subagent` 已对子会话放开**：队友能给自己**直接**派的子代理发后续/纠正（`hideFromMember` 只摘 `stop_subagent`，`send_to_subagent` 保留；YAML `blackpig-subtalk` 配置 `interruptBeforeSend: true`）。
- **`stop_subagent` 仍只给大脑**：子会话 scope 上被 `tools.restrict({ deny: [stop_subagent] })` 摘掉（当前 `requestedDeny = [INTERRUPT_TOOL_NAME]`，即 **1 个工具**；`INTERRUPT_TOOL_NAME = 'stop_subagent'`），且 `execute` 里有 coordinator-only 结构化拒绝兜底。
- **边界（同样仅对 rc.1 成立）**：本机 rc.1 下队友发不到孙代理、也发不到别人派的子代理；**大脑也够不到队友派的子代理**（`list_agents` 看不到它；`wait_agent` 在无活跃队友时立刻 noProgress，不能用它等子代理），只能靠队友转述结果。大脑自己对直接派出的子代理用 `send_to_subagent`（配 `childSessionId`）。**master 下这条限制已被「同树任意成员互发」取代，待装新版后实测三条通路（见 J 节）。**
- **回执语义**：`messageId` 只证明消息进了收件箱；`interrupt` 是请求无回执（`interruptVerified: false`），`stop_subagent` 返回 `request-sent-unverified`。刚被中断后紧跟的 steer 会落到**下一轮**而非最近步骤边界，纠错可能晚于正在跑的动作。

---

## E. 任务板（团队模式的意义）

- **官方唯一判据**：`packages/team/agent-team/README.md:38,42`「**需不需要共享任务板**」。**不是**「任务大不大 / 跨多少轮」。需要「谁拥有哪块、哪块等哪块」才用队友；只是需要一个别的 preset → `subagent_preset`。
- 有队友 = 有板：`team_task_create` / `team_task_get` / `team_task_list` / `team_task_update` 记录 owner / state / blockers；注意 `team_task_create` 建的是 **unowned pending**，`team_task_update` 的 claim 才设 owner。流程：**认领（拿当前 revision）→ 干活 → 完成**。不抢别人 owner 的任务，用 `send_message` 去问。
- 团队**不提供文件隔离**：共享 cwd、无 worktree、无锁；`write_scopes` 只是提示（队友人格要求「只碰 brief 点名的文件」）。
- **团队工具数量按产品线分开，别写成「团队工具只有 4 个」这种笼统话**：本机 **rc.1**（experimental 包）**仍有 `spawn_teammate`**，连同 `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_*` 共 **9 个团队工具**；**master**（正式 `dsh-tool-agent-team` 包）才删成只剩 **4 个 `team_task_*`**、身份层合并进子代理。官方 v0.2.1-rc.2 迁移文档讲的移除是更早的另一条产品线。见 G 节版本基线。

---

## F. 历史踩过的坑（新对话务必别再犯）

1. **错把「队友/子代理不受 guard 保护」当漏洞**，新增了 `blackpigworker` preset + `fs-read-gate.mjs`「先读后写」闸门。**两者都已撤销删除**（当前活动源码根已无 `fs-read-gate.mjs`、无 `blackpigworker` 字样；只在 `_backup-*` 与 `.bak-*` 备份里）。**队友/子代理工具面完整是设计**；大脑本来就不能写，闸门护错了对象。
2. **曾把队友人格写成 `You are a WORKER...`**——错。队友是**完整的执行者/小组长**，不是「只能判断的手」。`not hands` 比喻误导，已删。当前 `member-persona.text` 开头是 `You are a TEAMMATE ...`，并明写「full tool surface ... Nothing gets done that you do not do」。
3. **曾写「队友继承你的模式 + 拿到完整工具面」自相矛盾**——模式收窄只作用于**大脑**，队友在收窄之外（`release()` 早退）。当前 persona.prefix 的正确表述是 `The reduced tool surface applies to you alone`。
4. **曾误以为队友不能给自己的子代理发消息** → 实测 `send_message` 对子代理 id 报 `active teammate not found` **是因为它只认 roster**；正确通道是 `send_to_subagent`（**已放开**，见 D 节；三条通路待装新版实测）。
5. **曾以为 `failed` 状态的 worker 不可恢复而重派**——**错**。cold resume **不看 `stopReason`**；限流/网络/超时是外部原因，应等一下**重试同一个 helper** 而非重派（`Reuse by default` 已写进两份人格）。重派会丢掉它读过的大文件/大范围 grep 的画面。
6. **曾把 `send_to_subagent`/`stop_subagent` 的 deny 当成「防大脑」**——其实只对**子会话**生效（`hideFromMember` 在 `agent/created` 且 `isDelegatedChild` 时执行）。它建立在一个**过度陈述的旧注释**上（「worker 会停掉父会话、掐断用户正在看的回答」）——实测不成立：大脑是根会话、从不在 `resident` 表，`interrupt()` 对它静默 no-op；停嵌套父代理会抛 UNAUTHORIZED。真正该防的是「回执不可信」。当前 `subtalk.mjs` 头部注释已改成实话。
7. **计划模式**：`@deepseek-ai/dsh-plan-mode` 是 **DSH 内置包**，0.2.2 起 `exit_plan_mode` 改成**条件注册**（进 plan mode 才出现），工具面 **25 → 24 是官方行为，不是故障、不要去装包或删声明**。`DEFAULT_KEEP` 里保留 `exit_plan_mode` 只是「注册时别被 guard 剪掉」，不会让它凭空出现。
8. **`dsh-capability-scope` 是用户自装的第三方插件**（watertao/dsh-capability-scope），曾把空白根会话按目录记忆切到 `standard`，导致「人格丢失」——**那是外部插件行为，别在黑猪里修**。

---

## G. 未来版本（DSH 0.2.2-rc.1 → master）风险清单

> **版本基线（必读，别串台）**：本机当前运行时是 **DSH 0.2.2-rc.1**（build commit `c59d10aff…`，在公开仓库 422 查无）；master HEAD 比 tag `dsh-v0.2.2-rc.1` 领先 **811 个提交**（compare API `ahead_by=811`；其 `commits` 数组只返回前 250 条，别把 250 当成领先数）。**两代代码，master 结论未在本机生效**；以下整节全部是 master 相对本机 rc.1 的差异，均「未生效」，不是当前已生效行为。当前现状以你读本机 `src\` 源码 + rc.1 asar 为准；**绝不要把 master 的源码结论套到本机 rc.1 去改当前代码**。
>
> - 本机 rc.1 的团队包名是 `@deepseek-ai/dsh-experimental-tool-agent-team`，**确实仍注册 `spawn_teammate`**，连同 `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_*` 共 **9 个团队工具**；tag `dsh-v0.2.2-rc.1` 同路径也有。
> - master 包名变 `@deepseek-ai/dsh-tool-agent-team`（`packages/team/tool-agent-team`），只剩 4 个 `team_task_*` `defineTool`，**`spawn_teammate` 已删**。
> - 官方迁移文档 `docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md` 讲的「移除」是 **v0.2.1-rc.2 那条线，比 rc.1 早**；rc.1 的 experimental 包保留了旧工具。**这是两条不同产品线**，别混为一谈。
> - 本机 rc.1 的 `ctx.subagents.sendMessage` 授权是「直接父 ↔ 直接子」，越界抛 `belongs to another parent session` / `authorizeLineage`（rc.1 asar `dsh-subagent/lib/index.js:1544-1557, 1665-1668`）。master 里 `authorizeLineage` 与那串报错全库搜不到，`packages/subagent/subagent/src/manager.ts:561-577` 的 sendMessage 改成**同一棵子代理树里任意成员互发**，配合 `resolveName` 可解析 lead / 全名 / 任意 session id；`list-agents.ts:50` 明写 "You can message any other agent in the subagent tree"。**授权边界是版本相关的，不是两代通用事实。**
> - **引入时间线（别统称「master 引入」）**：`spawn_teammate` 移除 / `startActivation` 拍平 = **v0.2.1-rc.2**；PTC `ABORTED` = **v0.2.1-rc.3**（仅「调用方取消 + 运行时 abort」，其余仍 `CODE_RUN_FAILED`）；`when:` 条件 / `tools.mode z.never()` / 控制工具 `agent_id→agent` / `list_agents` 改版 / `wait_agent` = **0.2.2 系列(alpha.2 起)**。`exit_plan_mode` 的 `when: selectedActive || entered` master 与本机 rc.1 **都有**，0.2.1-rc.5 没有。官方**无独立逐条 CHANGELOG**（只有 Release Notes 一句概述 + 各 upgrade-guide）。
> - `@deepseek-ai/dsh-plan-mode` 是官方内置包，**无 `engines` 字段**、仅 `peerDependencies` 9 项；npm 可查 `0.2.2-rc.1`，但 `dist-tags.latest` 是 `0.0.1-rc.1`（别把 tag 版本当 npm 最新）；`dsh-capability-scope` 确为第三方 watertao 所装；`send_to_subagent`/`stop_subagent` 在 master 与整个 asar 都不存在（本插件自造）属实。

用**「能力存在性探测」而非版本号**判断（`compat.detectControlApi` 的主判据是 `send_message` 的 schema 里有没有 `agent` 键，`SUBAGENT_CATALOG_VERSION` 为辅，`wait_agent` 存在与否**明确不作判据**——rc.1 团队插件就已注册它）。**不要写死本机路径。**

| 变化 | 现状 / 应对 |
| --- | --- |
| `spawn_teammate` 删除；队友改用 `subagent` / `subagent_fork` 创建（**v0.2.1-rc.2** 引入该 breaking；rc.1 experimental 线仍保留，master 正式线才删） | **仅 master 生效**。本机 rc.1 的 experimental 团队包仍注册 `spawn_teammate` + 共 9 个团队工具；master 才只剩 4 个 `team_task_*`。当前 `cordis.patch.yml` 仍装着 `tool-subagent` / `tool-subagent-fork` 两行、`DEFAULT_KEEP` 仍含 `spawn_teammate`；人格里用「if `team_task_create` is present」判断有无板，别硬依赖 `spawn_teammate`。 |
| `startActivation` 入参由嵌套 `{ request: { prompt, parent, agentPreset } }` 拍平成顶层（**v0.2.1-rc.2**） | `blackpig-roster.mjs` 已用「**超集入参**」`startActivation({ provider, label, request, ...request, signal, delivery })`（`delegate` 与 `ask` 两处 `startActivation({` 调用），同时喂嵌套与拍平两代。 |
| `send_message`/`interrupt_agent` 参数 `agent_id` → `agent`（**语义变了：由会话 id 变名字**，走 `subagents.resolveName()`；**0.2.2 系列(alpha.2 起)**） | `compat.mjs` 的 `targetOf` / `applyToTools` / `resolveTargetId` / `callSendMessage` 归一化：两种名字都收，名字先解析成 id 再调服务层，解析不出抛 `BLACKPIG_UNRESOLVED_TARGET`，不静默往下传。 |
| `list_agents` 改版（**0.2.2 系列(alpha.2 起)**）：master 返回**数组**，元素 `{name, status, description?}`，status 5 枚举 `running/inactive/corrupt/unsupported/unavailable`；rc.1 是 `{kind,id,label,status,parent,depth}`；入参 `{scope}`→`{}`，总列整棵树 | `compat.mjs` **当前没有 `normalizeAgents` 导出**（历史曾被删，见文末「附」节）。当前源码里 `detectControlApi` 只探测、`subtalk.mjs` 自己的 `describeTarget` 查目标状态；若下版真要归一化 `list_agents` 返回项，**接手时须先核对/补回**这一层，别假设它还在。 |
| **sendMessage 授权放宽（重要）** | 本机 rc.1 = 直接父↔直接子、越界 `belongs to another parent session` / `authorizeLineage`；master = 同树任意成员互发、`resolveName` 可解析 lead/全名/任意 session id，`list-agents.ts:50` 明写 "You can message any other agent in the subagent tree"。**人格里「发不到孙代理/别人派的」在 master 会失效，必须复核**。见 D 节。另：master `docs/tool-catalog.md` 说 `exit_plan_mode`「规划未激活仍保留 schema」与 `when:` 冲突，是官方文档自身不一致，别把那句当权威；官方无独立逐条 CHANGELOG（只有 Release Notes 一句概述 + 各 upgrade-guide）。 |
| `SUBAGENT_CATALOG_VERSION` 0 → 3、新增 `wait_agent`（均 **0.2.2 系列(alpha.2 起)**，不是 master 才引入） | `compat.readCatalogVersion` 尽力读、读不到返回 `undefined` 并 warn；`>=3` 判新版、`<=1` 判旧版。`wait_agent` 只记录不参与结论——rc.1 团队插件就已注册它。 |
| **`wait_agent` 版本分层（rc.1 → master）** | `wait_agent` 的 rc.1 行为是「只见队友、对 subagent_preset worker 立刻 noProgress」；master 把它挪到 tool-subagent-control 包、语义变为可等同一树内任意 agent 的输入/完成通知 —— 人格里「wait_agent 只对队友有意义」这条是 rc.1 限制，master 生效前须复核再上线。 |
| `tools.mode` 变 `z.never()`（**0.2.2 系列(alpha.2 起)**）；PTC 取消码 `CODE_RUN_FAILED` → `ABORTED`（**v0.2.1-rc.3**，仅「调用方取消 + 运行时 abort」，其余仍 `CODE_RUN_FAILED`） | 与本包无直接耦合；改 guard/roster 时别依赖旧枚举，也别把所有失败都当 `ABORTED`，用能力探测。 |
| `catalogHas()` 在 master 静默降级（不是方法名问题） | master 服务面无 `listChildren`、只有 `listDescendants(root=父自己)`；`subtalk.mjs` 的 `catalogHas()` 遇无 `listChildren` 直接返回 'unavailable' → 整个 catalog 探查静默关闭、`isKnownId` 少一腿、finished 分支不可达、`stop_subagent` 结论退化。rc.1 asar 已含 `listDescendants` 且返回项带 `id`，本机可验证语义，无需等 master。**master 生效前**给 `catalogHas` 加 `listChildren ?? listDescendants(父自己)` 兜底并同步 source 标签；现在 rc.1 不执行、不改。 |
| 其他 | 不深引宿主内部子路径（会 `ERR_MODULE_NOT_FOUND`）；`compat.mjs` 刻意只从已拿在手中的对象读 catalog 版本。 |
| **TEAM_POLICY 事实（两代同名同 order，按能力探测区分）** | rc.1 的 `@deepseek-ai/dsh-experimental-tool-agent-team` 在 Team 成员 scope 注入 `name:'team:policy'` / `order:TEAM_POLICY(600)` 的 section，文本是其自带 `teamPolicy()`（讲共享目录 / FS_STALE_VERSION / send_message 唤醒 inactive / wait_agent noProgress / Lead 必须等），**不是** master `packages/team/tool-agent-team` 的 TEAM_POLICY 文本（讲 board / owner 是 list_agents 名字 / root 可改派 / task 变更不结束 wait_agent）；全 asar 仅此一个注入器，正式包在 asar 内不存在。人格里 rc.1 授权边界句（发不到孙代理、两条通道、wait_agent 只对队友）在 master 生效前须按 L135/139/141 复核。 |

---

## H. 绝对红线（安全，最重要）

- **只改黑猪插件自己的源码目录**（即本文件所在目录 `src\`，用相对路径指代；本文不写任何机器绝对路径）。**绝不碰**：
  - `app.asar`（DSH 实现本体）、`@deepseek-ai/*` 内置包；
  - `~/.dsh/` 下任何配置、desktop profile 的 `cordis.patch.yml`；
  - `node_modules` 运行副本（那是装载后实际生效的代码，只能整体重装，不手改）；
  - 任何其他第三方插件（记忆插件、`dsh-capability-scope`、`dsh-multitask` 等）。
- **上次曾把 DSH 弄崩溃过，务必小心。**
- 改前备份 + 改后验证：`node --check`（对每个 `.mjs`）、YAML **SafeLoader 带 `tag:yaml.org,2002:js` 构造器**（因为 `cordis.patch.yml` 有 `!!js`，PyYAML 原生不支持是**既有情况**，不是本次故障）、`verify.ps1`。
- **`DSH_HOME` 隔离机制**：DSH 有真实环境变量 `DSH_HOME`（`dsh-home-paths/lib/index.js:15,109`、Desktop `lib/main.js:1731,1772`），可把 `~/.dsh` 指到自定义目录；`--profile` 只选 `$DSH_HOME/profiles/<name>`，**`--home` 开关查不到**。Desktop 由 Electron 独占、CLI 启动会写 `cordis.yml`。
- **优先「零启动静态验证」**：`npm pack` 到 `%TEMP%` + 解包检查 + `node --check` + YAML 解析 + 假 profile 跑 `verify.ps1`；确需起进程验证时，用 `DSH_HOME` 指向隔离目录，并先证明与真实 profile 物理隔离（绝对路径不同 + 真实 profile mtime/SHA 前后一致）再动手。`verify.ps1` 对 `desktop` 用 `%TEMP%` 影子 profile + 目录联接只读指回真 `node_modules`，跑完即删——照这个思路，别直接动真 profile。
- 编码/换行铁律：**`.ps1` 必须 UTF-8 BOM**；**`.mjs` / `.md` / `.json` / `.yml` 无 BOM**；**纯 LF**。当前实测：两个 `.ps1` 有 BOM，其余全无 BOM，全部 `CRLF=0`。
- **禁止直跑 `.ps1`**（本机 pwsh 5.1 会把中文按 GBK 读乱码）。用 `powershell -NoProfile -ExecutionPolicy Bypass -File "<...>\verify.ps1" -Profile <名>`。读源码中文用 `node fs.readFileSync(p,'utf8')`，**禁止 `Get-Content -Raw`**。临时脚本只放 `%TEMP%`，用完删。
- 〔维护者本机备忘，使用者可忽略〕维护者自己的 DSH 工作区 `AGENTS.md` 另有一组红线：只有导演能批准；付费接口两道确认；删前挪走并验证；改前用本机归档脚本打快照，改后跑核对脚本并报 exit code + hash 差异表；AGENTS.md 是唯一权威、docs 只留指针、出现第二份完整副本即报警。（归档 / 核对脚本属于维护者的本机工作流，与本插件无关，故不写具体路径与盘符）

---

## I. 怎么打包 / 安装 / 回归

- **打包**：`npm pack`（按 `package.json` 的 `files` 白名单）。注意 **npm 对 `README*` / `LICENSE*` 前缀强制包含**。若源码根残留旧的 `.tgz`，一律以 `npm pack` 新产出的那个为准，不要复用旧文件。
  > **2026-11-08 更新**：`1.1.0.tgz` 是版本号写错的废弃包（包内是旧字节），**未发布、勿用**，已移出并归档。当前有效发布件 = **`dsh-blackpig-mode-1.0.4.tgz`**，其字节数与 sha256 以 GitHub Release `v1.0.4` 页面公布的资产为准（本文不抄具体数字，抄一次就会过期）；`1.0.3.tgz` 保留为上一版。
- **实测**：`src\` 根下现存的 `README.md.bak-*` 会被 npm 的 `README*` 强制包含规则打进 tgz（不受 `files` 白名单限制）；`COLD-START-HANDOFF.md` 不在 `files`、不会被带入。**重新打包前必须先把源码根所有 `.bak-*` / `_backup-*` 移走或清掉**，否则发布包里混进备份文件。
- **安装**：用 Desktop 自带 CLI shim：
  `"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile <你的profile名> add <tgz>`
  （GitHub 装法：`... add github:tianmingtianming/dsh-blackpig-mode`；Release：`... add https://github.com/tianmingtianming/dsh-blackpig-mode/releases/download/v1.0.4/dsh-blackpig-mode-1.0.4.tgz`）。**别用包目录路径 add**（会装成 Junction，源目录一挪就坏）；本地 `file:` 指向 tgz 要放进 `optionalDependencies`。
  - ⚠️ `pnpm add <本地tgz>` 会把 profile 的 `optionalDependencies` 改成本地 `file:` 路径，**发版要改回 GitHub URL**。
- **装完建议重启一次桌面端以确保生效**（HMR 有时能自动重组，但不要指望；本流程以重启为准。README 侧同步此口径）；`node_modules` 里才是**运行时实际加载**的。
- **全功能回归清单**（每项的判据是**实际调用记录**，不是「看起来装上了」）：派队友、任务板四件（create/get/list/update）、派代理（`subagent_preset`）、队友派子代理、子代理再派、大脑工具面收窄（实测工具数）、队友人格（开头是 `You are a TEAMMATE`）、复用/冷恢复（同一个 `childSessionId`）、队友 → 直接子代理发消息（`send_to_subagent`）等。每项留 path / 命令 / 输出 / SHA256 或计数。

---

## J. 待办 / 未决

1. ~~当前源码已改完，但尚未重新打包安装~~ —— **已于 2026-11-08 闭环**：已 `npm pack` 出 **1.0.4** 并经「解包读回人格、逐字确认新规则」验证；GitHub 已发 **v1.0.4**；profile 依赖行已切到 v1.0.4 的 Release URL 并装进 `node_modules`。
   > **2026-11-08 再修**：`verify.ps1` 的内置字节表已**降级为参考信息**（默认不参与 exit code，见该脚本 `-StrictSizes`）。原因是写死字节对下载者无意义，且每次编辑都要手工同步，忘一次就是假告警。
2. `send_to_subagent` 放开给队友后的**三条通路待装新版后实测**：① 队友 → 直接子代理；② 队友 → 孙代理；③ 大脑 → 队友派的子代理。**预期结果按版本分**：本机 rc.1 下 ② 应被 `belongs to another parent session` / `authorizeLineage` 拒绝、③ 应够不到（只能等队友转述）；master「同树任意成员互发」下 ②③ 可能直接可达，需复核人格与文案，不能沿用 rc.1 结论。
3. `compat.mjs` 的 `normalizeAgents` 当前不在源码里；若下版 `list_agents` 返回结构变化要归一化，接手时先核对再补，别假定存在。
4. 下版 master 删 `spawn_teammate` 后，需重测「团队退化成标准 subagent + 4 个 `team_task_*`」下人格与任务板文案是否仍自洽。
5. master 生效前补 `catalogHas` 的 `listDescendants` 兜底 + 复核 `stop_subagent` 的 `targetState` 语义与人格；rc.1 现状不改。**限制**：master 的 `listDescendants(root)` 返回**整棵子树**（含孙代），直接平替会把 isKnownId 误认孙代、finished/source 失真；兜底须按 parent 过滤或标注 source，不是简单改名（另见 G 节 `catalogHas` 行）。
6. 收敛后第一项：把 `subtalk.mjs` 两处重复的目标解析块（send_to_subagent / stop_subagent 各一份、去注释后逐字相同的 15 行）抽成 `apply()` 内局部 helper，返回 `{ requestedTarget, targetId, isKnownId }`（send 路径多两个消费者）；零能力变化、零新增 import/包边；落地后同步 `verify.ps1` 期望表与重打包。评估事实已查完，不再重新评估。
7. 【硬传播项，与重新打包同批】`~/.dsh/blackpig-model/selftest.mjs` 里自带一个假的 `guardReason(exec)` 测试替身（不在发布 src\、不在 `files` 白名单、不是当前生效运行副本，故本轮按红线不动）。src 改成 `checkGuards` 后旧 harness 反而没有该方法 → 自检抛 TypeError 被吞 → 大量断言转红（engaged/guard=ok/幂等跳过/N4 不误报 UNPROTECTED），两头失真。必须成对改：把该 harness 的 `guardReason(exec)` 替身改名为 `checkGuards(exec)`（实现体逐字不动，其语义本就与宿主 chainLayers 取首个非空 reason 一致）+ 同步 staging 的 `guard-v10.mjs` 里同处改名；随后重打包两个 tgz + 更新 profile 运行副本，最后跑一次真 selftest 才算闭环。本轮不跑 selftest（会红、且禁止启动进程）。
8. 【低】`guard-v10.mjs` 幂等早退处的 `leaked` 判据（`nowVisible.filter(name => !keep.has(name) && !extraDeny.has(name))`）把 extraDeny 里的名字排除在外；若 `config.extraDeny` 写了不在 keep 里的名字、该工具因限制失效重新可见，leaked 仍为 0 → restrict 不重算（执行层仍拒，schema 层漏）。当前 YAML 两项恰在 keep 内、不触发。改法：leaked 用 `!isCoordinatorTool(name)` 或去掉 `&& !extraDeny.has(name)`。属配置态真问题。
9. 【低】`hardDeny=false` 时自检会打「guard layer failed」并把 healthy 置 false，用户主动关执行层却收到失效告警。当前部署不可达。
10. 【优化】`guard-v10.mjs` `guardOk` 与 `guardLayerOk` 是同一布尔、healthy 第三次写 `guardVerified===true`，三处等价可化简（纯等价、零能力改变）。
11. 【优化】一次 `send_to_subagent` 里 `detectControlApi` 跑两遍（`subtalk.mjs` 的 `send_to_subagent` 内先探一次，`callSendMessage` 内的 `detectControlApi` 又探一次），每次遍历 definitions 全表且 warn 刷两遍；可把已算的 api 经 opts 传进去跳过重探。零能力改变。
12. 【优化】`blackpig-roster.mjs` 两处 `startActivation` 调用块（delegate/ask）逐字重复，可抽 `apply()` 内局部 helper；超集入参逐字保留、零新增 import。
13. 【低·条件】若装了在 global 层对任意 name 都返回拒绝理由的第三方 guard，或某 guard 直接非可选访问 exec.signal/session/toolSet，`guard-v10.mjs` 的 fail-closed 自检会假绿/假 FAIL。当前 asar 穷举 4 个 guard 均不会，属将来前提；改法是校验拒绝理由来自本插件 / 给合成 exec 补全空壳字段。

---

## 附：本次接手时的「当前状态」速查（以实际读到的源码为准）

- **版本基线**：本插件 `package.json` version **1.0.4**；`files` 白名单 10 项；`exports["./*"]="./*"` 在。本文所有「现状」均以此为准。宿主 DSH 版本差异一律在 G 节标「未生效」——以你机器上 `dsh --version` 实测为准，本文不写死宿主版本号。
- `cordis.patch.yml`：`plugins:` 下 **25 行顶层插件行**（含 2 个 `cordis:group`，组内 4 行；全文件共 30 个 `- id:`，其中 1 个是外层 `- id: preset-blackpigmodel`）；2 处 `!!js`。`keep: [subagent_preset]`、`extraDeny: [subagent, subagent_fork]`。
- 两份人格（PyYAML SafeLoader 实测）：`persona.prefix` 12 个非空行 / 11 个加粗段（大脑）；`member-persona.text` 23 个非空行 / 9 个加粗段——其中最后一个 `**Every report must carry these four parts, in this order.**` 是 4 条编号「报告四段」的标题，**不重复相加**（队友），**无 `WORKER` 字样**。
- `compat.mjs` 导出 9 个符号，**无 `normalizeAgents`**；`detectControlApi` 以 `agent` schema 键为主判据。
- `subtalk.mjs`：`requestedDeny = [INTERRUPT_TOOL_NAME]` = **1 个工具**（`stop_subagent`）；`send_to_subagent` 对子会话保留、`stop_subagent` coordinator-only。
- `guard-v10.mjs`：`DEFAULT_KEEP` = 27；`sync()` 对 `isDelegatedChild` `release()` 早退。
- 编码：按 **src 根下 13 个文件**统计——`files` 白名单 10 项 + `package.json` + npm 强制包含的 `LICENSE` + 本交接文档 `COLD-START-HANDOFF.md`（后两者里的本交接文档不进 tgz：tgz 实为 **12 个文件**，BOM 结论相同）。这**与 A 节「`files` 白名单 10 项」不是同一套 10，别拿两个数对账**。其中两个 `.ps1` 有 BOM，其余 **11 个**文件（含 `README.md`）无 BOM，全部纯 LF（CRLF=0）。
- `fs-read-gate.mjs` / `blackpigworker` **不在活动源码**；只在备份里。
- 备份与临时文件：根下大量 `.bak-2026*`、`_backup-2026*`（`fs-read-gate.mjs` 的残留就在 `_backup-20261106-040106-settled-baseline\` 与 `_backup-20261106-cleanup\` 里），**不是活动代码**。

---

## 版本历史（一行一版；真实历史，勿改）

- **v1.0.0** — 首个快照：规划者不持有动手工具，动手全部下放。
- **v1.0.1** — 修 GUI fork / 种子会话被误判成子会话（大脑工具面被放开、人格被换成 WORKER）。
- **v1.0.2** — 人格新增「工具调用失败 ≠ 结果，是改派触发器」，同一 turn 内必须改派。
- **v1.0.3** — 源码与发布件对齐（guard / roster / subtalk / persona / compat / file-info 同步）。
- **v1.0.4** — 人格改写「按能力选模式、不按难度」；并在本次重发里清掉面向下载者的本机绝对路径、把 `verify.ps1` 字节表降级为参考（`-StrictSizes` 才判）。
- *(废弃号)* **1.1.0** — **版本号写错、包内是旧字节的废弃包，从未发布，勿用**；已归档。
