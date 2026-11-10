# 黑猪模式（Black Pig Mode）— DSH agent preset

> **本插件只作用于 `blackpigmodel`。** 用其它模式（DSH 内置的 `minimal` / `standard`，或别的部署自己的 preset）派出的代理，**不受本插件任何约束** —— 本包不改别人模式的语义。

一个 DeepSeek Harness（DSH）的 agent preset：**规划者不持有任何动手工具**。它读不到文件内容、跑不了命令、搜不了网页、抓不了网页，只能拆任务、派活、核对交付、汇总结论。所有实际的读写、命令、搜索都交给子代理去做。

装上之后，你的 DSH profile 里会多出一个名为「黑猪模式」的模式（preset id：`blackpigmodel`）。

---

## 为什么做这个（作者背景）

我是影视导演，不是程序员。**这个插件全程由 AI 编写，我一行代码都没看过。**

我做影视工作流，遇到的核心困难是：**我急需一个干净的上下文。**

刚开始用 `multitask`，但发现**依旧不够干净**。于是只能自己用 AI 做。

做的途中领悟了一件事：**其实根本不需要会话有「读」的功能，它只需要了解它需要的东西。**

做完发现一个人生的真谛：**人生的上下文只有这么长，一定要用大部分时间去做自己愿意做的事。**

技术上怎么落到这套代码上：读文件会吃掉上下文，所以把「读」这件事交给 helper——主对话的 `read` 与 `grep` 一起从工具面上摘掉（留 `grep` 等于留半个 `read`，纪律不成立），只保留两类验证工具：`file_info`（查文件类型 / 是否存在 / 字节数）和 `read_image`（看图）。这个取舍是有意识的：**代价是规划者看不到文件内容**，想知道里面写了什么，只能靠 brief 再派一个人去看，并要求带回行号和原文；**换来的是上下文不被文件内容吃掉**，主对话只承载结论和判断。所以 brief 必须自包含，验证必须换人做，汇报必须带证据——这三条不是风格要求，是这个交换成立的前提。

发出来只是为了让朋友们装起来方便——不是产品，没有客服，也没有维护承诺。代码里会有粗糙的地方，取舍也带着明显的个人偏好。**能用，但别当作品看。**

**如果你的活更复杂，我更推荐你去装 `dsh-multitask`。** 它功能比我这个强大得多，而且是正经维护的。我这个只是个人用的一个极端取舍：把读取工具彻底从规划者手上摘掉，换一个干净的上下文。

---

## 它解决什么问题

主对话上下文是最贵的资源。一个"顺手读一下文件看看"的动作，代价是把整份文件塞进主对话，此后每一轮都要为它付费，直到压缩掉。黑猪模式不是靠提示词劝模型少读，而是**把读的工具从工具面上摘掉**——工具不在，就调不了。

它的四条核心设计：

| 设计 | 做法 | 约束住的是什么 |
| --- | --- | --- |
| 规划者无读取工具 | `guard-v10.mjs` 在大脑自己的 agent scope 上装 `tools.restrict()` + `tools.guard()`，`DEFAULT_KEEP` 共 **27** 个名字，其中 `subagent` / `subagent_fork` 被 `extraDeny` 一票否决（它们留在默认表里只是「撤销 extraDeny 即可恢复」的配置回滚位，**不参与可用计数**），经 `extraDeny` 后**实际可用 25 个**，分七类：核实 2 个（`file_info`（类型/存在性/字节数）、`read_image`）；派活 3 个（`subagent_preset`、`send_to_subagent`、`stop_subagent`）；团队协作 9 个（`spawn_teammate`、`send_message`、`list_agents`、`interrupt_agent`、`wait_agent`、`team_task_create` / `list` / `get` / `update`）；后台任务 3 个（`job_list` / `job_output` / `job_kill`）；长期目标 3 个（`create_goal` / `get_goal` / `update_goal`）；交互与自我管理 4 个（`todo_write`、`present`、`ask_user_question`、`working_directory`）；计划模式条件注册 1 个（`exit_plan_mode`）；**2+3+9+3+3+4+1 = 25** | 强制出信息压缩边界：过程数据进不了主对话 |
| brief 必须自包含 | 队友看不到主对话，只看得到 brief。人格与工具描述都要求「点名文件路径、行号、具体改什么」，禁止「按你刚才的发现去修」 | 派活必须先把信息压成一份可执行的说明书 |
| 验证必须独立 | 主对话只剩 `file_info` 和 `read_image`，能证明「文件存在 / 多大 / 是否为空」，证明不了「里面写了什么」。要问内容，只能再派一个人去看 | 自己验自己会互相印证错误；独立验证要求换人 |
| 汇报必须带证据 | `member-persona.mjs` 强制队友报告四段：结论 / 依据（路径+行号、命令+输出、SHA256 或计数）/ 范围与限制 / 不确定。缺依据的结论，主对话不得转述为事实 | 防止把推测升级成事实汇报给用户 |

派活只有一个入口：`subagent_preset`（由 `blackpig-roster.mjs` 注册），`preset` 参数必填，无默认值。`subagent` / `subagent_fork` 在主对话上被 `extraDeny` 摘掉——因为前者会固定回落到 `agentPreset: "standard"`，后者压根不支持选模式，两条旧路径都会让活派错人且**不报错**。

