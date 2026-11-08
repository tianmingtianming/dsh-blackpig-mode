#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-blackpig-mode 安装后生效验证（只读为主）

.DESCRIPTION
    装完包后运行（通常无需重启）。核对：包是否落盘且文件完整、profile 是否登记了包、
    是否还残留旧 preset 声明、dsh --dump-config 能否正常合成并含 preset-blackpigmodel。

    字节数默认只作参考、不影响退出码（写死字节对下载者没有意义）；维护者本机要严格
    校验包内文件字节时加 -StrictSizes。

    本脚本不写任何 profile 文件，也不修改 cordis.patch.yml / package.json。
    唯一可能的副作用：若 profile 缺 cordis.yml，`dsh --dump-config` 会自动生成一份
    空壳（正常 profile 本来就有），脚本会先提示这一点。

    已知平台限制：dsh 的 CLI 会硬拒绝 `--profile desktop`（报 "managed exclusively
    by the Electron application"），所以对 desktop 无法直接 dump-config。此时脚本
    会自动改用「影子 profile」：在 %TEMP% 下复制一份 package.json + cordis.patch.yml，
    node_modules 用目录联接指回真 profile（只读），再对这个临时 profile 跑
    dump-config，跑完立刻删除临时目录。真 profile 的 node_modules 不被写入。

.PARAMETER Profile
    目标 profile 名，默认 desktop。路径为 $DSH_HOME\profiles\<名>。

.PARAMETER StrictSizes
    按内置字节表严格判定（不符计 WARN → 影响 exit code）。默认关闭：字节表只打印作参考。
    只在「维护者本机源码自检」时使用；普通安装用户不需要它。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\verify.ps1 -Profile desktop

.NOTES
    退出码：0 = 可直接使用  1 = 缺件或有冲突  2 = 环境不满足或关键输入不可读（找不到 dsh/profile、package.json 或 patch 读不到/解析失败等），由 -Hard 标记；
    FAIL 与 WARN 都认 -Hard（desktop 被 CLI 独占、影子 profile 不可用这类环境问题亦折算为 2，不折算 1）；标记后会继续跑完剩余检查，最终统一 exit
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',

    # 默认不按字节数判死：写死字节对「从 GitHub 装包的人」毫无意义
    # （版本一升、换行符一口径变化，期望值必然对不上，却会让人以为自己装坏了）。
    # 维护者本机自检需要严格判字节时，显式加 -StrictSizes。
    [switch]$StrictSizes
)

$ErrorActionPreference = 'Stop'

$script:failCount = 0
$script:warnCount = 0
$script:hardStop = $false
$script:verdicts = New-Object System.Collections.ArrayList

function Report {
    param([string]$Tag, [string]$No, [string]$Title, [string]$Detail, [switch]$Hard)
    $label = '[OK]  '
    if ($Tag -eq 'WARN') {
        $label = '[WARN]'
        $script:warnCount++
        # 2026-11-07 修（R14）：WARN 也要能标「无法判断」，与 check.ps1:63 同口径。
        # 带 -Hard 的 WARN = 环境不满足 / 读不到、无法判断 → exit 2（BLOCKED）；
        # 不带 -Hard 的 WARN = 真有残留 / 冲突 → 仍 NEEDS-CLEANUP（exit 1），其它 WARN 语义不变。
        if ($Hard) { $script:hardStop = $true }
    }
    elseif ($Tag -eq 'FAIL') {
        $label = '[FAIL]'
        $script:failCount++
        if ($Hard) { $script:hardStop = $true }
    }
    Write-Output ("{0} {1} {2} — {3}" -f $label, $No, $Title, $Detail)
}

function Get-DshHome {
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    if ($env:USERPROFILE) { return (Join-Path $env:USERPROFILE '.dsh') }
    return (Join-Path $HOME '.dsh')
}

function Find-PresetDeclaration {
    param([string]$Path)
    $found = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path)) { return $found }
    # 读取失败（例如被独占打开）不中断整个脚本：只记下原因并返回空集合。
    # 注意 Report 走 Write-Output，不能在本函数内调用（会被返回值吞掉），
    # 统一由调用方报 FAIL/置位，再跳过「无残留」判定，保证结论行照常输出。
    $lines = @()
    try {
        $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
    } catch {
        $script:presetReadError = $_.Exception.Message
        return $found
    }
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $raw = $lines[$i]
        $kind = $null
        if ($raw -match '^\s*-\s+id\s*:\s*["'']?preset-blackpigmodel["'']?\s*(?:#.*)?$') {
            $kind = 'preset-blackpigmodel'
        }
        elseif ($raw -match '^\s*-\s+id\s*:\s*["'']?blackpigmodel["'']?\s*(?:#.*)?$') {
            $kind = 'blackpigmodel'
        }
        if (-not $kind) { continue }
        [void]$found.Add([pscustomobject]@{ Line = $i + 1; Text = $raw.Trim(); Kind = $kind })
    }
    return $found
}

