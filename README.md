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

技术上怎么落到这套代码上：读文件会吃掉上下文，所以把「读」这件事交给 helper——主对话的 `read` 与 `grep` 一起从工具面上摘掉（留 `grep` 等于留半个 `read`，纪律不成立），只保留只读验证工具：`file_info`（查类型 / 存在性 / 字节数；`list: true` 列目录条目名）与 `read_image`（看图）；后台任务三件套 `job_list` / `job_output` / `job_kill` 已于 v1.0.10（2026-11-22）一并从保留集摘除，大脑不再能查看后台任务原始输出。这个取舍是有意识的：**代价是规划者看不到文件内容**，想知道里面写了什么，只能靠 brief 再派一个人去看，并要求带回行号和原文；**换来的是上下文不被文件内容吃掉**，主对话只承载结论和判断。所以 brief 必须自包含，验证必须换人做，汇报必须带证据——这三条不是风格要求，是这个交换成立的前提。

发出来只是为了让朋友们装起来方便——不是产品，没有客服，也没有维护承诺。代码里会有粗糙的地方，取舍也带着明显的个人偏好。**能用，但别当作品看。**

**如果你的活更复杂，我更推荐你去装 `dsh-multitask`。** 它功能比我这个强大得多，而且是正经维护的。我这个只是个人用的一个极端取舍：把读取工具彻底从规划者手上摘掉，换一个干净的上下文。

---

## 它解决什么问题

主对话上下文是最贵的资源。一个"顺手读一下文件看看"的动作，代价是把整份文件塞进主对话，此后每一轮都要为它付费，直到压缩掉。黑猪模式不是靠提示词劝模型少读，而是**把读的工具从工具面上摘掉**——工具不在，就调不了。

它的四条核心设计：

| 设计 | 做法 | 约束住的是什么 |
| --- | --- | --- |
| 规划者无读取工具 | `guard-v10.mjs` 在大脑自己的 agent scope 上装 `tools.restrict()` + `tools.guard()`，`DEFAULT_KEEP` 共 **21** 个名字，其中 `subagent` / `subagent_fork` 被 `extraDeny` 一票否决（它们留在默认表里只是「撤销 extraDeny 即可恢复」的配置回滚位，**不参与可用计数**），经 `extraDeny` 后**实际可用 19 个**，分七类：核实 1 个（`file_info`：类型/存在性/字节数；`list: true` 列目录条目名）；看图 1 个（`read_image`）；派活 3 个（`subagent_preset`、`send_to_subagent`、`stop_subagent`）；团队协作 7 个（`send_message`、`list_agents`、`interrupt_agent`、`team_task_create` / `list` / `get` / `update`；`spawn_teammate` / `wait_agent` 已于 2026-11-24 从保留集删除——后者只等自己收件箱的输入、无 target、不能替代完成通知）；长期目标 3 个（`create_goal` / `get_goal` / `update_goal`）；交互与自我管理 3 个（`todo_write`、`present`、`ask_user_question`）；计划模式条件注册 1 个（`exit_plan_mode`）；**1+1+3+7+3+3+1 = 19** | 强制出信息压缩边界：过程数据进不了主对话 |
| brief 必须自包含 | 队友看不到主对话，只看得到 brief。人格与工具描述都要求「点名文件路径、行号、具体改什么」，禁止「按你刚才的发现去修」 | 派活必须先把信息压成一份可执行的说明书 |
| 验证必须独立 | 主对话只剩 `file_info` / `read_image`：`file_info` 列有哪些名字（`list: true`）并验大小与存在性、`read_image` 看图；`job_output` 自 v1.0.10（2026-11-22）起已不在保留集；三者全都证明不了「文件里写了什么」。要问内容，只能再派一个人去看 | 自己验自己会互相印证错误；独立验证要求换人 |
| 汇报必须带证据 | 大脑在派活的 brief 里要求回报四段：结论 / 依据（路径+行号、命令+输出、SHA256 或计数）/ 范围与限制 / 不确定。缺依据的结论，主对话不得转述为事实 | 防止把推测升级成事实汇报给用户 |

派活只有一个入口：`subagent_preset`（由 `blackpig-roster.mjs` 注册），`preset` 参数必填，无默认值。当本会话已有可续（`continuable`）worker 时，还必须显式二选一：`reuseId`（冷恢复既有 worker，不新建）或 `fresh: true`（明确新开）；都不传会被拒并回 ≤3 个候选（候选只在被拒时出现，正常路径零新增 token）。没有可续 worker 时无需传这两个参数。`subagent` / `subagent_fork` 在主对话上被 `extraDeny` 摘掉——因为前者会固定回落到 `agentPreset: "standard"`，后者压根不支持选模式，两条旧路径都会让活派错人且**不报错**。

