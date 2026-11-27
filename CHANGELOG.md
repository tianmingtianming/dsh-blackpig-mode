# Changelog — dsh-blackpig-mode

## 1.1.0（2026-11-27）：六条硬机制与人格压缩

> **版本号仍是 1.1.0**，不新建版本号（仓库惯例：同版本多节，按日期追加）。本节记本版六条机制与人格压缩；文件守卫的挂载细节见下一节。

**一句话**：把「并行派活」从口头约定变成六道机器闸门 —— 冲突可见、卡死可唤、brief 可验、重复可拦、模式可对、失败必改派。文件 / 派发类闸门都在**真正发生之前**判定，拦下时只回执、不落盘、不中断正在跑的工人；看门狗只在事中观察，只唤醒、不杀。

**1. 文件写冲突守卫（`blackpig-file-guard.mjs`）**

- 挂 `fs/write-intent` / `fs/edit-intent`（`{prepend: true}`），write / edit / apply_patch 三条落盘路径都在**真正写之前**判定。
- 同一文件已被另一个在跑的 worker 占用时，后写者被拒，错误码 **`FS_CLAIMED_BY_PEER`**；文案含**文件路径**、持有者**完整 `childSessionId`**、**已持有秒数**、**两条出路**（`send_to_subagent` 把活交给同一 worker / 等它结束后重试）。
- 占用随 `agent/disposed`（worker 结束）、判死、TTL（默认 **600 s**，env **`DSH_BLACKPIG_FILE_CLAIM_TTL_MS`**）自动释放，无需人工清理；同一 worker 反复写自己占的文件放行。

**2. 父侧看门狗（`blackpig-watchdog.mjs`）**

- 四证判活：模型正在生成（`agent/assistant-stream` 未 end）/ 工具在飞（`pre-execute` 已发未回）/ 后台 job 在跑（`jobs.list`）/ 等审批；**任一为真只刷新计时，绝不计时**。
- 四证全空且静默超阈值（默认 **600 s**，env **`DSH_BLACKPIG_WATCHDOG_SILENCE_MS`**）→ 给协调者发一条 `[WATCHDOG-STALLED]` 通知把它唤醒，**绝不 interrupt 工人**；同一段静默期最多 2 条通知，任何活动恢复即复位。
- 证据源取不到 → 该工人永久跳过监控，绝不退化成「按时间判死」。

**3. brief 三段格式校验**：`subagent_preset` / `send_to_subagent` 的 brief 缺 `TASK` / `INPUT` / `OUT` 任一 → 拒 **`brief-not-structured`**。

**4. 必填 `task` 标签 + 派发去重**：同一调用方下同一 `task` 已有存活 worker → 拒 **`duplicate-task`**（文案给 `send_to_subagent` 的完整 `childSessionId`）；`reuseId` 复用不判重。

**5. `reuseId` 模式一致性**：复用的 worker 模式与传入 `preset` 不符 → 拒 **`reuse-mode-mismatch`**。

**6. 失败必改派闸**：协调者某次工具失败后，下一次派活的 brief 必须提到该错误（错误码 / 工具名，或错误原文前 20 字），否则拒 **`failure-not-delegated`**；立刻重试同一工具视为已处理。豁免：`ask_user_question`、派活工具自身失败、黑猪策略拒绝、`ABORTED` 系。

**7. 人格压缩**：`persona.prefix` **8,105 → 7,285 字符**（按字符/4 粗估约 **2,026 → 1,821 token**；实测日期 2026-11-27）。删掉已被代码接管的文字，新增「一条 brief = 一个产物」判据。

**已知限制（七条，不许粉饰）**

