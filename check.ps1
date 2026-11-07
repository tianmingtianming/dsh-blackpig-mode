#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-blackpig-mode 安装前冲突检测（只读，不写任何文件）

.DESCRIPTION
    在 `dsh plugin --profile <名> add dsh-blackpig-mode` 之前运行。
    逐项报告目标 profile 是否会出现 preset id 冲突、是否已经装过、是否留有残留。

    本脚本是纯只读的：只做 Test-Path / Get-Content / ConvertFrom-Json，
    不写文件、不调用 dsh、绝不修改 cordis.patch.yml 与 package.json。

.PARAMETER Profile
    目标 profile 名，默认 desktop，路径为 $DSH_HOME\profiles\<名>。
    （$DSH_HOME 未设置时按 %USERPROFILE%\.dsh 处理。）

.PARAMETER DryRun
    额外打印：装包会改写哪些声明、包会落到哪个目录、脚本自身的只读保证。
    不改变任何检查结果与退出码。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\check.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\check.ps1 -Profile desktop -DryRun

.NOTES
    退出码：0 = READY（可以装）  1 = NEEDS-CLEANUP（有残留 / 冲突，先清理）
            2 = BLOCKED（环境不满足，或关键输入读不到、无法判断：找不到 dsh.cmd、profile 目录不存在、
                        package.json / cordis.patch.yml 读不到或未通过 3/7 的轻量语法健全性检查（tab 缩进 / 顶层 insert: 与 plugins: 结构；不是完整 YAML 解析）等，由 Report 的 -Hard 标记，脚本仍跑完再统一 exit）
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$script:failCount = 0
$script:warnCount = 0
$script:hardStop = $false
$script:reasons = New-Object System.Collections.ArrayList
# 2026-11-07 修（R14）：按来源分桶。reasons = 真有残留 / 冲突（需要清理）；
# hardReasons = 环境不满足 / 关键输入读不到、无法判断。BLOCKED 结论只念后者，
# 避免把「preset 已有声明」这类待清理项说成「不是清理」。退出码语义不变。
$script:hardReasons = New-Object System.Collections.ArrayList

function Report {
    param(
        [string]$Tag,
        [string]$No,
        [string]$Title,
        [string]$Detail,
        [switch]$Hard
    )
    $label = '[OK]  '
    if ($Tag -eq 'INFO') {
        $label = '[INFO]'
    }
    elseif ($Tag -eq 'WARN') {
        $label = '[WARN]'
        $script:warnCount++
        # 2026-11-07 修（R13b3）：WARN 也要能标「无法判断」。
        # 带 -Hard 的 WARN = 读不到、无法判断 → 环境类语义 exit 2（BLOCKED），与 verify.ps1 的 -Hard 口径一致；
        # 不带 -Hard 的 WARN = 真有残留 / 冲突 → 仍 NEEDS-CLEANUP（exit 1），保留「先清理」输出。
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

# 在 cordis.patch.yml 里找 preset 声明；返回 @{ Line; Text; Kind; InsertLine }
function Find-PresetDeclaration {
    param([string]$Path)
    $found = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path)) { return $found }

    # 读取失败（例如文件正被独占打开）不终止脚本：
    # 只记下原因并返回空集合，由调用方按「无法判断」处理（见 3/7）。
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

        $insertLine = 0
        for ($j = $i; $j -ge 0; $j--) {
            if ($lines[$j] -match '^\s*-\s*insert\s*:\s*$') { $insertLine = $j + 1; break }
        }
        [void]$found.Add([pscustomobject]@{
            Line       = $i + 1
            Text       = $raw.Trim()
            Kind       = $kind
            InsertLine = $insertLine
        })
    }
    return $found
}

