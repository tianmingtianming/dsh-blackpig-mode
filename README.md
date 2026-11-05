# 黑猪模式（Black Pig Mode）— DSH agent preset

一个 DeepSeek Harness（DSH）的 agent preset：**规划者不持有任何动手工具**。它读不到文件内容、跑不了命令、搜不了网页、抓不了网页，只能拆任务、派活、核对交付、汇总结论。所有实际的读写、命令、搜索都交给子代理去做。

装上之后，你的 DSH profile 里会多出一个名为「黑猪模式」的模式（preset id：`blackpigmodel`）。

---

## 为什么做这个（作者背景）

我是影视导演，不是程序员。**这个插件全程由 AI 编写，我一行代码都没看过。**

我做影视工作流，遇到的核心困难是：**我急需一个干净的上下文。**

刚开始用 `multitask`，但发现**依旧不够干净**。于是只能自己用 AI 做。

做的途中领悟了一件事：**其实根本不需要会话有「读」的功能，它只需要了解它需要的东西。**

做完发现一个人生的真谛：**人生的上下文只有这么长，一定要用大部分时间去做自己愿意做的事。**

技术上怎么落到这套代码上：读文件会吃掉上下文，所以把「读」这件事交给工人——主对话的 `read` 与 `grep` 一起从工具面上摘掉（留 `grep` 等于留半个 `read`，纪律不成立），只保留两类验证工具：`file_info`（查文件类型 / 是否存在 / 字节数）和 `read_image`（看图）。这个取舍是有意识的：**代价是规划者看不到文件内容**，想知道里面写了什么，只能靠 brief 再派一个人去看，并要求带回行号和原文；**换来的是上下文不被文件内容吃掉**，主对话只承载结论和判断。所以 brief 必须自包含，验证必须换人做，汇报必须带证据——这三条不是风格要求，是这个交换成立的前提。

发出来只是为了让朋友们装起来方便——不是产品，没有客服，也没有维护承诺。代码里会有粗糙的地方，取舍也带着明显的个人偏好。**能用，但别当作品看。**

**如果你的活更复杂，我更推荐你去装 `dsh-multitask`。** 它功能比我这个强大得多，而且是正经维护的。我这个只是个人用的一个极端取舍：把读取工具彻底从规划者手上摘掉，换一个干净的上下文。

---

## 它解决什么问题

主对话上下文是最贵的资源。一个"顺手读一下文件看看"的动作，代价是把整份文件塞进主对话，此后每一轮都要为它付费，直到压缩掉。黑猪模式不是靠提示词劝模型少读，而是**把读的工具从工具面上摘掉**——工具不在，就调不了。

它的四条核心设计：

| 设计 | 做法 | 约束住的是什么 |
| --- | --- | --- |
| 规划者无读取工具 | `guard-v10.mjs` 在大脑自己的 agent scope 上装 `tools.restrict()` + `tools.guard()`，保留集只留 `file_info`（类型/存在性/字节数）、`read_image`、派活与团队协作工具 | 强制出信息压缩边界：过程数据进不了主对话 |
| brief 必须自包含 | 队友看不到主对话，只看得到 brief。人格与工具描述都要求「点名文件路径、行号、具体改什么」，禁止「按你刚才的发现去修」 | 派活必须先把信息压成一份可执行的说明书 |
| 验证必须独立 | 主对话只剩 `file_info` 和 `read_image`，能证明「文件存在 / 多大 / 是否为空」，证明不了「里面写了什么」。要问内容，只能再派一个人去看 | 自己验自己会互相印证错误；独立验证要求换人 |
| 汇报必须带证据 | `member-persona.mjs` 强制队友报告四段：结论 / 依据（路径+行号、命令+输出、SHA256 或计数）/ 范围与限制 / 不确定。缺依据的结论，主对话不得转述为事实 | 防止把推测升级成事实汇报给用户 |

