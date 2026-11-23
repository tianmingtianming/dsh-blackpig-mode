# caps 格式与运维（preset-caps）

> 适用：`dsh-blackpig-mode` **1.0.10 及以后**。
> **名册 live 优先**：`subagent_preset({ list: true })` 从活注册表派生
> （`agentPresets.acquireScope` + `tools.view` + `skills.list`）；
> 静态 `preset-caps.json` **只在接口缺失（老宿主）、单模式取不到、或整体读不到时兜底**。
> 因此**不再需要跑基准测试**；本文只描述 caps 文件的格式契约、兜底语义与运维（改描述 / 禁用模式）。
>
> **v3 校验（2026-11-15 起）**：顶层 `version:3` / `scope` / `baseline` / `baselineTools`；
> 每模式必填 `tools` / `toolCount` / `suitableFor` / `notSuitableFor`。
> **老格式（v1/v2）不兼容**：缺必需字段回 `preset-caps-invalid`（`stop:false`），**不回退包内默认**。
>
> 要查「这台机器装了哪些模式」：直接 `subagent_preset({ list: true })` 看名册。

---

## 一、这份文档是干什么的

黑猪的「名册」是模型选人的唯一依据：它只告诉你每个 preset **有几个工具、适合干什么、不适合干什么**。
这三样数据**没有任何办法在运行时自动算出来**（见第九节），所以只能「跑一次基准测试 → 把结果写进一个 JSON 文件 → 名册读这个文件」。

本文就是这个流程的操作手册：什么时候要跑、怎么跑、数据从哪取、结果写哪、怎么改、怎么禁。

配套的成品数据就是包内 `defaults/preset-caps.json`：4 个内置模式、**核心工具数 33 / 1 / 4 / 35**
（这是排除第三方插件的口径，机器无关）。`list: true` 实际显示的数取决于它读到哪份文件，见 1.1 与 1.2。

### 1.1 两种口径：核心工具数 vs 实测全量工具面

本文件会同时出现两组数字，**它们不是同一个口径，不要混用**：

| 口径 | 数字 | 来源 | 含义 |
|---|---|---|---|
| **核心工具数** | standard 33 / ptc 1 / minimal 4 / cordis 35 | 包内 `defaults/preset-caps.json`（`scope: "generic"`） | **排除第三方插件**后的工具数。这是「装个裸 DSH 就有」的通用工具，**机器无关**，可作所有人的默认值 |
| **实测全量工具面** | **不写死，随机器变**（测法见 1.2） | 用户覆盖层 `~/.dsh/blackpig-preset-caps.json`（`scope: "local"`，基准测试产出，含第三方插件） | **本机实际能调的全部工具**，含各第三方插件注入的工具 |

**为什么差这么多**：第三方插件在 preset 层注入工具，装了就带上。差额 = **那台机器装了哪些带工具的插件**，
所以它是个变量，不是常数：装一个插件差额变大，卸一个变小；而核心口径一个都不动。

- 有些插件**全局注入**：装了就进所有内置模式，于是几个内置模式同步多出同一批工具。
- 有些插件的工具**只进它自己的那个模式**（工具名前缀通常能看出归属）。所以「内置模式多出 N 个」这句话
  **不能套到自定义模式上**——每个模式的差额都要各自测。
- 只有 `run_code` 一个工具的那种模式（`ptc`），插件工具通常一个都没注入，差额为 0。

**该看哪个**：

- 想判断「某个模式在其他机器上大概能干什么」→ 看**核心工具数**（包内 `defaults/` 是这个口径，`scope:"generic"`）
- 想判断「在**我这台机器上**这个模式现在实际能干什么」→ 看**实测全量**（`~/.dsh/blackpig-preset-caps.json`，`scope:"local"`）
- `list: true` 本身**不认口径，只认文件**：先读用户覆盖层、读不到才回退包内默认。
  🔴 **v3 起**：用户覆盖层存在但**格式不是 v3**（含 v1/v2 老格式）→ 直接回 `preset-caps-invalid`，**不回退**包内默认。