锚点提醒模块的 L2/L3/L3+ 每轮/周期机器注入已于 2026-11-24 下架（`blackpig-anchor.mjs` 删除），复用纪律改由上面的工具侧硬判据强制；L1 静态人格句 `**Reuse by default.**` 保留。

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
dsh.cmd plugin --profile <名> add https://github.com/tianmingtianming/dsh-blackpig-mode/releases/download/v1.0.6/dsh-blackpig-mode-1.0.6.tgz
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

**7. 依赖该放 `optionalDependencies` 还是 `dependencies`，取决于安装方式。**
**如果你用本地 `file:` 指向 tgz 安装**：请把这条依赖放进 `optionalDependencies`，不要放进 `dependencies`。
否则那个 tgz 一旦被删除或挪走，`pnpm install` 会整体失败（`ENOENT`，exit `-4058`），**连装别的插件也装不了**。
放进 `optionalDependencies` 后，pnpm 只跳过它、其余照装（已实测：tgz 不存在 + 有/无 lockfile、远程 URL 404，三种情形均为 exit 0）。

**从 GitHub Release URL 正式安装时**：用 `dsh plugin add <URL>`，pnpm 会写进 `dependencies`——
这是插件页出现「已安装插件」卡片和启用/停用开关的前提。若手工写进 `optionalDependencies`，
插件页连卡片都不会显示（虽然功能正常）。

> 为什么两种场景结论相反：宿主判定 `installed = dependencies.includes(name)`，**只读 `dependencies`**，
> `optionalDependencies` 不算。写在后者里 ⇒ 插件页那张卡片和开关**根本不会渲染**。

---

## 文件说明

13 个文件（无子目录；r5 删 `lib/client.js`、r6 删 `defaults/` 与 `docs/` 两个文件，2026-11-24 删 `blackpig-anchor.mjs`），一句话一个（其中三个不参与字节校验，见下）：

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 整套 preset 声明：1 个 `insert`，26 个顶层插件行（其中 2 个是 `cordis:group`，组内还有 4 行），人格前缀整段内联在这里 |
| `guard-v10.mjs` | 大脑的工具面收窄与硬拦：`deny = 可见集 − 保留集`，只在大脑自己的 agent scope 上装；另有**一处结构性摘除**作用于队友（subtalk 摘 `stop_subagent`），那不是收窄 |
| `compat.mjs` | **委派控制接口兼容层**：`detectControlApi` / `callSendMessage` / `resolveTargetId` / `applyToTools`。旧宿主的 `agent_id` 与新宿主的 `agent`（名字）在这里归一化，调用点不再各判一遍版本 |
| `blackpig-roster.mjs` | `subagent_preset` 工具 + 代理名册：`list: true` **优先从活注册表派生**（`agentPresets.acquireScope` + `tools.view` + `skills.list`）；接口缺失时报 `live roster unavailable`；派活走活的注册表校验 |
| `subtalk.mjs` | `send_to_subagent` / `stop_subagent`：与已派出的代理继续对话或叫停，冷恢复它自己的上下文 |
| `file-info.mjs` | `file_info`：只 stat 不读内容，给类型 / 存在性 / 字节数；`list: true` + `path` 时列目录直接子条目（200 条 / 8 KB 硬顶、不递归），已取代原 `ls` |
| `section-mute.mjs` | 在 preset scope 注册**空文本段**，遮蔽全局 `harness:source` / `app:web-surface` 两个 prompt 段（空文本段被宿主渲染丢弃）；任何异常只记日志、不影响启动 |
| `package.json` | `dsh.bundle.patch` 声明 + `"exports": { "./*": "./*" }` 子路径映射 |
| `README.md` | 本文件（不参与字节校验） |
| `check.ps1` | **装前**只读检查（**6 项编号检查**；`-DryRun` 才额外打印装包影响范围，**不编号**，`Report` 编号最大只到 `6/7`，默认不跑），发现同名声明时报行号并 exit 1。装完之后再跑它通常仍返回 0（READY）：「已含包名」判为 INFO（正常升级态），只有另有需清理项（如旧名 `dsh-blackpig-model` 残留）才返回 1（不参与字节校验） |
| `verify.ps1` | **装后**生效验证（编号 0/5–5/5）：包落盘（缺件判 FAIL）、`bundles` 登记、`dump-config` 退出码；包内文件字节以**参考信息**打印，**默认不影响退出码**，加 `-StrictSizes` 才按字节判；`README.md` / `check.ps1` / `verify.ps1` 三个恒 SKIP |
| `LICENSE` | MIT 许可证全文 |