另一条路是 Agent Teams 的 `spawn_teammate`（只有你的工具表里真有它，才说明团队插件开着）。它和 `subagent_preset` 的区别要说清：**`spawn_teammate` 没有 `preset` 参数**，队友永远继承父会话自己的模式，你没法把它指到别的模式；**但它拿得到该 preset 的完整工具面，确实能干活**（结构性例外：guard 摘掉 `spawn_teammate`、subtalk 摘掉 `stop_subagent`，见下），不是二传手。所以分工是：活需要「某个特定模式」→ `subagent_preset`；活需要「多轮协作、中途纠偏、两个帮手要对表」→ 队友。

---

## 安装（三种，按推荐顺序）

### 1. 首选：直接从 GitHub 装（一条命令，仓库已公开）

```powershell
dsh.cmd plugin --profile <名> add github:tianmingtianming/dsh-blackpig-mode
```

前提：**你的机器上装了 git**（`git --version` 能跑）。本包零依赖、零构建脚本，不需要额外编译步骤。

### 2. 次选：从 Release 装（不需要 git）

```powershell
dsh.cmd plugin --profile <名> add https://github.com/tianmingtianming/dsh-blackpig-mode/releases/download/v1.0.5/dsh-blackpig-mode-1.0.5.tgz
```

### 3. 兜底：本地 tgz（离线、或上面两条都不通时）

先把 tgz 解包到一个目录，在**那个目录里**跑装前只读检查（**6 项编号检查**；`-DryRun` 才额外打印装包影响范围，**不编号**，`Report` 编号最大只到 `6/7`，默认不跑）：

```powershell
.\check.ps1 -Profile <名>
dsh.cmd plugin --profile <名> add <tgz的完整路径>
.\verify.ps1 -Profile <名>
```

> `check.ps1` 与 `verify.ps1` 在解包后的目录里。**装完之后再跑 `check.ps1` 通常仍返回 0（READY）**——它第 4 项会把「已含包名」判为 **INFO（正常升级态）**，不计入 WARN；**只有另有需要清理的项（例如旧名 `dsh-blackpig-model` 残留）才会返回 1（NEEDS-CLEANUP）**。这不是装坏了；装后验证仍请用 `verify.ps1`。

### 装完怎么核对

无论走哪条路，装完后 `check.ps1` / `verify.ps1` 都会落在 `node_modules\dsh-blackpig-mode\` 里，可以直接从那里跑（**普通用户不要加 `-StrictSizes`**：那个开关是维护者本机自检用的，会让文件字节的细微差异变成告警）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<profile目录>\node_modules\dsh-blackpig-mode\verify.ps1" -Profile <名>
```

### 装之前要注意

- **如果走第 3 种方式（已解包），装前建议先跑 `check.ps1`**，它会告诉你 profile 里有没有同名 `blackpigmodel` 声明；它只读、不写任何文件。方式 1/2 免解包安装时拿不到该脚本（`check.ps1` 只随包分发），可装完后用 `verify.ps1` 复核。
- 装完 `dsh` 会在 `profiles\<名>\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都登记 `dsh-blackpig-mode`，并读取本包 `package.json` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 挂载 preset 声明；**它不会改你的 `cordis.patch.yml`**。
- 你需要会用命令行、能重启应用、接受 Windows 优先。

**`check.ps1` 的三个退出码**：

- **`0` = READY**：可以安装。干净 profile（目录存在、还没装过黑猪模式）返回这个。
- **`1` = NEEDS-CLEANUP**：有残留或冲突，按它给出的行号清理后重跑。**注意：装完之后再跑 `check.ps1` 通常仍返回 0（READY）**——第 4 项会把「已含包名」判为 INFO（正常升级态），不计入 WARN；**只有另有需要清理的项（例如旧名 `dsh-blackpig-model` 残留）才会返回 1（NEEDS-CLEANUP）**。装后请改用 `verify.ps1`。
- **`2` = BLOCKED**：环境不满足，**或关键输入读不到、无法判断**——找不到 `dsh.cmd`、**profile 目录根本不存在**、`package.json` 读不到，或 `cordis.patch.yml` patch 读不到、未通过 `check.ps1` 的轻量语法健全性检查（tab 缩进 / 引号成对 / 冒号后空格 / 括号配平 / 顶层结构可识别；**不是完整 YAML 解析**）（脚本仍会跑完剩余检查，只在末尾统一 exit）。全新环境里若报 2，先用 `dsh` 初始化那个 profile（随便跑一条 `dsh.cmd plugin --profile <名> list` 之类），让它把目录建出来再跑。

---

## 验证装好了

装完（建议重启一次以确保生效）后跑：

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 -Profile <你的profile名>
```

它按编号做 **5 条核对（`0/5`–`4/5`）**，最后打印结论文本（**没有 `5/5`**，结论行不编号）：

