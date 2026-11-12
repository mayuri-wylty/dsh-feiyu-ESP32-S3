<#
.SYNOPSIS
    一键安装 dsh-feiyu 所需的全部本地运行环境，安装路径统一收敛到仓库根目录的 deps\ 下。

.DESCRIPTION
    三块环境（全部串行执行，不并发，内存占用小）：
      1. 抖音（douyin）  -> deps\douyin\{.venv,browsers}   patchright + 本地 Chromium
      2. 微信（wechat）  -> deps\wechat\.venv                wechatauto-replica
      3. QQ 网关 NapCat  -> deps\napcat\                      Node 版 NapCat Shell v4.18.42（注入式，QQ 9.9.36 下核心起不来，仅作 DLL 来源）
         QQ 网关（现行）-> deps\napcat-old\                 独立版 NapCat v4.18.19（自带 QQ 运行库，不注入本机 QQ，无需管理员）

    另外：
      - 建立 D:\NapCat 目录联接（junction）指向 deps\napcat\napcat，
        满足上游代码里写死的 D:/NapCat/... 路径，并给计划任务一个纯 ASCII 目标。
        若 D:\NapCat 已是你自己的真实目录，则不会改动它，改为直接引用 deps 内路径。
      - 把各环境路径深合并进 ~\.dsh\feiyu.config.json（只写路径，不写任何密钥）。

    幂等：已完成的步骤会跳过，可重复运行。
    安全：压缩包解压带路径越界检查；绝不递归删除目录；NapCat 的 config\ 不会被覆盖。

.PARAMETER SkipNapCat
    跳过 NapCat（下载 + 解压 + 联接 + 启动脚本）。

.PARAMETER SkipDouyin
    跳过抖音环境（venv + pip + Chromium）。

.PARAMETER SkipWeChat
    跳过微信环境（venv + pip）。

.PARAMETER Force
    重新下载并覆盖解压 NapCat（保留 napcat\config\ 下已有文件）、重装 Chromium、重写启动脚本。
    pip 步骤本身幂等，不需要 -Force。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-deps.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipNapCat,
    [switch]$SkipDouyin,
    [switch]$SkipWeChat,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Deps      = Join-Path $RepoRoot 'deps'
$Cache     = Join-Path $Deps '.cache'
$PypiIndex = 'https://mirrors.aliyun.com/pypi/simple/'

# 上游 NapNeko/NapCatQQ 的 release 附件在本机网络下取不到；
# fork XingYunStar/NapCatQQ 携带同名同版本附件（字节数一致），并在此固定 SHA256 防调包。
$NapCatVersion = '4.18.42'
# 下载源按顺序尝试：先自己仓库的 release 备份，再 fork；任何来源都必须通过下面的 SHA256 校验。
$NapCatUrls    = @(
    "https://github.com/mayuri-wylty/dsh-feiyu-ESP32-S3/releases/download/deps-napcat-v$NapCatVersion/NapCat.Shell.Windows.Node.zip",
    "https://github.com/XingYunStar/NapCatQQ/releases/download/v$NapCatVersion/NapCat.Shell.Windows.Node.zip"
)
$NapCatSha256  = '77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed'
$NapCatZip     = Join-Path $Cache 'NapCat.Shell.Windows.Node.zip'
$NapCatDir     = Join-Path $Deps 'napcat'
$NapCatSub     = Join-Path $NapCatDir 'napcat'
$Junction      = 'D:\NapCat'