# 在 extraDeny 列表里找某个工具名；返回命中的行号
function Find-DeniedTool {
    param([string[]]$Lines, [string]$Tool)
    $hits = New-Object System.Collections.ArrayList
    if (-not $Lines) { return $hits }

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $m = [regex]::Match($Lines[$i], '^(\s*)extraDeny\s*:\s*(.*)$')
        if (-not $m.Success) { continue }
        $baseIndent = $m.Groups[1].Value.Length
        $inline = $m.Groups[2].Value.Trim()

        if ($inline.StartsWith('[')) {
            foreach ($item in ($inline.Trim('[', ']') -split ',')) {
                if ($item.Trim().Trim('"', "'") -eq $Tool) { [void]$hits.Add($i + 1); break }
            }
            continue
        }

        $j = $i + 1
        while ($j -lt $Lines.Count) {
            $l = $Lines[$j]
            if ($l.Trim() -eq '') { $j++; continue }
            $mm = [regex]::Match($l, '^(\s*)-\s+([^\s#]+)')
            if (-not $mm.Success) { break }
            if ($mm.Groups[1].Value.Length -le $baseIndent) { break }
            if ($mm.Groups[2].Value.Trim('"', "'") -eq $Tool) { [void]$hits.Add($j + 1) }
            $j++
        }
    }
    return $hits
}

# ────────────────────────────── 头部 ──────────────────────────────
$dshHome    = Get-DshHome
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$patchPath  = Join-Path $profileDir 'cordis.patch.yml'
$pkgPath    = Join-Path $profileDir 'package.json'
$pkgDir     = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-blackpig-mode'
$legacyDir  = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-blackpig-model'

Write-Output '============================================================'
Write-Output ' 黑猪模式 · 安装前冲突检测 (check.ps1)   只读，不改任何文件'
Write-Output '============================================================'
Write-Output (" profile   : {0}" -f $Profile)
Write-Output (" profile 目录: {0}" -f $profileDir)
Write-Output (" DSH_HOME  : {0}" -f $dshHome)
if ($DryRun) { Write-Output ' 模式      : DRY-RUN（额外打印装包影响范围）' }
Write-Output ''

# ── 1/7 DSH 安装 ──
$dshCmd = $null
$candidates = @()
if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
}
if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
}
foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { $dshCmd = $c; break }
}
if (-not $dshCmd) {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { $dshCmd = $cmd.Source }
}
if ($dshCmd) {
    Report 'OK' '1/7' 'DSH 安装' ("找到 " + $dshCmd)
} else {
    Report 'FAIL' '1/7' 'DSH 安装' '没找到 dsh.cmd —— 这台机器没装 DeepSeek Harness，或不在此路径' -Hard
}

# ── 2/7 profile 目录 ──
if (Test-Path -LiteralPath $profileDir -PathType Container) {
    Report 'OK' '2/7' 'profile 目录' '存在'
} else {
    Report 'FAIL' '2/7' 'profile 目录' ("不存在: " + $profileDir) -Hard
}

