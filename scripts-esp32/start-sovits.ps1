#requires -Version 7.0
<#
.SYNOPSIS
    启动（或确认已在运行的）GPT-SoVITS api_v2 服务（默认 127.0.0.1:9880）。

.DESCRIPTION
    dsh-feiyu 的语音链路依赖 GPT-SoVITS：
      - 安装目录默认 D:\GPT-SoVITS
      - Python 默认 <Root>\.venv\Scripts\python.exe（也兼容 runtime\python.exe）
      - 入口默认 <Root>\api_v2.py
      - 参考音默认 <Root>\models\<音色>\<音色>.wav + 同名 .txt

    本脚本幂等：若 9880 已在监听且能响应 HTTP，直接报告并返回 0。
    若本机根本没有安装 GPT-SoVITS，会以 BLOCKED-USER 退出（退出码 2）
    并打印安装/通过标准。

.PARAMETER Root
    GPT-SoVITS 根目录，默认 D:\GPT-SoVITS。

.PARAMETER Python
    指定 Python 解释器；不传则依次探测 <Root>\.venv\Scripts\python.exe、
    <Root>\runtime\python.exe、<Root>\python.exe、PATH 中的 python。

.PARAMETER BindHost
    监听地址，默认 127.0.0.1。

.PARAMETER Port
    监听端口，默认 9880。

.PARAMETER TimeoutSec
    等待端口/HTTP 就绪的秒数，默认 120。

.PARAMETER ShowWindow
    显示 api_v2.py 的控制台窗口（默认隐藏，日志写入 %TEMP%）。

.EXAMPLE
    pwsh -File .\start-sovits.ps1

.EXAMPLE
    pwsh -File .\start-sovits.ps1 -Root 'E:\GPT-SoVITS' -TimeoutSec 180
#>
[CmdletBinding()]
param(
    [string]$Root = 'D:\GPT-SoVITS',
    [string]$Python = '',
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 9880,
    [int]$TimeoutSec = 120,
    [switch]$ShowWindow
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host "[SoVITS] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[SoVITS] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[SoVITS] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[SoVITS] $Message" -ForegroundColor Red }

function Get-PortListener {
    param([int]$PortNumber)
    Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Test-SovitsHttp {
    param([string]$HostName, [int]$PortNumber)
    $url = "http://${HostName}:$PortNumber/docs"
    try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 4 -UseBasicParsing
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        # 4xx/5xx 也说明 HTTP 服务已经起来了；连接被拒绝才是真的没起。
        if ($null -ne $_.Exception.Response) { return $true }
        return $false
    }
}

function Show-ProcessOwner {
    param([int]$ProcessId)
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
        return "$($p.ProcessName) (PID=$ProcessId)"
    }
    catch { return "PID=$ProcessId" }
}

# 1) 幂等检查：端口已在监听
$listener = Get-PortListener -PortNumber $Port
if ($null -ne $listener) {
    if (Test-SovitsHttp -HostName $BindHost -PortNumber $Port) {
        Write-Ok "GPT-SoVITS 已在运行：http://${BindHost}:$Port（监听进程 $(Show-ProcessOwner -ProcessId $listener.OwningProcess)）。"
        exit 0
    }
    Write-Fail "端口 $Port 已被占用，但 HTTP 无响应：$(Show-ProcessOwner -ProcessId $listener.OwningProcess)。"
    Write-Fail "这不是可用的 GPT-SoVITS 服务；请先释放端口，或改用 -Port 指定其他端口。"
    exit 1
}