0. `0/5`：`dsh` 可执行文件（`dsh.cmd`）是否存在
1. 包是否落盘到 `profiles\<名>\node_modules\dsh-blackpig-mode`（**缺件判 FAIL**），并打印包内文件字节：**字节数默认只作参考、不影响退出码**；加 `-StrictSizes` 才按字节判 WARN。`README.md` / `check.ps1` / `verify.ps1` 三个显示 `[SKIP]`，永远不参与（原因见本节末尾）
2. `profiles\<名>\package.json` 的 `dependencies` **或** `optionalDependencies`（二者任一即可）与 `dsh.profile.bundles` 是否都登记了本包
3. `cordis.patch.yml` 里是否还残留旧的 `blackpigmodel` 声明
4. `dsh --profile <名> --dump-config` 的退出码是否为 0，输出里 `preset-blackpigmodel` 命中次数以 **1 + 3/5 已报的残留条数** 为上限：超出上限判 FAIL，落在 1 与上限之间只记 WARN（同一根因不二次判死）
最后汇总并给退出码（此项不编号，直接打印 `结论:` 行与 `exit code:`；`0` 可直接使用 / `1` 有缺件或冲突 / `2` 环境不满足）

关于第 4 项：`desktop` 这个 profile 由 Electron 独占，`dsh` CLI 会硬拒绝 `--dump-config`。此时 `verify.ps1` 会自动在 `%TEMP%` 下建一个影子 profile（复制 `package.json` 与 `cordis.patch.yml`，`node_modules` 用目录联接只读指回真 profile）来复核，跑完立即删除。真 profile 的 `node_modules` 不被写入。

**为什么字节数默认不参与判定，以及为什么有三个 `[SKIP]`。** 字节表是**维护者本机的自检工具**：它锁的是「这份源码打出来的包长什么样」。对**从 GitHub 装包的人**来说，写死字节只有两种结果——恰好相同（没有任何信息量），或者不同（于是被判 WARN、退出码变 1，让人误以为装坏了）。版本一升级、换行符口径一变，这张表必然过期。所以默认只把实际/期望/差值打印出来供参考，**不影响退出码**；维护者本机要严格校验时加 `-StrictSizes`。

`README.md` / `check.ps1` / `verify.ps1` 三个永远 `[SKIP]`：它们随文档与脚本编辑而变，写死自身字节等于每改一次就要改两处，还必然忘。

也**不要**把这里换成 SHA256：换行符口径变化、或副本落后一个版本，SHA 一样对不上——脆弱的根因没变，只是从一种脆弱换成另一种。

**`check.ps1` 是安装前脚本；装完之后再跑它通常仍返回 0（READY）。** 它第 4 项专门查 `package.json` 里有没有黑猪包名，装好之后会把「已含包名」判为 **INFO（正常升级态）**，不计入 WARN；**只有另有需要清理的项（例如旧名 `dsh-blackpig-model` 残留）才会返回 1（NEEDS-CLEANUP）**。这是设计如此，不是装坏了、也不是要你去清理。装后验证请用 `verify.ps1`。

**已知限制：`extraDeny` 若写成行内带注释或跨行数组，`check.ps1` 的流式解析会漏检（这是脚本已知缺陷，勿据此判定安全）。**

**`verify.ps1` 的 exit 2 是真的会发生的**：找不到 `dsh.cmd`、`profiles\<名>` 目录不存在，或关键输入不可读：`package.json` 读不到，或 `cordis.patch.yml` patch 读不到、未通过 `check.ps1` 的轻量语法健全性检查（tab 缩进 / 引号成对 / 冒号后空格 / 括号配平 / 顶层结构可识别；**不是完整 YAML 解析**），这些都由 `-Hard` 标记、最终统一折算成 exit 2；但**标记后仍会继续跑完剩余检查**（脚本只在末尾一处 `exit`），不会提前返回。exit 0 = 可直接使用（`FAIL 0 / WARN 0`），exit 1 = 有缺件或有冲突（任一 FAIL 或 WARN 都算）。

手工确认也可以：

```
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile <你的profile名> --dump-config
```

在输出里搜 `preset-blackpigmodel`，应能看到 `name: '@deepseek-ai/dsh-agent-preset'`，且 `config.id` 是 `blackpigmodel`。或者直接新开一个会话，看模式选择里有没有「黑猪模式」。

---

## 卸载

```
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile <你的profile名> remove dsh-blackpig-mode
```

然后重启 DSH。因为 preset 声明行来自本包的 patch、不写进你 profile 的 `cordis.patch.yml`，所以删包即彻底移除：`dependencies` 与 `dsh.profile.bundles` 两条登记会一起消失，不需要手工清残留。

---

## 已知限制

七条。每条都说清「缺了会怎样」。

**1. 大脑没有第三方插件提供的工具（本包不写死任何第三方工具名）。**
典型例子：装了记忆插件（如 `dsh-mnemon`），它的记忆协议仍会被宿主**无条件注入**到系统提示里（`dsh-mnemon/lib/index.js` 的 `mnemon:routing` 与 `mnemon:strategy` 两段：前者可用 `routingGuidance:false` 关掉一句，后者随 View 无条件注入、**没有开关**），但那些工具会被 guard 从大脑工具面上摘掉。结果是大脑会看到「用记忆工具」的提示却调不到它们——**这是已知噪音，不是故障**。要查历史、写记忆，派子代理去做（子代理保留完整工具面）。
如果你想让大脑自己拥有某些第三方工具：把工具名加进 `cordis.patch.yml` 里 `blackpig-guard` 的 `config.keep`（**精确名字匹配，不支持通配**）。注意 `keep` 一旦改动就要自己维护，且 profile 侧覆盖 preset config 是**整体替换不是合并**。
*缺了会怎样*：不配 `keep` 就是上面那段噪音，其余一切照常；配错的工具名不命中任何实际注册的工具，guard **静默忽略**，不崩、不报错。