逐文件字节数不写在这张表里：包内的 `verify.ps1` 有一份内置参考值表，本表抄一份只会过期。要核对就运行 `verify.ps1`，第 1 项会逐个打印实际字节与参考值的差值——**它只是参考，不会让退出码变红**（要严格判就加 `-StrictSizes`）。

### 目录列名能力（已并入 `file_info`，2026-11-24）

原 `ls` 工具已删除，列名改由 `file_info` 的 `list: true` 完成，能力边界不变：

- **只列目录下直接条目的名字**：文件 + 子目录，每条标 `dir`/`file` + 文件字节数（目录记 0）。
- **绝不返回任何文件内容**：只走 `ctx.fs.resolve/stat/listDir`，没有任何读取正文的调用。
- **不 glob、不递归、不 grep、不读正文**：`recursive` 参数保留但永不递归。
- **输出硬顶**：最多 200 条 / 8 KB（两者取先到者），超出即截断并报总数（`total` / `shown` / `truncated`）。
- **参数**：`list: true` + `path`（默认会话 cwd）、`recursive?`；`list` 缺省时按 `paths` 报元数据。
- **排序**：目录在前，其余按名字字母序；路径不存在 / 不是目录 → 明确抛错。

配套流程：**`file_info(list:true)` 列有哪些名字 → `file_info(paths)` 验大小/存在性 → 真需要内容才派代理去读**（要求带行号与原文，不要整篇回灌）。

三个 `[SKIP]` 的理由：`README.md` 随文档改动而变；`check.ps1` / `verify.ps1` 本身会随编辑变化（当前 `.gitattributes` 为 `*.ps1 text eol=lf`，入库与打包的换行符口径都是 LF，不会因换行符变形；但已安装副本可能落后于源码，版本不同也不是字节比对能兜住的）。它们的字节数即使写对也很快过期，所以干脆不参与。

两点容易踩：

- `package.json` 里的 `"exports": { "./*": "./*" }` **不能删**。preset 挂载时 baseUrl 是 profile 根，5 个本地插件是以 `dsh-blackpig-mode/xxx.mjs` 这种子路径解析到本包的，靠的就是这条 exports。
- 对外挂载的插件用包名子路径解析（`dsh-blackpig-mode/xxx.mjs`）；包内相对引用只有一条：`subtalk.mjs` → `compat.mjs`（`./compat.mjs`），指向同目录、随包一起分发，所以整个包仍可整体搬运。**打包时 `compat.mjs` 必须在 `package.json` 的 `files` 里**，漏了会在装载时直接 `ERR_MODULE_NOT_FOUND`。

---

## 名册：实时派生（v1.0.10 起）

**`list: true` 优先从活注册表派生**：对每个已安装 preset 调 `agentPresets.acquireScope(id)` 取 scope key，
再用 `tools.view(key).visible` 取该模式的可见工具名、用 `skills.list({ cwd, scope: key })` 取技能名；
接口缺失（老宿主）时明确报 `live roster unavailable: agentPresets.acquireScope is missing`，**不读任何文件**。

现在的名册结构（示例，编号与工具名随部署而变）：

```text
Tool roster (A numbering: first-seen order across presets; installed modes missing here can still be dispatched if you know their id)

Global tool index (N tools):
[001] ask_user_question, [002] create_goal, …

Skill index (12):
[s01] blackpig-search, [s02] office, …

- standard: [001-049] | s[01-02]
- ptc: [050] | s[02]
- davinci-editor: [003-006] … [060-099] | s[02]
```

规则：

- 工具编号 = registry 顺序 × 每个模式工具顺序，首现发号、三位补零，绝不截断。
- 技能单独编号（`s01`…）= 模式顺序 × 每模式 `skills.list()` 顺序；模式行按模式给技能区间（`| s[…]`）。
- 每模式只列编号区间：**不再有 `(N tools)` 计数、`suitable:` 两行、`skills:` 行及其 `only in` 子句**。
- 单模式取不到（`broken` 或 `acquireScope` 抛错）时**仍保留该行**，写 `- <id>: — [unknown]`（不许吞行）。

### 工具面三级取数（v1.1.0 起）

行上的编号**优先是「模型真能直接调用的那批」**，不是「注册了的那批」：

| 来源 | 什么时候用 | 渲染 |
| --- | --- | --- |
| `executor` | 挂了 `@deepseek-ai/dsh-tool-executor-ptc` 的模式 | 固定 `run_code`，**不实测、不缓存** |
| `captured` | 缓存命中，或当场实测成功 | 真实工具表编号 |
| `registered` | 实测拿不到，退回 `tools.view()` 注册面 | 编号后缀 **` ~reg`** |

`~reg` 是**诚实标注**：那些编号是「注册了」，不等于「模型真能直接调」。看到 `~reg` 说明这次实测没跑通，
不是名册坏了。