派活只有一个入口：`subagent_preset`（由 `blackpig-roster.mjs` 注册），`preset` 参数必填，无默认值。`subagent` / `subagent_fork` 在主对话上被 `extraDeny` 摘掉——因为前者会固定回落到 `agentPreset: "standard"`，后者压根不支持选模式，两条旧路径都会让活派错人且**不报错**。

另一条路是 Agent Teams 的 `spawn_teammate`（只有你的工具表里真有它，才说明团队插件开着）。它和 `subagent_preset` 的区别要说清：**`spawn_teammate` 没有 `preset` 参数**，队友永远继承父会话自己的模式，你没法把它指到别的模式；**但它拿得到该模式的全套工具，确实能干活**，不是二传手。所以分工是：活需要「某个特定模式」→ `subagent_preset`；活需要「多轮协作、中途纠偏、两个帮手要对表」→ 队友。

---

## 安装（三种，按推荐顺序）

### 1. 首选：直接从 GitHub 装（一条命令，仓库已公开）

```powershell
dsh.cmd plugin --profile <名> add github:tianmingtianming/dsh-blackpig-mode
```

前提：**你的机器上装了 git**（`git --version` 能跑）。本包零依赖、零构建脚本，不需要额外编译步骤。

### 2. 次选：从 Release 装（不需要 git）

```powershell
dsh.cmd plugin --profile <名> add https://github.com/tianmingtianming/dsh-blackpig-mode/releases/download/v1.0.1/dsh-blackpig-mode-1.0.1.tgz
```

### 3. 兜底：本地 tgz（离线、或上面两条都不通时）

先把 tgz 解包到一个目录，在**那个目录里**跑装前检查（只读，7 项）：

```powershell
.\check.ps1 -Profile <名>
dsh.cmd plugin --profile <名> add <tgz的完整路径>
.\verify.ps1 -Profile <名>
```

> `check.ps1` 与 `verify.ps1` 在解包后的目录里。**装完之后再跑 `check.ps1` 会返回 exit 1，这是设计行为**（它第 4 项会因「已含包名」报 WARN），不是装坏了；装后验证请用 `verify.ps1`。

### 装完怎么核对

无论走哪条路，装完后 `check.ps1` / `verify.ps1` 都会落在 `node_modules\dsh-blackpig-mode\` 里，可以直接从那里跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<profile目录>\node_modules\dsh-blackpig-mode\verify.ps1" -Profile <名>
```

### 装之前要注意

- 装前必须先跑 `check.ps1`（第 3 种方式里已包含），它会告诉你 profile 里有没有同名 `blackpigmodel` 声明。它只读、不写任何文件。
- 装完 `dsh` 会在 `profiles\<名>\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都登记 `dsh-blackpig-mode`，并读取本包 `package.json` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 挂载 preset 声明；**它不会改你的 `cordis.patch.yml`**。
- 你需要会用命令行、能重启应用、接受 Windows 优先。

**`check.ps1` 的三个退出码**：

- **`0` = READY**：可以安装。干净 profile（目录存在、还没装过黑猪模式）返回这个。
- **`1` = NEEDS-CLEANUP**：有残留或冲突，按它给出的行号清理后重跑。**注意：装完之后再跑 `check.ps1` 也会返回 1**（第 4 项会因「已含包名」报 WARN），这是设计行为，不是装坏了——装后请改用 `verify.ps1`。
- **`2` = BLOCKED**：环境不满足——找不到 `dsh.cmd`，**或 profile 目录根本不存在**。全新环境里若报 2，先用 `dsh` 初始化那个 profile（随便跑一条 `dsh.cmd plugin --profile <名> list` 之类），让它把目录建出来再跑。

---

## 验证装好了

装完（必要时重启）后跑：

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 -Profile <你的profile名>
```

它做 5 项核对：