**2. 本包是 DSH 专用，换平台不通用。**
它依赖 DSH 自己的 bundle / patch / agent-preset 三套机制：`dsh.bundle.patch` 挂载、`cordis-plugin-include` 的 patch 方言（`insert` + `!!js`）、`@deepseek-ai/dsh-agent-preset` 的声明行格式（`id` / `name` / `plugins`，可选 `order` / `description`）。它还读取宿主的 agent scope 工具面 API。
*缺了会怎样*：Claude Code、Codex、Cursor 等平台不能直接装。要用得另写一层移植，本包一行代码都复用不上。

**3. 装完建议重启一次以确保生效（HMR 可能自动重组，但不保证）。**
`dsh-hmr` 会监视 profile 的 `package.json`（`dsh-hmr/lib/index.js:849,873`）：`dsh.profile.bundles` 一变就触发 `reconcileProfile()` → `recomposeProfile()` 自动重组；UI 的插件页开关走 `publishAndReload` → `hmr.reconcileProfile`，同样直接生效。**但不要指望它**：HMR 可能自动重组、也可能没重组，装完重启一次最稳（本流程以重启为准）。已经开着的会话和它们的子会话会保留自己启动时那份插件 revision。
*缺了会怎样*：重启一次就都好了；HMR 万一自动重组了也不冲突。不重启且 HMR 没重组，就是「装了但看不到黑猪模式」，`--dump-config` 里也不会有它。这不是装失败。

**4. profile 里已存在同名 `blackpigmodel` 声明会让装载失败。**
preset id 固定是 `blackpigmodel`，不能两个 bundle 各声明一次。会报 `Duplicate agent preset: blackpigmodel`，整个模式从选择器里消失。
*缺了会怎样*：不先删旧声明就装，必然失败。`check.ps1` 的第 3 项专门查这个并报行号，**装之前先跑它**。清理时要从 `- insert:` 一路删到它的内容结束（下一个顶层 `- id:` 之前），包括 `keep:`、`extraDeny:` 这些子项，别留半个。

**5. 需要 DSH 桌面版 CLI（`dsh.cmd`）。**
桌面版 profile 由 `dsh-desktop-host` 管理。在命令行裸跑 `node bin.js` 走的是另一条路径，会被 `rejectElectronProfile` 拒绝。
*缺了会怎样*：用裸 node 装，报 `rejectElectronProfile`，装不上。另外 `desktop` 这个 profile 还被 Electron 独占，`--dump-config` 也读不了（`verify.ps1` 会自动改用影子 profile 绕过去）。

**6. 包目录路径不能直接 `add`。**
**别用「包目录路径」去 add**（例如 `add file:C:\path\to\dsh-blackpig-mode`），会装成 Junction / 软链，源目录一删一挪就坏。**用 `.tgz` 文件路径或远程 URL 都行。**
*缺了会怎样*：源目录一删、一挪、一改，装好的模式立刻坏掉，而且报错方式取决于坏在哪一步，很难查。

**7. 本地 `file:` 指向 tgz 装时，要放进 `optionalDependencies`。**
**如果你用本地 `file:` 指向 tgz 安装**：请把这条依赖放进 `optionalDependencies`，不要放进 `dependencies`。否则那个 tgz 一旦被删除或挪走，`pnpm install` 会整体失败（`ENOENT`，exit `-4058`），**连装别的插件也装不了**。放进 `optionalDependencies` 后，pnpm 只跳过它、其余照装（已实测：tgz 不存在 + 有/无 lockfile、远程 URL 404，三种情形均为 exit 0）。

---

## 文件说明

12 个条目，一句话一个（其中三个不参与字节校验，见下）：

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 整套 preset 声明：1 个 `insert`，25 个顶层插件行（其中 2 个是 `cordis:group`，组内还有 4 行），人格前缀整段内联在这里 |
| `guard-v10.mjs` | 大脑的工具面收窄与硬拦：`deny = 可见集 − 保留集`，只在大脑自己的 agent scope 上装；另有**两处结构性摘除**作用于队友（guard 摘 `spawn_teammate`、subtalk 摘 `stop_subagent`），那不是收窄 |
| `compat.mjs` | **委派控制接口兼容层**：`detectControlApi` / `callSendMessage` / `resolveTargetId` / `applyToTools`。旧宿主的 `agent_id` 与新宿主的 `agent`（名字）在这里归一化，调用点不再各判一遍版本 |
| `blackpig-roster.mjs` | `subagent_preset` 工具 + 代理名册：列出每个模式的能力标签，支持 `list` / `ask` / `detail` 三种查询 |
| `subtalk.mjs` | `send_to_subagent` / `stop_subagent`：与已派出的代理继续对话或叫停，冷恢复它自己的上下文 |
| `file-info.mjs` | `file_info`：只 stat 不读内容，给类型 / 存在性 / 字节数，一次调用可覆盖一组路径 |
| `member-persona.mjs` | 子会话人格覆盖：把「你不能动手」换回干活的人格，按 agent scope 注册、只覆盖继承本 preset 的子会话 |
| `package.json` | `dsh.bundle.patch` 声明 + `"exports": { "./*": "./*" }` 子路径映射 |
| `README.md` | 本文件（不参与字节校验） |
| `check.ps1` | **装前**只读检查（**6 项编号检查**；`-DryRun` 才额外打印装包影响范围，**不编号**，`Report` 编号最大只到 `6/7`，默认不跑），发现同名声明时报行号并 exit 1。装完之后再跑它通常仍返回 0（READY）：「已含包名」判为 INFO（正常升级态），只有另有需清理项（如旧名 `dsh-blackpig-model` 残留）才返回 1（不参与字节校验） |
| `verify.ps1` | **装后**生效验证（编号 0/5–4/5；无 5/5，结论行不编号）：包落盘（缺件判 FAIL）、`bundles` 登记、`dump-config` 退出码；包内文件字节以**参考信息**打印，**默认不影响退出码**，加 `-StrictSizes` 才按字节判；`README.md` / `check.ps1` / `verify.ps1` 三个恒 SKIP |
| `LICENSE` | MIT 许可证全文 |