实测路径：缓存未命中 → 先回看该 preset **已结束**的子会话（免费采样）→ 没有才当场派一个极短探针子代理
（`reply OK`），**等它跑完**（`activation.result.promise`）再读 `request/header.tools`。
首次 `list: true` 因此会慢（本机实测约 28 s），成功后写缓存
`${DSH_HOME}/profiles/desktop/preset-tools-cache.json`，之后走缓存只剩回看。

> ⚠️ **2026-11-25 修复（原地覆盖 v1.1.0）**：此前写的是 `await activation.result`，而宿主返回的
> `activation.result` 是 `Promise.withResolvers()` 的 **resolver 对象**（不是 thenable），`await` 在 0 ms
> 返回 ⇒ 探针刚创建就读请求头 ⇒ 所有非 ptc 模式全员 `~reg`。现已改为等 `activation.result.promise`。

> ⚠️ **2026-11-26 修复（同一版本再次原地覆盖）**：上一版只修了「等」，但探针**根本派不出去**——
> `subagents.startActivation()` 的 spec 漏了必填的 **`signal`**，宿主 `manager.js:642` 第一句就是
> `signal.throwIfAborted()` ⇒ `undefined` 直接 TypeError，被本模块 catch 吞成一条 warn，9 个模式全员
> 静默退回注册面并标 `~reg`。`delegate` 路径一直传 `signal: exec?.signal`，所以**只有探针挂、派活正常**。
> 现已补 `signal: options.signal`。同一轮还修了 `listDescendants()`：宿主签名是
> `listDescendants(rootSessionId, signal)`，**必须传根会话 id**，无参调用必抛
> `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`，「免费回看」这条路径此前等于不存在。

### ptc 说明行（v1.1.0 起）

执行器模式（`ptc`）**只输出一行**：`- ptc: [NNN] | s[…] — Programmatic Tool Calling. …`，
说明续行缩进两格。此前它会先输出一条纯编号行、再输出一条说明行，同一模式出现两次（已修）。

三件事分清楚：

| 想做的事 | 怎么做 | 效果 |
| --- | --- | --- |
| 只在名册里不显示 | 该模式加 `"hidden": true` | `list: true` 看不到它；**`delegate` 仍能派给它** |
| 彻底禁用（不许派） | 黑猪 `cordis.patch.yml` 里 `blackpig-roster` 的 config 加 `disabledPresets: [mode-id]` | `delegate` 回 `preset-disabled`（stop: true） |

> ⚠️ **名册看不到 ≠ 派不了**（`hidden: true` 只是不显示）；**派活永远是活的校验** —— `delegate` 读 `agentPresets` 注册表确认目标存在且没坏。要真禁用必须用 `disabledPresets`。

---

## 文件写冲突守卫（1.1.0 新增）

**解决什么问题**：黑猪把活拆给多个 worker 并行跑。两个工人被派到**同一个文件**时，宿主的默认行为是「后写者无条件覆盖」——先写的那份**静默消失**，而两边都回报成功。大脑拿到两份「已完成」，磁盘上只剩一份，这种损坏在日常汇报里看不出来。

**怎么工作**：新模块 `blackpig-file-guard.mjs` 在 `cordis.patch.yml` 里以 `blackpig-file-guard` 挂上 `fs/write-intent` / `fs/edit-intent` 两条 waterfall（`{prepend: true}`，排在链首做判定），write / edit / apply_patch 三条落盘路径都在**真正写之前**经过它：

| 情况 | 行为 |
| --- | --- |
| 文件无主 | 登记「谁在写」并放行（占用表在 `globalThis[Symbol.for('dsh-blackpig-mode:file-claims:v1')]`，进程内、不落盘） |
| 自己就是持有者 | 刷新持有时间后放行（同一个 worker 反复改同一文件不受影响，不会自锁） |
| 被别的 worker 持有 | 拒绝写入，抛 `FsError`，错误码 **`FS_CLAIMED_BY_PEER`** |

拒绝文案四要素缺一不可：哪个文件（`displayPath`）、持有者（label，或**完整** `childSessionId`，可直接粘进 `send_to_subagent`）、已持有秒数、下一步（交给同一个 worker，或等它结束后重试）。

**占用怎么释放**：① `agent/disposed` —— 会话结束立刻释放（主路径）；② `agents.get()` 判活 —— 持有者已不在就清（取不到服务 ≠ 已死，三态处理，不会误清）；③ TTL 兜底 —— 默认 10 分钟，环境变量 **`DSH_BLACKPIG_FILE_CLAIM_TTL_MS`**（毫秒）可覆盖，验证时用它调短。

