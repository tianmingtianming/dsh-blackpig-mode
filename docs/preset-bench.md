# 模式能力基准测试（preset benchmark）

> 适用：`dsh-blackpig-mode` **1.0.7 及以后**。名册（`subagent_preset({ list: true })`）不查宿主注册表、不做能力推导，
> **v1.0.10 起**：名册**优先从活注册表派生**（`agentPresets.acquireScope` + `tools.view` + `skills.list`）；静态 `preset-caps.json` 退化为**兜底快照**——只在接口缺失（老宿主）、单模式取不到、或整体读不到时使用。下面的基准流程仍适用于兜底数据。
> 包内自带 4 个内置模式的默认值；自定义模式、或内置模式的工具面变了，都得自己跑一次。
>
> **1.0.7 第三轮（2026-11-14 起）已移除 `list: { all: true }`**：`list` 参数回到纯 boolean。
> 「这台机器装了哪些模式」改为**派一个 standard worker 读 `cordis.patch.yml`** 拿到 id 清单（见第三节）。
> 为什么删：①它只服务基准测试，日常只用 `list: true` + `delegate`；②它绕过 hidden 过滤（见 3.4）。
>
> **A 规则（2026-11-20 起）名册改版**：不再打印 `BASELINE` 段，也不再打印 `lacks` / `gains` / `only` /
> `comparisonSummary`；改成「**全局工具编号表 + 每模式工具编号区间 + 两行说明**」。格式规则见第六节。
> 那四个旧字段仍可留在文件里（向后兼容：不校验、不渲染），但**新写的文件不必带**。
>
> **v3 校验（2026-11-15 起）**：顶层 `version:3` / `scope` / `baseline` / `baselineTools`；
> 每模式必填 `tools` / `toolCount` / `suitableFor` / `notSuitableFor`。
> **老格式（v1/v2）不兼容**：缺必需字段回 `preset-caps-invalid`（`stop:false`），**不回退包内默认**。
> 设置页提示词（`lib/client.js`）同步生成 v3。
>
> 本文取代 1.0.7 之前的旧版本文档。**旧的 `EXTRA:` 行写法已废弃**（v2 起工具清单直接从会话日志取，不再让 worker 自报）。
>
> 📌 **本文只写「怎么测」和「契约是什么」，不写任何一台机器的现值**——工具数、文件字节数、跑测日期都不写死。
> 需要现值时按 1.2 的五种测法现场测。这是刻意的：**现值会漂（换机器、装插件、升 DSH 都变），测法不会**。

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
| `~/.dsh/blackpig-preset-caps.json` | `local` | 本机真实全量工具面（数值随本机装的插件而变，测法见 1.2 第 1 条），含插件 | 设置页提示词驱动黑猪跑基准 |

> ⚠️ 覆盖层无论是「重跑基准生成」还是「从别处转换而来」，**都必须满足第六节的 v3 校验**；
> 转换来的文件 `scope` 要如实写 `local`，否则里面的数会被误读成通用口径。

---

## 二、什么时候要重新跑

满足任意一条就重跑。不重跑的后果：**名册里那份能力说明过时了，大脑会照过时的说明选人**——比没有数据更糟，因为它看起来很可信。

1. **首次使用**本插件，且想把自己装的模式也列进名册（只关心 4 个内置模式可以不跑）。
2. **DSH 升级之后**（升级会增删内置工具；同一大版本内也换过工具集，见第十节第 4 条）。
3. **装了新插件**（尤其带工具的，它们会往某些模式里加工具）。
4. **新增或删除会话模式**（新建自定义 preset、卸了某个 preset）。
5. **改了某个 preset 的 `cordis.patch.yml`**（工具面变了）。

---

## 三、怎么发现要测哪些模式

跑之前得先知道「有哪些 id 要测」。

> 🔴 **2026-11-14 第三轮改写**：原来这里的「途径 A：`list: { all: true }`」**已随该参数一起删除**。
> 现在唯一入口是**派一个 worker 读配置文件**（下面 3.1）。删掉 `all: true` 的两条理由见 3.2。

### 3.1 派 worker 读配置文件（唯一入口，1.0.7 第三轮起）

黑猪自己**没有** `read` / `grep` / `glob`（工具面被 `blackpig-guard` 收窄成 `keep: [subagent_preset]`），
所以它读不了配置文件 —— 但**它可以派一个有 read/grep 的 worker 去读**，再把 id 清单报回来。

