#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-blackpig-mode 安装后生效验证（只读为主）

.DESCRIPTION
    装完包后运行（通常无需重启）。核对：包是否落盘且文件完整、profile 是否登记了包、
    是否还残留旧 preset 声明、dsh --dump-config 能否正常合成并含 preset-blackpigmodel。

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

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\verify.ps1 -Profile desktop

.NOTES
    退出码：0 = 可直接使用  1 = 缺件或有冲突  2 = 环境不满足（找不到 dsh / profile）
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$script:failCount = 0
$script:warnCount = 0
$script:hardStop = $false
$script:verdicts = New-Object System.Collections.ArrayList

function Report {
    param([string]$Tag, [string]$No, [string]$Title, [string]$Detail, [switch]$Hard)
    $label = '[OK]  '
    if ($Tag -eq 'WARN') { $label = '[WARN]'; $script:warnCount++ }
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
        [void]$found.Add([pscustomobject]@{ Line = $i + 1; Text = $raw.Trim(); Kind = $kind })
    }
    return $found
}

# 内置期望值表（字节，UTF-8 口径）
#
# 2026-11-03 全量重测（包内 11 个文件）。
# README.md 与 verify.ps1 自身不参与字节校验：它们会随编辑变化，
# 参与校验只会在每次安装后报假 WARN（见 $skipSizeCheck）。
$expected = [ordered]@{
    'cordis.patch.yml'    = 37275
    'guard-v10.mjs'       = 122412
    'blackpig-roster.mjs' = 74754
    'subtalk.mjs'         = 35457
    'file-info.mjs'       = 25863
    'member-persona.mjs'  = 15336
    'package.json'        = 727
    'README.md'           = 0       # 仅记录最后已知尺寸（不参与校验，故置 0）
    'LICENSE'             = 1073
    'check.ps1'           = 13564
    'verify.ps1'          = 0       # 自引用：写死自身字节必然追不上，不参与校验
}

# 不参与字节校验的文件（允许编辑，或换行符随 git 配置变化）：
#   README.md  —— 随文档更新
#   verify.ps1 —— 自身，改一次字节就变，参与校验必然自死循环
#   check.ps1  —— 该脚本本身随检查项增删而变，且换行符口径依赖 .gitattributes。
#                 当前 .gitattributes 为 *.ps1 text eol=lf，入库与打包后都是 LF，
#                 但仍不参与校验，避免以后规则再调整时误报版本不符。
# 注意：不要改用 SHA256 —— 换行符口径一变 SHA 同样对不上。
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

# ── 1. 包落盘 + 文件字节数 ──
if (-not (Test-Path -LiteralPath $pkgDir -PathType Container)) {
    Report 'FAIL' '1/5' '包落盘' ("没有 " + $pkgDir + " —— 包没装上，或 dsh plugin add 失败")
    [void]$script:verdicts.Add('缺少 dsh-blackpig-mode 包目录')
} else {
    $fileRows = @()
    $sizeBad  = 0
    $missing  = 0
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
        $len = (Get-Item -LiteralPath $fp).Length
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
    $extraFiles = @(Get-ChildItem -LiteralPath $pkgDir -File | Where-Object { -not $expected.Contains($_.Name) })
    if ($missing -gt 0) {
        Report 'FAIL' '1/5' '包落盘' ("目录存在，但缺 {0} 个文件（共 {1} 个应到）" -f $missing, $expected.Count)
    } elseif ($sizeBad -gt 0) {
        Report 'WARN' '1/5' '包落盘' ("{0} 个文件齐全，{1} 个字节数与期望不符（可能是版本不同，务必看下一行明细）" -f ($expected.Count - $missing), $sizeBad)
    } else {
        Report 'OK' '1/5' '包落盘' (($expected.Count - $missing).ToString() + ' 个文件齐全，字节数与内置期望值全部一致；README.md 不参与字节校验（允许编辑）')
    }
    Write-Output '       文件明细（字节，UTF-8 口径）:'
    Write-Output '       注: 本脚本 (verify.ps1) 与 check.ps1 不参与字节校验（换行符随 git 配置变化，见 .gitattributes 的 *.ps1 eol=lf）'
    foreach ($r in $fileRows) { Write-Output $r }
    if ($extraFiles.Count -gt 0) {
        Write-Output ('       另有 {0} 个非清单文件（不参与校验）: {1}' -f $extraFiles.Count, (($extraFiles | ForEach-Object { $_.Name }) -join ', '))
    }
    if ($missing -gt 0 -or $sizeBad -gt 0) { [void]$script:verdicts.Add('包文件不完整/版本不符') }
}