**守卫自己出错时一律放行**：取 sessionId 失败、服务形状不符、表被外部改坏等内部异常，都只 `logger.warn` 一行并照常 `await next()`。它是保险，不是单点故障——代价只能是「这一次没拦住」，绝不会变成「这一次谁都不许写」。放行时**原样** `return await next()`，不合成任何 intent，不改变宿主「无条件覆盖」的语义（不会给普通写入凭空加一层 CAS）。

**已知限制（三条）**：

1. **shell 写入不拦**：`pwsh` / `bash` / `run_code` 写文件绕过 `ctx.fs`，守卫管不到；宿主原生策略同样管不到 shell，这是同一条边界，不是本守卫引入的。
2. **`fs-observation-policy` 启用后失效**：它占同一条 waterfall，先截断则守卫完全失效。判据：`--dump-config` 里该行 `disabled` 不再是 `true` 就要重测本守卫。
3. **仅同进程内生效**：占用表只在当前进程的 `globalThis` 上，不落盘、不跨进程；两个 DSH 实例之间不共享，进程重启即清空。

**验证状态**：`dsh-verify` **PASS + exit 0**（未盖基线）；**离线端到端四条判据全部通过** —— c1 第二个工人的写被拒、c2 冲突期间先写的内容不丢、c3 文案带可执行的持有者身份、c4 持有者释放后重试成功（终值为后写者内容，即「后写者赢」只发生在授权之后）。⚠️ 真·黑猪 preset 会话在离线 HOME 里构造不出（宿主 preset 绑定缺陷），所以这四条是**机制级**端到端，不是桌面实例上的黑猪全链路。

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

### v1.0.7

**简化版：v1.0.7 曾把名册改成读静态快照；该链路已于 r6 整体删除，名册改回 live 优先。**

这一版只动名册与查询，**派活逻辑一行未改**（`delegate()` 原样保留，含它自己的活校验）。

- **删除 `list: true` 的静态快照读取**（r6），改为从活注册表派生；不再出现 `files` / `shell` / `CAN-SPAWN-SUBAGENTS` 这类推导标签。
- **删除 `detail: true` 分支**（读单个 preset 的 YAML 声明）：名册已经写了「适合 / 不适合」，不需要再拉声明。
  连带删除 `readPresetDetail()`、`DETAIL_MAX_BYTES`、`config.detailMaxBytes`。
- **删除 `ask: true` 分支**（起一个短 worker 让模式自述能力）：同样被基准文件取代。
  连带删除 `extractProbeText()`、`probe_prompt` 参数。
- **删除能力推导链**：`DEFAULT_CAPABILITY_HINTS`（模块名→能力词映射）、`HIDDEN_MODULES`、`shortLabel()`、
  `compositionToTags()`。名册不再调用 `compositionInventory()`，也不再需要 `config.capabilityHints`。
- **新增 `config.disabledPresets`**：`delegate` 的部署级硬闸，命中回 `preset-disabled`。与基准文件里的
  `hidden: true`（只隐藏、仍可派）是两件事。
- **工具参数只剩 4 个**：`preset` / `prompt` / `description` / `list`。
- **人格改写**：`cordis.patch.yml` 里「能力不清楚时先 `ask: true` 再 `detail: true`」那半句删掉，改为读名册的
  适合/不适合说明，仍不清楚就问用户。

#### v1.0.7 追加（2026-11-15 第五轮）：名册字节上限**整体移除**

**名册现在永远输出完整内容**，不再有任何字节预算、不再截断、不再加 ` …`。

- **删掉的东西**：`ROSTER_HARD_CAP_BYTES`（= 4000）常量、`truncateWithSuffix()`、`clipToBytes()`、
  `bytes()`、`renderRoster()` 内的 `clampToCap()` / `nonEmptyFallback()`、`config.rosterMaxBytes`
  配置项，以及 `render()` / `renderRoster()` 的 `capBytes` 形参。所有「超顶就截」的分支一并删除，
  `degraded` 列表也**永远完整**输出。
- **为什么删**：4,000 B 这个上限是为「一个部署装几十上百个模式」这种**不存在的场景**设防的。
  模式数量天然有限（本机 8 个，极端部署也就几十个），而代价是真实名册被砍掉一半、
  模型看不到被丢掉的模式——**为一个假想场景牺牲真实可用性**。
- **认包判据**：`blackpig-roster.mjs` **36,302 B**（改前 43,116 B，−6,814 B）；`cordis.patch.yml`
  **31,632 B**（改前 31,516 B，+116 B，只改了注释）；`verify.ps1` 内置表同步为 36302 / 31632。
- **行为差异**：装 8 个模式时名册约 2.8 KB 以上（完整输出，不再被 4,000 B 截）；模式越多越长，
  这是**有意为之**。