逐文件字节数不写在这张表里：包内的 `verify.ps1` 有一份内置参考值表，本表抄一份只会过期。要核对就运行 `verify.ps1`，第 1 项会逐个打印实际字节与参考值的差值——**它只是参考，不会让退出码变红**（要严格判就加 `-StrictSizes`）。

三个 `[SKIP]` 的理由：`README.md` 随文档改动而变；`check.ps1` / `verify.ps1` 本身会随编辑变化（当前 `.gitattributes` 为 `*.ps1 text eol=lf`，入库与打包的换行符口径都是 LF，不会因换行符变形；但已安装副本可能落后于源码，版本不同也不是字节比对能兜住的）。它们的字节数即使写对也很快过期，所以干脆不参与。

两点容易踩：

- `package.json` 里的 `"exports": { "./*": "./*" }` **不能删**。preset 挂载时 baseUrl 是 profile 根，5 个本地插件是以 `dsh-blackpig-mode/xxx.mjs` 这种子路径解析到本包的，靠的就是这条 exports。
- 对外挂载的插件用包名子路径解析（`dsh-blackpig-mode/xxx.mjs`）；包内相对引用只有一条：`subtalk.mjs` → `compat.mjs`（`./compat.mjs`），指向同目录、随包一起分发，所以整个包仍可整体搬运。**打包时 `compat.mjs` 必须在 `package.json` 的 `files` 里**，漏了会在装载时直接 `ERR_MODULE_NOT_FOUND`。

---

## 这是给谁用的

写清前提，缺一条就别装：

- 你**已经在用 DSH**，且用的是桌面版（有 `dsh.cmd`）。
- 你**会用命令行**：本包的安装、检查、验证都是命令行操作，没有图形界面入口。
- 你**能重启应用**：装完建议重启一次以确保生效（HMR 可能自动重组，但不保证，本流程以重启为准）。
- 你**知道自己要的是哪种取舍**：你愿意用「看不到文件内容」换「主对话上下文不被过程数据吃掉」。如果你的活主要是自己读代码、自己改小文件，这个模式会让你更慢。
- 你**接受 Windows 优先**：两个 `.ps1` 脚本用的是 PowerShell，`dsh.cmd` 的路径也按 Windows 写的。`.mjs` 插件本身没有平台绑定，但脚本这块没做跨平台。

---

## 不是什么

- **不是通用框架。** 它没有抽象层、没有插件目录、没有"接入你自己的后端"的口子。它就是一套针对 DSH 这个特定平台的声明和 5 个插件。
- **不是插件市场里的产品。** 没有版本发布流程、没有兼容性矩阵、没有客服。`1.0.0` 是作者本地部署切出来的一个快照（`1.0.1` 修复了 GUI fork 会话被误判为子会话的 bug，详见下方「变更记录」）。
- **不保证跨平台。** 见上一节最后一条。
- **不包含记忆功能。** 本包**不写死任何第三方工具名**；别的包（如记忆插件）提供的工具不在大脑的工具面上，要放行由你自己往 `keep:` 里加。本包自己没有任何记忆、存储、检索实现。
- **不包含 MCP 服务。** 一个都没有。
- **不包含任何影视业务流程。** 没有分镜、没有渲染、没有素材管理。模式里的"派活"是通用的 agent 编排，跟具体行业无关。
- **不是"更好的模型"。** 它只改工具面和人格，不改模型能力。规划者变笨的地方，它一点忙都帮不上。

---

## 变更记录

### v1.0.5

**人格：新增一条 —— 「声称做过某事」必须手上有可核对产物，否则不许这么写。**

- 症状（这条规则要防的）：协调者（大脑）在回复里写「已派人去查了」，但实际上**从未发起任何调用**——只是把承诺当成事实写进了回复，用户追问三次才暴露。根因是拿「自我印象」当判据（觉得自己派了），这是**自证式判据**，必然静默失效；而且当时并没有任何失败的调用，所以「工具失败 = 改派」那条**管不到**它。
- 修法：人格里**新增**一段 `**A claim of action requires an artifact.**`，紧跟在 `**A failed tool call is not a result — it is a delegation trigger.**` 之后（同一主题：不许把非事实当结果）。规则不写「要记得验证」（那还是自证判据），而是**报某状态就必须拿出该动作的产物**：派活必须拿到 `childSessionId`、写文件必须有写入回执、跑命令必须有输出；拿不出产物就不要写那句话，改成描述「我接下来要做什么」。原文末句：*A promise in prose is not an action, and treating it as one is how work silently disappears.*
- 未改动的部分：只加这一段，人格其余各段与队友人格（`member-persona.text`）一字未改。
- 已知代价：人格正文（`persona.prefix`）+558 B 字符口径（7,695 → 8,253 B，同一量法）；`cordis.patch.yml` 37,395 → **37,953 B**（`verify.ps1` 内置期望表已同步）；打出的 tgz 203,498 B。