# 2) 目录 / 入口检查
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Fail "未找到 GPT-SoVITS 安装目录：$Root"
    Write-Host ''
    Write-Host '[BLOCKED-USER] 本机没有安装 GPT-SoVITS，dsh-feiyu 的语音链路无法拉起。' -ForegroundColor Yellow
    Write-Host '  需要人工完成：'
    Write-Host '    1) 安装 GPT-SoVITS（含 api_v2.py 与 Python 运行环境）到 D:\GPT-SoVITS，'
    Write-Host '       或把本脚本 -Root 指向已有安装目录。'
    Write-Host '    2) 准备参考音：D:\GPT-SoVITS\models\<音色>\<音色>.wav 与同名 .txt（文本须与音频一致）。'
    Write-Host '    3) 重新运行：pwsh -File .\start-sovits.ps1'
    Write-Host '  通过标准：http://127.0.0.1:9880/docs 返回 HTTP 200，且 /tts 能返回 WAV。'
    exit 2
}

$apiScript = Join-Path $Root 'api_v2.py'
if (-not (Test-Path -LiteralPath $apiScript)) {
    Write-Fail "目录存在，但没有找到入口脚本：$apiScript"
    Write-Host '[BLOCKED-USER] 请确认这是 GPT-SoVITS 的完整安装目录（api_v2.py 位于根目录）。' -ForegroundColor Yellow
    exit 2
}

# 3) Python 探测
$pythonPath = $null
$candidates = @()
if ($Python) { $candidates += $Python }
$candidates += (Join-Path $Root '.venv\Scripts\python.exe')
$candidates += (Join-Path $Root 'runtime\python.exe')
$candidates += (Join-Path $Root 'python.exe')
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $pythonPath = $candidate; break }
}
if (-not $pythonPath) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($null -ne $pythonCommand) { $pythonPath = $pythonCommand.Source }
}
if (-not $pythonPath) {
    Write-Fail "没有找到可用的 Python 解释器。"
    Write-Fail "请先创建 GPT-SoVITS 的虚拟环境（<Root>\.venv），或通过 -Python 指定解释器路径。"
    exit 2
}

# 4) 已有 api_v2.py 进程但端口没通：提示可能仍在加载
$existing = Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'api_v2\.py' } |
    Select-Object -First 1
if ($null -ne $existing) {
    Write-Warn "发现 api_v2.py 进程 PID=$($existing.ProcessId)，但端口 $Port 尚未监听；可能仍在加载模型。"
}

# 5) 启动
$logBase = Join-Path $env:TEMP "gpt-sovits-$Port"
$stdoutLog = "$logBase.out.log"
$stderrLog = "$logBase.err.log"
$argumentList = @($apiScript, '-a', $BindHost, '-p', "$Port")

Write-Info "启动 GPT-SoVITS：$pythonPath $($argumentList -join ' ')"
Write-Info "工作目录：$Root"

if ($ShowWindow) {
    $process = Start-Process -FilePath $pythonPath -ArgumentList $argumentList -WorkingDirectory $Root -PassThru
}
else {
    $process = Start-Process -FilePath $pythonPath -ArgumentList $argumentList -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
}
Write-Info "进程已拉起：PID=$($process.Id)；日志：$stdoutLog / $stderrLog"

# 6) 等待端口 + HTTP
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
        Write-Fail "api_v2.py 已退出，退出码 $($process.ExitCode)。"
        foreach ($logFile in @($stdoutLog, $stderrLog)) {
            if (Test-Path -LiteralPath $logFile) {
                Write-Host "--- $logFile (最后 30 行) ---" -ForegroundColor DarkGray
                Get-Content -LiteralPath $logFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            }
        }
        exit 1
    }
    if ($null -ne (Get-PortListener -PortNumber $Port)) {
        if (Test-SovitsHttp -HostName $BindHost -PortNumber $Port) {
            Write-Ok "GPT-SoVITS 已就绪：http://${BindHost}:$Port（PID=$($process.Id)）。"
            Write-Info "下一步可运行 probe.ps1 做真实 /tts 合成测试。"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 1000
}

Write-Fail "等待超时（${TimeoutSec}s）：端口 $Port 未就绪或 HTTP 未响应。"
Write-Fail "进程可能仍在加载模型；可查看日志：$stdoutLog / $stderrLog"
Write-Fail "也可在前台手动运行以看完整报错："
Write-Fail "  & '$pythonPath' '$apiScript' -a $BindHost -p $Port"
exit 1