#### v1.0.7 追加（2026-11-15）：人格去重精简 −1,020 B

只改 `cordis.patch.yml` 的 `persona.prefix` 正文，**代码一行未动**（7 个代码文件
`blackpig-roster.mjs` / `compat.mjs` / `file-info.mjs` / `guard-v10.mjs` / `index.mjs` / `lib/client.js` /
`subtalk.mjs` 逐字节不变）。

- **人格正文 7,669 B → 6,649 B（−1,020 B，约 −255 token，常驻每轮）**；`cordis.patch.yml`
  **32,536 → 31,516 B**（`verify.ps1` 内置期望表已同步为 31516）。
- **段落数仍是 15，顺序未变**：只做「删重复句 + 删过时句」，没有增删段落、没有搬段。
- 改动最大的三段：`Pick the mode by capability…` −649 B（删掉「永远不要从模式名推断能力」整段重复论证、
  删掉「按 suitable/not suitable 逐行挑最小档」这句与名册表头自相矛盾的指示）、
  `Two tools take two names…` −193 B（删掉与工具 schema 逐字重复的参数说明）、`You do not do the work…` −99 B。
- 判据（`--dump-config` 合成树）：新措辞 `Your verification tools (\`file_info\`, \`read_image\`, \`job_output\`)`
  命中 1、旧措辞 `Your read-only verification tools are` 命中 0；`take the \`agent\` **name**` 命中 1；
  `The roster no longer carries capability labels` 命中 0。

#### v1.0.7 追加（2026-11-14 同日第二轮）：`list: { all: true }` —— **第三轮已撤回**

> 🔴 **2026-11-14 第三轮：`list: { all: true }` 已删除，`list` 回到纯 boolean。**
> 下面这段是历史记录，**不要再按它用**。删它的两条理由：①只服务基准测试，日常只用 `list: true` + `delegate`；
> ②它绕过 `hidden` 过滤（`renderAllPresetIds()` 不读 caps.json、不判 hidden，而 `renderRoster()` 会跳过
> self 与 `hidden: true`）。替代方案：派一个 standard worker 读 `cordis.patch.yml`（见上文与 `docs/preset-bench.md` 第三节）。

第二轮曾这么改（**已撤回**）：

- ~~`list` 参数从 `z.boolean` 扩成两形态~~：`list: true` 与 `list: { all: true }`。→ **已删除，现只接受 boolean**。
- ~~新增 `renderAllPresetIds()`~~（约 40 行，模块级）：读 `registry.list()`，只回 id。
  → **函数已整体删除**（连同它专用的 `clampRosterText()`）。
- ~~schema 用 `oneOf: [boolean, object]`~~ → **schema 回到 `{ type: 'boolean' }`**，传对象会被宿主拒绝。
- ~~registry 取不到 → `registry-unavailable`；`list()` 抛错 → `registry-unreadable`；空表 → `degraded: ['registry-empty']`~~
  → 这三条回执随分支一起消失。
- **`delegate()` 一行未改**（两轮都没动）。

> 升级注意：`blackpig-roster.mjs` 现在 **42,898 B / 886 行**（第二轮 48,573 B / 1,008 行；v1.0.6 是 102,521 B）。
> `cordis.patch.yml` = 31,175 B。装完必须**重启 DSH** 才生效（插件在启动期装载）。

### v1.0.6

**适配 DSH 0.2.2-rc.2：恢复升级后丢失的 4 个委派控制工具；删除 member-persona；人格去死文本、修参数名。**

> ⚠️ **本次原地覆盖了 v1.0.6 的发布资产**（未发 1.0.7）。原因是本版在首版 v1.0.6 发布后
> 又发现人格里有**三处错误**（见下「人格修正」），而控制工具挂载才是这一版的主线，
> 两者属于同一次适配。若你手上是 2026-11-12 20:2x 之前下载的 1.0.6，请重新下载：
> 旧包的 `send_message` / `interrupt_agent` 参数说明是错的。
>
> ⚠️ **2026-11-12 22:4x 又原地覆盖了第二次**（仍未发 1.0.7，用户决定）：补回
> 2026-11-08（v1.0.3）被误删的 `**Third-party capabilities are not yours.**` 一段，见下「补回误删条款」。
> 判据：`cordis.patch.yml` = **31,674 B**。手上若是 31,345 B 那版，请重新下载。
> （这里不写 tgz 的字节数——README 自己在包内，写包体大小是自我指涉、每改一次就失效；
> 认包请认 Release 页面上显示的资产大小与 `cordis.patch.yml` 的 31,674 B。）

