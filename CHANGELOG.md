# Changelog — dsh-blackpig-mode

## 1.0.10（2026-11-23～2026-11-24 原地覆盖；版本号字符串不变，仍是 1.0.10）

> 本节记的是**同一个版本号下的原地覆盖**：`package.json` 的 `version` 保持 `1.0.10`，
> 只重打 tgz 并覆盖 GitHub Release `v1.0.10` 的资产，不产生 1.0.11。
> 判断装机版本仍看 `package.json` 的 `version` + 本节日期。

### 2026-11-24 r6（删净基准测试残留；名册完全 live）

> 同一版本号 `1.0.10` 下原地覆盖；**版本号不 bump**。

- **删除 caps 兜底整条链**：`defaults/preset-caps.json`、`docs/preset-bench.md`、`CAPS_FILE_NAME` / `CAPS_DEFAULTS_RELATIVE` / `loadPresetCaps` / `validateV3` / `readCapsCandidate` / `rowsFromCaps`，以及 `preset-caps-invalid` / `preset-caps-missing` 两个错误分支。
- **名册只走 live**：`agentPresets.acquireScope` 或 `tools.view` 缺失时直接渲染一句 `live roster unavailable: agentPresets.acquireScope is missing`（带 `degraded: ['live-roster-unavailable']`），**不再读任何文件**。
- **取不到的模式**：行显示 `- <id>: — [unknown]`；`[snapshot]` 回填与标记删除。
- 连带：`package.json` `files[]` 12 项、包 **14 文件 / 0 目录 / 14 打包条目**；`verify.ps1` 删两行期望值、`skipSizeCheck` 去掉 `docs/preset-bench.md`；README 里 caps 段落改为「不依赖基准快照」。
- **死物清理**：`guard-v10.mjs` 删 `spawn_teammate`（三张表 + `TEAMMATE_FORBIDDEN_TOOL` + 队友摘除分支）；删 `index.mjs` 及 `package.json` 的 `main` 与 `exports["."]`（保留 `"./*"` 子路径映射）；清掉 roster 的 caps 注释、guard 的旧人格模块/currentTurn 历史注释、compat/subtalk 的旧子会话列举接口注释。
- 未动用户文件 `~/.dsh/blackpig-preset-caps.json`（已另备份；确认后再删）。

### 2026-11-24 r4（技能编号 S-Num-A）

> 同一版本号 `1.0.10` 下原地覆盖；**版本号不 bump**。

- **技能编号**：名册新增 `Skill index (NN):` 段（`[s01] …`，首现序 = 模式顺序 × 每模式 `skills.list()` 顺序，约 100 字符折行）；
  模式行改为「工具区间在前、技能区间在后」：`- standard: [001-057] | s[01-07]`。
- **删除** `skills:` 行及其 `only in` 子句、重复名单（归属由模式行的 `s[…]` 表达）。
- caps 兜底（无 live 技能）时省略 `Skill index` 与模式行 `s[…]`，不留空占位。
- 真实数据实测：整块 5,174 B → **4,839 B（−335 B，−6.47%）**；`blackpig-roster.mjs` 50,617 B。

### 2026-11-24 r3（索引命名空间折叠 + P4 人格压缩）

> 同一版本号 `1.0.10` 下原地覆盖；**版本号不 bump**。

- **索引折叠（A）**：`renderRows` 的全局索引把连续同 server 的 `mcp__<server>__<tool>` 折成组头
  `mcp__<server>__: ` + 组内 `[NNN] <tool>,`（去掉每项重复的 server 前缀）；编号与模式行完全不变。
  收益：r2 实测规模下索引块 4,395 B → 3,177 B（−1,218 B）；单 server 仅 1 个工具时不折叠。
- **P4 压缩（C①）**：persona 第 4 段（`**Every brief stands alone.**`）由 1,746 B 压到 **1,594 B**；
  段数仍 **9**；`based on your findings, fix it` / `Ask for the answer, not the file` / `spend it sparingly`
  / `DELEGATED_CALLER` / `childSessionId` 全部保留。`cordis.patch.yml` 35,030 B。

### 2026-11-24 阶段 1–5（人格/描述压缩、`ls` 并入、名册实时派生、段遮蔽）

> 同一版本号 `1.0.10` 下的原地改动；**版本号不 bump**。