**为什么这条路合法**：黑猪（depth 0）派 worker ⇒ worker 是 depth 1，远低于本项目 `maxDepth: 2`。
「派 worker 去读文件」不占用额外深度层级，也不依赖任何特殊参数。

**具体 prompt 模板（在 `blackpigmodel` 会话里直接说给黑猪）**：

```text
派一个 standard 模式的 worker，让它做这件事（它自己有 read / grep）：

读 <DSH_HOME>/profiles/<profile>/cordis.patch.yml，
找所有 name 为 "@deepseek-ai/dsh-agent-preset" 的声明行，
取各自 config.id，加上 4 个内置（standard/ptc/minimal/cordis），
报回完整 id 列表。注意外层实例名（如 preset-blender-worker）不是真正的 id，
真正的 id 在 config.id 里。
```

`<DSH_HOME>` / `<profile>` 是占位符，**别让 prompt 写死成本机路径**：
黑猪会把它拼成绝对路径交给 worker，写死在别的机器上就错。要具体值时从当前 profile 的配置推，不要凭记忆填。

**worker 该回的形状**：**一行一个 id**，纯 id、不带序号或解释，方便直接当待测清单。
⚠️ **别拿某台机器的 id 清单当样例**——装了哪些模式因机器而异，清单必须现场读出来。

**拿到清单后要做的三件事**：

1. 去掉 `blackpigmodel`（黑猪自己，派自己会被 `self-preset` 拦，见 3.3）。
2. 拿不准的 id 先试派一次 —— 派不存在的 id 只回 `unknown-preset`，**不浪费 LLM 调用**（见 3.3 表）。
3. 这份清单只是「注册表里有哪些」，**不是「哪些测过」**；测过与否看 `preset-caps.json`。

> ⚠️ 不要指望 worker 顺手把「能力」也报回来：能力自述不可靠（实测踩坑见第九节）。
> 这一步只干一件事：**要 id**。

### 3.2 为什么不再用 `list: { all: true }`（已删除）

该参数在 1.0.7 第二轮加、第三轮删。删的两条理由都经代码核查：

1. **只服务基准测试，日常无用。** 黑猪日常只用两个动作：`list: true`（读 `preset-caps.json` 出能力名册）
   和 `delegate`（派活）。`all: true` 只在「跑基准测试第 1 步」用得到，为它养一个 schema 分支 + 一个
   渲染函数不划算。
2. **它绕过 hidden 过滤。** 两条渲染路径的过滤行为完全不同：
   - `renderRoster()` 有**两道过滤**：跳过自己（`id === selfId`）、跳过 `hidden: true`（`entry.hidden === true`）。
   - 已删除的 `renderAllPresetIds()` **完全不读 `preset-caps.json`、不判断 hidden**。

   ⇒ 留着 `all: true` 等于开一条后门：名册里**故意藏起来**的模式，用 `all: true` 一样能列出来，
   而且连「不在 caps.json 里的」「broken 的」「自己」都一起列，四类 id 全漏。

现在「有哪些 id」走 `3.1` 的 worker 读配置，`hidden` 的语义只有一处（`list: true`），不会再自相矛盾。

### 3.3 一个必须提醒的点：派未知 id 与「测过」是两件事

`delegate` 的校验是**活的**：`presetUnusable()` 有四道闸，顺序是 `self` → `disabledPresets` → 注册表读取 → `broken` / `unknown`。

| 情况 | 结果 |
| --- | --- |
| 派一个**根本不存在的 id** | 立刻回 `unknown-preset`（`stop: false`，附可用清单）—— **不浪费 LLM 调用**，值得鼓励先试一次 |
| 派一个**存在但没写进 caps.json 的 id** | **派活成功**、正常出结果；只是 `list: true` 不显示它 |
| 派一个存在但组合不起来的 id | 回 `preset-broken`，附 `broken` 原因 |
| 派黑猪自己（`blackpigmodel`） | 回 `self-preset`（`stop: true`）—— 自己不能派自己 |

⇒ 「测过」和「能派」是两个独立维度：**测过 = 名册能说清它；能派 = 注册表里有它且没坏。**
所以基准测试里**不要**把 `blackpigmodel` 放进「要派活去测」的清单（它自己就是派活方，会被 `self-preset` 拦住）；
它的工具面只能从它自己的会话日志里取。