# 独立版 NapCat 4.18.19：自带 QQ 9.9.32 运行库，node.exe index.js 直接跑，不注入本机 QQ。
$SaVersion = '4.18.19'
$SaUrls    = @(
    "https://github.com/mayuri-wylty/dsh-feiyu-ESP32-S3/releases/download/deps-napcat-v$SaVersion/NapCat.Shell.Windows.Node.zip",
    "https://github.com/XingYunStar/NapCatQQ/releases/download/v$SaVersion/NapCat.Shell.Windows.Node.zip"
)
$SaSha256  = 'a08e7bebe49f656807f198bbf3a5d3f2fd6f840499728d665285323db4342d77'
$SaZip     = Join-Path $Cache 'NapCat-standalone-4.18.19.zip'
$SaDir     = Join-Path $Deps 'napcat-old'
$SaJunction = 'D:\NapCatOld'

# 配置里写入的 napcat_launcher（Install-NapCat 会按联接是否可用改写）
$script:NapCatLauncher = 'D:/NapCat/start-qq-gateway.bat'
$script:Py = $null

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    [skip] $msg" -ForegroundColor DarkGray }
function Write-Warn($msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 工具函数

function Test-Cmd([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-Sha256([string]$Path) {
    <# 流式计算 SHA256（小写十六进制）；不依赖 Get-FileHash（模块路径被污染时 5.1 可能找不到它）。 #>
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant()
    } finally {
        $fs.Dispose()
        $sha.Dispose()
    }
}

function Invoke-Native {
    <# 运行外部程序并返回退出码。
       输出：-LogPath 写日志；-Show 打到屏幕；都不给则丢弃。
       临时放宽 ErrorActionPreference：Windows PowerShell 5.1 下 2>&1 会把 stderr 行变成错误记录，
       在 Stop 模式下会误中断（pip 的 [notice] 就走 stderr）。 #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [string]$LogPath,
        [switch]$Show
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($LogPath) {
            & $Exe @Arguments 2>&1 | Out-File -FilePath $LogPath -Encoding utf8
        } elseif ($Show) {
            & $Exe @Arguments 2>&1 | Out-Host
        } else {
            & $Exe @Arguments 2>&1 | Out-Null
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Find-Python {
    <# 选一个 >=3.10 的解释器；返回 @{ Exe=..; PyArgs=@(..) } #>
    $candidates = @(
        @{ Exe = 'py';     PyArgs = @('-3.12') },
        @{ Exe = 'python'; PyArgs = @() }
    )
    foreach ($c in $candidates) {
        if (-not (Test-Cmd $c.Exe)) { continue }
        $probe = @($c.PyArgs) + @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)')
        $code = Invoke-Native -Exe $c.Exe -Arguments $probe
        if ($code -eq 0) { return $c }
    }
    throw '未找到可用的 Python（需要 3.10+，推荐 3.12）。请先安装并加入 PATH。'
}

function New-Venv([string]$VenvDir) {
    $py = Join-Path $VenvDir 'Scripts\python.exe'
    if (Test-Path -LiteralPath $py) {
        Write-Skip "venv 已存在：$VenvDir"
        return $py
    }
    Write-Host "    creating venv: $VenvDir"
    $a = @($script:Py.PyArgs) + @('-m', 'venv', $VenvDir)
    $code = Invoke-Native -Exe $script:Py.Exe -Arguments $a
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $py)) { throw "venv 创建失败：$VenvDir" }
    return $py
}

function Invoke-Pip([string]$VenvPy, [string]$Requirements, [string]$LogPath) {
    Write-Host "    pip install -r $(Split-Path -Leaf $Requirements) ..."
    $a = @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
           '--progress-bar', 'off', '-i', $PypiIndex, '-r', $Requirements)
    $code = Invoke-Native -Exe $VenvPy -Arguments $a -LogPath $LogPath
    if ($code -ne 0) { throw "pip install 失败，日志：$LogPath" }
}