# ── 3/7 preset id 冲突（核心）──
if (-not (Test-Path -LiteralPath $patchPath)) {
    Report 'OK' '3/7' 'preset 冲突' ("没有 cordis.patch.yml —— 干净 profile 的正常状态，不存在任何旧声明（本包不改 profile 的 cordis.patch.yml，靠 bundle 层挂载）: " + $patchPath)
} else {
    $script:presetReadError = $null
    $decls = @(Find-PresetDeclaration -Path $patchPath)
    # 2026-11-07（R18）：轻量 YAML 语法健全性检查（零新依赖，不是完整解析）。
    # 之前 3/7 只做正则，语法坏掉的 patch 会被当成「没有 blackpigmodel 声明」→ 假 READY。
    # 查三条硬错：tab 缩进 / 顶层 - insert: 与 plugins: 结构 / 以引号开头的值是否闭合。
    # 关键：block scalar（`key: |` / `|-` / `>` / `>-`）的正文是自由散文，必须整体跳过，
    # 否则里面成对的 " 与 ' 会被当成未闭合。合法 patch 不产生任何输出。
    $patchSyntaxIssue = $null
    if ($null -eq $script:presetReadError) {
        $synLines = $null
        try { $synLines = @(Get-Content -LiteralPath $patchPath -Encoding UTF8) } catch { $synLines = $null }
        if ($null -ne $synLines -and $synLines.Count -gt 0) {
            $synBlockIndent = -1
            $synQuotePending = $false
            for ($si = 0; $si -lt $synLines.Count; $si++) {
                $synRaw = [string]$synLines[$si]
                $synTrim = $synRaw.Trim()
                if ($synTrim -eq '' -or $synTrim.StartsWith('#')) { continue }
                $synIndent = $synRaw.Length - $synRaw.TrimStart(' ').Length
                if ($synBlockIndent -ge 0) {
                    if ($synIndent -gt $synBlockIndent) { continue }
                    $synBlockIndent = -1
                }
                if ($synQuotePending) {
                    $synP = 0
                    while ($synP -lt $synRaw.Length) {
                        if ($synRaw[$synP] -eq '\') { $synP += 2; continue }
                        if ($synRaw[$synP] -eq '"') { $synQuotePending = $false; break }
                        $synP++
                    }
                    if ($synQuotePending) { continue }
                }
                if ($synRaw -match '^[ ]*\t') { $patchSyntaxIssue = ('第 ' + ($si + 1) + ' 行用 tab 缩进（YAML 禁止 tab 缩进）'); break }
                if ($synRaw -match ':\s*[|>][-+]?\d*\s*(?:#.*)?$') { $synBlockIndent = $synIndent; continue }
                if ($synRaw -match '^\s*(?:-\s+)?[A-Za-z0-9_.-]+:\s*(["''])' ) {
                    $synQ = $Matches[1]
                    $synP = $synRaw.IndexOf($synQ, $synRaw.IndexOf(':') ) + 1
                    $synClose = -1
                    while ($synP -lt $synRaw.Length) {
                        if ($synRaw[$synP] -eq '\') { $synP += 2; continue }
                        if ($synRaw[$synP] -eq $synQ) {
                            if ($synQ -eq "'" -and ($synP + 1) -lt $synRaw.Length -and $synRaw[$synP + 1] -eq "'") { $synP += 2; continue }
                            $synClose = $synP; break
                        }
                        $synP++
                    }
                    if ($synClose -lt 0) { $synQuotePending = $true; continue }
                }
            }
            if ($synQuotePending) { $patchSyntaxIssue = '末尾仍有未闭合的引号值' }
            if ($null -eq $patchSyntaxIssue) {
                $synJoined = ($synLines -join "`n")
                if ($synJoined -notmatch '(?m)^\s*-\s*insert\s*:') { $patchSyntaxIssue = '找不到顶层 - insert: 结构' }
                elseif ($synJoined -notmatch '(?m)^\s*plugins\s*:') { $patchSyntaxIssue = '找不到顶层 plugins: 结构' }
            }
        }
    }
    if ($null -ne $patchSyntaxIssue) {
        Report 'FAIL' '3/7' 'preset 冲突' ("cordis.patch.yml 未通过轻量语法健全性检查：" + $patchSyntaxIssue + "（不是完整 YAML 解析）") -Hard
        [void]$script:hardReasons.Add("cordis.patch.yml 语法健全性检查失败：" + $patchSyntaxIssue)
    } elseif ($script:presetReadError) {
        Report 'WARN' '3/7' 'preset 冲突' ('无法读取 cordis.patch.yml，可能被占用: ' + $script:presetReadError + ' —— 本项无法判断') -Hard
        [void]$script:hardReasons.Add('cordis.patch.yml 无法读取（可能被占用），preset 冲突无法判断')
    } elseif ($decls.Count -eq 0) {
        Report 'OK' '3/7' 'preset 冲突' 'cordis.patch.yml 里没有 blackpigmodel 声明'
    } else {
        $lineList = ($decls | ForEach-Object { $_.Line }) -join ', '
        Report 'FAIL' '3/7' 'preset 冲突' ("cordis.patch.yml 已有 blackpigmodel 声明，共 {0} 处，行号: {1}" -f $decls.Count, $lineList)
        $kinds = ($decls | ForEach-Object { '{0}({1})' -f $_.Line, $_.Kind }) -join '  '
        Write-Output ("            命中: " + $kinds)
        foreach ($d in $decls) {
            Write-Output ("            第 {0} 行: {1}" -f $d.Line, $d.Text)
            if ($d.InsertLine -gt 0) {
                Write-Output ("                     所属 insert 块起点: 第 {0} 行" -f $d.InsertLine)
            }
        }
        Write-Output '            处置: 删掉上面这些行所在的整个 - insert: 块（从 insert 起点到下一个同级项之前），'
        Write-Output '                  或整份恢复成没有黑猪的备份，再跑一次本脚本确认变 [OK]。'
        Write-Output '            原因: 装包后同一 preset id 会被声明两次，dsh 启动时报 Duplicate agent preset。'
        [void]$script:reasons.Add(('preset 已有声明（第 {0} 行）' -f $lineList))
    }
}

# ── 4/7 package.json 里是否已声明 ──
$newDepName    = 'dsh-blackpig-mode'
$legacyDepName = 'dsh-blackpig-model'
$depNames = @($newDepName, $legacyDepName)
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Report 'WARN' '4/7' 'package.json' ("读不到，无法判断是否装过: " + $pkgPath) -Hard
    [void]$script:hardReasons.Add('profile 缺 package.json，无法判断是否装过（先确认 profile 目录是否正确，再用 dsh 重新初始化该 profile）')
} else {
    $pkgBad = $false
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $pkg = $null
        $pkgBad = $true
        Report 'WARN' '4/7' 'package.json' ('解析失败，无法判断是否装过: ' + $_.Exception.Message) -Hard
        [void]$script:hardReasons.Add('package.json 解析失败，无法判断是否装过（修好 JSON 后重跑本脚本）')
    }
    # PS 5.1 的 ConvertFrom-Json 对空文件/纯空白/null/[] 不抛异常，会返回 $null 或数组；
    # 不在这里立即校验，4/7 会被整段静默跳过，最终报出假 READY（exit 0）。
    if (-not $pkgBad -and $null -eq $pkg) {
        $pkgBad = $true
        Report 'WARN' '4/7' 'package.json' '内容为空或为 null，无法判断是否装过' -Hard
        [void]$script:hardReasons.Add('package.json 内容为空或为 null，无法判断是否装过（修好 JSON 后重跑本脚本）')
    }
    if (-not $pkgBad -and ($pkg -is [System.Array] -or $pkg -is [string] -or $pkg -is [ValueType])) {
        $pkgBad = $true
        Report 'WARN' '4/7' 'package.json' ('根不是对象（实际为 ' + $pkg.GetType().Name + '），无法判断是否装过') -Hard
        [void]$script:hardReasons.Add('package.json 根不是对象，无法判断是否装过（修好 JSON 后重跑本脚本）')
    }
    if (-not $pkgBad -and $pkg) {
        # ⚠️ 2026-11-07 修（R13b3）：README 第 7 条要求本地 file: 指向 tgz 时装进 optionalDependencies，
        # verify.ps1（2/5）也认这个字段；check.ps1 以前只读 dependencies，同一 profile 会给出相反结论
        # （check 报 4/7 [OK]「都没有黑猪包名」，verify 报 2/5 缺件）。这里合并两个来源，按原顺序去重；
        # 下面的 $hasNewName / $hasLegacyName 判定与各分支逻辑保持不变。
        $deps = @()
        $depSources = @()
        if ($pkg.dependencies)         { $depSources += @($pkg.dependencies.PSObject.Properties.Name) }
        if ($pkg.optionalDependencies) { $depSources += @($pkg.optionalDependencies.PSObject.Properties.Name) }
        if ($depSources.Count -gt 0) { $deps = @($depSources | Select-Object -Unique) }
        $bundles = @()
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
            $bundles = @($pkg.dsh.profile.bundles)
        }
        $depHit    = @($deps    | Where-Object { $depNames -contains $_ })
        $bundleHit = @($bundles | Where-Object { $depNames -contains $_ })
        # ⚠️ 2026-11-07 修（R7）：新名与废弃旧名必须分开判定。
        # 旧版把两者收进同一个命中集合：只声明旧名时也报 INFO「正常升级态」，于是
        # warnCount=0、exit 0，旧名残留（4/7）不再暴露。旧名任何形式出现都必须 WARN。
        $hasNewName    = (($deps -contains $newDepName) -or ($bundles -contains $newDepName))
        $hasLegacyName = (($deps -contains $legacyDepName) -or ($bundles -contains $legacyDepName))

        if ($hasLegacyName) {
            # 2026-11-07 修（R17C）：明细只能列「旧名」。$depHit / $bundleHit 是按新名 + 旧名一起过滤的，
            # 直接拼进来会把新名 dsh-blackpig-mode 也列成「需清理」，而下一行处置明写
            # 「不要动 dsh-blackpig-mode」—— 用户照字面清理就会删掉正常声明。
            $legacyDepHit    = @($depHit    | Where-Object { $_ -eq $legacyDepName })
            $legacyBundleHit = @($bundleHit | Where-Object { $_ -eq $legacyDepName })
            $parts = @()
            if ($legacyDepHit.Count -gt 0)    { $parts += ('dependencies/optionalDependencies: ' + ($legacyDepHit -join ', ')) }
            if ($legacyBundleHit.Count -gt 0) { $parts += ('dsh.profile.bundles: ' + ($legacyBundleHit -join ', ')) }
            $state = '旧名残留'
            if ($hasNewName) { $state = '已含新名 dsh-blackpig-mode，但另有旧名残留' }
            Report 'WARN' '4/7' 'package.json' ($state + ' —— 旧名 dsh-blackpig-model 已废弃，需清理 —— ' + ($parts -join ' / '))
            Write-Output '            处置: 从 dependencies / optionalDependencies / dsh.profile.bundles 里删掉 dsh-blackpig-model（旧名），不要动 dsh-blackpig-mode。'
            [void]$script:reasons.Add('package.json 有旧名残留 dsh-blackpig-model')
        } elseif ($hasNewName) {
            # 口径与上一支保持一致：明细只认旧名（本支 $hasLegacyName 为假，故 $parts 恒为空，
            # 输出与原来「只写结论」等价，不会再把新名列成待注意项）。判定条件本身未动。
            $legacyDepHit    = @($depHit    | Where-Object { $_ -eq $legacyDepName })
            $legacyBundleHit = @($bundleHit | Where-Object { $_ -eq $legacyDepName })
            $parts = @()
            if ($legacyDepHit.Count -gt 0)    { $parts += ('dependencies/optionalDependencies: ' + ($legacyDepHit -join ', ')) }
            if ($legacyBundleHit.Count -gt 0) { $parts += ('dsh.profile.bundles: ' + ($legacyBundleHit -join ', ')) }
            $infoDetail = '已含黑猪包名，可能已经装过 —— 正常升级态，不算待清理'
            if ($parts.Count -gt 0) { $infoDetail = $infoDetail + ' —— ' + ($parts -join ' / ') }
            Report 'INFO' '4/7' 'package.json' $infoDetail
            Write-Output '            处置: 已装过属正常情况；升级/重装直接重跑 dsh plugin add 覆盖即可，不要删包、不要手改上面这几处声明（optionalDependencies 里那份按 README 第 7 条属正常）。'
        } else {
            Report 'OK' '4/7' 'package.json' 'dependencies / optionalDependencies 与 dsh.profile.bundles 都没有黑猪包名'
        }
    }
}