| # | 限制 | 后果 / 判据 |
| --- | --- | --- |
| 1 | **shell 写不拦** | 工人用 `pwsh` / `bash` / `run_code` 写文件绕过 `ctx.fs`，文件守卫看不见 |
| 2 | **`delete-intent` 未挂** | 先删后重建可绕过占用检查 |
| 3 | **`fs-observation-policy` 一旦启用会截断链** | 守卫完全失效；判据：`--dump-config` 里该插件那行 `disabled` 不再为 `true` |
| 4 | **工具内部死锁看门狗判不出来** | 永远表现为「工具在飞」，按安全边永不触发 |
| 5 | **brief 校验只验格式** | 验不了「brief 是否自足、产物是否可验收」——那部分靠人格判据 |
| 6 | **去重依赖标签纪律** | 同一件事换了 `task` 写法就拦不住 |
| 7 | **同一微任务内两 worker 同时起步的竞态** | 代码推断不会双双读到无主，**未实测** |

**验证（分级）**

- 单元测试：批二 **15/15**、看门狗 **6/6**（含变异测试）、批三 **10/10**。
- 装载层：`dsh-verify` **PASS + exit 0**（临时 HOME 装载）。
- 文件守卫：**离线黑猪会话端到端四条已通过** —— 后写者被拒 / 文件未被覆盖 / 文案含持有者 id / 前者结束后重试成功。
- 其余五条：截至本次发布，**机制层与装载层已验证；真实黑猪会话端到端未在本文档成稿时确认**（见 README「验证状态」表）。

## 1.1.0（2026-11-27）：新增文件写冲突守卫 blackpig-file-guard

> **版本号仍是 1.1.0**，未建新 tag。本轮带源码修复（新增守卫模块），因此按「删 Release → 删 tag → `gh release create v1.1.0 --target <新 sha>`」让 tag 指向带本模块的提交；`package.json` 的 `version` 未动，`files[]` 增加一项 `blackpig-file-guard.mjs`。

**新增文件写冲突守卫 `blackpig-file-guard`：并行 worker 写同一文件时，后写者被拒并被告知持有者，占用随 agent 结束自动释放。**

- **挂载**：`cordis.patch.yml:421`（`- id: blackpig-file-guard` / `config: {enabled: true, ttlMs: 600000}`）；挂 `fs/write-intent` 与 `fs/edit-intent` 两条 waterfall（`{prepend: true}`），一次覆盖 write / edit / apply_patch 三条落盘路径。
- **拒绝码 `FS_CLAIMED_BY_PEER`**，文案四要素：哪个文件（`displayPath`）、持有者（label 或**完整** `childSessionId`）、已持有秒数、可执行的下一步（`send_to_subagent` 交给同一个 worker，或等它结束后重试）。
- **释放三路**：`agent/disposed`（会话结束即释放，主路径）、`agents.get()` 判活（取不到 ≠ 已死，三态处理）、TTL 兜底（默认 600000 ms，可用环境变量 `DSH_BLACKPIG_FILE_CLAIM_TTL_MS` 覆盖）。
- **失败取向**：守卫自身任何异常一律放行 + `logger.warn`，绝不当单点故障；放行时 `return await next()` 交回下游原值，不合成任何 intent（不改变宿主「无条件覆盖」语义）。

**文件守卫自身的三个边界**（本版机制的完整七条见上一节）：

1. **shell 写入不拦**：`pwsh` / `bash` / `run_code` 写文件绕过 `ctx.fs`，守卫拦不到（宿主原生策略同一条边界）。
2. **`fs-observation-policy` 启用后失效**：它占同一 waterfall 且先截断则守卫完全失效；`--dump-config` 里该行 `disabled` 不再是 `true` 就要重测本守卫。
3. **仅同进程内生效**：占用表在 `globalThis[Symbol.for('dsh-blackpig-mode:file-claims:v1')]`，不落盘、不跨进程，两个 DSH 实例之间不共享。

**验证**：`dsh-verify` **PASS + exit 0**（未盖基线）；离线端到端四条判据（c1 后写被拒 / c2 冲突期间先写不丢 / c3 文案带可执行持有者身份 / c4 释放后重试成功）**全中**。此后在同一版本上又补做了**离线黑猪会话**端到端，四条同样全过（后写者被拒 / 文件未被覆盖 / 文案含持有者 id / 前者结束后重试成功）：**原先「离线 HOME 构造不出黑猪 preset 会话」的结论已被这次补测推翻，以补测为准。**