- 判断「现在显示的是哪份文件的数」→ 拿名册首行 `Global tool index (N tools)` 的 `N`，和两份文件各自的 `baselineTools.length` 对：
  等于哪份，名册读的就是哪份。**数字本身不是口径证据，`scope` 才是。**
- 若把覆盖层换成核心口径的 v3 数据（如直接抄包内 `defaults/`），或覆盖层不存在/读坏回退到包内默认，
  `list: true` 就显示 33 / 1 / 4 / 35
- 一句话：**`list: true` 的数字 = 当前那份文件里记的数字**，不是口径的证据；判断口径要看它读的是哪个文件、里面的 `scope` 是 `generic` 还是 `local`

### 1.2 怎么测现值（五种测法，别抄别人的数）

本节刻意不写任何现值。要现值就现场测，**每条都只依赖当前这一版的行为，不依赖某一台机器的状态**，所以放三年也照样能用。

1. **名册内容 / 各 preset 工具数**——调 `subagent_preset { list: true }`，返回的 `message` 就是名册原文；
   每个模式那行的 `(<toolCount> tools)` 就是该模式的数。
   独立来源交叉验证：解开会话日志读 `request/header.tools[]`（第五节），数组长度应与该数字一致
   （不一致说明会话被白名单裁剪过，见第十节第 3 条）。
2. **当前协调者 / 某个 preset 的工具面**——两条等价来源：
   ① 会话日志 `request/header` → `tools` 数组长度；
   ② 名册首行 `Global tool index (N tools)` 的 `N`（这是**所有 preset 工具名的并集去重数**，不是某一个模式的数）。
   只要单个模式的数：看它那行的编号区间 `[001-0NN]`，或直接数该模式自己 `tools` 数组的长度。
3. **包内默认 caps 是否被用户覆盖层盖住**——看 `~/.dsh/blackpig-preset-caps.json` 在不在：
   **在 → 用它**（`scope` 应为 `local`）；**不在 → 用包内 `defaults/preset-caps.json`**（`scope: generic`）。
   在但格式坏 → `preset-caps-invalid`，**不会**回退包内默认（刻意的，见第六节）。
4. **名册渲染有没有变化**——渲染是纯函数：同一份 caps + 同一个 `selfId`，`renderRoster(caps, selfId)` 的输出
   必须逐字可复现。所以「有没有变」用 **diff** 判：把这次 `list: true` 的原文存下来，与上次存的 diff。
   **空 diff = 行为没变**；有 diff 就是代码或 caps 变了，按第七节定位。
   好处：这个测法**不需要记任何数字**，只需要留着上一次的原文。
5. **覆盖层 vs 包内，现在用的是哪份**——除了测法 3 看文件在不在，还能从内容反推：
   名册里各模式的 `suitable` 文本取自 `suitableFor`，用户覆盖层会重写这些描述，
   所以在 `suitable` 里找该部署的特征词就能判断读的是哪份；再交叉验证 `N` 与 `baselineTools.length`（测法 2）。

**v3 两份文件的职责**：

| 文件 | `scope` | 内容 | 谁生成 |
| --- | --- | --- | --- |
| `<包目录>/defaults/preset-caps.json` | `generic` | 4 内置模式的通用核心口径（33/1/4/35），剔除第三方插件 | 发布包自带，维护者改 |
| `~/.dsh/blackpig-preset-caps.json` | `local` | 本机真实全量工具面（数值随本机装的插件而变，测法见 1.2 第 1 条），含插件 | 本机历史产物（旧流程，现已不需要） |

> ⚠️ 覆盖层无论是「重跑基准生成」还是「从别处转换而来」，**都必须满足第六节的 v3 校验**；
> 转换来的文件 `scope` 要如实写 `local`，否则里面的数会被误读成通用口径。

