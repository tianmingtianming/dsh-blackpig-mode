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
    退出码：0 = READY（可以装）  1 = NEEDS-CLEANUP（先清理）  2 = BLOCKED（环境不满足）
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

    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $raw = $lines[$i]
        $kind = $null
        if ($raw -match '^\s*(?:-\s*)?id\s*:\s*["'']?preset-blackpigmodel["'']?\s*(?:#.*)?$') {
            $kind = 'preset-blackpigmodel'
        }
        elseif ($raw -match '^\s*(?:-\s*)?id\s*:\s*["'']?blackpigmodel["'']?\s*(?:#.*)?$') {
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
    Report 'OK' '3/7' 'preset 冲突' ("没有 cordis.patch.yml —— 干净 profile 的正常状态，不存在任何旧声明（装包后才会新建）: " + $patchPath)
} else {
    $decls = @(Find-PresetDeclaration -Path $patchPath)
    if ($decls.Count -eq 0) {
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
$depNames = @('dsh-blackpig-mode', 'dsh-blackpig-model')
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Report 'WARN' '4/7' 'package.json' ("读不到，无法判断是否装过: " + $pkgPath)
} else {
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $pkg = $null
        Report 'WARN' '4/7' 'package.json' ('解析失败，无法判断是否装过: ' + $_.Exception.Message)
    }
    if ($pkg) {
        $deps = @()
        if ($pkg.dependencies) { $deps = @($pkg.dependencies.PSObject.Properties.Name) }
        $bundles = @()
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
            $bundles = @($pkg.dsh.profile.bundles)
        }
        $depHit    = @($deps    | Where-Object { $depNames -contains $_ })
        $bundleHit = @($bundles | Where-Object { $depNames -contains $_ })

        if ($depHit.Count -gt 0 -or $bundleHit.Count -gt 0) {
            $parts = @()
            if ($depHit.Count -gt 0)    { $parts += ('dependencies: ' + ($depHit -join ', ')) }
            if ($bundleHit.Count -gt 0) { $parts += ('dsh.profile.bundles: ' + ($bundleHit -join ', ')) }
            Report 'WARN' '4/7' 'package.json' ('已含黑猪包名，可能已经装过 —— ' + ($parts -join ' / '))
            Write-Output '            处置: 已装过属正常情况；升级/重装直接重跑 dsh plugin add 覆盖即可，不要删包、不要手改上面这两处声明。'
            [void]$script:reasons.Add('package.json 已含黑猪声明（可能装过）')
        } else {
            Report 'OK' '4/7' 'package.json' 'dependencies 与 dsh.profile.bundles 都没有黑猪包名'
        }
    }
}

# ── 5/7 node_modules 残留 ──
$installedPresent = Test-Path -LiteralPath $pkgDir
$legacyPresent    = Test-Path -LiteralPath $legacyDir
if ($installedPresent -and $legacyPresent) {
    Report 'INFO' '5/7' 'node_modules' ('已安装 dsh-blackpig-mode（' + $pkgDir + '）；另有旧名残留 dsh-blackpig-model（' + $legacyDir + '）')
    Write-Output '            已安装不是问题：升级/重装直接跑 dsh plugin add 覆盖即可，不要删 dsh-blackpig-mode。'
    Write-Output '            处置: 只删旧名残留目录 node_modules\dsh-blackpig-model（旧名，已废弃）。'
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
if (Test-Path -LiteralPath $patchPath) {
    $patchLines = @(Get-Content -LiteralPath $patchPath -Encoding UTF8)
    $denyHits = @(Find-DeniedTool -Lines $patchLines -Tool 'subagent_preset')
}
if ($denyHits.Count -eq 0) {
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
    Write-Output ' 环境不满足，先解决第 1/2 项，再谈装包。'
} else {
    Write-Output (' 先清理: ' + ($script:reasons -join '; '))
    Write-Output ' 清理后重跑本脚本，直到 READY 再装。'
}
Write-Output (" exit code: {0}" -f $code)
Write-Output '------------------------------------------------------------'

exit $code