### v1.0.4

**人格：派活选模式按「所需能力」选最小档，不按任务难度 —— 每个模式都同样聪明，只是能力范围不同。**

- 症状（这条规则要防的）：把「任务重要 / 难 / 复杂」当成「该抬档」的理由，于是派活时选了一个能力更大、工具更多的模式，活本身并不需要那些工具，只是白背一堆用不上的工具面。
- 修法：大脑人格里**改写**了原有的 `Pick the mode by capability, never by name` 这一段（不是新增一段重复规则），标题改为 `Pick the mode by capability, never by difficulty — and never by name`，并明确：难不代表所需能力多；抬档不会让活干得更好；只问一句「这活需要哪些额外能力」，没有就用最小档；「重要 / 看起来很难」**不是**抬档理由（这是反面示例，已在同一段里明写禁止）。
- 不写死任何模式名或能力清单（不出现具体模式 id、参数名、能力词表）—— 模式清单会改名、会增删。段落里出现的 `harness-dev` / `plugin-admin` / `plugin-market` 是**改前就有的**危险能力标签，本次未改动、也不算模式名。
- 队友人格（`member-persona.text`）里的同名段落**未改**：那条是给队友「再往下派活」用的，本次只动大脑。
- 已知代价：`verify.ps1` 里 `cordis.patch.yml` 的期望字节数随本次重新打包同步更新（**具体数字见脚本内置表，本文不再抄写——抄一次就会过期**）。
- **同版另修（面向所有 GitHub 下载者的通用性）**：
  - 清掉仓库文档里写死的**本机绝对路径与用户名**（源码目录、CLI 安装位置原本写成了某台机器上的完整路径），改用相对路径与 `%LOCALAPPDATA%` 这类环境变量——**换一台机器照样成立**。
  - `COLD-START-HANDOFF.md` 顶部加读者定位说明：它被本文件公开指向，但它是**维护者交接手册**，只想安装的读者看完 README 即可。
  - `verify.ps1` 的内置字节表**降级为参考信息，默认不再影响退出码**（新增 `-StrictSizes` 供维护者严格自检）。理由见上文「为什么字节数默认不参与判定」。
  - 修掉一处过期安装指引（原文指向旧 tag `v1.0.3`），统一指向 `v1.0.4` 的 Release 资产。

### v1.1.0（内部草稿号，**从未发布**，勿据此选版本）

> 说明：`1.1.0` 这个号是当时写错的一个内部草稿号，**没有任何 Release、npm 包内也不是这份字节**。此后版本号回落到 1.0.3 → 1.0.4。安装请一律以 `package.json` 的 `version` 与 GitHub Release 页面为准。

**新增：委派控制接口的版本兼容层（`compat.mjs`）+ `restrict()` 的失败保护 —— 防 DSH 下一版静默搞坏。**

DSH 下一版（master，未发版）把委派控制接口改了两件事，任何一件都能让本包**静默**出错而不是报错：

- **入参改名且语义变了**：`send_message` / `interrupt_agent` 的 `agent_id`（会话 id）→ `agent`（**名字**，走 `ctx.subagents.resolveName()`）。
- **`list_agents` 返回结构变了**：`{kind,id,label,status}` → `{name,status,description}`，没有 `id`、没有 `kind`；入参也从 `{scope}` 变成 `{}`，且总是列整棵树。

注：`wait_agent` 在 rc.1 的团队插件里已注册（不是 master 才新增），master 变的是控制版参数与返回结构；`SUBAGENT_CATALOG_VERSION` 是 master 的模块级常量；rc.1 宿主侧是本地 catalog `version:0` 与 `EXTERNAL_SUBAGENT_CATALOG_VERSION=2`（**宿主常量，不由本包定义**）；本包 `compat.mjs` 其中三个常量是 `CONTROL_API_OLD` / `CONTROL_API_NEW` / `UNRESOLVED_TARGET`（另有 6 个函数导出，见下）。

最危险的是 `status`：老代码把未知 / 缺失的 status 原样往下传时，`undefined` 会被当成正常值继续参与判断，「目标不存在」和「目标在跑」变得无法区分 —— 不抛错，只是答案悄悄变错。