---

## 六、结果写到哪

**用户覆盖层（优先读，你自己的数据写这里）：**

```
~/.dsh/blackpig-preset-caps.json      # Windows: C:\Users\<你>\.dsh\blackpig-preset-caps.json
```

**包内默认（回退）：**

```
<包目录>/defaults/preset-caps.json
```

读取顺序写死在 `blackpig-roster.mjs` 的 `loadPresetCaps()` 里：**用户文件优先，读不到 / 读坏了才回退包内默认**；
两者都没有 → `list: true` 明确回 `preset-caps-missing`（文案 `No preset baseline data found (未找到基准数据)`）并列出试过的路径，
**不编造模式、不猜能力**。

> ⚠️ 这两个文件**口径可以不同，名册不做换算**。出厂状态：包内 `defaults/preset-caps.json` 是**核心工具数**（33/1/4/35，机器无关）。
> 用户覆盖层通常记的是**实测全量工具面**（数值随机器变，测法见 1.2 第 1 条）。
> 名册只按「先用户层、后包内」决定**读哪个文件**，不判断里面记的是哪种口径——所以在覆盖层里放核心口径也完全成立
> （把包内 `defaults/` 抄成用户文件就是这么做的，此时 `list: true` 显示 33）。
> **唯一硬规则：同一份文件里只能有一种口径**，否则「这个模式有几个工具」和它实际列得出来的工具会自相矛盾。区别见 1.1。

### 格式（v3，2026-11-15 起；**老 v1/v2 不兼容**）

```json
{
  "version": 3,
  "scope": "<generic | local>",
  "baseline": "standard",
  "testedAt": "<跑基准的日期>",
  "testedOn": "<DSH 版本 / profile>",
  "note": "<这份文件的口径与来历，一句话>",
  "baselineTools": ["<baseline 模式的工具清单，字母序>"],
  "presets": {
    "<preset-id>": {
      "tools": ["字母序"],
      "toolCount": "<整数，与该模式 tools.length 相等>",
      "suitableFor": "一句话",
      "notSuitableFor": "一句话",
      "hidden": false
    }
  }
}
```

| 字段 | 必填(v3) | 说明 |
| --- | --- | --- |
| `version` | **是** | 必须 `3`；≠3 直接 `preset-caps-invalid`，不回退 |
| `scope` | **是** | `generic`（包内默认）/ `local`（本机覆盖层） |
| `baseline` | **是** | 基准 preset id（用 `standard`） |
| `baselineTools` | **是** | baseline 模式的工具清单（字母序）；全局编号表从它开始发号 |
| `presets` | **是** | 顶层对象，键 = preset id；**键的顺序就是名册里的顺序**，也决定编号的首现次序 |
| `tools` | **是** | 工具名数组，**必须字母序**；每条都会进名册的全局编号表 |
| `toolCount` | **是** | 名册括号里的数字；渲染时取 `entry.toolCount`，不是数字则回退 `tools.length` |
| `suitableFor` / `notSuitableFor` | **是** | 名册里的两行，一句话 |
| `hidden` | 否 | `true` = 不在名册里显示（见第八节） |
| `lacks` / `gains` / `only` / `comparisonSummary` | 否（**已废弃**） | A 规则 2026-11-20 起：**不校验、不渲染**。新文件不必写；写了也不会出现在名册里 |

> 📌 **v3 的 `loadPresetCaps()` 会逐个校验必需字段**：顶层 `version===3` / `scope` / `baseline` / `baselineTools` 数组，
> 以及每模式的 `tools` / `toolCount` / `suitableFor` / `notSuitableFor`。**缺任一个 = 整份文件无效 → `preset-caps-invalid`（`stop:false`），不回退包内默认**。
> 这是刻意的：老格式（v1 只有 4 字段、v2 缺 `scope`/`baselineTools`）现在没人用，
> 静默回退会让人误以为「名册还是旧的 4 个内置模式」。