### 3.4 `hidden: true` 只影响名册排版，**不影响派活**

这一条必须说清，否则很容易误以为「hidden = 禁用了」：

| 手段 | 影响 `list: true` 排版？ | 影响 `delegate` 派活？ |
| --- | --- | --- |
| `preset-caps.json` 里 `"hidden": true` | **是**，名册不显示它 | **否，仍能派给它** |
| 不在 `preset-caps.json` 里 | **是**，名册不显示 | **否，仍能派** |
| `config.disabledPresets`（黑猪 roster 的 config） | 否 | **是**，回 `preset-disabled`（`stop: true`） |

⇒ 想**只让大脑别误选**它 → `hidden: true`；想**真禁用**、谁都不许派 → `config.disabledPresets`。
两者不是一回事，见第八节。

---

## 四、怎么跑（必须由黑猪自己驱动）

> ⚠️ **这一节是本文档最重要的一条，也是旧文档说反了的地方** —— 详见本节末尾「旧结论已推翻」。

**关键约束：基准测试必须由黑猪（`blackpigmodel`）自己派活，不能交给普通 worker 代跑。**

原因：普通 worker 的工具面里**没有 `subagent_preset`**，它只有 `subagent` / `subagent_fork`，而那两个**指定不了 `agentPreset`**。
让一个 `standard` worker 去「派一个 minimal worker」，实测**落成的还是 standard**（踩过，见第九节实测记录）。
所以要测哪个模式，就得有一个**手上真有 `subagent_preset` 的角色**去派——那就是黑猪本身。

**怎么「交给黑猪」**：在桌面端**新建一个 `blackpigmodel` 模式的会话**，把下面这段 prompt 说给它。
⚠️ 不要试图用 `subagent_preset({ preset: 'blackpigmodel' })` 从外面把黑猪派出来——那是自己派自己，
`presetUnusable()` 的 `self` 闸会直接回 `self-preset`（`stop: true`）。黑猪只能由用户从模式列表里选中启动。

```text
第 0 步：先搞清楚装了哪些模式 —— 你自己没有 read/grep，所以派一个 standard worker 去读配置：

  用 subagent_preset 派一个 standard worker，prompt 里让它这样干：

    读 <DSH_HOME>/profiles/<profile>/cordis.patch.yml，
    找所有 name 为 "@deepseek-ai/dsh-agent-preset" 的声明行，
    取各自 config.id，加上 4 个内置（standard/ptc/minimal/cordis），
    报回完整 id 列表。注意外层实例名（如 preset-blender-worker）不是真正的 id，
    真正的 id 在 config.id 里。

它会回一行一个 id 的清单。去掉 blackpigmodel（就是你自己，派自己会被 self-preset 拦），
剩下的就是待测清单。见第三节 3.1。

然后对清单里每个 preset 各派一个 worker（用 subagent_preset，指定 preset），
在 prompt 里要求它严格返回两行，不要解释、不要寒暄、不要列工具清单：

  SUITABLE: <一句话，这个模式适合干什么>
  NOT_SUITABLE: <一句话，这个模式不适合干什么 / 缺什么工具导致干不了什么>

重要：
1) 不要列工具清单（TOOLS / EXTRA 都不要写）。工具清单我们从会话日志的 request/header 里取原文，
   比你自报的准；你自报反而会漏、会错（实测漏过 read/write，也把 1 个报成 60 个）。
2) 判断「适合 / 不适合」以工具面为依据，不要写「更聪明 / 更强」这种空话。
   例：没有 read/write/edit 就是不能读写文件；没有 web_fetch/web_search 就是不能联网；
   没有浏览器 DOM/截图/点击工具就是不能操作网页界面。
3) 工作目录用一个空的临时目录，别碰真实项目文件。
4) 两句话各一行，原样贴回给我，不要汇总、不要改写。
```

跑到这里，每个模式你会拿到**两句话**。工具清单**不在这一步产出**——它来自第五节的会话日志。

> 成本：每个模式 = 一次极短的 worker 运行。4 个模式约 4 次短任务，几分钟。

### 旧结论已推翻（2026-11-14）

旧版本本文档写的是：