# 内置期望值表（字节，UTF-8 口径）—— **参考信息，默认不参与判定**
#
# 为什么要降级（2026-11-08）：本脚本随 npm 包发布，下载者拿到的是自己的副本。
# 写死字节对下载者只有两种结果：要么恰好相同（没提供任何信息），要么不同
# （于是报 WARN → exit 1，让人误以为装坏了）。而版本一升级、换行符口径一变，
# 这张表必然过期。所以默认只打印「实际 / 期望 / 差值」供参考，不参与 exit code；
# 维护者本机要严格校验时加 -StrictSizes。
#
# 同理不要改成 SHA256：换行符口径变化或副本落后一个版本，SHA 一样对不上，
# 脆弱的根因不变，只是换了一种脆弱。
#
# 维护者改完源码、重新打包后，应把这里更新为 `npm pack` 产物里的实测值。
$expected = [ordered]@{
    'cordis.patch.yml'    = 37395
    'guard-v10.mjs'       = 196819
    'blackpig-roster.mjs' = 102521
    'subtalk.mjs'         = 54964
    'file-info.mjs'       = 31745
    'compat.mjs'          = 26659
    'member-persona.mjs'  = 23330
    'package.json'        = 745
    'README.md'           = 0       # 不参与校验（随文档编辑变化）
    'LICENSE'             = 1073
    'check.ps1'           = 0       # 在 $skipSizeCheck 里，不参与比对（旧值 13564 早已失效）
    'verify.ps1'          = 0       # 自引用：写死自身字节必然追不上，不参与校验
}

# 不参与字节校验的文件（允许编辑，或换行符随 git 配置变化）：
#   README.md  —— 随文档更新
#   verify.ps1 —— 自身，改一次字节就变，参与校验必然自死循环
#   check.ps1  —— 该脚本本身随检查项增删而变。.gitattributes 的 *.ps1 text eol=lf 只保证
#                 入库与打包的换行符口径是 LF，并不保证「包内文件 = 源码 = 已安装副本」三者
#                 字节数一致（已安装副本可能是上次打包留下的，会落后于源码，见重打包待办）。
#                 真正跳过的理由是：写死字节的期望值必然追不上脚本编辑。
# 注意：不要改用 SHA256 —— 换行符口径一变、或副本落后一个版本，SHA 同样对不上。
$skipSizeCheck = @('README.md', 'check.ps1', 'verify.ps1')

$dshHome    = Get-DshHome
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$patchPath  = Join-Path $profileDir 'cordis.patch.yml'
$cordisPath = Join-Path $profileDir 'cordis.yml'
$pkgPath    = Join-Path $profileDir 'package.json'
$pkgDir     = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-blackpig-mode'

Write-Output '============================================================'
Write-Output ' 黑猪模式 · 安装后生效验证 (verify.ps1)   只读核对'
Write-Output '============================================================'
Write-Output (" profile   : {0}" -f $Profile)
Write-Output (" profile 目录: {0}" -f $profileDir)
Write-Output (" DSH_HOME  : {0}" -f $dshHome)
Write-Output ' 说明: 本脚本不写 profile 文件。唯一例外是 dsh --dump-config 在缺 cordis.yml'
Write-Output '       时会自动补一份空壳，正常 profile 本来就有该文件。'
Write-Output ''

# ── 0. dsh 可执行 ──
$dshCmd = $null
$cands = @()
if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd') }
if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd') }
foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { $dshCmd = $c; break } }
if (-not $dshCmd) {
    $gc = Get-Command dsh -ErrorAction SilentlyContinue
    if ($gc) { $dshCmd = $gc.Source }
}
if ($dshCmd) { Report 'OK' '0/5' 'dsh' ('找到 ' + $dshCmd) }   # 找不到时由下面 4. dump-config 段以 0/5 与 4/5 两条 FAIL 报出（同一根因，如实计分）