- **一个归一化点**：新增 `compat.mjs`，9 个导出（3 个常量 + 6 个函数）—— `readCatalogVersion`（读 catalog 版本：只采信探针对象自有属性上的 `SUBAGENT_CATALOG_VERSION` / `catalogVersion`，泛名 `version` 只在明确的 `subagentCatalog` 句柄上采信）、`detectControlApi`（探测走哪套：以 `ctx.tools.get('send_message').parameters.properties` 里有没有 `agent` 键为主判据，`SUBAGENT_CATALOG_VERSION` 为辅；`wait_agent` 存在与否**明确不作判据**，因为 rc.1 的团队插件就已经注册了它）、`resolveTargetId`（名字 / id 都接受，解析不出就抛）、`callSendMessage`（唯一的发送入口，名字先解析成 id 再调服务层）、`targetOf`（取调用入参里的目标，空值与冲突都响亮报错）、`applyToTools`（让工具同时接受 `agent` 与 `agent_id`，`message` 必填）。
- **失败必须响**：探测不出结论时按旧版走，但记 `warn` 并列出每个判据各自的失效原因；目标既不是已知 id 也无法按名字解析 → 抛 `BLACKPIG_UNRESOLVED_TARGET`，**不把原字符串当成功往下传**。
- **落在真实调用层**：`subtalk.mjs` 的 `send_to_subagent` / `stop_subagent` 改成「解析一次 → 用同一个 id 探查、中断、发送」，没有新建平行调用链；解析走 `compat.resolveTargetId`，发送走 `compat.callSendMessage`。渲染文案改用 `targetOf(args)`，新宿主下不会再渲染出 `undefined`。
- **`restrict()` 不再能把插件构造带崩**：`dsh-tools` 的 `restrict()` 遇到当时还没注册的工具名会直接抛错（历史「改个 deny 列表插件就不启动」的成因）。现在 `guard-v10.mjs` 在调用前先与 `view(scope).restrictableNames` 求交，未知名单独记 `error`；整条调用包 `try/catch`，错误原文带 scope 与 deny 列表一起记 `error`。**捕获不等于成功**：结局写进可观测状态 `guardInstallStatus()`（`engaged` / `degraded` / `unprotected`），并在非 `engaged` 时往 Lead 的首条上下文注入一次提示，让模型知道「可见的工具面不可信、这些工具调了会被拒」。
- **向后兼容**：新旧两套契约都走同一条代码路径，判据是宿主自己的 schema，不是版本号字符串；旧配置格式完全不变，旧用户升级后行为不变。
- **打包注意**：`compat.mjs` 已加入 `package.json` 的 `files`；逐文件期望字节以 `verify.ps1` 内置表为唯一权威，本表不重复抄写。

### v1.0.2

**修复：大脑调用自己工具面里没有的工具、被 guard 拒绝后，不作为、直接收尾。**

- 症状：大脑去调一个不在它工具面上的工具（例如记忆插件注入的 `mnemon_runtime_memory`），被 `blackpig-guard` 以 `not on the coordinator's tool surface` 拒掉，之后**既不派活也不告诉用户**，直接把这一轮收尾掉。实测一例：失败发生 → **152 秒后用户不得不开口追问** → **91 秒后才改派**，总 **243.6 秒**，且**必须用户介入**才派出活来。
- 根因：人格里没有「工具失败必须改派」这条规则；离它最近的一条只覆盖「你根本没有这个工具」这一种情形，而且被放在段尾，没有和「可以收尾 / 可以汇报」形成对立，所以模型读到的信号是「这一步不该我做」而不是「这一步还欠着用户」。
- 修法：人格新增一段 **`A failed tool call is not a result — it is a delegation trigger`**，要求**同一个 turn 内**改派 helper，并且 brief 里必须装进失败的那次原样调用与错误原文，改派之后还要说出派了什么；明确规定失败可以上报、不可以丢弃。
- 不受影响：工具面、guard 白名单、判据逻辑均未变；只改人格文本。
- 已知代价：`verify.ps1` 里 `cordis.patch.yml` 的期望字节数已同步更新到本次实测值。

### v1.0.1

**修复：GUI fork（分叉）出来的会话被误判为子代理，导致大脑工具面被放开、人格被换成 WORKER。**

- 症状：在界面上对一条黑猪会话做「分叉 / 分支」后，新会话的工具表从 25 个变成 65 个（含 `pwsh` / `read` / `write` / `edit` / `glob` / `grep`），系统提示从大脑人格变成 `You are a WORKER on a work team, not the coordinator.`，于是大脑可以自己跑命令。
- 根因：fork 产出的会话 header 是 `isSeeded: true` + 非空 `parentSession` + **无** `origin` + `delegationDepth: 0`；而 `guard-v10.mjs` / `member-persona.mjs` / `subtalk.mjs` 三处 `isDelegatedChild()` 把「有 `parentSession`」单独当成「是子会话」，`guard` 于是对它 `release()` 卸掉收窄、`member-persona` 又把它的人格换成 WORKER。真子代理是 `origin: 'subagent'` + `delegationDepth >= 1`，两者形态不同，这是判据没区分开的地方。
- 修法：三处 `isDelegatedChild()` 改成同一口径——`origin === 'subagent'` → true；`delegationDepth > 0` → true；`isSeeded === true` → **false**（fork 会话是新的一条根，`parentSession` 只是历史来源）；最后才兜底「有非空 `parentSession`」。另在 `guard-v10.mjs` 的 `teamMembershipOf()` 里对「种子会话 + 非 subagent + 无委派深度」提前 `return undefined`，避免它被丢进 `tryMembership` 误判成 Team 成员。
- 不受影响：真子代理与真队友（含 `spawn_teammate(context: "fork")`——它也带 `isSeeded: true`，但同时带 `origin: 'subagent'` 与 `delegationDepth >= 1`，被排除条件放过）行为不变；根会话行为不变。
- 已知代价：`verify.ps1` 里 `guard-v10.mjs` / `subtalk.mjs` / `member-persona.mjs` 的期望字节数已同步更新到本次实测值。

### v1.0.0

首个公开发布版本。

---

## 参考与致谢