> 「黑猪模式自己只有 `subagent_preset`、没有 `subagent`，所以别让黑猪模式自己跑这一步」

**这条是错的，已推翻。** 反过来才对：正因为黑猪手上有 `subagent_preset`（能指定 preset）、普通 worker 没有，
所以**只有黑猪能驱动基准测试**。按旧文档把活交给 `standard` worker 跑，实测派出去的 minimal 会落成 standard，
拿到的数据是错的——而且看起来完全正常，最难发现。

---

## 五、数据怎么取（工具清单的唯一权威来源）

**一次派活得两份数据：**

| 数据 | 从哪来 | 谁产出 |
| --- | --- | --- |
| 工具清单（精确、逐字） | 会话日志的 `request/header` 事件 | DSH 运行时（原文，不经过模型转述） |
| 适合 / 不适合（人话） | worker 回复的两行 | 那个 preset 的 worker |

**日志路径：**

```
~/.dsh/sessions/<workspace>/<childSessionId>/session.v4.jsonl.zstd
# Windows: C:\Users\<你>\.dsh\sessions\<workspace>\<childSessionId>\session.v4.jsonl.zstd
```

`<childSessionId>` 就是黑猪刚才派出去那个 worker 的会话 id（`subagent_preset` 的返回里有）。

**取法（三步）：**

1. **解 zstd**。文件是 **zstd 多帧**拼接（不是单帧），魔数 `28 B5 2F FD`，每帧解出来是一段 JSONL；
   用能连续解多帧的库（Node 用 `zstd` 解压流式喂、或 `fzstd` 的 decompress 逐帧），别只解第一帧——只有第一帧会漏掉大部分 `request/header`。
2. **找 `request/header` 事件**，读 `data.header.tools[]`。
3. **每个元素的 `name`** 就是模型当时真实拿到的工具名（元素结构 = `{ name, description, parameters }`，
   `parameters` 是完整 JSON Schema）。

**为什么这条路是权威的：** `request/header` 是 DSH 发给模型的**真实请求头**，`tools[]` 就是模型那一刻的工具面原文。
它不是模型的「自述」，也不是插件的「声明」，是实际发出去的东西——**唯一不会被 worker 记错的一手证据**。

**两个取数注意点（实测）：**

- **同一会话内工具可能变**（实测有会话出现过中途变化，见第十节第 5 条，其余模式稳定）。
  → 统一**取第一条 `request/header`** 即可，不要取最后一条、也不要合并。
- **部分会话根本没有 `request/header`**（比如一启动就失败/被取消的）。
  → 这类会话拿不到清单，换一个会话重跑，不要编。

**剔除第三方插件工具。** 日志里的 `tools[]` 包含本机装的所有插件带进来的工具，
写进**核心口径**基准文件前要**剔掉**第三方插件的工具，只留「装裸 DSH 就有」的核心工具。
具体剔哪些、剔几个**不要抄任何文档**：按 `tools[]` 里出现的插件工具名前缀现场分类
（前缀与插件的对应关系看该插件自己的文档），差额随机器变（见 1.1）。
要写**全量口径**（用户覆盖层）时则**一个都不剔**。

> ⚠️ 所以同一台机器会同时存在两套数：**日志原文条数 = 全量口径**，**剔除后 = 核心口径**。
> 写进包内 `defaults/` 的是核心口径；写进用户覆盖层 `~/.dsh/blackpig-preset-caps.json` 的是全量口径。
> 两套数都不一样，**而且两套都随机器/版本变**——这才是 1.2 给测法而不给数的原因。
> `list: true` 显示哪个数，只取决于它读到哪份文件（见 1.1）。

**怎么核对两套数（用测法，不用记数）：**

1. 同一份 caps 里，每个模式的 `toolCount` 与它自己的 `tools.length` 应当一致（渲染时就是这个规则，见第六节）。
2. 全量口径的 `baselineTools.length` 应等于该模式日志里 `request/header.tools[]` 的长度（一个都不剔）。
3. 核心口径的 `tools` 应是全量去掉插件工具名后的子集；**差额不是常数**，每次重测都要重算，别复用上次的差额。

> `ptc` 的 `run_code` 在程序内部可以再调度别的工具，**但模型侧只看得到 1 个**——基准记录的是「模型侧看到的」，所以它的工具数恒为 1。

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
[001] <tool>, [002] <tool>, ...        ← 全局编号表，约 100 字符折行，绝不截断