# ── 1. 包落盘 + 文件字节数 ──
if (-not (Test-Path -LiteralPath $pkgDir -PathType Container)) {
    Report 'FAIL' '1/5' '包落盘' ("没有 " + $pkgDir + " —— 包没装上，或 dsh plugin add 失败")
    [void]$script:verdicts.Add('缺少 dsh-blackpig-mode 包目录')
} else {
    $fileRows = @()
    $sizeBad  = 0
    $missing  = 0
    $readErr  = 0
    # 读取失败明细先收集（文件名 + 原因），循环结束后只发一条 1/5，避免同号重复、failCount 按文件数翻倍
    $readFailures = @()
    foreach ($name in $expected.Keys) {
        $fp = Join-Path $pkgDir $name
        $skip = ($skipSizeCheck -contains $name)
        if (-not (Test-Path -LiteralPath $fp -PathType Leaf)) {
            if ($skip) {
                $fileRows += ("  {0,-20} {1,10}  (不参与字节校验，但文件本应在)" -f $name, 'MISSING')
            } else {
                $fileRows += ("  {0,-20} {1,10}  期望 {2}" -f $name, 'MISSING', $expected[$name])
            }
            $missing++
            continue
        }
        try {
            $len = (Get-Item -LiteralPath $fp).Length
        } catch {
            # 读单个文件失败只收集明细（文件名 + 原因），继续校验其它文件与后续各项；
            # 1/5 的 FAIL 统一在循环结束后发一条，避免同一编号重复、failCount 按文件数翻倍。
            $readErr++
            $readFailures += ('{0}（{1}）' -f $name, $_.Exception.Message)
            [void]$script:verdicts.Add(('包文件无法读取: ' + $name))
            $fileRows += ("  {0,-20} {1,10}  [FAIL] 无法读取" -f $name, 'ERROR')
            continue
        }
        if ($skip) {
            $fileRows += ("  {0,-20} {1,10}  [SKIP] 不参与字节校验（允许编辑）" -f $name, $len)
            continue
        }
        if ($len -eq $expected[$name]) {
            $fileRows += ("  {0,-20} {1,10}  [OK]" -f $name, $len)
        } else {
            $fileRows += ("  {0,-20} {1,10}  [WARN] 期望 {2} (差 {3})" -f $name, $len, $expected[$name], ($len - $expected[$name]))
            $sizeBad++
        }
    }
    $extraFiles = @()
    try {
        $extraFiles = @(Get-ChildItem -LiteralPath $pkgDir -File | Where-Object { -not $expected.Contains($_.Name) })
    } catch {
        $readErr++
        $readFailures += ('包目录 {0}（{1}）' -f $pkgDir, $_.Exception.Message)
        [void]$script:verdicts.Add('无法读取包目录 dsh-blackpig-mode')
    }
    if ($readErr -gt 0) {
        # 全部读取失败（含目录）只报一条 1/5；明细并入该条文本，前 3 个列名，其余以「等 N 个」概括
        $shown = @($readFailures | Select-Object -First 3)
        $readDetail = ($shown -join '；')
        if ($readFailures.Count -gt $shown.Count) { $readDetail += ('；等 {0} 个' -f $readFailures.Count) }
        Report 'FAIL' '1/5' '包落盘' ('{0} 处读取失败，1/5 未能完整判定: {1}' -f $readErr, $readDetail) -Hard
        Write-Output ('       有 {0} 处读取失败，1/5 未能完整判定（见上面 [FAIL] 行）' -f $readErr)
        [void]$script:verdicts.Add('包文件/目录读取失败，1/5 判定不完整')
    } elseif ($missing -gt 0) {
        Report 'FAIL' '1/5' '包落盘' ("目录存在，但缺 {0} 个文件（共 {1} 个应到）" -f $missing, $expected.Count)
    } elseif ($sizeBad -gt 0 -and $StrictSizes) {
        Report 'WARN' '1/5' '包落盘' ("{0} 个文件齐全，{1} 个字节数与期望不符（-StrictSizes 已开；明细见下一行）" -f ($expected.Count - $missing), $sizeBad)
    } elseif ($sizeBad -gt 0) {
        Report 'OK' '1/5' '包落盘' ("{0} 个文件齐全（{1} 个字节数与内置参考值不同，属正常——版本/换行符差异；要严格判请加 -StrictSizes）" -f ($expected.Count - $missing), $sizeBad)
    } else {
        Report 'OK' '1/5' '包落盘' (($expected.Count - $missing).ToString() + ' 个文件齐全，字节数与内置期望值全部一致；README.md 不参与字节校验（允许编辑）')
    }
    Write-Output '       文件明细（字节，UTF-8 口径）:'
    Write-Output '       注: 本脚本 (verify.ps1) 与 check.ps1 不参与字节校验（换行符随 git 配置变化，见 .gitattributes 的 *.ps1 eol=lf）'
    Write-Output ('       注: 字节数为参考信息，默认不影响退出码（加 -StrictSizes 才按字节判）：{0}' -f $(if ($StrictSizes) { '当前已开启严格字节判定' } else { '当前未开启严格字节判定' }))
    foreach ($r in $fileRows) { Write-Output $r }
    if ($extraFiles.Count -gt 0) {
        Write-Output ('       另有 {0} 个非清单文件（不参与校验）: {1}' -f $extraFiles.Count, (($extraFiles | ForEach-Object { $_.Name }) -join ', '))
    }
    if ($missing -gt 0) { [void]$script:verdicts.Add('包文件不完整') }
    if ($sizeBad -gt 0 -and $StrictSizes) { [void]$script:verdicts.Add('包文件字节数与内置参考值不符（-StrictSizes）') }
}

# ── 2. profile package.json 登记 ──
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Report 'FAIL' '2/5' 'profile 登记' ("读不到 " + $pkgPath) -Hard
    [void]$script:verdicts.Add('profile package.json 缺失')
} else {
    $pkgBad = $false
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $pkg = $null
        $pkgBad = $true
        Report 'FAIL' '2/5' 'profile 登记' ('package.json 解析失败: ' + $_.Exception.Message) -Hard
        [void]$script:verdicts.Add('profile package.json 无法解析')
    }
    # PS 5.1 的 ConvertFrom-Json 对空文件/纯空白/null/[] 不抛异常，会返回 $null 或数组；
    # 不在这里立即校验，2/5 会被整段静默跳过，最终报出假 READY。
    if (-not $pkgBad -and $null -eq $pkg) {
        $pkgBad = $true
        Report 'FAIL' '2/5' 'profile 登记' 'package.json 内容为空或为 null，无法判断是否登记' -Hard
        [void]$script:verdicts.Add('profile package.json 内容为空或为 null')
    }
    if (-not $pkgBad -and ($pkg -is [System.Array] -or $pkg -is [string] -or $pkg -is [ValueType])) {
        $pkgBad = $true
        Report 'FAIL' '2/5' 'profile 登记' ('package.json 根不是对象（实际为 ' + $pkg.GetType().Name + '），无法判断是否登记') -Hard
        [void]$script:verdicts.Add('profile package.json 根不是对象')
    }
    if (-not $pkgBad -and $pkg) {
        $deps = @()
        if ($pkg.dependencies) { $deps = @($pkg.dependencies.PSObject.Properties.Name) }
        $optDeps = @()
        if ($pkg.optionalDependencies) { $optDeps = @($pkg.optionalDependencies.PSObject.Properties.Name) }
        $bundles = @()
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }

        # 按 README 第 7 条：用本地 file: 指向 tgz 安装时，依赖应放进 optionalDependencies。
        # 因此 dependencies 与 optionalDependencies 任一含本包，都算「已登记」，不报 FAIL。
        $inDeps    = ($deps    -contains 'dsh-blackpig-mode')
        $inOptDeps = ($optDeps -contains 'dsh-blackpig-mode')
        $inBundles = ($bundles -contains 'dsh-blackpig-mode')

        $where = @()
        if ($inDeps)    { $where += 'dependencies' }
        if ($inOptDeps) { $where += 'optionalDependencies' }

        if ($where.Count -gt 0 -and $inBundles) {
            Report 'OK' '2/5' 'profile 登记' (($where -join ' 与 ') + ' 与 dsh.profile.bundles 都登记了 dsh-blackpig-mode')
            if ($inOptDeps) {
                Write-Output '       [INFO] 该包登记在 optionalDependencies（按 README 第 7 条，属正常）'
                if ($inDeps) { Write-Output '       [INFO] dependencies 里也有一份；两处并存不影响运行，留一处即可' }
            }
        } else {
            $miss = @()
            if ($where.Count -eq 0) { $miss += 'dependencies/optionalDependencies' }
            if (-not $inBundles)    { $miss += 'dsh.profile.bundles' }
            Report 'FAIL' '2/5' 'profile 登记' ('缺: ' + ($miss -join ' 与 ') + ' —— 重跑 dsh plugin --profile ' + $Profile + ' add dsh-blackpig-mode')
            [void]$script:verdicts.Add(('profile 缺 ' + ($miss -join '/')))
        }
    }
}