这套东西不是凭空造的，主要参考了两处。

**一是第三方插件 `dsh-multitask@1.2.25`（社区包，GitHub 仓库 `https://github.com/Senguk520/dsh-multitask`，从 GitHub 安装，DSH 并不自带它）。** 要说清楚：**万分感谢它。** 它让我第一次看到"一个模式可以是一整个 bundle"这件事该怎么做——自己的 `cordis.patch.yml`、自己的 preset 声明、自己的协调者工具收窄，这套骨架就是从它身上学的。安装方式（`dsh plugin add` 一条命令、不碰用户自己的配置）也是照它的路子。

需要说清：它不是 DSH 内置模式，而是独立的 npm 包 `dsh-multitask`，靠 profile 的 `dependencies` 与 `dsh.profile.bundles` 引入；本包里提到的版本是 `1.2.25`，其他版本的行为可能不同。

学完之后我发现一件事：`dsh-multitask@1.2.25` 的协调者保留了 `read` / `grep` / `glob`（这一条在 1.2.25 上实测成立）。我照着用了一段时间，上下文还是被文件内容吃掉。所以这一版把读的工具整个摘掉，只留「查文件类型/是否存在/字节数」和「看图」两类验证。**这不是说它做得不对——它的取舍是对的，只是我要的比它更极端。**

**二是 DSH 的官方文档与代码。** 下列内容是照官方口径写的，不是猜的：

- `@deepseek-ai/dsh-agent-preset` 的声明行格式（`id` / `name` / `plugins`，可选 `order` / `description`）—— 来自 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`：「Agent presets are ordinary `@deepseek-ai/dsh-agent-preset` declarations carried by bundle patches.」
- bundle 的 `dsh.bundle.patch` 挂载机制 —— 来自 `dsh-app-boot` 与官方 `docs/user/develop/basic/publish.md`
- 「Spawn 才支持独立 `agentPreset`，省略或 fork 继承父会话的组合」—— 来自 `docs/subsystems/subagent.md`
- guard 的 `keep` / `extraDeny` 语义，以及 `deny = 可见集 − 保留集` 这个判据 —— 本项目 `guard-v10.mjs` 实现，行为照 DSH 的 agent scope 工具面 API

---

## English summary

`dsh-blackpig-mode` is an agent preset for DeepSeek Harness (DSH). The coordinator agent holds **no hands-on tools**: no file reads, no shell, no web search or fetch. Its only verification surface is `file_info` (file kind, existence, byte count) plus `read_image`. All actual work is delegated to subagents through a single required-argument tool, `subagent_preset`.

### Origin

I am a film director, not a programmer. **This plugin was written entirely by AI. I have never read a line of the code.**

I work on film and video workflows, and the core difficulty I hit was this: **I badly needed a clean context.**

At first I used `multitask`, but found it **still not clean enough**. So I had to build it myself with AI.

Along the way I understood one thing: **a session does not actually need a "read" capability at all — it only needs to know the things it needs to know.**

When it was done I realised something about life: **a person's context is only so long, so most of your time has to go to what you are willing to do.**

I published it only so my friends could install it easily. It is not a product: no support, no maintenance promise.

**If your work is more complex, I would recommend `dsh-multitask` instead.** It is far more capable than mine, and it is properly maintained. Mine is just one extreme personal trade-off: taking every read tool away from the coordinator in exchange for a clean context.

Design intent: keep the main conversation's context free of process data. The coordinator compresses what it needs into a self-contained brief, delegates, and relays only conclusions that carry evidence. Verification must be done by someone other than the author of the work.

Cost, stated plainly: the coordinator cannot see file contents. To learn what a file says it must spend another round trip. This is a deliberate trade, not a bug.

Install, three ways in order of preference: `dsh.cmd plugin --profile <name> add github:tianmingtianming/dsh-blackpig-mode` (needs git); the v1.0.5 Release tarball URL (no git needed); or a local `.tgz` path after unpacking it and running `check.ps1` first. Full steps are in the Chinese section above.

`check.ps1` exit codes: **0 = READY**, **1 = NEEDS-CLEANUP**, **2 = BLOCKED** (no `dsh.cmd`, or the profile directory does not exist yet — initialize the profile first). Re-running `check.ps1` *after* a successful install normally still returns **0 (READY)**: item 4 treats "package name already present" as **INFO (normal upgrade state)** and does not count it as a WARN. It returns **1** only when something else still needs cleaning up (for example a leftover old name `dsh-blackpig-model`); use `verify.ps1` for post-install verification.

Windows-first, DSH-only, requires the desktop CLI (`dsh.cmd`); restarting once after install is recommended to be sure it takes effect (HMR may recompose the profile when `dsh.profile.bundles` changes, but do not rely on it). MIT licensed.

Built with heavy reference to **`dsh-multitask@1.2.25`**, a **third-party community plugin** (`https://github.com/Senguk520/dsh-multitask`) installed from GitHub — it is **not** bundled with DSH (with thanks), and to the official DSH docs on agent presets and bundles.

---

## 许可

MIT，见 [LICENSE](LICENSE)。5 个 `.mjs` 插件与人格文本来自作者的本地 DSH 部署，随包原样分发。
> 无记忆接手本插件：仓库根有 `COLD-START-HANDOFF.md`（**不在 npm 包内**，只在 GitHub 仓库里）；装包后请到仓库查看。