- **症状（为什么必须发这个版本）**：DSH 从 0.2.2-rc.1 升到 rc.2 后，黑猪大脑的工具面从 **24 个掉到 15 个**——`send_message`、`list_agents`、`wait_agent`、`interrupt_agent` 四个工具**消失**。
- **根因（不是本包挂错，是宿主改了分发方式）**：
  - rc.1 的 `@deepseek-ai/dsh-experimental-agent-team-profile` bundle 在全局层 `disabled: true` 掉 `tool-subagent-control` / `tool-subagent` / `tool-subagent-fork`，再由 `dsh-experimental-tool-agent-team` **一个包注册全部 9 个团队工具**。黑猪 preset 不挂任何工具，靠宿主全局注入也拿得到——这符合「保持通用性、不写死第三方工具」的设计原则。
  - rc.2 用 `RETIRED_BUNDLES` 退役该 bundle，把工具**拆成两个插件**：`dsh-tool-agent-team` → `team_task_*`（仍由 base 全局挂、受会话级 Team 开关控制）；`dsh-tool-subagent-control` → `send_message` / `list_agents` / `wait_agent` / `interrupt_agent`（**改为各 preset 自己声明**）。
  - `standard.patch.yml` 声明了 `tool-subagent-control`（所以 standard 一直有这 4 个工具），**黑猪 preset 从没声明过** → rc.2 起这 4 个工具无提供者。
- **修法**：黑猪 preset 的 `plugins` 里补挂 `@deepseek-ai/dsh-tool-subagent-control`（`interrupt: true`）。该行不含任何第三方/项目私有引用，`inject` 只有 `tools/subagents/agents/systemPrompt` 四个通用服务，**不违反「不写死第三方工具名」红线**。
- **人格修正（本次覆盖发布的真正原因）**：首版 v1.0.6 发布后又查出三处**事实性错误**，全部按实测改掉：
  - 🔴 **参数名**：原文说「`send_to_subagent` / `stop_subagent` / `send_message` 三者参数相同」。**实测不是** —— `send_message` 与 `interrupt_agent`（宿主 `tool-subagent-control` 提供）的 schema **只有 `agent`（名字）**，传裸 id 会因缺必填字段而失败；只有本包自己的 `send_to_subagent` / `stop_subagent` 经 `compat.mjs` 的 `applyToTools()` 才同时收 `agent_id` 与 `agent`。
  - 🔴 **`wait_agent` 语义**：原文把它写成“等收件箱输入”。官方描述是「Wait for input at **your next step**」——它报告的是“你自己的下一步有输入到了”，**不告诉你是哪个子代理结算了**，所以不能当“等某个子代理”用。
  - 🟡 **`interrupt_agent` 漏了两个坑**：它「returns without waiting for it to stop」，且「Subagents it started will keep running」。
- **删除 `member-persona.mjs`**（2026-11-12，用户决定）：它只覆盖「继承黑猪 preset 的子会话」，而 rc.2 里能让子会话继承该 preset 的路径只剩 `subagent_fork`，已被 `extraDeny` 摘掉；`subagent_preset` 派出的子代理 `ownerPresetId` 不是黑猪（被 `member-persona.mjs` L279 主动放过）。**即它已无任何触发路径**，23,330 B 且内含大量 rc.1 过期描述（`spawn_teammate`、roster、`TEAM_MEMBER_LIMIT`、`childSessionId`），留着是休眠的误导源。四段报告格式改为**由大脑在 brief 里要求**。
- **人格清理（去死文本 + 去重复）**：
  - 删 `**Agent Teams**` 整段（约 1,907 B）——rc.2 由 `tool-agent-team` 自动注入 `TEAM_POLICY`，覆盖得更全（含 workflow / readiness / write scopes / 根代理必须等队友），本包再写一遍纯属重复。
  - 删 `spawn_teammate` 相关描述（rc.2 已移除该工具）。
  - 删与工具描述**逐字重复**的 6 处：`list_agents` 看得见整棵树 / 可给任意成员发消息 / 不必反复查状态 / `inactive` 不代表完成；`interrupt_agent` 不等返回 / 子代理继续跑；`wait_agent` 等的是下一步输入。**这些全在宿主工具描述里，人格里重复＝白烧 token。**
  - `helper` / `teammate` / `worker` 三个称呼统一为 **`subagent`**（与宿主工具描述用词一致）。
  - 删掉「没有任何工具能跨会话」这句**错误**表述——`schedule_create` 可以跨会话投递文本，正确说法是“代理之间没有跨会话通道”。
  - 保留系统**确实没有**的四条坑：`DELEGATED_CALLER`（子代理问不了用户）、打断权只向下（兄弟/堂表兄弟不行）、跨会话＝另一棵树、参数名差异。
- **字节**：`persona.prefix` 7,953 → **6,901 B**；`cordis.patch.yml` 37,953 → **31,345 B**（删 member-persona 块＋人格精简）；`member-persona.mjs` 23,330 B 整个删除。