1. 包是否落盘到 `profiles\<名>\node_modules\dsh-blackpig-mode`，以及核对包内文件字节：11 个条目里 **8 个参与字节校验**，`README.md` / `check.ps1` / `verify.ps1` 三个显示 `[SKIP]` 不参与（原因见本节末尾）
2. `profiles\<名>\package.json` 的 `dependencies` **或** `optionalDependencies`（二者任一即可）与 `dsh.profile.bundles` 是否都登记了本包
3. `cordis.patch.yml` 里是否还残留旧的 `blackpigmodel` 声明
4. `dsh --profile <名> --dump-config` 的退出码是否为 0，输出里 `preset-blackpigmodel` 是否恰好出现 1 次
5. 汇总结论并给退出码（`0` 可直接使用 / `1` 有缺件或冲突 / `2` 环境不满足）

关于第 4 项：`desktop` 这个 profile 由 Electron 独占，`dsh` CLI 会硬拒绝 `--dump-config`。此时 `verify.ps1` 会自动在 `%TEMP%` 下建一个影子 profile（复制 `package.json` 与 `cordis.patch.yml`，`node_modules` 用目录联接只读指回真 profile）来复核，跑完立即删除。真 profile 的 `node_modules` 不被写入。

**为什么第 1 项里有三个 `[SKIP]`。** `README.md` 随文档更新，改一次字节就变，参与校验没有意义。`check.ps1` / `verify.ps1` 也会随编辑变化，且换行符口径依赖 `.gitattributes`；**当前 `.gitattributes` 是 `*.ps1 text eol=lf`**，入库与 `npm pack` 打包都是 LF（已实测：包内 `verify.ps1` 与源码字节数、SHA256 完全一致）。即便如此这两个脚本仍不参与字节校验——写死自身字节的期望值，等于每改一次脚本就要改两处，还容易忘。注意改用 SHA256 也救不了：只要换行符口径一变，SHA 同样对不上。所以真正参与字节比对的只有 8 个文件，**脚本尺寸一律以 `verify.ps1` 内置期望值表为准，本文不抄具体数字**。

**`check.ps1` 是安装前脚本，装完再跑它会返回 exit 1。** 它第 4 项专门查 `package.json` 里有没有黑猪包名，装好之后必然命中，于是给出 WARN + `NEEDS-CLEANUP`（exit 1）。这是设计如此，不是装坏了、也不是要你去清理。装后验证请用 `verify.ps1`。

**`verify.ps1` 的 exit 2 是真的会发生的**：找不到 `dsh.cmd`，或 `profiles\<名>` 目录不存在，这两条是硬停（`-Hard`），直接返回 2，不会继续往下核对。exit 0 = 可直接使用（`FAIL 0 / WARN 0`），exit 1 = 有缺件或有冲突（任一 FAIL 或 WARN 都算）。

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

**3. 通常不需要重启。**
`dsh-hmr` 监视 profile 的 `package.json`（`dsh-hmr/lib/index.js:849,873`）：`dsh.profile.bundles` 一变就触发 `reconcileProfile()` → `recomposeProfile()` 自动重组；UI 的插件页开关走 `publishAndReload` → `hmr.reconcileProfile`，同样直接生效。**但**：如果 HMR 被关闭、或装完发现模式没出现，再重启一次即可。已经开着的会话和它们的子会话会保留自己启动时那份插件 revision。
*缺了会怎样*：HMR 开着时什么都不用做；HMR 关着时，不重启就是「装了但看不到黑猪模式」，`--dump-config` 里也不会有它。这不是装失败。

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

