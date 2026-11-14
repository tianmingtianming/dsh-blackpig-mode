// 黑猪模式 · 基准测试提示词（Web 客户端半边）
//
// ⚠️ 为什么不是 Config 的 `.description()`（2026-11-15 实测结论）：
//   1. 宿主 `@deepseek-ai/dsh-settings` 的 `describe()` 只投影 **volatile**
//      字段（`volatileForm()`，src/index.ts:308）；本包的 `blackpig-roster`
//      根本没有 export Config，加了也进不了 settings 命名空间。
//   2. 即便加了 `.volatile()`，**出厂客户端没有任何一个按 schema 自动渲染
//      表单** —— dsh-settings README 原文：「no shipped client does so yet」。
//      所以 description 在设置页没有渲染位置，多长都一样不显示。
//   3. 另有一条独立原因：本包所有 Loader 行都是子路径
//      （`dsh-blackpig-mode/blackpig-roster.mjs`），而宿主的客户端发现
//      （`exactPackageSpecifier`）只认**裸包名** —— 子路径不参与
//      `dsh.client` 扫描。所以 cordis.patch.yml 里补了一行裸名 `dsh-blackpig-mode`
//      （apply 为空，见 index.mjs）。
//
// 因此走正经的 Web 客户端插件路线：注册 `settings.section`（设置导航里的一级页面）。
// ⚠️ 不用 `plugins.item`：那个 slot 的注册项一律进「插件 → 内置插件配置」分组。
// ⚠️ 也不用 `plugins.bundle.config`：它只在「组合包详情页」里渲染，而本包在插件页
//    根本列不出来（宿主 listed 过滤要求 installed / official / error 三者之一；
//    本包写在 optionalDependencies 里 => installed=false，且无 error）。
// settings.section 是 dsh-multitask 已验证过的座位，不需要额外可见性条件。
// 卡片里放完整提示词 + 一键复制；实测全文 2453 字符、换行保留（white-space: pre-wrap）。
window.__ModuleLoader__.load({
  id: 'dsh-blackpig-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PROMPT = [
      '跑一次 preset 能力基准测试，结果写进用户覆盖文件。四步走，不要中途问我。',
      '',
      '【第 1 步：拿模式名单】',
      '派一个 standard worker 去读配置文件列名单：',
      'subagent_preset({ preset: "standard", prompt: "<下面这段>" })',
      '',
      '「读 DSH_HOME 下的 profiles/<profile>/cordis.patch.yml（DSH_HOME 通常是 ~/.dsh）。',
      '找所有 name 为 "@deepseek-ai/dsh-agent-preset" 的声明行，取各自 config.id。',
      '注意：外层实例名（如 preset-blender-worker）不是真正的 id，真正的 id 在 config.id 里。',
      '另外加上 4 个内置：standard / ptc / minimal / cordis。',
      '报回完整 id 列表，去重。',
      '',
      '预期拿到 8 个左右（4 内置 + profile 里声明的自定义模式）。',
      '★ 黑猪自己（blackpigmodel）不会出现在这个列表里——它在黑猪包自己的 cordis.patch.yml 里。',
      '  不用管它，第 2 步本来就要跳过它。',
      '不要读别的文件、不要改任何东西。」',
      '',
      '【第 2 步：逐个采人话描述】',
      '对第 1 步每个 id（跳过 blackpigmodel——你自己，会被 self 拒），各调一次：',
      'subagent_preset({ preset: "<id>", prompt: "<P>" })',
      '',
      'P = 「只回两行，不要其他内容、不要执行任何操作：',
      'SUITABLE: <一句话，基于你实际能调用的工具说适合做什么，不要空话>',
      'UNSUITABLE: <一句话，说清缺什么工具导致什么活干不了>」',
      '',
      '记下每条的 childSessionId 和那两行文字。',
      '派活失败（unknown-preset / preset-broken）就跳过并记入失败清单，不要重试。',
      '',
      '【第 3 步：派 worker 读日志 + 算差异 + 落盘】',
      '你自己没有 read/write/pwsh，必须派一个 standard worker 做这一步。',
      'subagent_preset({ preset: "standard", prompt: <BRIEF> })',
      '',
      'BRIEF 内容：',
      '',
      '■ 任务：从会话日志提取每个 preset 的精确工具清单，算差异，写成 JSON。',
      '',
      '■ 输入（父会话传来的数据，逐条列出）：',
      '  <id> childSessionId=<uuid> SUITABLE=<...> UNSUITABLE=<...>',
      '',
      '■ 取工具清单（关键，别用别的方式替代）：',
      '1. 定位日志：在 DSH 会话目录下递归找 **/<childSessionId>/session.v4.jsonl.zstd',
      '   会话根目录 = <DSH_HOME>/sessions/。子目录名是工作区路径转义后的形式，',
      '   不要硬编码，直接按 childSessionId 搜。',
      '2. 解压：这些文件是多帧 zstd 拼接。**必须**按魔数 28 B5 2F FD 逐帧切分后，',
      '   用 node 的 zlib.zstdDecompressSync 逐帧解。',
      '   ⚠️ 致命坑：整块一次解**不会报错**，只会**静默返回第一帧**（实测 257 B vs 真实 25.6 MB）。',
      '   如果你解出来很小、找不到 request/header，就是踩了这个坑——不要以为日志里没有。',
      '3. 取第一条 request/header 事件的 data.header.tools[]，每个元素取 name。',
      '   这是模型真实收到的权威清单，不是 worker 自报。',
      '   不要剔除任何工具——本机装了什么插件就记什么，这才是真实工具面。',
      '',
      '■ 算差异（用代码算集合差，不要手写）：',
      '以 standard 为 baseline：',
      '  lacks = baseline.tools 有、该模式没有的',
      '  gains = 该模式有、baseline.tools 没有的',
      '',
      '■ 写文件：',
      '路径 = <DSH_HOME>/blackpig-preset-caps.json（和 sessions/ 同级）',
      '格式：',
      '{"version":2,',
      ' "testedAt":"<今天 YYYY-MM-DD>",',
      ' "testedOn":"<当前 DSH 版本>",',
      ' "baseline":"standard",',
      ' "note":"黑猪预设能力基准，反映本机真实工具面（含第三方插件）。lacks/gains 按 baseline 计算。",',
      ' "presets":{"<id>":{"tools":[<字母序>],"toolCount":N,"lacks":[],"gains":[],"suitableFor":"...","notSuitableFor":"..."}}}',
      'UTF-8 无 BOM、2 空格缩进、LF。',
      '若某模式该隐藏，加 "hidden": true。',
      '',
      '■ 回报：每个模式的 toolCount / lacks 数 / gains 数；哪些 id 没找到日志。',
      '',
      '【第 4 步：自检】',
      '第 3 步回来后调 subagent_preset({ list: true })，确认名册显示新数据——',
      '应该看到刚测过的模式 + 它们的工具数和 suitable/not suitable 描述。',
      '如果名册还是旧的 4 个内置模式，说明 caps.json 没写对或路径不对，去查第 3 步的产物。',
      '',
      '【注意】',
      '- hidden:true 只影响 list:true 的排版，delegate 仍能派给它',
      '- 要彻底禁用某模式，在配置文件加 disabledPresets: [xxx]',
    ].join('\n')

    const wrapStyle = { display: 'flex', flexDirection: 'column', gap: '10px' }
    const barStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    }
    const titleStyle = { margin: '0', fontSize: '15px', fontWeight: '600', lineHeight: '1.4' }
    const hintStyle = { margin: '0', fontSize: '12px', lineHeight: '1.5', opacity: '0.72' }
    const preStyle = {
      margin: '0',
      padding: '12px',
      maxHeight: '440px',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.55',
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      borderRadius: '8px',
      background: 'color-mix(in srgb, currentColor 4%, transparent)',
      userSelect: 'text',
    }
    const buttonStyle = {
      flex: 'none',
      padding: '5px 12px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      color: 'inherit',
      cursor: 'pointer',
    }

    /** 设置页一级页面：完整提示词 + 一键复制。settings.section 不传 view，直接整块渲染。 */
    function BenchPromptCard(props) {
      const [copied, setCopied] = React.useState(false)
      const timer = React.useRef(undefined)
      React.useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
      const copy = React.useCallback(() => {
        const done = () => {
          setCopied(true)
          if (timer.current !== undefined) clearTimeout(timer.current)
          timer.current = setTimeout(() => { setCopied(false) }, 2000)
        }
        // 127.0.0.1 / https 属安全上下文，clipboard 可用；不可用时退回选中。
        if (navigator.clipboard !== undefined) {
          navigator.clipboard.writeText(PROMPT).then(done, done)
          return
        }
        done()
      }, [])

      return h('div', { style: wrapStyle },
        h('h2', { style: titleStyle }, 'dsh-blackpig-mode'),
        h('div', { style: barStyle },
          h('p', { style: hintStyle }, '把下面整段发给黑猪（blackpigmodel），它会照做跑完基准测试，结果写进 blackpig-preset-caps.json。'),
          h('button', { type: 'button', style: buttonStyle, onClick: copy }, copied ? '已复制' : '复制提示词'),
        ),
        h('pre', { style: preStyle, 'data-blackpig-bench-prompt': 'true' }, PROMPT),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'blackpig-bench-prompt',
          // 排在官方之后：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20。
          order: 60,
          label: 'dsh-blackpig-mode',
        }, BenchPromptCard))
      },
    }
  },
})