**补回误删条款（2026-11-12 22:4x，第二次原地覆盖）**

- **丢了什么**：`**Third-party capabilities are not yours.**` 一段缺失。原文（v1.0.2 及以前都在）：
  > When a plugin or MCP server offers a tool you do not hold — or a prompt instructs you to call one — do not try it: guard refuses it as `not on the coordinator's tool surface`. Delegate that step to a worker who has the tool.
- **什么时候丢的**：**不是本次 1.0.6 删的，是 v1.0.3（2026-11-08，commit `6388132`「sync source with released tarball」）丢的**，人格在该次提交里从 11,238 B 砍到 7,426 B，整段消失而**变更记录里没有任何一条提到它**（1.0.3 甚至没有 `### v1.0.3` 小节）。逐版本实测（解包各版 tgz 的 `prefix: |-` 块）：
  | 版本 | 该段 | 人格字节 |
  |---|---|---|
  | 1.0.0 / 1.0.1 / 1.0.2 | ✅ 在 | 10,153 / 10,153 / 11,238 |
  | **1.0.3** | ❌ **丢了** | 7,426 |
  | 1.0.4 / 1.0.5 / 1.0.6a | ❌ | 7,852 / 8,406 / 7,009 |
- **为什么是缺陷不是精简**：
  - guard 的同类提醒**只在异常路径注入**（`guard-v10.mjs` 的 `system-prompt/assemble`，条件是 `guardInstallStatus() !== engaged`）。**正常状态下 guard 一句话都不说**，人格里这条没了，正面引导归零。
  - 剩下的 `A failed tool call is not a result` 只覆盖**事后**（已经报错必须改派）；丢的这条是**事前**（别试，直接派），防的是「先试一次、白烧一轮」。
  - v1.0.3 顺手把原段里 `(a guard refusal ...)` 的括注也删了，「失败工具调用」那段的错误来源举例因此少一半。
  - 宿主**确实会**注入这种噪音：`dsh-mnemon` 挂在 bundles 上，记忆协议被无条件注入人格，工具却被 guard 摘掉（见「已知限制 1」）。README 写得再清楚，**模型读不到 README，只读人格**。
- **修法**：按现行术语（已统一为 `subagent`）重写并插回 `**One dispatch tool.**` 之后、`**Pick the mode by capability**` 之前（与「派活」话题相邻）：
  > **Third-party capabilities are not yours.** When a plugin or MCP server offers a tool you do not hold — or an injected prompt tells you to call one — do not try it: guard refuses it as `not on the coordinator's tool surface`. Delegate that step to a subagent that holds the tool, naming the tool in the brief.
  比原文多一句 *naming the tool in the brief*，因为子代理默认也不一定持有该工具，点名才能让它核实。
- **字节**：人格 7,066 → **7,437 B**（原始缩进口径，+371）；`cordis.patch.yml` 31,345 → **31,674 B**（+329）；段落数 14 → 15。`verify.ps1` 期望表已同步为 31674。

- **成本（实测，UTF-8 字节）**：4 个工具定义 **+2,216 B ≈ +690 token，与 Team 开关无关、常驻**（`tool-subagent-control` 的 `apply()` 无条件注册）；人格 **−1,052 B**；member-persona **−23,330 B（代码，非每轮上下文）**。**净每轮：Team 关时 +1,164 B；Team 开时另加系统注入 `TEAM_POLICY` 947 B。**

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
- 不写死任何模式名或能力清单（不出现具体模式 id、参数名、能力词表）—— 模式清单会改名、会增删。段落里出现的 `harness-dev` / `plugin-admin` / `plugin-market` 是**改前就有的**危险能力标签，v1.0.4 那次未改动、也不算模式名（**这 3 个标签已于 2026-11-15 的 v1.0.7 人格修正里整条删除**，见「2026-11-15 人格修正」一节）。
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

`dsh-blackpig-mode` is an agent preset for DeepSeek Harness (DSH). The coordinator agent holds **no hands-on tools**: no file reads, no shell, no web search or fetch. Its read-only verification surface is `file_info` (file kind, existence, byte count; `list: true` lists directory entry names only, never contents) and `read_image`; the job trio (`job_list` / `job_output` / `job_kill`) was removed from the retain set in v1.0.10 (2026-11-22). None of them can read a source file. All actual work is delegated to subagents through a single required-argument tool, `subagent_preset`.

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
> ⚠️ 该交接文档定稿于 **v1.0.4（2026-11-08）**，其版本号/字节数/工具数量等「当前状态」数字**已过期**，仅架构、术语、红线、rc.1→master 风险部分仍有效；现状以源码实测为准。