11 个条目，一句话一个（其中三个不参与字节校验，见下）：

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 整套 preset 声明：1 个 `insert`，25 个顶层插件行（其中 2 个是 `cordis:group`，组内还有 4 行），人格前缀整段内联在这里 |
| `guard-v10.mjs` | 大脑的工具面收窄与硬拦：`deny = 可见集 − 保留集`，只在大脑自己的 agent scope 上装，队友不受影响 |
| `blackpig-roster.mjs` | `subagent_preset` 工具 + 代理名册：列出每个模式的能力标签，支持 `list` / `ask` / `detail` 三种查询 |
| `subtalk.mjs` | `send_to_subagent` / `stop_subagent`：与已派出的代理继续对话或叫停，冷恢复它自己的上下文 |
| `file-info.mjs` | `file_info`：只 stat 不读内容，给类型 / 存在性 / 字节数，一次调用可覆盖一组路径 |
| `member-persona.mjs` | 子会话人格覆盖：把「你不能动手」换回干活的人格，按 agent scope 注册、只覆盖继承本 preset 的子会话 |
| `package.json` | `dsh.bundle.patch` 声明 + `"exports": { "./*": "./*" }` 子路径映射 |
| `README.md` | 本文件（不参与字节校验） |
| `check.ps1` | **装前**只读检查（7 项），发现同名声明时报行号并 exit 1。装完之后再跑它必然因「已含包名」报 WARN → exit 1，属设计行为（不参与字节校验） |
| `verify.ps1` | **装后**生效验证（5 项），核对文件字节、`bundles` 登记、`dump-config` 退出码；**脚本内置的期望字节表就是权威尺寸**，其中 8 个参与比对，`README.md` / `check.ps1` / `verify.ps1` 三个 SKIP（不参与字节校验） |
| `LICENSE` | MIT 许可证全文 |

逐文件字节数不写在这张表里：包内的 `verify.ps1` 有一份内置期望值表，才是权威来源，本表抄一份只会过期。要核对就运行 `verify.ps1`，第 1 项会逐个打印实际字节与期望字节的差值。

三个 `[SKIP]` 的理由：`README.md` 随文档改动而变；`check.ps1` / `verify.ps1` 本身会随编辑变化（当前 `.gitattributes` 为 `*.ps1 text eol=lf`，入库与打包均为 LF，不会因换行符变形），但仍不参与字节校验，避免改脚本时忘了同步期望值。

两点容易踩：

- `package.json` 里的 `"exports": { "./*": "./*" }` **不能删**。preset 挂载时 baseUrl 是 profile 根，5 个本地插件是以 `dsh-blackpig-mode/xxx.mjs` 这种子路径解析到本包的，靠的就是这条 exports。
- 5 个 `.mjs` 插件之间没有相对路径引用，全部用包名子路径解析，所以整个包可以整体搬运。

---

## 这是给谁用的

写清前提，缺一条就别装：

- 你**已经在用 DSH**，且用的是桌面版（有 `dsh.cmd`）。
- 你**会用命令行**：本包的安装、检查、验证都是命令行操作，没有图形界面入口。
- 你**能重启应用**：通常不用重启（HMR 会自动重组），但 HMR 关着时得手动重启一次才生效。
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

Install, three ways in order of preference: `dsh.cmd plugin --profile <name> add github:tianmingtianming/dsh-blackpig-mode` (needs git); the v1.0.1 Release tarball URL (no git needed); or a local `.tgz` path after unpacking it and running `check.ps1` first. Full steps are in the Chinese section above.

`check.ps1` exit codes: **0 = READY**, **1 = NEEDS-CLEANUP** (also returned *after* a successful install — that is by design, use `verify.ps1` afterwards), **2 = BLOCKED** (no `dsh.cmd`, or the profile directory does not exist yet — initialize the profile first).

Windows-first, DSH-only, requires the desktop CLI (`dsh.cmd`); no restart is normally needed (HMR recomposes the profile when `dsh.profile.bundles` changes) — restart only if HMR is off or the mode does not appear. MIT licensed.

Built with heavy reference to **`dsh-multitask@1.2.25`**, a **third-party community plugin** (`https://github.com/Senguk520/dsh-multitask`) installed from GitHub — it is **not** bundled with DSH (with thanks), and to the official DSH docs on agent presets and bundles.

---

## 许可

MIT，见 [LICENSE](LICENSE)。5 个 `.mjs` 插件与人格文本来自作者的本地 DSH 部署，随包原样分发。