- **人格（阶段 1）**：`persona.prefix` 仍是 **9 段**，删/压 14 处（P1/P4/P5/P6/P8/P9），新增「上下文纪律」一节；判据只认段数 9 与逐条断言。
- **工具描述压缩（阶段 2）**：上线口径 `send_to_subagent` 2,262→**1,854** B、`stop_subagent` 1,105→**923** B、`subagent_preset` 1,395→**1,197** B。
- **`ls` 并入 `file_info`（阶段 3）**：工具面 **16→15**；`file_info` 新增 `list?: boolean`（列直接子条目，200 条 / 8192 B 硬顶，永不递归），`ls-tool.mjs` 删除。
- **名册改为实时派生（阶段 4）**：`list: true` 优先走 `agentPresets.acquireScope` + `tools.view` + `skills.list`；接口缺失才回退 `preset-caps.json`；每模式只列编号区间（不再有 `(N tools)` / suitable 两行），新增 `skills:` 行；取不到的模式保留行并标 `[snapshot]` / `[unknown]`。
- **新增 `section-mute.mjs`（阶段 5）**：在 preset scope 注册空文本段遮蔽 `harness:source`（10,000）与 `app:web-surface`（10,100）；宿主 `renderPrompt` 丢弃空文本段，故不进 prompt。

### 2026-11-23 最终修订（9 段人格 + 四处回执/判据订正 + preset-bench 通用化）

**人格精简**：`cordis.patch.yml` 的 `persona.prefix` 由 17 段合并为 **9 段**——同类断言归段
（身份/只读、唯一出口/第三方、按能力选模式、brief/报告/产物、复用/finished、启动/批量、
钱与困惑、路径被堵/工具失败委派、参数/树边界），删去宿主已声明与不影响行为的冗词，
所有关键断言逐条保留。`timeout backstop` / 具体分钟数等瞬时判据一律不在人格内。
段落判据只认「段数 = 9」与逐条断言，不认任何字节数当现状。

**四处订正**（都按通用契约，不写本机值）：
- `guard-v10.mjs` 的 `teamAvailable()` 只认 `team_task_create` 一个团队能力标志物——
  `wait_agent` 由宿主无条件注册、`spawn_teammate` 在 rc.5 已不存在，用整张清单求 any
  会让无团队部署误判成 teamMode 恒真、solo 文案不可达。
- `subtalk.mjs` 的 `send_to_subagent` 描述改为「同树任意成员互发」；回执 reason 增
  `finished`（COLD RESUME）与 `unknown`（目标未查成）两支——`ok:true` + `messageId`
  只证明宿主接纳，不证明到达预期 worker，绝不重发确认。
- `blackpig-roster.mjs` 派活回执改为：`send_to_subagent` 收 `agent_id`，也收 agent 名字
  或 unambiguous id prefix（不写死前缀长度阈值，判据在 `compat.mjs` 常量里）。
- `compat.mjs` 的 `targetOf()` 报错改为完整 childSessionId 的裸 `<uuid>` 与
  `session-<uuid>` 两种形态都接受（与文件内已有判据一致）。

**preset-bench 通用化**：包内 `docs/preset-bench.md` 换用去掉本机瞬时值的新版；
`README.md` 的 `preset-caps.json` 描述不再写死字节数。

**打包/校验**：`tools\build-blackpig-tgz.mjs` 打带 `package/` 前缀的 tgz，
`verify-entry-files.mjs` 判入口落盘；`verify.ps1` 期望表同步所有改动文件字节。

### 2026-11-23 修订（C-1 人格 + 摘 `working_directory`）

**修订 1：人格 18 段 → 17 段（`cordis.patch.yml`）**

- **删 P11 的「超时兜底 5/15 分钟」整句**：那段超时数字属于宿主超时策略该管的事，
  写进人格只会让模型对「超时多久算异常」另立一套判据。
- **P18「有状态任务保持模式」并入 P09「默认复用」**：两段讲的是同一件事的两半
  （复用已有 worker / 别中途换模式），分成两段反而让「什么时候该换」和「换了会怎样」
  拆在两个地方。合并后仍在同一段里，判据一条不少。
- 当轮实测（历史值，之后的精简见本文件「最终修订」节）：人格正文 **18 段 → 17 段**；
  `cordis.patch.yml` 该轮由 35,420 B 降至 34,748 B（−672）。段落从 L70 起、正文至 L102、
  L103 空行、L104 起 `- id: agent-instructions`。
- 判据（新措辞必须在、旧措辞必须不在）：`timeout backstop` 全程 **0 命中**；
  `stateful or interactive` **1 命中**（并入 P09 后仍保留该句）。