# ── 3. 旧 preset 声明残留 ──
# R17C：本段数出的 preset 声明条数同时作为 4/5 的「已知残留基线」，
# 让「patch 里本来就有旧声明」这个根因只在 3/5 判一次，不在 4/5 二次判死。
$presetResidualDecls = 0
if (-not (Test-Path -LiteralPath $patchPath)) {
    Report 'OK' '3/5' '旧声明残留' '没有 cordis.patch.yml（干净 profile 的正常状态；包靠 bundle 层挂载）'
} else {
    $script:presetReadError = $null
    $decls = @(Find-PresetDeclaration -Path $patchPath)
    # 只数形如 - id: preset-blackpigmodel 的声明；旧式 - id: blackpigmodel 只抬模糊命中，不计入基线
    $presetResidualDecls = @($decls | Where-Object { $_.Kind -eq 'preset-blackpigmodel' }).Count
    if ($script:presetReadError) {
        Report 'FAIL' '3/5' '旧声明残留' ('无法读取 cordis.patch.yml: ' + $script:presetReadError) -Hard
        [void]$script:verdicts.Add('cordis.patch.yml 无法读取')
    } elseif ($decls.Count -eq 0) {
        Report 'OK' '3/5' '旧声明残留' 'cordis.patch.yml 里没有 blackpigmodel 的旧声明'
    } else {
        $lineList = (($decls | ForEach-Object { $_.Line }) -join ', ')
        Report 'FAIL' '3/5' '旧声明残留' ("还残留 {0} 处 blackpigmodel 声明，行号: {1} —— 会与包内声明冲突" -f $decls.Count, $lineList)
        foreach ($d in $decls) { Write-Output ("       第 {0} 行: {1}" -f $d.Line, $d.Text) }
        Write-Output '       处置: 删掉这些行所在的整个 - insert: 块后重启 DSH。'
        [void]$script:verdicts.Add(('cordis.patch.yml 残留旧声明（第 ' + $lineList + ' 行）'))
    }
}

# ── 4. dsh --dump-config ──
$dumpPresetHits = 0
$dumpIdHits = 0
$dumpCode = $null
$dumpLines = New-Object System.Collections.ArrayList
$dumpNote = ''
# 命中统计来自哪次调用：real = 真 profile（默认），shadow = 影子 profile。
# 4/5 的判定一律按它取值，不再靠 $dumpNote 的字符串前缀猜来源。
$dumpSource = 'real'
# [4] 影子 profile 的 file: 依赖绝对化失败时不再单独发一条 4/5（否则同一编号两条、warnCount 计 2），
# 而是记在这里，并入后面唯一那条 4/5 的文本。
$shadowSpecNote = ''

function Invoke-DumpConfig {
    param([string]$DshCmd, [string]$ProfileName)
    # 2026-11-07 修（R17C）：不能写成 $raw = @(& $DshCmd ... 2>&1)。$ErrorActionPreference='Stop'
    # 下只要 stderr 被兜成终止错误，整条赋值就作废，事后只剩一条「调用异常」，
    # 命中统计必然偏 0（preset-blackpigmodel 永远数不到）。
    # 改成「边收边落定」：输出逐行进 $lines，异常只追加一条，已经收到的行不丢。
    $old = $ErrorActionPreference
    $lines = New-Object System.Collections.ArrayList
    $c = $null
    try {
        $ErrorActionPreference = 'Continue'
        & $DshCmd --profile $ProfileName --dump-config 2>&1 | ForEach-Object {
            if ($null -eq $_) { return }
            if ($_ -is [System.Management.Automation.ErrorRecord]) { [void]$lines.Add([string]$_.Exception.Message) }
            else { [void]$lines.Add([string]$_) }
        }
        $c = $LASTEXITCODE
    } catch {
        # 已收到的行留在 $lines 里；退出码未知，如实记 -1。
        [void]$lines.Add('调用异常: ' + $_.Exception.Message)
        $c = -1
    } finally {
        $ErrorActionPreference = $old
    }
    return [pscustomobject]@{ Code = $c; Lines = $lines }
}