# ── 5/7 node_modules 残留 ──
$installedPresent = Test-Path -LiteralPath $pkgDir
$legacyPresent    = Test-Path -LiteralPath $legacyDir
if ($installedPresent -and $legacyPresent) {
    Report 'WARN' '5/7' 'node_modules' ('已安装 dsh-blackpig-mode（' + $pkgDir + '）；另有旧名残留 dsh-blackpig-model（' + $legacyDir + '）')
    Write-Output '            已安装不是问题：升级/重装直接跑 dsh plugin add 覆盖即可，不要删 dsh-blackpig-mode。'
    Write-Output '            处置: 只删旧名残留目录 node_modules\dsh-blackpig-model（旧名，已废弃）。'
    [void]$script:reasons.Add('node_modules 有旧名残留 dsh-blackpig-model')
} elseif ($installedPresent) {
    Report 'INFO' '5/7' 'node_modules' ('已安装 dsh-blackpig-mode（' + $pkgDir + '），不是残留，不要删除')
    Write-Output '            处置: 升级/重装直接跑 dsh plugin --profile <名> add dsh-blackpig-mode 覆盖安装即可。'
} elseif ($legacyPresent) {
    Report 'WARN' '5/7' 'node_modules' ('发现旧名残留目录 dsh-blackpig-model: ' + $legacyDir)
    Write-Output '            处置: 删掉该旧名目录 node_modules\dsh-blackpig-model（旧名，已废弃），不要动 dsh-blackpig-mode。'
    [void]$script:reasons.Add('node_modules 有旧名残留 dsh-blackpig-model')
} else {
    Report 'OK' '5/7' 'node_modules' '没有 dsh-blackpig-mode / dsh-blackpig-model 目录'
}