**修订 2：`guard-v10.mjs` 的 `DEFAULT_KEEP` 摘掉 `working_directory`**

- **为什么摘**：协调者持有 `working_directory` 就能自己换工作目录，等于给「只判断、
  不动手」的大脑开了一个能影响**后续所有派活相对路径**的口子——它换一次，
  队友的默认 cwd 与它的判断基准就错位了。
- **摘后行为**：协调者不再能自己 `cd`；**相对路径基准固定为会话创建目录**，
  绝对路径完全不受影响（`file_info` / `ls` / `read_image` 传绝对路径照样能用）。
- **只动保留集，不动裁剪豁免表**：`:574` 的 `TRIM_EXEMPT_TOOLS` 里那行 `working_directory`
  **保留**（同 `job_kill` 先例——那是「结果太小不需要裁剪」的表，与「大脑能持有什么」
  是两套语义；留着它只影响裁剪，不还给大脑任何工具）。
- 实测：`DEFAULT_KEEP` **25 名 → 24 名**；`guard-v10.mjs` **197,330 → 197,307 B**（−23）。
  全文件 `working_directory` 剩余命中 **1 处**（`:573`，即上面的裁剪豁免表）；
  `node --check guard-v10.mjs` exit 0。

**修订 3：README 的保留集数字同步**

- `DEFAULT_KEEP` **28 → 24** 名；扣掉 `extraDeny: [subagent, subagent_fork]` 后可**用 22 个**
  （原 26）。旧文那句「后台任务 3 个（`job_list` / `job_output` / `job_kill`）」**删除**
  ——这三个 v1.0.10 首发时已不在保留集，写在那里是把历史值当现状。
- `verify.ps1` 内置期望表跟着改：`guard-v10.mjs` 197330 → **197307**；
  `cordis.patch.yml` 期望值本就是 `0`（不参与字节校验），**无需变更**；
  `package.json` 981 不变（版本号没动）。

**修订 4：这次覆盖顺带钉死打包方式**

- 新 tgz 用 `tools\build-blackpig-tgz.mjs` 打，条目一律带 `package/` 前缀
  （`package/lib/client.js` / `package/defaults/preset-caps.json` / `package/docs/preset-bench.md`），
  包根无裸 `client.js` 这类摊平指纹。装完仍须跑一次
  `tools\dsh-backup\verify-entry-files.mjs` 作双保险。

## 1.0.9 (2026-11-19)