function Expand-ZipGuarded {
    <# 安全解压：拒绝任何逃逸出目标目录的条目（zip-slip）；
       -KeepExisting 前缀下已存在的文件不覆盖（保护用户配置）。逐条流式写盘，不整体读入内存。 #>
    param(
        [string]$ZipPath,
        [string]$DestPath,
        [string[]]$KeepExisting = @()
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not (Test-Path -LiteralPath $DestPath)) {
        New-Item -ItemType Directory -Path $DestPath -Force | Out-Null
    }
    $fullDest = [IO.Path]::GetFullPath($DestPath).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $zip.Entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $fullDest $entry.FullName))
            if (-not $target.StartsWith($fullDest, [StringComparison]::OrdinalIgnoreCase)) {
                throw "压缩包条目越界，已中止：$($entry.FullName)"
            }
            if ([string]::IsNullOrEmpty($entry.Name)) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                continue
            }
            if ($KeepExisting.Count -gt 0 -and (Test-Path -LiteralPath $target)) {
                $keep = $false
                foreach ($k in $KeepExisting) {
                    if ($entry.FullName.StartsWith($k, [StringComparison]::OrdinalIgnoreCase)) { $keep = $true; break }
                }
                if ($keep) { continue }
            }
            $dir = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally {
        $zip.Dispose()
    }
}

# ---------------------------------------------------------------- 1. NapCat