# ── 6/7 extraDeny 是否禁掉了 subagent_preset ──
$denyHits = @()
$denyReadError = $null
if (Test-Path -LiteralPath $patchPath) {
    try {
        $patchLines = @(Get-Content -LiteralPath $patchPath -Encoding UTF8)
        $denyHits = @(Find-DeniedTool -Lines $patchLines -Tool 'subagent_preset')
    } catch {
        $denyReadError = $_.Exception.Message
        Report 'WARN' '6/7' 'extraDeny' ('无法读取 cordis.patch.yml，可能被占用: ' + $denyReadError + ' —— 本项无法判断') -Hard
        [void]$script:hardReasons.Add('cordis.patch.yml 无法读取（可能被占用），extraDeny 无法判断')
    }
}
if ($denyReadError) {
    # 已在上面报过 WARN，本项按「无法判断」处理，不再给 OK/FAIL
} elseif ($denyHits.Count -eq 0) {
    Report 'OK' '6/7' 'extraDeny' '没有显式 deny subagent_preset'
} else {
    Report 'FAIL' '6/7' 'extraDeny' ('显式 deny 了 subagent_preset（第 ' + (($denyHits) -join ', ') + ' 行）—— 装了也用不了：大脑无法把活派给别的 preset')
    Write-Output '            处置: 删掉 extraDeny 列表里的 subagent_preset 一行，或整段 extraDeny。'
    [void]$script:reasons.Add('extraDeny 禁了 subagent_preset')
}