> **本版本号是当前唯一在装的版本，且**不随修复 bump**。用户明确要求「别搞这么多版本」，
> 所以 1.0.9 之后的所有修复都合进 1.0.9 这一节（下面的「修订」段落按时间追加），
> 不再产生 1.0.10 / 1.0.11 之类的小版本号。**判断装机版本请看 `package.json` 的
> `version` 字段 + 本节最新修订日期，不要看 `patches\` 里 tgz 的文件名。**
> 文件名 `dsh-blackpig-mode-1.0.9.tgz` 会被**原地覆盖**（旧件另存
> `.bak-20261119-1.0.10`）。

### 2026-11-19 修订（装机后长会话验收实测暴露的三处缺陷）

这一轮修的是 1.0.9 装机后**长会话真实调用**暴露的问题，不是代码写错而是「回执与报错没把话说全」。

**修订 1：前缀解析回执不回显解析结果（缺陷 1）**

- **症状**（session-5c60e4d6 实测）：传 `{"agent_id": "0587566b"}` 成功，回执原文是
  `message accepted into the inbox of subagent 0587566b | messageId=… | targetState=finished`
  —— 回显的是**输入值**，**没有任何地方显示它解析到了完整 id**
  `0587566b-e451-47be-b3d6-2510e2cc96b9`。发错 worker 时无从判断解析对不对。
- **根因**：宿主 `sendMessage` 只回 `messageId`，回执正文由本包 `render()` 拼；旧 render 直接
  回显 `targetOf(args)`（= 输入值），解析结论只活在 `resolved.id` 里，没有进正文。
- **修法**：`compat.mjs` 新增 `resolutionNote(how, from, to, source)` —— **只在真的发生了转换时**
  产出说明（`id-prefix` / `resolveName`），`full-id` 与 `known-id` 直通返回 `undefined`
  （不制造噪音）。`resolveTargetId()` 的返回值新增 `note` 字段，`callSendMessage()` 把它带进
  结构化结果（`note` / `requested`），`subtalk.mjs` 的 render 把 `resolvedNote` 摊平进正文：
  `(resolved "0587566b" → 0587566b-e451-47be-b3d6-2510e2cc96b9 via durable child catalog id-prefix match @ sessionQuery.subagentCatalog)`。
  **宿主文本一个字没改**，只是本包在正文里补了这一段。

**修订 2：0 命中时没有列出相似候选（缺陷 2）**

- **症状**（实测传 `zzzzzzzz`）：报错末尾只有
  `… durable child catalog id-prefix match via sessionQuery.subagentCatalog → 0 candidate(s)`，
  设计稿承诺的「0 命中按最长公共前缀给近似候选」**一条都没给**。
- **根因**：`similarCandidates()` 里那行 `.filter((entry) => entry.score > 0)` ——
  `zzzzzzzz` 与任何 UUID 首字符都不共享 ⇒ 名册 409 条**全部被滤掉** ⇒ 返回空数组 ⇒
  `candidateNote` 整段为空。**名册越大反而越给不出候选**，与设计意图正好相反。
- **修法**：去掉 `score > 0` 过滤，名册非空就一定给前 3；同分（真实 409 条名册里全部同分 0）
  按 **`createdAt` 降序（最近派出的排前面）** 再按 id 升序（保证稳定）。候选文案统一为
  `"name" = <完整 id> [mode]`（`candidateText()`）—— **名字 + 完整 id + mode** 三样齐全，
  模型能直接判断「这条还能不能续」。名册读不到时正文明确写 `catalog unavailable`，
  与「名册为空」（`… is EMPTY`）是两种可区分的结果，不假装有候选。

**修订 3：`readCallerChildCatalog` 的过滤规则写进注释（409 条名册查证结论）**

- **实测**（session-24720769，758+ turn）：`subagentCatalog` 投影 **411 条、全部
  `parentSession` 指向该根会话、全部 `delegationDepth=1`、全部 `mode=continuable`**；
  410/410 有对应磁盘会话目录、`session-trash` 命中 0、无一孙子会话自带 catalog。
  ⇒ **409 是真实的 409 个直接子会话，不是混入了孙代理 / 别的父会话 / trash 残留**。
  投影本身按父会话分区（`subagent/catalog` 事件只 append 到 parent），无需再加语义过滤。
- **结论**：函数保持「只做形状清洗」（丢坏行 / 去重 / 保留 external 与 one-shot），
  并把这条判据与实测数字写进函数注释，避免下次有人以为需要按 `mode` 过滤。
  顺带：行对象补 `label` / `createdAt` / `activity` 三个已经能读到的字段（候选排序与诊断要用）。

### 修复：8 位 childId 前缀容错实测不生效（缺陷 A）

- **根因**：宿主 `resolveName()` 对**不含 "/"** 的名字有一个回退分支——树内查不到名字时**原样返回输入**（`dsh-subagent/lib/index.js:3072-3079` 的 `return brandString(name)`）。8 位前缀（如 `ed43bb07`）恰好匹配宿主名字字符集 `[a-z][a-z0-9-]{0,31}`，于是 `compat.resolveTargetId()` 在第 2 级就把回弹值当解析成功的 id 返回，第 3 级前缀匹配**永远没机会跑**，原值被当全量 id 交给服务层，冷恢复时报 `subagent "ed43bb07" is unavailable`（宿主 NOT_RESUMABLE，`:2256/2300`）。实测：L78 传 `"agent_id":"ed43bb07"` → L79 报错；L85 换完整 UUID → L86 成功。
- **修法**（`compat.mjs` `resolveTargetId`）：宿主 resolveName 返回值**与输入原样相同**时不可采信（不区分「名字真叫这个」与「没查到回弹」——现实中名字是 ≤32 位小写连字符、id 是 36 位 UUID，自指情况不存在），落到第 3 级前缀匹配；真解析（返回 id ≠ 输入）直通不受影响。
- **报错自纠正增强**：`unresolvedTargetError` 现列出**调用方可见名册里前缀最像的候选**（最多 3 个完整 id 原文），模型可直接复制正确写法；双参不一致报错同样给出各值语义（1.0.8 已有，保留）。

### 修复：L2 失败判据对 completed 结算失灵（缺陷 B）

- **实测**：4 条 subagent-settled 全部 `stopReason=completed`，其中探针子代理读不存在文件、正文含 `Error: cannot read … not found`，但 v1.0.8 的 `SETTLEMENT_FAILURE_RE` 只认显式失败变体（failed/was stopped/ran out of room/declined/ended abnormally）→ 全部漏判 → L2 窗口从未开启。
- **修法**（`blackpig-anchor.mjs`）：两层判据——第 1 层保留原显式失败变体；第 2 层新增「completed 结算 + 同块正文内行首级失败证据」（`Error:`/`ERROR:` 行首（m 标志）、宿主级失败词（is unavailable/not resumable，仅结算消息本体）、中文失败回显（命令失败 / exit code: 非零））。
- **误报防护**：证据必须与结算首句在**同一块正文**内；`Error:` 只认行首（句中引用不命中）；普通用户消息里的 Error 不触发（必须先是结算首句形态）。已知残余误报面：子代理把以 `Error:` 开头的日志行作为证据完整引用——有意接受（那种情况多注一条 ~50 token 提醒远优于漏判后重开 worker 的重放成本）。
- 窗口行为不变：5 轮固定 R1→artifact→R1 循环铺满（触发轮 fresh + 后续 4 轮），成功冷恢复提前关窗。

### 修复：完整 UUID 被 1.0.9 自己的判据拒掉（完整 id 直通）

- **问题**：上一轮改动让**完整 UUID 在 resolveName 回弹后被拒**（`id === wanted` 且 `looksLikeIdPrefix` 为真 → 不采信），落到依赖已删 API 的前缀匹配 → 恒 `BLACKPIG_UNRESOLVED_TARGET`。1.0.8 明明可用的「传完整 childSessionId 冷恢复」全断。
- **修法**：新增**第 0 级**——目标本身是完整 36 位 UUID（裸形态 `/^[0-9a-f]{8}-…-[0-9a-f]{12}$/i` 或带 `session-` 前缀形态）时**直接采信原值**：不调 `isKnownId`、不调 `resolveName`、不查任何目录，返回 `how: 'full-id'`。

### 修复：目录读取改用当前版本真实存在的 API

- **根因**：`subagents.listChildren()` **在 DSH v0.2.1-rc.2 已被删除**（归档内 `dsh/docs/upgrade-guide/v0.2.1-rc.2/subagent-service-methods/guide.zh.md:13`）。于是前缀匹配与 `catalogHas()` 恒失败。
- **修法**：`readCallerChildCatalog(ctx, sub, sender, signal)` 单一读法 —— 主路径 `ctx.get('sessionQuery').observeSession(parentId, { signal }).projections?.values.subagentCatalog`（宿主 `listChildren` 自己的实现，`dsh-subagent/lib/index.js:2444-2455`；lease 用 `[Symbol.dispose]()` 释放），退路 `sub.listDescendants(sub.rootOf(sender).id, signal)`（`:3153`）按行上的 `parentId` 过滤直接子会话。**不再有第二条目录读法。**

### 诊断

- `tried` 只记**真正执行过**的来源（1.0.9 在调用前 push，没跑的项也进了报错）。
- `control API: old` 从面向用户的报错里**移除**（该字段不参与任何分支，只会把排查引向「宿主版本不对」）；三探针全失败时 `detectControlApi()` 返回 `CONTROL_API_UNDETERMINED`，原因进内部 warn 日志与 `error.controlApi` 字段。

### 单测（不依赖 DSH，`node` 直跑，对**生产文件**跑）

- 解析层 9/9 PASS：前缀解析 resolved 回显 / `full-id` 直通无噪音 / 0 命中列 ≤3 候选（名字+完整id+mode）/ 名册读不到写 `catalog unavailable` / 混合名册只留本父会话直接子会话 / 409 条名册复现（唯一命中 + 歧义拒绝 + 候选排序稳定）/ `tried` 只含已执行项 / `detectControlApi` 不谎报 old / 报错不含 `control API`。
- 端到端 4/4 PASS：走 `subtalk.mjs` 真实工具注册 → `execute` → `render`，断言**模型实际看到的正文**。

### 2026-11-19 二次修订：名册显示策略（`blackpig-anchor.mjs` L3+）

1.0.9 装机后长会话实测（session-24720769，403~415 个 worker）暴露旧名册注入的三个毛病：
只列 8 条、**按 id 字典序**取前 8（等于随机抽最早期派出的那几个）、**不标运行状态**
（只有 `[可冷恢复]`，看不出 running 还是 inactive）。本轮按 N 分档重做显示策略。

**1. 头部改成分区计数（两种档位都输出）**

```
现存 worker 名册已变化：共 19 个（running 10 / inactive 9 / 可冷恢复 19 个）。
```

- `running` / `inactive` 来自 `listDescendants()` 行上的 `activity`
  （`dsh-subagent/src/list-children.ts:124`）；`activity` 取不到时如实计入 `unknown`
  分区并在行上标 `unknown/…`，**不假装 running**。
- `可冷恢复` = `mode === 'continuable'` 的条数（与旧口径一致）。

**2. 列表改按 N 分档的混合制（不再是固定 8 条）**

| N（名册总行数） | 行为 |
|---|---|
| `N = 0` | **不注入**（空名册没有可提醒的内容，注一句「名册为空」只是噪音） |
| `1 ≤ N ≤ 20` | **全部列出**，不截断、不输出「另有 K 个」行 |
| `N > 20` | 只列**最近 8 个** + 截断行 |

- 排序键一律 `createdAt` **倒序**（最近的在前）。`createdAt` 只能从 `subagentCatalog`
  目录投影 join（`listDescendants` 在 `list-children.ts:121` 把它解构掉了），
  读法同 `compat.readCallerChildCatalog()` 的主路径；**取不到时退化为按 id 升序**并在
  代码注释里写明退化原因。
- 每条格式：`- agent-17 [inactive/可冷恢复]` / `- agent-4 [running]` —— 状态在前，
  一眼看出要不要冷恢复（`running` 的不挂模式尾缀，因为它直接 send 就行）。
- 截断行（仅 `N > 20`）：
  `（完整名册用 list_agents；另有 K 个未列出，其中可冷恢复 J 个）`。
  K = N − 8，J = 未列出部分里 `mode === 'continuable'` 的个数；`K = 0` 时不输出该行。

**3. 变化判据 key 改成含 activity**

旧 key = `[id, resumable]` 的 JSON。`running → inactive` 时 id 集合与 mode 都没变 ⇒ key 不变
⇒ **不重注**，而那恰恰是最该提醒的时刻（一个刚空出来的 worker 变成可复用候选）。
新 key = `SHA-1(JSON([id, activity, mode]))`（只在内存里比对，409 条名册下仍是 40 字符）。

**为什么小名册要全列（数据依据，见设计稿第十二节）**：session-24720769 全程只注入了
**8 次**名册（不是每轮），8 次列 8 条共 2,304 字符 ≈ 1,536 token（按 1.5 字符/token 粗估）；
若当初**全列**，8 次共 99,540 字符 ≈ 66,360 token（27.6 倍）。**但 27.6 倍乘的是一个很小的基数**
——正常会话（≤20 个 worker）全列一次 605 字符（≈207 token 细估 / ≈403 token 粗估），
一次性、不重复，与「完整名单有决策价值」相比完全划算；只有 400+ 条这种规模才必须截断。

**单测 13/13 PASS**（对真实文件跑，走真实 `apply()` → `agent/pre-step` 注册路径，
断言模型实际会看到的注入正文）：19 条全列 / 21 条只列 8 + 截断行含 `list_agents` /
20 条边界全列 / 416 条只列 8 / 空名册不注入 / `running→inactive` 必须重注 /
`activity` 缺失标 `unknown` / `createdAt` 缺失退化 / ≤8 条无截断行 / createdAt 倒序 /
无变化不重注 / listDescendants 抛错不假装空名册 / token 估算。

## 沿革（版本号变更史，不要据此判断装机版本）

- **1.0.9**：本文件当前的版本；2026-11-19 当天先发了 1.0.9，随后因回归紧急装过一版临时编号
  1.0.10（仅当日晚间存在数小时，**从未对外发布**），用户要求「别搞这么多版本」后，
  1.0.10 的全部修复**回并进 1.0.9**，版本号字符串改回 1.0.9，`patches\dsh-blackpig-mode-1.0.9.tgz`
  原地覆盖（旧件存为 `.bak-20261119-1.0.10`）。因此：**若看到 1.0.10 的 tgz/备份目录，
  那是历史上的临时件，内容与当前 1.0.9 等价或更旧，不要回滚到它。**
- **1.0.8**：`blackpig-anchor.mjs` 锚点提醒模块首次落地（L2/L3/L3+）。
- **1.0.9 首发**：缺陷 A/B 修复（resolveName 回弹判据放宽、L2 判据两层）。