# ── 2. profile package.json 登记 ──
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Report 'FAIL' '2/5' 'profile 登记' ("读不到 " + $pkgPath)
    [void]$script:verdicts.Add('profile package.json 缺失')
} else {
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $pkg = $null
        Report 'FAIL' '2/5' 'profile 登记' ('package.json 解析失败: ' + $_.Exception.Message)
        [void]$script:verdicts.Add('profile package.json 无法解析')
    }
    if ($pkg) {
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
if (-not (Test-Path -LiteralPath $patchPath)) {
    Report 'OK' '3/5' '旧声明残留' '没有 cordis.patch.yml（干净 profile 的正常状态；包靠 bundle 层挂载）'
} else {
    $decls = @(Find-PresetDeclaration -Path $patchPath)
    if ($decls.Count -eq 0) {
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

function Invoke-DumpConfig {
    param([string]$DshCmd, [string]$ProfileName)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = @()
    $c = $null
    try {
        $raw = @(& $DshCmd --profile $ProfileName --dump-config 2>&1)
        $c = $LASTEXITCODE
    } catch {
        $raw = @('调用异常: ' + $_.Exception.Message)
        $c = -1
    } finally {
        $ErrorActionPreference = $old
    }
    $lines = New-Object System.Collections.ArrayList
    foreach ($item in $raw) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) { [void]$lines.Add([string]$item.Exception.Message) }
        else { [void]$lines.Add([string]$item) }
    }
    return [pscustomobject]@{ Code = $c; Lines = $lines }
}

if (-not $dshCmd) {
    Report 'FAIL' '4/5' 'dump-config' '找不到 dsh.cmd，无法验证运行时能否合成' -Hard
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
    $joined = ($res.Lines -join "`n")

    # desktop 由 Electron 独占：CLI 会硬拒绝，改用影子 profile 复核
    $electronLock = ($joined -match 'managed exclusively by the Electron application')

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

    $dumpText = ($dumpLines -join "`n")
    $dumpPresetHits = ([regex]::Matches($dumpText, 'preset-blackpigmodel')).Count
    $dumpIdHits = ([regex]::Matches($dumpText, 'blackpigmodel')).Count

    if ($null -eq $dumpCode) { $dumpCode = -1 }
    $suffix = ''
    if ($dumpNote) { $suffix = '  [' + $dumpNote + ']' }

    if ($electronLock -and -not $dumpNote.StartsWith('阴影')) {
        # 既拒绝又没有影子可用：不判死，降级为 WARN 并说明
        Report 'WARN' '4/5' 'dump-config' ('desktop 被 dsh CLI 独占，无法 dump-config，运行时合成未验证（其余检查照常）' + $suffix)
        [void]$script:verdicts.Add('desktop 无法 dump-config（平台限制）')
    } elseif ($dumpCode -ne 0) {
        Report 'FAIL' '4/5' 'dump-config' ("exit code = {0}（应为 0）—— 配置合成失败，见下方前几行{1}" -f $dumpCode, $suffix)
        foreach ($l in ($dumpLines | Select-Object -First 12)) { Write-Output ('       | ' + $l) }
        [void]$script:verdicts.Add(('dump-config exit ' + $dumpCode))
    } elseif ($dumpPresetHits -eq 0 -and $dumpIdHits -eq 0) {
        Report 'FAIL' '4/5' 'dump-config' ("exit code = 0，但输出里没有 preset-blackpigmodel / blackpigmodel（命中 0/0）—— 包没被合成进配置{0}" -f $suffix)
        [void]$script:verdicts.Add('dump-config 里没有黑猪 preset')
    } elseif ($dumpPresetHits -eq 0) {
        Report 'WARN' '4/5' 'dump-config' ("exit code = 0，命中 preset-blackpigmodel x0 / blackpigmodel x{0} —— 名字在但没找到 preset 声明行，人工复核{1}" -f $dumpIdHits, $suffix)
        [void]$script:verdicts.Add('dump-config 命中数可疑')
    } elseif ($dumpPresetHits -gt 1) {
        Report 'FAIL' '4/5' 'dump-config' ("exit code = 0，但 preset-blackpigmodel 命中 {0} 次（应为 1）—— 重复声明，启动会报 Duplicate agent preset{1}" -f $dumpPresetHits, $suffix)
        [void]$script:verdicts.Add(('dump-config 里 preset 出现 ' + $dumpPresetHits + ' 次（重复声明）'))
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

# ── 5. 结论 ──
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
Write-Output (" 结论: {0}" -f $verdict)
Write-Output (" (FAIL {0} / WARN {1})" -f $script:failCount, $script:warnCount)
if ($codeOut -eq 0) {
    Write-Output (' 下一步: 重启 DSH 后新建会话，preset 里应能看到「黑猪模式」。')
}
Write-Output (" exit code: {0}" -f $codeOut)
Write-Output '------------------------------------------------------------'

exit $codeOut