## 2026-11-26 v1.1.0 **再次原地覆盖**（版本号不变）：探针缺 `signal` = BUG1 真因

> **版本号仍是 1.1.0**，**不建新 tag**。`gh release upload v1.1.0 --clobber` 覆盖同一资产，
> `package.json` 的 `version` 未动。上一节（2026-11-25）的记录保持原文不删，本节是它的**修正**。

### BUG1 真因：`startActivation()` 的 spec 少了必填的 `signal`

- **上一版为什么没修好**：2026-11-25 那版修的是「等」——把 `await activation.result` 改成等
  `activation.result.promise`。但探针**在创建阶段就抛了**，`activation` 根本没拿到，那条等待代码
  一次都没执行到。当时的离线 mock 没复刻宿主对 `signal` 的硬校验，所以 mock 显示「修好了」。
- **根因**：`subagents.startActivation(spec)` 的 `spec.signal` 是**必填**。宿主
  `SubagentActivationSpec` 的 `signal` 缺失时，`manager.trackStartup()` 第一句
  `signal.throwIfAborted()`（`dsh-subagent/lib/manager.js:642`）直接抛 **TypeError**
  （`Cannot read properties of undefined (reading 'throwIfAborted')`）。该异常被 `liveCapture()` 的
  `try/catch` 吞成一条 warn，`liveCapture()` 返回 `null` ⇒ 每个模式都退回 `tools.view()` 注册面并标
  `~reg` ⇒ **9 个模式全员 `~reg`，表现为静默回退，日志里只有一条不显眼的 warn**。
- **对照组**：`delegate` 路径（`blackpig-roster.mjs` 的 `:1311`）一直传 `signal: exec?.signal`，
  所以**派活正常、只有探针挂**——这也是为什么之前容易误判成「等待逻辑坏了」。
- **修法**：`collectLive()` 调用点补 `signal: exec?.signal`；探针 `startActivation` 的 spec 补
  `signal: options.signal`。
- **离线 harness 复现/验证**（`%TEMP%\bp-harness\harness.cjs`，忠实复刻
  `spec.signal.throwIfAborted()` 与 `activation.result` 的 resolver 对象形态）：
  ```
  修前（生产包 71087 B）：~reg = 9 ; startActivation 抛 TypeError → 全部退回注册面
  修后（本版 72198 B）  ：~reg = 0 ; startActivation 调用 8 次全成功 ; 缓存写满 1844 B
  二次调用              ：0 次探针（走缓存），4 ms
  ```

### 附带修复：`listDescendants()` 必须传 `rootSessionId`