- <presetId> (<toolCount> tool|tools): [001-0NN]        ← 该模式工具的编号区间
  suitable: <suitableFor>
  not suitable: <notSuitableFor>
```

**规则（这几条是契约，改版才算变）：**

1. **编号（A 规则）**：按 `presets` 的**键顺序**遍历各模式的 `tools`，工具名**首次出现**即分配号码（从 1 递增），
   已发号固定不重排；**编号不写进 caps 文件**，渲染时现场算。基线模式因为是第一个 preset，固定占前段。
2. **全局编号表**：`Global tool index (<N> tools):` 下一行起平铺 `[NNN] 工具名`，**逗号分隔**，
   每行约 100 字符处折行，**绝不截断**。`<N>` = 所有模式工具名的**并集去重数**，不是某一个模式的数。
3. **每模式一行**：`- <id> (<toolCount> tools): <编号区间>`。区间由该模式工具的号码压缩成连续段——
   连续时写成 `[001-0NN]`，不连续时写成多段（如 `[012] [034-036]`），空集写 `[]`。
4. **单复数**：`toolCount === 1` 时写 `tool`，其余写 `tools`（即 `(1 tool)` / `(0 tools)` / `(N tools)`）。
5. **两行说明**：只在字段非空时打印 `  suitable: ` / `  not suitable: `；JSON 里的换行会被折成单空格。
6. **过滤**：跳过 `selfId`（不列自己），跳过 `hidden: true` 的条目。两者都只影响**显示**，不影响派活（见 3.4）。
7. **不打印**：`BASELINE` 段、`lacks` / `gains` / `only` / `comparisonSummary`（A 规则起移除；旧字段即使写了也被忽略）。
8. **不设字节上限**：`ROSTER_HARD_CAP_BYTES` / `config.rosterMaxBytes` 已整体移除，全量清单与所有模式原样输出，绝不截断。
9. **空结果**：一个条目都不可显示时（全 hidden、或只剩自己），回
   `No preset baseline entry is visible (every entry is hidden, or is this mode itself).`，不是空字符串。

> 🔍 **怎么验格式没变**：别背某次输出。把这次 `list: true` 的原文存下来，与上次的 diff（1.2 测法 4）。
> **空 diff = 格式与内容都没变**；有 diff 时按上面 9 条定位是哪一条变了。
> 这个测法不依赖任何数字，所以三年前存的原文今天照样能 diff。

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
   **1.0.7 第三轮（2026-11-14）已删除 `list: { all: true }`**，所以现在发现模式要靠第三节 3.1 的
   「派一个 standard worker 读 `cordis.patch.yml`」。
   这条路的真实限制：①worker 必须真的读文件、不能凭记忆报（prompt 里已要求按 `name:` 行找 `config.id`）；
   ②它只给 id、不给能力（能力仍要跑基准测出来）；③文件名/结构变了它可能报错，需人工核一眼。
   `hidden: true` 只影响 `list: true` 排版，**不影响 `delegate` 派活**（要真禁用请用 `config.disabledPresets`，见 3.4 与第八节）。

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
只是想看「这台机器到底装了哪些模式」→ 派一个 standard worker 读 `cordis.patch.yml`（第三节 3.1 有现成 prompt）。

**Q：`list: { all: true }` 还能用吗？**
**不能了，1.0.7 第三轮（2026-11-14）已删除。** `list` 参数现在只接受 boolean，传对象会被宿主 schema 直接拒绝。
要枚举 id 就派 worker 读配置（第三节 3.1）。删它的理由见 3.2。

**Q：`delegate` 会因为基准文件缺条目而拒绝派活吗？**
不会。派活校验是活的：读注册表确认目标存在且没坏。基准文件只决定「名册怎么写」。

**Q：重启才能生效吗？**
改 `node_modules` 里的包 → 是（启动期装载）。只改 `~/.dsh/blackpig-preset-caps.json` → 不用重启。

**Q：这份文档里的数字，我该信哪个？**
只信 **33 / 1 / 4 / 35**——那是包内 `defaults/` 的契约值，机器无关。
其余任何「本机有几个工具」「文件多大」本文都**不写**，需要时按 1.2 现场测。