### 名册的格式规则（A 规则，2026-11-20 起；**以规则为准，不以某次输出为准**）

名册是**纯函数输出**，形状固定如下（`<...>` 是占位符，不是要你填的字面量）：

```text
Tool roster (A numbering: first-seen order across presets; installed modes missing here can still be dispatched if you know their id)

Global tool index (<N> tools):
[001] <tool>, [002] <tool>, ...          ← 约 100 字符折行，绝不截断

Skill index (<S>):
[s01] <skill>, [s02] <skill>, ...        ← 技能单独编号，约 100 字符折行

- <presetId>: [001-0NN] | s[01-07]       ← 工具区间在前、技能区间在后
```

**规则（这几条是契约，改版才算变）：**

1. **工具编号（A 规则）**：按 `presets` 的**键顺序**遍历各模式的 `tools`，工具名**首次出现**即分配号码（从 1 递增），
   已发号固定不重排；**编号不写进 caps 文件**，渲染时现场算。基线模式因为是第一个 preset，固定占前段。
2. **全局工具索引**：`Global tool index (<N> tools):` 下一行起平铺 `[NNN] 工具名`，**逗号分隔**，
   每行约 100 字符处折行，**绝不截断**。`<N>` = 所有模式工具名的**并集去重数**，不是某一个模式的数。
3. **技能编号**：按模式顺序 × 每个模式 `skills.list()` 的返回顺序，技能名首次出现即发号 `s01`、`s02`…；
   技能索引形如 `[s01] 名字`，同样约 100 字符折行、不截断。
4. **模式行**：`- <id>: <工具区间> | <技能区间>`。区间由该模式的号码压缩成连续段——
   连续时写成 `[001-0NN]` / `s[01-07]`，不连续时写多段（如 `[012] [034-036]` / `s[02,04-07]`），空集省略该侧。
5. **不再打印** `(N tools)` 计数、`suitable:` / `not suitable:` 两行、`skills:` 行及其 `only in` 子句。
6. **过滤**：跳过 `selfId`（不列自己），跳过 `hidden: true` 的条目。两者都只影响**显示**，不影响派活。
7. **取不到的模式**：仍保留一行——caps 能回填则标 ` [snapshot]`，caps 也没有则写 `— [unknown]`，不许吞行。
8. **不设字节上限**：`ROSTER_HARD_CAP_BYTES` / `config.rosterMaxBytes` 已整体移除，全量清单与所有模式原样输出，绝不截断。
9. **空结果**：一个条目都不可显示时回 `No preset entry is visible.`，不是空字符串。

---
---

## 七、怎么改描述

只有一件事：**直接编辑 `suitableFor` / `notSuitableFor` 两个字段**，改完存盘即可。
名册那两行文字就变了，改完**不用重跑基准测试**、也不用改任何代码。

两条纪律：

1. **描述里只提核心工具能干什么**（按**核心口径**写：剔除插件后 `tools` 里真有什么才写什么；全量数更大，但不能拿来当描述依据，见 1.1）。别写「管记忆柜」「驱动远程会话」「发 IM 文件」——那些是第三方插件的能力，
   剔除后已经不在 `tools` 里了，写进去就是假话。
2. **不写「更强 / 更聪明 / 更通用」这类空话。** 判断标准必须是工具面：没有 `read/write/edit` 就是不能读写文件；
   没有 `web_fetch/web_search` 就是不能联网；没有浏览器 DOM / 截图 / 点击工具就是不能操作网页界面。

改了 `node_modules` 里的包 → 需要重启 DSH 生效（启动期装载）。只改 `~/.dsh/blackpig-preset-caps.json` 这个用户文件 → 下次 `list` 重读即生效。

---

## 八、怎么禁用某个模式

三件不同的事，别混：