# ── 7/7 dry-run 影响范围 ──
if ($DryRun) {
    Write-Output ''
    Write-Output '[DRY] 装包影响范围'
    Write-Output ("            将改写: {0}" -f $pkgPath)
    Write-Output '                     · dependencies 增一行 dsh-blackpig-mode'
    Write-Output '                     · dsh.profile.bundles 增一项 dsh-blackpig-mode'
    Write-Output ("            将落盘: {0}" -f $pkgDir)
    Write-Output ("            不动  : {0}（包自带的 patch 由 bundle 层挂载，不需要写进你的文件）" -f $patchPath)
    Write-Output '            只读保证: 本脚本到此为止没有写任何文件、没有调用 dsh。'
}

# ── 总结 ──
Write-Output ''
Write-Output '------------------------------------------------------------'
if ($script:hardStop) {
    $verdict = 'BLOCKED'
    $code = 2
} elseif ($script:failCount -gt 0 -or $script:warnCount -gt 0) {
    $verdict = 'NEEDS-CLEANUP'
    $code = 1
} else {
    $verdict = 'READY'
    $code = 0
}

Write-Output (" 结论: {0}    (FAIL {1} / WARN {2})" -f $verdict, $script:failCount, $script:warnCount)
if ($verdict -eq 'READY') {
    Write-Output (' 可以直接装: dsh plugin --profile ' + $Profile + ' add dsh-blackpig-mode')
} elseif ($verdict -eq 'BLOCKED') {
    if ($script:hardReasons.Count -gt 0) {
        Write-Output (' 环境不满足 / 无法判断（不是「有残留要清理」）: ' + ($script:hardReasons -join '; '))
        Write-Output ' 先解决上面这些读不到 / 缺件的问题，再谈装包。'
    } else {
        Write-Output ' 环境不满足，先解决第 1/2 项，再谈装包。'
    }
    if ($script:reasons.Count -gt 0) {
        Write-Output (' 另有待清理（修好上面的环境问题后仍需处理）: ' + ($script:reasons -join '; '))
    }
} else {
    Write-Output (' 先清理: ' + ($script:reasons -join '; '))
    Write-Output ' 清理后重跑本脚本，直到 READY 再装。'
}
Write-Output (" exit code: {0}" -f $code)
Write-Output '------------------------------------------------------------'

exit $code