if (-not $dshCmd) {
    Report 'FAIL' '0/5' 'dsh' '找不到 dsh.cmd，无法验证运行时能否合成' -Hard
    # [3] 补一条 4/5：结论段声称编号覆盖 0/5–4/5，而这里原来只发 0/5 就离开，
    # 整轮不出现 4/5，与说明不符。现按「跳过」明确报出（同一根因，属如实计分）。
    Report 'FAIL' '4/5' 'dump-config' 'dsh 不可用，跳过运行时合成验证'
    [void]$script:verdicts.Add('找不到 dsh.cmd')
    $dumpCode = -1
} elseif (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
    Report 'FAIL' '4/5' 'dump-config' ('profile 目录不存在: ' + $profileDir) -Hard
    [void]$script:verdicts.Add('profile 目录不存在')
    $dumpCode = -1
} else {
    if (-not (Test-Path -LiteralPath $cordisPath)) {
        Write-Output '       [提示] profile 缺 cordis.yml，dsh 会自动补一份空壳（这是 dsh 的标准行为）'
    }

    $res = Invoke-DumpConfig -DshCmd $dshCmd -ProfileName $Profile
    $dumpCode = $res.Code
    $dumpLines = $res.Lines
    # 先把原始输出落定，再拼文本做判定（$dumpLines 在 Invoke-DumpConfig 里已逐行收好，不会因 catch 丢行）
    $joined = ((@($dumpLines) | ForEach-Object { [string]$_ }) -join "`n")

    # desktop 由 Electron 独占：CLI 会硬拒绝，改用影子 profile 复核。
    # 显式布尔：仅当「这次调用的是真 profile」且「输出含独占拒绝串」时才为真。
    # 不再用 $dumpNote 前缀判断来源 —— 影子成功/失败都会改 $dumpNote，前缀判断会把分支指错。
    $electronLock = (($dumpSource -eq 'real') -and ($joined -match 'managed exclusively by the Electron application'))

    if ($electronLock) {
        Write-Output '       [说明] dsh CLI 拒绝直接读 desktop（Electron 独占），改用影子 profile 复核'
        Write-Output '              （%TEMP% 下临时代理：复制 package.json + cordis.patch.yml，'
        Write-Output '                node_modules 用目录联接指回真 profile；跑完立即删除）'
        $shadowHome = Join-Path $env:TEMP ('bp-verify-shadow-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $shadowName = 'bpverify' + (Get-Random -Minimum 1000 -Maximum 9999)
        $shadowProf = Join-Path (Join-Path $shadowHome 'profiles') $shadowName
        $shadowOk = $false
        $shadowFailReason = ''
        try {
            New-Item -ItemType Directory -Force -Path $shadowProf | Out-Null

            # 影子 package.json 只保留 base + web-app + 本包三条 bundle 登记，
            # 其余第三方 bundle 与依赖一律去掉：用户自己的 bundle 加载失败不该算到本包头上。
            $shadowPkgText = $null
            $srcBundles = @()
            try {
                $srcPkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $srcVer = '0.0.0'
                if ($srcPkg -and $srcPkg.dependencies -and $srcPkg.dependencies.'dsh-blackpig-mode') {
                    $srcVer = [string]$srcPkg.dependencies.'dsh-blackpig-mode'
                } elseif ($srcPkg -and $srcPkg.optionalDependencies -and $srcPkg.optionalDependencies.'dsh-blackpig-mode') {
                    $srcVer = [string]$srcPkg.optionalDependencies.'dsh-blackpig-mode'
                }
                if ($srcPkg -and $srcPkg.dsh -and $srcPkg.dsh.profile -and $srcPkg.dsh.profile.bundles) {
                    $srcBundles = @($srcPkg.dsh.profile.bundles)
                }
                # 影子 profile 落在 %TEMP%，相对的 file: spec 抄过去无法解析（见文件头「官方装法是 file: 指向 tgz」）。
                # 这里只把「非绝对的 file: spec」按真 profile 目录解析成绝对路径；版本号 / github: / https 原样保留。
                if ($srcVer -match '^file:(.+)$') {
                    $fileSpec = $Matches[1].Trim()
                    $isAbsSpec = ($fileSpec -match '^[A-Za-z]:[\\/]') -or $fileSpec.StartsWith('\') -or $fileSpec.StartsWith('/')
                    if (-not $isAbsSpec) {
                        try {
                            $absSpec = (Resolve-Path -LiteralPath (Join-Path $profileDir $fileSpec) -ErrorAction Stop).Path
                            $srcVer = 'file:' + ($absSpec -replace '\\', '/')
                        } catch {
                            $shadowSpecNote = ('影子 profile 的 file: 依赖无法绝对化，按原值保留: ' + $srcVer + ' —— ' + $_.Exception.Message)
                            [void]$script:verdicts.Add(('影子 profile 的 file: 依赖无法绝对化（' + $srcVer + '）'))
                        }
                    }
                }
                $shadowPkg = [ordered]@{
                    name         = 'dsh-profile-' + $shadowName
                    private      = $true
                    dependencies = [ordered]@{ 'dsh-blackpig-mode' = $srcVer }
                    dsh          = @{ profile = @{ bundles = @(
                        '@deepseek-ai/dsh-base',
                        '@deepseek-ai/dsh-web-app',
                        'dsh-blackpig-mode'
                    ) } }
                }
                $shadowPkgText = ($shadowPkg | ConvertTo-Json -Depth 8)
            } catch {
                # 真 package.json 读不动时退回原样复制，至少还比没有强
                Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $shadowProf 'package.json') -ErrorAction Stop
                $shadowPkgText = $null
            }
            if ($shadowPkgText) {
                $enc = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText((Join-Path $shadowProf 'package.json'), $shadowPkgText, $enc)
                foreach ($bn in @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-blackpig-mode')) {
                    if ($srcBundles -notcontains $bn) {
                        Write-Output ('       [注意] 真 profile 的 bundles 里本来就没有 ' + $bn + '，影子仍按最小集登记')
                    }
                }
                Write-Output '       [说明] 影子 package.json 只登记 base + web-app + dsh-blackpig-mode（剔除了用户自己的其它 bundle，避免误报）'
            }

            if (Test-Path -LiteralPath $patchPath) {
                Copy-Item -LiteralPath $patchPath -Destination (Join-Path $shadowProf 'cordis.patch.yml') -ErrorAction Stop
            }

            # node_modules 用目录联接指回真 profile；mklink 失败必须检查，不能吞掉
            $realNm = Join-Path $profileDir 'node_modules'
            $linkOk = $true
            if (Test-Path -LiteralPath $realNm -PathType Container) {
                $link = Join-Path $shadowProf 'node_modules'
                $mkOut = @(cmd /c mklink /J "$link" "$realNm" 2>&1)
                $mkCode = $LASTEXITCODE
                if ($mkCode -ne 0) {
                    $linkOk = $false
                    $mkTxt = (($mkOut | ForEach-Object { ([string]$_).Trim() }) -join ' ')
                    if ($mkTxt.Length -gt 200) { $mkTxt = $mkTxt.Substring(0,200) + '…' }
                    $shadowFailReason = ('目录联接建立失败（mklink /J 退出码 {0}）: {1}' -f $mkCode, $mkTxt)
                } elseif (-not (Test-Path -LiteralPath (Join-Path $link 'dsh-blackpig-mode'))) {
                    $linkOk = $false
                    $shadowFailReason = ('目录联接已建立，但通过联接访问不到 dsh-blackpig-mode（目标 ' + $realNm + ' 不可用）')
                }
            } else {
                $linkOk = $false
                $shadowFailReason = ('真 profile 没有 node_modules 目录: ' + $realNm)
            }

            if (-not $linkOk) {
                $shadowOk = $false
            } else {
                $oldHome = $env:DSH_HOME
                $env:DSH_HOME = $shadowHome
                try {
                    $res2 = Invoke-DumpConfig -DshCmd $dshCmd -ProfileName $shadowName
                } finally {
                    $env:DSH_HOME = $oldHome
                }
                $dumpCode = $res2.Code
                $dumpLines = $res2.Lines
                $dumpNote = '阴影 profile 复核'
                $dumpSource = 'shadow'
                $shadowOk = $true
            }
        } catch {
            $shadowFailReason = $_.Exception.Message
            Write-Output ('       [提示] 影子 profile 建立失败: ' + $_.Exception.Message)
        } finally {
            if (Test-Path -LiteralPath $shadowHome) {
                try { Remove-Item -LiteralPath $shadowHome -Recurse -Force -ErrorAction Stop }
                catch { Write-Output ('       [提示] 临时目录未删净，请手工删除: ' + $shadowHome) }
            }
        }
        if (-not $shadowOk) {
            $dumpNote = 'desktop 被 CLI 独占，且影子 profile 不可用'
            Write-Output ''
            Write-Output '       [WARN] 影子 profile 没能建起来，本次未验证运行时合成（这是环境问题，不是包坏了）'
            if ($shadowFailReason) { Write-Output ('              原因: ' + $shadowFailReason) }
            Write-Output '              人工验证步骤:'
            Write-Output '                1) 打开 DSH（desktop），新建会话，看 preset 列表里有没有「黑猪模式」；'
            Write-Output '                2) 有 = 包已生效，本条 WARN 可忽略；'
            Write-Output '                3) 没有 = 再看本脚本第 1/2/3 项的结论，以及 DSH 日志里的加载报错。'
        }
    }

    $dumpText = ((@($dumpLines) | ForEach-Object { [string]$_ }) -join "`n")
    $dumpPresetHits = ([regex]::Matches($dumpText, 'preset-blackpigmodel')).Count
    $dumpIdHits = ([regex]::Matches($dumpText, 'blackpigmodel')).Count
    # 精确计数：只认真正的 preset 声明行（id / config.id 为 blackpigmodel），
    # 不数 YAML 注释、也不数依赖名回显 —— 否则「根本没挂上」的 0/0 判定永远触发不了（R17C 修）。
    $dumpDeclHits = ([regex]::Matches($dumpText, '(?m)^[ \t]*-?[ \t]*(?:config\.id|id)[ \t]*:[ \t]*["'']?blackpigmodel["'']?[ \t]*$')).Count
    # 本次计入统计的输出本身是不是 Electron 独占拒绝（真 profile / 影子 profile 都可能被拒）
    $dumpLocked = ($dumpText -match 'managed exclusively by the Electron application')
    # 已知残留基线：真 profile 的 cordis.patch.yml 里本来就有 preset 声明时，3/5 已单独报过；
    # 那份 patch 会被复制进影子、也会一起合成，于是多出相应的 preset 命中。
    # 用「包自身 1 条 + 已知残留 N 条」当上限，同一根因不在 4/5 再判一次死。
    $expectedPresetHits = 1 + $presetResidualDecls

    if ($null -eq $dumpCode) { $dumpCode = -1 }
    $suffix = ''
    if ($dumpNote) { $suffix = '  [' + $dumpNote + ']' }
    if ($shadowSpecNote) { $suffix += '   [提示: ' + $shadowSpecNote + ']' }

    if ($electronLock -and $dumpSource -eq 'real') {
        # 真 profile 被独占、且影子复核没成功（$dumpSource 仍为 real）：不判死，降级为 WARN 并说明。
        # 2026-11-07 修（R14）：这是环境问题（不是包坏了），带 -Hard → exit 2（环境不满足），
        # 不再折算成 exit 1（NEEDS-CLEANUP），与 .NOTES 的「2 = 环境不满足」一致。
        # 2026-11-07 修（R17C）：判据由 $dumpNote 前缀改为 $dumpSource，影子失败时才落进本支。
        Report 'WARN' '4/5' 'dump-config' ('desktop 被 dsh CLI 独占，无法 dump-config，运行时合成未验证（其余检查照常）' + $suffix) -Hard
        [void]$script:verdicts.Add('desktop 无法 dump-config（平台限制）')
    } elseif ($dumpLocked) {
        # 计入统计的这次 dump 也是 Electron 独占拒绝（影子 profile 也没绕开）：同属环境限制，
        # 不能算包坏了 —— 按 .NOTES 的「2 = 环境不满足」报 WARN + -Hard（exit 2），不报 FAIL（exit 1）。
        Report 'WARN' '4/5' 'dump-config' ('desktop 被 dsh CLI 独占，影子 profile 也没能绕开，运行时合成未验证（其余检查照常）' + $suffix) -Hard
        [void]$script:verdicts.Add('desktop 无法 dump-config（平台限制）')
    } elseif ($dumpCode -ne 0) {
        Report 'FAIL' '4/5' 'dump-config' ("exit code = {0}（应为 0）—— 配置合成失败，见下方前几行{1}" -f $dumpCode, $suffix)
        foreach ($l in ($dumpLines | Select-Object -First 12)) { Write-Output ('       | ' + $l) }
        [void]$script:verdicts.Add(('dump-config exit ' + $dumpCode))
    } elseif ($dumpPresetHits -eq 0 -and $dumpDeclHits -eq 0) {
        # 「根本没挂上」：精确串与真正的声明行都没有；注释 / 依赖名抬高的模糊命中不作数。
        Report 'FAIL' '4/5' 'dump-config' ("exit code = 0，但输出里既没有 preset-blackpigmodel，也没有 id: blackpigmodel 声明行（模糊命中 blackpigmodel x{0}，不作数）—— 包没被合成进配置{1}" -f $dumpIdHits, $suffix)
        [void]$script:verdicts.Add('dump-config 里没有黑猪 preset')
    } elseif ($dumpPresetHits -eq 0) {
        Report 'WARN' '4/5' 'dump-config' ("exit code = 0，命中 preset-blackpigmodel x0 / blackpigmodel x{0} —— 名字在但没找到 preset 声明行，人工复核{1}" -f $dumpIdHits, $suffix)
        [void]$script:verdicts.Add('dump-config 命中数可疑')
    } elseif ($dumpPresetHits -gt $expectedPresetHits) {
        Report 'FAIL' '4/5' 'dump-config' ("exit code = 0，但 preset-blackpigmodel 命中 {0} 次，超出上限（包自身 1 次 + 已知残留 {1} 次 = {2} 次）—— 重复声明，启动会报 Duplicate agent preset{3}" -f $dumpPresetHits, $presetResidualDecls, $expectedPresetHits, $suffix)
        [void]$script:verdicts.Add(('dump-config 里 preset 出现 ' + $dumpPresetHits + ' 次（重复声明）'))
    } elseif ($dumpPresetHits -gt 1) {
        # 命中数落在 (1, 1 + 已知残留]：多出来的都来自 3/5 已单独报过的旧声明残留。
        # 同一根因不重复判死 —— 这里只提示，不计 FAIL（3/5 已把待清理项说清）。
        Report 'WARN' '4/5' 'dump-config' ("exit code = 0，preset-blackpigmodel 命中 {0} 次，多出的 {1} 次来自 cordis.patch.yml 里已有的旧声明残留（同一根因已在 3/5 报过，不再计 FAIL）—— 清掉 3/5 那几行后重跑{2}" -f $dumpPresetHits, ($dumpPresetHits - 1), $suffix)
        [void]$script:verdicts.Add('dump-config 命中数含 3/5 已报的旧声明残留（同一根因，不重复计）')
    } elseif ($shadowSpecNote) {
        Report 'WARN' '4/5' 'dump-config' ("exit code = 0，命中 preset-blackpigmodel x{0} / blackpigmodel x{1}，但影子 profile 的 file: 依赖未能绝对化，结果需人工复核{2}" -f $dumpPresetHits, $dumpIdHits, $suffix)
    } else {
        Report 'OK' '4/5' 'dump-config' ("exit code = 0，命中 preset-blackpigmodel x{0} / blackpigmodel x{1}{2}" -f $dumpPresetHits, $dumpIdHits, $suffix)
    }
    Write-Output ("       输出共 {0} 行 / {1} 字符（只统计，不打印全文）" -f $dumpLines.Count, $dumpText.Length)
    $warns = @($dumpLines | Where-Object { $_ -match '^\s*dsh:\s' } | Select-Object -First 5)
    if ($warns.Count -gt 0) {
        Write-Output '       dsh 自身的告警（不影响本判定，供参考）:'
        foreach ($w in $warns) { Write-Output ('       ! ' + $w.Trim()) }
    }
}

# ── 附: 守卫安装状态 · 只读诊断（不改变 exit code）──
#
# 背景（P0-3）：guard-v10.mjs 往 system-prompt/assemble 的 decision.contexts 追加了一条
# `{ name: 'blackpig-guard:install-status', required: true }`，但宿主在 runtime-context 被抑制时只保留
# **通过 systemPrompt.context() 注册**的 required 项（靠 contextByName 查名）。我们那条不在该表里，
# 抑制态下会被整条过滤掉。所以「日志」与「guardInstallStatus()」才是可观测性的主通道；
# 这一段就是查后者的入口：把当前进程里这张状态表原样打出来。
#
# 只读：不写任何文件、不加载插件、不改 exit code（只是输出）。读不到就明说读不到。
Write-Output ''
Write-Output '── 附: 守卫安装状态（guardInstallStatus，只读诊断，不影响 exit code）──'
$guardModPath = Join-Path $pkgDir 'guard-v10.mjs'
if (-not (Test-Path -LiteralPath $guardModPath -PathType Leaf)) {
    Write-Output '       [INFO] 读不到 guard-v10.mjs（包未落盘），本项跳过'
} else {
    try {
        # 用 node 直接 import 模块并打印状态表。不启动任何插件、不触碰 profile。
        $probe = @'
import { pathToFileURL } from 'node:url'
// ⚠️ process.argv[1] 是**本探针脚本自己**（self-import → 顶层 await 永不 settle，exit 13）。
// 模块路径必须从 argv[2] 取（node <probe.mjs> <guard-v10.mjs>）。
const mod = await import(pathToFileURL(process.argv[2]).href)
const snapshot = mod.guardInstallStatus()
const keys = Object.keys(snapshot)
console.log('BLACKPIG_GUARD_STATUS_KEYS=' + JSON.stringify(keys))
if (keys.length === 0) {
  console.log('BLACKPIG_GUARD_STATUS_EMPTY=1')
} else {
  for (const key of keys) console.log('BLACKPIG_GUARD_STATUS_ROW=' + key + ' ' + JSON.stringify(snapshot[key]))
}
'@
        $probeFile = Join-Path $env:TEMP ('bp-guard-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.mjs')
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($probeFile, $probe, $enc)
        # 2026-11-07 修（R18G）：同 Invoke-DumpConfig —— 不能把原生命令 2>&1 收进单次赋值，
        # $ErrorActionPreference='Stop' 下 stderr 被兜成终止错误时整条赋值作废。改成边收边落定：
        # 输出逐行进 $probeOut，异常只追加一条，已经收到的行不丢。
        $old = $ErrorActionPreference
        $probeOut = New-Object System.Collections.ArrayList
        try {
            $ErrorActionPreference = 'Continue'
            & node $probeFile $guardModPath 2>&1 | ForEach-Object {
                if ($null -eq $_) { return }
                if ($_ -is [System.Management.Automation.ErrorRecord]) { [void]$probeOut.Add([string]$_.Exception.Message) }
                else { [void]$probeOut.Add([string]$_) }
            }
        } catch {
            # 已收到的行留在 $probeOut 里；异常只追加一条。
            [void]$probeOut.Add('调用异常: ' + $_.Exception.Message)
        } finally {
            $ErrorActionPreference = $old
            if (Test-Path -LiteralPath $probeFile) { Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue }
        }
        $probeLines = @($probeOut | ForEach-Object { [string]$_ })
        $statusRows = @($probeLines | Where-Object { $_ -like 'BLACKPIG_GUARD_STATUS_ROW=*' })
        $empty = @($probeLines | Where-Object { $_ -like 'BLACKPIG_GUARD_STATUS_EMPTY=1' }).Count -gt 0
        if ($statusRows.Count -gt 0) {
            Write-Output ('       本进程外静态导入：状态表有 {0} 条记录（只在插件真正装载并 sync 过之后才可能有内容）:' -f $statusRows.Count)
            foreach ($r in $statusRows) { Write-Output ('       ' + $r.Substring('BLACKPIG_GUARD_STATUS_ROW='.Length)) }
        } elseif ($empty) {
            Write-Output '       [INFO] 状态表为空：说明本次探测是全新进程，尚未有会话 sync 过（正常，不是失败）。'
            Write-Output '              真实进程里的状态请看 DSH 日志中 blackpig-guard 的 PROTECTION LOST / RE-INSTALL FAILED /'
            Write-Output '              PROTECTION NOT ENGAGED 行 —— 那是不受 runtime-context 抑制影响的通道。'
        } else {
            Write-Output '       [INFO] 探测没有拿到状态表输出（模块导入失败或 node 不可用），原始输出前 6 行:'
            foreach ($l in ($probeLines | Select-Object -First 6)) { Write-Output ('       | ' + $l) }
        }
    } catch {
        Write-Output ('       [INFO] 状态表探测异常（不影响判定）: ' + $_.Exception.Message)
    }
}

# ── 结论（非检查项；检查项编号为 0/5 – 4/5，该说明已写进下面的结论行）──
Write-Output ''
Write-Output '------------------------------------------------------------'
if ($script:hardStop) { $codeOut = 2 }
elseif ($script:failCount -gt 0 -or $script:warnCount -gt 0) { $codeOut = 1 }
else { $codeOut = 0 }

if ($script:verdicts.Count -eq 0) {
    $verdict = '可直接使用 —— 包已落盘、profile 已登记、无冲突、dsh 能正常合成 preset。'
} else {
    $verdict = ('有 ' + $script:verdicts.Count + ' 处待处理: ' + ($script:verdicts -join '; '))
}
Write-Output (" 结论（非检查项；检查项 0/5 – 4/5）: {0}" -f $verdict)
Write-Output (" (FAIL {0} / WARN {1})" -f $script:failCount, $script:warnCount)
if ($codeOut -eq 0) {
    Write-Output (' 下一步: 重启 DSH 后新建会话，preset 里应能看到「黑猪模式」。')
}
Write-Output (" exit code: {0}" -f $codeOut)
Write-Output '------------------------------------------------------------'

exit $codeOut