| 想做的事 | 怎么做 | 效果 |
| --- | --- | --- |
| 改描述文字 | 改 `preset-caps.json` 里该模式的 `suitableFor` / `notSuitableFor` | 名册那两行文字变了 |
| **软隐藏**（只在名册不显示） | 该模式加 `"hidden": true` | `list: true` 看不到它；**`delegate` 仍能派给它** |
| **彻底禁用**（不许派） | 黑猪 `cordis.patch.yml` 里 `blackpig-roster` 的 config 加 `disabledPresets: [your-mode-id]` | `delegate` 回 `preset-disabled`（`stop: true`） |

`disabledPresets` 写法：

```yaml
- id: blackpig-roster
  config:
    enabled: true
    selfPresetId: blackpigmodel
    disabledPresets: [your-mode-id]
```

> ⚠️ 两个「看不到」的坑：**名册看不到 ≠ 派不了**（`hidden: true` 或根本不在 JSON 里，都只是不显示）；
> **派活永远是活的校验** —— `delegate` 读 `agentPresets` 注册表确认目标存在且没坏，与基准文件无关。
> 所以基准文件写错只会让名册难看，不会让派活失败。

---

## 九、为什么不能用静态解析 / 不能让 worker 自报

### 静态解析走不通

宿主的 `agentPresets` 能给的只有「这个模式装载了哪些模块」，**给不出运行时真实可调用的工具名**：
`definitions(scope)` 要求 scope 是活跃 Agent，静态拿不到。官方原文：

> **a tool schema is not statically knowable**

「模块 → 能力」这条路本来就不稳：装一个插件，所有模式的工具面都变。
v1.0.6 及以前的名册正是靠模块名映射能力词（`DEFAULT_CAPABILITY_HINTS`），结果是又长又不准。
v1.0.7 因此改成「跑一次、存下来、读文件」。

### worker 自报也不行（实测踩坑）

模型对自己工具面的自述**不可靠**。以下是实测踩到的三类，重点在**结论**，不在当时的数字：

1. **同一个模式，两次自述能差几十倍。** 一次把程序内部能调度的工具全算成「我能直接调用」，一次漏到只剩一个。
2. **自报是凭「记得自己用过」，不是凭「查过自己有」。** 有 worker 在自述里列出了它其实没有的工具
   （例如本来就不在它 `tools` 里的 `read` / `write`）。
   某个模式到底有哪些工具，只由它的 `tools` 决定（核心口径见 1.1，全量口径见 1.2 测法 1），**自述不作数**。
3. **派 minimal 实际落成 standard。** 让一个 `standard` worker 用 `subagent` 去开 minimal worker，
   参数写了 `agentPreset: minimal` 也没用——`subagent` 不接受 preset 参数，落成的还是 standard，
   于是你拿到的「minimal 数据」其实是 standard 的。**这就是「必须黑猪自己驱动」的由来。**

结论：**工具清单只信 `request/header` 原文**；worker 只负责写那两句人话（那是它的强项，也只需要它做这个）。

---

## 十、已知限制

1. **基准测试必须由黑猪自己驱动。** 普通 worker 的工具面没有 `subagent_preset`，无法派指定 preset 的 worker；
   只有黑猪（或有 `subagent_preset` 的角色）能跑。见第四节。
2. **一次派活得两份数据。** 工具清单只能从会话日志取（`request/header.tools[]`），描述只能从 worker 回复取。
   少任何一份都不完整；两件事不能合并成一次自述。
3. **preset 名不唯一映射工具集。** 同一个 preset，不同会话的工具数可以差很多（有会话只剩残余几个）。
   根因是**委派方附加的工具白名单**（父会话可以在派活时裁剪子会话的工具），而这份裁剪**不记录在日志的配置字段里**。
   但**黑猪的 `delegate` 不传 `toolFilter`**，所以走黑猪路径时工具集由 preset 唯一决定。
   → 取数时要确认那个会话是黑猪派的（判据是「它是不是 `subagent_preset` 派出去的」，**不是工具数**），别混进被裁剪过的会话。