- **根因**：宿主签名是 `listDescendants(rootSessionId, signal)`（`dsh-subagent/lib/types/list-children.js`），
  原来**无参调用** ⇒ 每次都抛 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`，被 `catch` 吞掉。
  后果不是名册坏掉（还有派探针兜底），而是「免费回看已结束子会话」这条路径**等于不存在**，
  每次都得白派一个探针。
- **修法**：`latestChildCapture()` 改为 `listDescendants(rootId)`，`rootId` 取 `parent?.id`；
  `rootId` 为空时直接返回 `null`（不再发无参调用去撞异常）。

### 其它

- `verify.ps1` 字节表同步：`blackpig-roster.mjs` 71087 → **72198**。
- 包内 `README.md` / `CHANGELOG.md` 同步（`~reg` 三级取数章节补两条 ⚠️ 修复说明）。
- 三处修复**只动 `blackpig-roster.mjs`**；`inject` 仍是 `['tools', 'subagents', 'agentPresets']`，
  `package.json` 的 `version` 仍是 `1.1.0`，`files[]` 仍是 11 项。

## 2026-11-25 v1.1.0 **原地覆盖**（版本号不变）：修两个实测 bug

> **版本号 1.1.0 保持不变**，未建新 tag。按用户裁定「版本号更新用户说了算，不说就默认覆盖」
> 与纪律「原地覆盖当前版本」，用 `gh release upload v1.1.0 --clobber` 覆盖 v1.1.0 的 Release 资产。
> （同日更早那次 1.1.0 发布保持原文不删，见下一节；本节是它的**修补覆盖**。）

### BUG1（致命）：`list: true` 里所有非 ptc 模式全部 `~reg`，实测路径全挂

- **现象**：9 个模式全部退到注册面并标 `~reg`；ptc 正常（它走执行器特判、不实测）。
- **根因**：`liveCapture()` 里写的是 `await activation.result`。宿主 `subagents.startActivation()`
  返回的 `activation.result` 是 `Promise.withResolvers()` 的 **resolver 对象**
  （`{ promise, resolve, reject }`），**不是 thenable** —— `await` 一个普通对象会在 **0 ms** 内返回
  （实测 `typeof result = object` / `result.then = undefined` / `elapsed = 0`）。
  后果：探针子会话**刚创建、还没发出任何请求**，紧接着 `readRealTools()` 读请求头拿到「没有请求头」
  → 返回 `null` → 每个模式都退回注册面并标 `~reg`。
  宿主真正暴露的等待入口是 `activation.result.promise`（`dsh-subagent/lib/index.js:2211`）。
- **修法**：新增模块级 `awaitActivation(activation)`，兼容三种形态（thenable / `{ promise }` / 都没有），
  `liveCapture()` 改为 `await awaitActivation(activation)`。**没有**把 `inject` 加任何服务。
- **实测对照**（同样复刻宿主 resolver 对象形态，子会话 300 ms 后才写出请求头）：
  ```
  BEFORE  - standard: [001-003] ~reg            ptc 两行    elapsed 1ms   （根本没等）
  AFTER   - standard: [001-004]                 ptc 一行    elapsed 314ms （真的等了）
  ```

### BUG2：`list: true` 里 ptc 输出两行

- **根因**：`renderRows()` 先**无条件** push 一条 `- ptc: [058] | s[…]`，随后 `if (row.source === 'executor')`
  又 push 一条 `- ptc: [058] — <说明…>`，同一个模式出现两次。
- **修法**：执行器分支**接管**这一行——编号 + 技能 + 说明写在同一行（`- ptc: [NNN] | s[…] — 说明`），
  说明续行仍缩进两格；非执行器行保持原样。

### 其它

- `verify.ps1` 字节表同步：`blackpig-roster.mjs` 68514 → **71087**。
- 包内 `README.md` 同步名册章节（实测行为、`~reg` 含义、ptc 单行）。
- 两处修复都**只动 `blackpig-roster.mjs`**；`inject` 仍是 `['tools', 'subagents', 'agentPresets']`。

## 2026-11-25 v1.1.0：名册显示**真实工具面**（不再拿注册面冒充）

> 版本号 **1.0.10 → 1.1.0**（`package.json` 的 `version` 已 bump）。

- **根因**：`subagent_preset({ list: true })` 的工具区间取自 `tools.view(scope).visible` —— 那是该 scope 下**已注册**的工具集，不等于模型实际下发的工具表。executor 类模式最典型：`ptc` 注册了整套被代理的工具，模型真正能直接调的只有 `run_code`，名册却把整套都列了出来。
- **改为实测值**：新增 `readRealTools(ctx, childId)`，数据链 `sessionQuery.readSession(childId)` → 折叠 `request/header` 事件 → `header.tools`（= 模型当时看到的真表）。新建会话没有请求头时返回 `null`，任何异常也 `null`，绝不把「读不到」当成「零个工具」。
- **折叠实现放在本包内**（`foldLastRequestHeader()`）：**没有** `import { foldRequestHeader } from '@deepseek-ai/dsh-session'`。2026-11-25 实测该裸包在本部署两个解析根下都 `ERR_MODULE_NOT_FOUND`（profile 的 `node_modules\@deepseek-ai` 只有 `cosmokit` / `schemastery`，宿主包在 `app.asar` 里），ESM 静态 import 在装载期解析失败会让整个 `blackpig-roster` 起不来、工具与 `delegate` 一起消失。折叠判据与上游等价：遍历事件取**最后一条** `request/header` 的 `data.header`。
- **ptc 特判**：挂载了 `@deepseek-ai/dsh-tool-executor-ptc` 的模式（本部署即 `ptc`）固定返回 `['run_code']`，**不实测、不缓存**；名册在该行下面另出一段 5 行说明（Programmatic Tool Calling / 什么时候用 / 只有 `run_code` 可直接调）。说明行里的编号由全局首现发号自动产生，不硬编码。
- **首次实测 + 被动采集 + `~reg` 回退**（三级取数）：
  1. ptc 执行器 → `run_code`（`source: executor`）；
  2. 缓存命中 → 用缓存值（`source: captured`）；
  3. 缓存未命中 → 先回看该 preset **已结束**、且比缓存新的子会话（免费采样），没有才当场派一个极短子代理（`reply OK`，**等它跑完**、不设超时）再读请求头；成功即写缓存（`source: captured`）。
  实测拿不到时退回 `tools.view()` 的注册面并标 `source: registered`，渲染成编号后带 ` ~reg`：那些编号是「注册了」而不是「模型真能直接调」，不许伪装成实测值。
- **被动采集**：`delegate` 成功路径把 `{ presetId → childId }` 记进缓存（**只记 childId，不覆盖已有 `tools` / `capturedAt`**），下次 `list: true` 就能回看该子会话刷新工具表，省掉再派探针。
- **缓存文件**：路径优先取 `config.toolsCachePath`（`cordis.patch.yml` 可配）；未配置时由**本次进程的 `DSH_HOME`** 推出 `${DSH_HOME}/profiles/desktop/preset-tools-cache.json`（`DSH_HOME` 未设置则退 `homedir()/.dsh`，与 `dsh-home-paths` 的 `defaultDshHome()` 同口径）。**代码里不写死 `~` 或任何机器路径**：`fs.readText` 会经 `expandHomePrefix()` → `os.homedir()` 展开，而 `homedir()` 只看 USERPROFILE、与 `DSH_HOME` 无关 ⇒ 隔离实例（临时 `DSH_HOME`）会把缓存写进生产 profile，多 HOME 互踩。结构：`{ "version": 1, "presets": { "<id>": { "tools": [...], "capturedAt": <epochMs>, "childId": "..." } } }`。读失败 / 不存在 / 结构不符 → 空表、不抛；写失败只 `warnOnce` 一次，绝不阻塞名册；写入意图按 `fs.stat()` 的结果分三支：文件存在且 `FsInfo.version` 可用 → `{ kind: 'replaceIfVersion', version }`（版本令牌**只能**来自 `stat()`，宿主契约明写 `MUST NOT interpret this token`，不许自己造）；文件不存在 → `{ kind: 'createIfAbsent' }`；create 撞上已存在 → 重读拿版本再替换。任何写失败（含 `FS_STALE_VERSION`）只 warn 一次，名册不受影响。
- **`inject` 未动**：仍是 `['tools', 'subagents', 'agentPresets']`。`sessionQuery` / `fs` / `skills` / `workingDirectory` 一律用 `ctx.get()` 按需取，取不到就降级 —— 往 `inject` 里加拿不到的服务会让整个插件静默失活。
- **已知限制**：
  - 实测要**真的派一个子代理并等它跑完**（用户要求不设超时），首次 `list: true` 因此会慢，并消耗一次极小子会话；缓存命中后只剩回看（无新建会话）。
  - 工具表只会**事后刷新**：某模式升级了插件、但缓存的 `capturedAt` 比新会话还新时，回看会跳过它，仍显示旧表，直到该子会话比缓存更新或缓存被删。想强制重测就删缓存文件。
  - 缓存按 preset id 存，**不区分 DSH 版本**；宿主升级后工具面可能变，删缓存即可重测。
  - 取不到插件表（`agentPresets.plugins()` 不可用）时，ptc 只能按 `row.id === 'ptc'` 兜底判据识别；其他 executor 类模式会被当成普通模式实测。
  - 回看依赖 `subagents.listDescendants()` 与行上的 `agentPreset` / `createdAt` 字段；字段缺失时只是少一次免费采样，不影响当场实测。
  - 缓存路径默认按 `DSH_HOME` 推导，但**profile 目录名仍写死 `desktop`**：非 desktop profile 的部署要显式配 `config.toolsCachePath`，否则多个 profile 会共用同一份缓存（只是缓存，最坏是互相加速、不会损坏）。
- **打包（缺陷已定位，脚本未改）**：`tools/build-blackpig-tgz.mjs` 的 `walk()` 收 staging 下的**全部**条目，**不读 `package.json` 的 `files[]`、也不过掉点文件**。拿仓库根当 `--staging .` 打，条目数 **278**、其中 `.git` 占 **264**（含 `.git/COMMIT_EDITMSG`）= 2 MB 级 tgz。⇒ 打 1.1.0 的包**必须**先建干净 staging（只拷 `files[]` 的 11 个文件、不递归、不含 `.git`），再从 staging 打；打完用 `tar -tzf | grep -c '^\.git/'` 应为 **0**。
- `verify.ps1` 期望字节同步：`blackpig-roster.mjs` 46944 → **68514**（初版 64274，含本轮三个缺陷修复）、`package.json` 709 → **708**（BOM 保留）。

## 2026-11-24 追加（版本号不 bump，仍 1.0.10）：可控工具描述保守精简

- 只精简黑猪自注册的 4 个工具描述，防误用语义全保留：`subagent_preset` 963→895 B（保留先 list:true、按能力区间选、reuseId/fresh 判据原文不动）、`send_to_subagent` 1064→651 B（保留 messageId 只证明入队、interruptVerified=false、下一轮投递）、`stop_subagent` 634→483 B（保留 send_to_subagent 先请求 interrupt）、`file_info` 846→541 B（保留 list:true 与 200 条/8192 B 上限）。
- 合计省 **937 B ≈234 token**；宿主工具描述零改动。`verify.ps1` 期望字节同步（roster 46944 / subtalk 57920 / file-info 39726，BOM 已补回）。

## 2026-11-24 追加（版本号不 bump，仍 1.0.10）：删除 wait_agent

- **从大脑工具面删除 `wait_agent`**：`guard-v10.mjs` 的 `DEFAULT_KEEP`/`TRIM_EXEMPT_TOOLS`/`TEAM_ONLY_TOOLS` 各删一处；该工具只等自己收件箱输入、无 target、不能替代完成通知，属误导面。`DEFAULT_KEEP` 21 名（删前 22）、扣 extraDeny 后可用 19（删前 20）。
- **清理死提示**：guard 轮询闸门的 team 分支不再说「要等队友就调用一次 wait_agent」，改为等结算通知自动到；`blackpig-roster.mjs` 派活回执、`subtalk.mjs` stop 回执删 wait_agent 误导线；人格（cordis.patch.yml:80）那条禁令改为通用表述「结算通知自动唤醒、派出即报即停」。`compat.mjs` 里的 wait_agent 仅作宿主版本探测参考（不作判据），保留。README 工具计数同步。

## 2026-11-24 追加（版本号不 bump，仍 1.0.10）：可续 worker 硬判据 + 锚点注入下架

- **`subagent_preset` 复用硬判据**：存在 `mode==='continuable'` 的直接子会话时，`delegate` 要求显式二选一——`reuseId`（冷恢复，`compat.callSendMessage`，不新建）或 `fresh:true`（新开）；都不传 → `reusable-worker-exists` + ≤3 候选（仅拒时回，正常路径零新增 token）。名册走 durable catalog 投影，不进每轮上下文；不判 desc 相似。schema +`reuseId`/+`fresh`（4→6 参数，工具定义 ≈+705 B ≈176 token）。
- **锚点注入层下架**：删除 `blackpig-anchor.mjs` 与 `cordis.patch.yml` 挂载行，L2/L3/L3+ 每轮/周期机器注入全部停止；保留 L1 静态人格句 `**Reuse by default.**`。`package.json files[]` 去该文件，`verify.ps1` 期望表/布局判据同步（section-mute 未动）。
- 验证：`dsh-verify` 改前改后均 PASS/exit 0（零差异）；包内 `verify.ps1` 0/5–5/5 全 OK、exit 0。

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