function Initialize-NapCatJunction {
    <# 建立 D:\NapCat -> deps\napcat\napcat 联接；结果写入 $script:NapCatLauncher。
       只用非递归方式删除联接本身，绝不递归删除目录。 #>
    $viaJunction = 'D:/NapCat/start-qq-gateway.bat'
    $direct = (Join-Path $NapCatSub 'start-qq-gateway.bat') -replace '\\', '/'

    if (-not (Test-Path -LiteralPath 'D:\')) {
        Write-Warn 'D: 盘不存在，跳过联接，配置改为直接引用 deps 内路径'
        $script:NapCatLauncher = $direct
        return
    }

    $item = Get-Item -LiteralPath $Junction -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        New-Item -ItemType Junction -Path $Junction -Target $NapCatSub | Out-Null
        Write-Ok "联接已创建：$Junction -> $NapCatSub"
        $script:NapCatLauncher = $viaJunction
        return
    }

    if ($item.LinkType -eq 'Junction') {
        $targets = @($item.Target) | ForEach-Object { ([string]$_).TrimEnd('\') }
        if ($targets -contains $NapCatSub.TrimEnd('\')) {
            Write-Skip "联接已存在：$Junction -> $NapCatSub"
            $script:NapCatLauncher = $viaJunction
            return
        }
        if ($Force) {
            [IO.Directory]::Delete($Junction, $false)   # 仅删除联接本身
            New-Item -ItemType Junction -Path $Junction -Target $NapCatSub | Out-Null
            Write-Ok "联接已重建：$Junction -> $NapCatSub"
            $script:NapCatLauncher = $viaJunction
            return
        }
        Write-Warn "$Junction 是指向别处的联接（$($targets -join ', ')），未改动；加 -Force 可重建。配置改为直接引用 deps 内路径"
        $script:NapCatLauncher = $direct
        return
    }

    Write-Warn "$Junction 已存在且是真实目录（可能是你自己的 NapCat），未改动；配置改为直接引用 deps 内路径"
    $script:NapCatLauncher = $direct
}

function Install-NapCat {
    Write-Step "NapCat v$NapCatVersion (QQ 网关)"
    $boot = Join-Path $NapCatSub 'NapCatWinBootMain.exe'

    if ((Test-Path -LiteralPath $boot) -and -not $Force) {
        Write-Skip "已安装：$NapCatSub"
    } else {
        if (-not (Test-Path -LiteralPath $Cache)) { New-Item -ItemType Directory -Path $Cache -Force | Out-Null }
        if ($Force -and (Test-Path -LiteralPath $NapCatZip)) { Remove-Item -LiteralPath $NapCatZip -Force }
        if (-not (Test-Path -LiteralPath $NapCatZip)) {
            if (-not (Test-Cmd 'curl.exe')) { throw '缺少 curl.exe，无法下载 NapCat。' }
            $done = $false
            foreach ($url in $NapCatUrls) {
                Write-Host "    downloading $url"
                $code = Invoke-Native -Exe 'curl.exe' -Show -Arguments @(
                    '-4', '--tlsv1.2', '-L', '-C', '-', '--retry', '5', '--retry-all-errors',
                    '-sS', '-o', $NapCatZip, $url)
                if ($code -eq 0 -and (Test-Path -LiteralPath $NapCatZip) -and (Get-Sha256 $NapCatZip) -eq $NapCatSha256) {
                    $done = $true; break
                }
                Write-Warn "该来源失败或校验不符（curl 退出码 $code），换下一个"
                if (Test-Path -LiteralPath $NapCatZip) { Remove-Item -LiteralPath $NapCatZip -Force }
            }
            if (-not $done) { throw "NapCat 所有下载源均失败：$($NapCatUrls -join ' ; ')" }
        } else {
            Write-Skip "压缩包已缓存：$NapCatZip"
        }
        $actual = Get-Sha256 $NapCatZip
        if ($actual -ne $NapCatSha256) {
            throw "NapCat 压缩包 SHA256 不符（期望 $NapCatSha256，实际 $actual）。已中止，未解压；请核对来源后删除 $NapCatZip 重试，或更新脚本里的固定值。"
        }
        Write-Host "    extracting -> $NapCatDir"
        Expand-ZipGuarded -ZipPath $NapCatZip -DestPath $NapCatDir -KeepExisting @('napcat/config/')
        if (-not (Test-Path -LiteralPath $boot)) { throw "解压后仍未找到 $boot" }
        Write-Ok "已安装：$NapCatDir"
    }

    # NapCat 的 config/cache/logs/plugins 全部落在 napcat.mjs 所在目录
    foreach ($d in 'config', 'cache', 'logs', 'plugins') {
        $p = Join-Path $NapCatSub $d
        if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    }
    Write-Ok '数据目录就绪：config/ cache/ logs/ plugins/'

    # 启动辅助脚本：模板在 scripts\napcat\，必须放进 NapCat 目录（脚本内用 %~dp0 定位同目录文件）
    $tpl = Join-Path $RepoRoot 'scripts\napcat\start-qq-gateway.bat'
    $dst = Join-Path $NapCatSub 'start-qq-gateway.bat'
    $same = (Test-Path -LiteralPath $dst) -and
            ((Get-Sha256 $tpl) -eq (Get-Sha256 $dst))
    if ($same -and -not $Force) {
        Write-Skip "启动脚本已是最新：$dst"
    } else {
        Copy-Item -LiteralPath $tpl -Destination $dst -Force
        Write-Ok "启动脚本已写入：$dst"
    }

    Initialize-NapCatJunction
}

function Install-NapCatStandalone {
    Write-Step "NapCat v$SaVersion 独立版 (QQ 网关，现行方案)"
    $node = Join-Path $SaDir 'node.exe'
    if ((Test-Path -LiteralPath $node) -and -not $Force) {
        Write-Skip "已解压：$SaDir"
    } else {
        if ($Force -and (Test-Path -LiteralPath $SaZip)) { Remove-Item -LiteralPath $SaZip -Force }
        if (-not (Test-Path -LiteralPath $SaZip)) {
            if (-not (Test-Cmd 'curl.exe')) { throw '缺少 curl.exe，无法下载 NapCat。' }
            $done = $false
            foreach ($url in $SaUrls) {
                Write-Host "    downloading $url"
                $code = Invoke-Native -Exe 'curl.exe' -Show -Arguments @(
                    '-4', '--tlsv1.2', '-L', '-C', '-', '--retry', '5', '--retry-all-errors', '-sS', '-o', $SaZip, $url)
                if ($code -eq 0 -and (Test-Path -LiteralPath $SaZip) -and (Get-Sha256 $SaZip) -eq $SaSha256) { $done = $true; break }
                Write-Warn "该来源失败或校验不符（curl 退出码 $code），换下一个"
                if (Test-Path -LiteralPath $SaZip) { Remove-Item -LiteralPath $SaZip -Force }
            }
            if (-not $done) { throw "独立版 NapCat 所有下载源均失败：$($SaUrls -join ' ; ')" }
        }
        $actual = Get-Sha256 $SaZip
        if ($actual -ne $SaSha256) { throw "独立版 NapCat SHA256 不符（期望 $SaSha256，实际 $actual），已中止。" }
        Write-Host "    extracting -> $SaDir"
        Expand-ZipGuarded -ZipPath $SaZip -DestPath $SaDir -KeepExisting @('napcat/config/')
        if (-not (Test-Path -LiteralPath $node)) { throw "解压后仍未找到 $node" }
        Write-Ok "已解压：$SaDir"
    }

    # 补丁 1：该包缺 x64 的 crypto.dll / ssl.dll，借用 deps\napcat（4.18.42 包）里的同名文件
    foreach ($dll in 'crypto.dll', 'ssl.dll') {
        $dst = Join-Path $SaDir $dll
        $src = Join-Path $NapCatDir $dll
        if (Test-Path -LiteralPath $dst) { continue }
        if (-not (Test-Path -LiteralPath $src)) { throw "缺少 $dll：需要先安装 deps\napcat（不要加 -SkipNapCat）" }
        Copy-Item -LiteralPath $src -Destination $dst
        Write-Ok "补齐 $dll"
    }

    # 补丁 2：worker 带 --no-sandbox 是给 Electron 用的，普通 node.exe 不认，直接删掉
    $mjs = Join-Path $SaDir 'napcat\napcat.mjs'
    $needle = '...Hu ? {} : { execArgv: ["--no-sandbox"] }'
    $text = [IO.File]::ReadAllText($mjs)
    if ($text.Contains($needle)) {
        [IO.File]::WriteAllText($mjs, $text.Replace($needle, '...{}'), (New-Object Text.UTF8Encoding($false)))
        Write-Ok '已去掉 napcat.mjs 里的 --no-sandbox'
    } else {
        Write-Skip 'napcat.mjs 无需打补丁'
    }

    # 启动脚本（纯 ASCII，避免 cmd 代码页问题）
    Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\napcat\start-napcat-standalone.bat') -Destination (Join-Path $SaDir 'start-napcat-standalone.bat') -Force
    Write-Ok '启动脚本已写入'

    # ASCII 联接 D:\NapCatOld -> deps\napcat-old（仓库路径含中文，计划任务/批处理走联接更稳）
    if (-not (Test-Path -LiteralPath 'D:\')) { Write-Warn 'D: 盘不存在，跳过 D:\NapCatOld 联接'; return }
    $item = Get-Item -LiteralPath $SaJunction -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        New-Item -ItemType Junction -Path $SaJunction -Target $SaDir | Out-Null
        Write-Ok "联接已创建：$SaJunction -> $SaDir"
    } elseif ($item.LinkType -eq 'Junction' -and (@($item.Target) | ForEach-Object { ([string]$_).TrimEnd('\') }) -contains $SaDir.TrimEnd('\')) {
        Write-Skip "联接已存在：$SaJunction"
    } else {
        Write-Warn "$SaJunction 已存在且不是指向 $SaDir 的联接，未改动（启动脚本会回退到相对路径）"
    }
}

# ---------------------------------------------------------------- 2. 抖音

function Install-Douyin {
    Write-Step '抖音环境（patchright + Chromium）'
    $venvPy = New-Venv (Join-Path $Deps 'douyin\.venv')
    Invoke-Pip $venvPy (Join-Path $RepoRoot 'scripts\requirements\douyin.txt') (Join-Path $Deps 'douyin\pip-install.log')

    $browsers = Join-Path $Deps 'douyin\browsers'
    if (-not (Test-Path -LiteralPath $browsers)) { New-Item -ItemType Directory -Path $browsers -Force | Out-Null }
    $env:PLAYWRIGHT_BROWSERS_PATH = $browsers
    $have = @(Get-ChildItem -LiteralPath $browsers -Filter 'chromium-*' -Directory -ErrorAction SilentlyContinue)
    if ($have.Count -gt 0 -and -not $Force) {
        Write-Skip "Chromium 已存在：$($have[0].Name)"
    } else {
        Write-Host '    installing chromium ...'
        $code = Invoke-Native -Exe $venvPy -Arguments @('-m', 'patchright', 'install', 'chromium') `
            -LogPath (Join-Path $Deps 'douyin\chromium-install.log')
        if ($code -ne 0) { throw 'patchright install chromium 失败，见 deps\douyin\chromium-install.log' }
    }
    Write-Ok "浏览器目录：$browsers"
}

# ---------------------------------------------------------------- 3. 微信

function Install-WeChat {
    Write-Step '微信环境（wechatauto-replica）'
    $venvPy = New-Venv (Join-Path $Deps 'wechat\.venv')
    Invoke-Pip $venvPy (Join-Path $RepoRoot 'scripts\requirements\wechat.txt') (Join-Path $Deps 'wechat\pip-install.log')
    Write-Ok '仅安装库；不要运行 wechatauto 的数据库解密 / 账号激活功能'
}

# ---------------------------------------------------------------- 4. 配置

function Merge-Config {
    Write-Step '合并运行配置到 ~\.dsh\feiyu.config.json'
    if (-not (Test-Cmd 'node')) {
        Write-Warn '未找到 node，跳过配置合并；装好 node 后运行：node scripts\merge-feiyu-config.mjs'
        return
    }
    $m = Join-Path $RepoRoot 'scripts\merge-feiyu-config.mjs'
    $code = Invoke-Native -Exe 'node' -Show -Arguments @($m, $RepoRoot, $script:NapCatLauncher)
    if ($code -ne 0) { throw '配置合并失败' }
}

# ---------------------------------------------------------------- main

if (-not (Test-Path -LiteralPath $Deps)) { New-Item -ItemType Directory -Path $Deps -Force | Out-Null }
if (-not (Test-Path -LiteralPath $Cache)) { New-Item -ItemType Directory -Path $Cache -Force | Out-Null }
$env:PIP_CACHE_DIR = Join-Path $Cache 'pip'   # pip 缓存也收进 deps\

Write-Host "仓库根目录：$RepoRoot"
Write-Host "安装根目录：$Deps"

if (-not ($SkipDouyin -and $SkipWeChat)) {
    $script:Py = Find-Python
    Write-Host "Python：$($script:Py.Exe) $($script:Py.PyArgs -join ' ')"
}

if (-not $SkipNapCat) { Install-NapCat; Install-NapCatStandalone }
if (-not $SkipDouyin) { Install-Douyin }
if (-not $SkipWeChat) { Install-WeChat }
Merge-Config

Write-Host ''
Write-Host '完成。仍需你手动完成（无法自动化）：' -ForegroundColor Yellow
Write-Host '  * 抖音：首次运行 douyin_interact.py 扫码登录（cookie 存 ~/.feiyu-ai/douyin-cookies.json）'
Write-Host '  * 微信：先在 PC 版微信客户端登录，再启动 wechat/wechat_bot.py'
Write-Host '  * QQ：运行 scripts\napcat\start-napcat-standalone.bat（独立版，无需管理员），扫 deps\napcat-old\napcat\cache\qrcode.png 登录'
Write-Host '  * QQ 首次登录后：在 deps\napcat-old\napcat\config\onebot11_<QQ号>.json 的 network.httpServers 启用 127.0.0.1:3000，并把 QQ 号写进 deps\napcat-old\qq-account.txt（之后快速登录）'