4. **版本漂移。** 同一模式的工具集在版本之间会变（同一大版本内也换过：同名工具被替换成行为不同的另一个）。
   同一份 JSON **不跨版本通用**。
   → **JSON 必须带 DSH 版本号（`testedOn`），升级后重跑**；判断「有没有变」用 1.2 测法 4 的 diff，别靠记数字。
5. **同一会话内工具可能变**（实测只有协调者模式出现过中途变化，其余模式稳定）。
   → 统一取第一条 `request/header`。
6. **部分会话没有 `request/header`。** 有的会话从未发过请求（启动即失败/被取消），拿不到清单。
   → 换会话重跑，不编数据。
7. **名册发现不了「JSON 之外的模式」，得靠派 worker 读配置。** `list: true` 只读 `preset-caps.json`，不看 registry。
   要查这台机器装了哪些模式：直接 `subagent_preset({ list: true })`。
   「派一个 standard worker 读 `cordis.patch.yml`」。
   这条路的真实限制：①worker 必须真的读文件、不能凭记忆报（prompt 里已要求按 `name:` 行找 `config.id`）；
   ②它只给 id、不给能力（能力仍要跑基准测出来）；③文件名/结构变了它可能报错，需人工核一眼。
   `hidden: true` 只影响 `list: true` 排版，**不影响 `delegate` 派活**（要真禁用请用 `config.disabledPresets`，见「怎么禁用某个模式」一节）。

---

## 十一、常见问题

**Q：我只用 DSH 自带的 4 个模式，还要跑吗？**
不用。包内 `defaults/preset-caps.json` 就是这 4 个模式的值（`scope: "generic"`，核心口径），复制成用户文件即可。

> 注意：这份是**核心口径**（33/1/4/35，剔了插件）。抄进去之后 `list: true` 就显示 33/1/4/35，**不再显示本机的全量数**——因为你把覆盖层换成了核心口径。想同时保留全量，就别覆盖现有覆盖层（见 1.1）。

**Q：装了 blender / mnemon / remote / im，为什么名册里没有它们的工具？**
因为它们不是「装裸 DSH 就有」的通用工具，会让基准在别人机器上失真。基准**包内默认只收核心工具**（v2 起连 `EXTRA` 行也不要了，
第三方工具就别写进 JSON）。

> 💡 但**本机的用户覆盖层不一样**：这份是「本机实测全量」，`tools` 里本来就含第三方插件工具
> （所以覆盖层里 `standard` 的工具数会**大于** 33）——它只用于「这台机器上现在能干什么」，不用于跨机器对比。两种口径的区别见 1.1。

**Q：名册里没有某个已装模式，是不是装坏了？**
不是。v1.0.7 起名册**只显示基准文件里有的模式**，不做自动发现。想让它出现 → 跑基准写进用户文件。
只是想看「这台机器到底装了哪些模式」→ 直接 `subagent_preset({ list: true })` 看名册。

**Q：`list: { all: true }` 还能用吗？**
**不能了，1.0.7 第三轮（2026-11-14）已删除。** `list` 参数现在只接受 boolean，传对象会被宿主 schema 直接拒绝。
要枚举 id 就用 `subagent_preset({ list: true })`。

**Q：`delegate` 会因为基准文件缺条目而拒绝派活吗？**
不会。派活校验是活的：读注册表确认目标存在且没坏。基准文件只决定「名册怎么写」。

**Q：重启才能生效吗？**
改 `node_modules` 里的包 → 是（启动期装载）。只改 `~/.dsh/blackpig-preset-caps.json` → 不用重启。

**Q：这份文档里的数字，我该信哪个？**
只信 **33 / 1 / 4 / 35**——那是包内 `defaults/` 的契约值，机器无关。
其余任何「本机有几个工具」「文件多大」本文都**不写**，需要时按 1.2 现场测。
