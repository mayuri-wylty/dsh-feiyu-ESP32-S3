#requires -Version 7.0
<#
.SYNOPSIS
    启动（或确认已在运行的）DSH 桌面版，并等待其 Web 宿主就绪。

.DESCRIPTION
    桌面版主进程是 "DeepSeek Harness.exe"；它会在内部拉起
    dsh-desktop-host/lib/index.js，该宿主监听 127.0.0.1 上的动态端口
    （命令行固定为 --port 0，不是 3080）。本脚本只负责拉起并报告端口，
    不会读取、打印或保存任何访问 token。

    幂等：若 Web 宿主已在运行，直接报告 PID / 端口并返回 0。

.PARAMETER InstallDir
    DSH 桌面版安装目录，默认 D:\DSH桌面版。

.PARAMETER TimeoutSec
    等待 Web 宿主监听端口的秒数，默认 90。

.PARAMETER NoWait
    只负责拉起进程，不等待 Web 宿主就绪。

.EXAMPLE
    pwsh -File .\start-dsh.ps1

.EXAMPLE
    pwsh -File .\start-dsh.ps1 -InstallDir 'D:\DSH桌面版' -TimeoutSec 120
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\DSH桌面版',
    [int]$TimeoutSec = 90,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host "[DSH] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[DSH] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[DSH] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[DSH] $Message" -ForegroundColor Red }

$exe = Join-Path $InstallDir 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Fail "未找到 DSH 桌面版：$exe"
    Write-Fail "请确认安装目录，或通过 -InstallDir 指定（例如 -InstallDir 'D:\DSH桌面版'）。"
    exit 1
}

function Get-DshHostProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match 'dsh-desktop-host' -and
            $_.CommandLine -match 'lib[\\/]index\.js'
        } |
        Select-Object -First 1
}

function Get-DshMainProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -notmatch '--type=' -and
            $_.CommandLine -notmatch 'dsh-desktop-host'
        } |
        Select-Object -First 1
}

function Get-DshWebPort {
    param([int]$HostProcessId)
    $conn = Get-NetTCPConnection -State Listen -OwningProcess $HostProcessId -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
        Select-Object -First 1
    if ($null -ne $conn) { return [int]$conn.LocalPort }
    return $null
}

# 1) 幂等检查：宿主已运行且已监听端口
$hostProcess = Get-DshHostProcess
if ($null -ne $hostProcess) {
    $port = Get-DshWebPort -HostProcessId $hostProcess.ProcessId
    if ($null -ne $port) {
        Write-Ok "DSH 已在运行：Web 宿主 PID=$($hostProcess.ProcessId)，端口=$port（127.0.0.1）。"
        Write-Info "未输出访问 token；外部脚本访问 API 仍会被 401 拦截。"
        exit 0
    }
    Write-Warn "检测到 Web 宿主 PID=$($hostProcess.ProcessId)，但尚未监听端口，继续等待。"
}
else {
    $mainProcess = Get-DshMainProcess
    if ($null -ne $mainProcess) {
        Write-Warn "检测到 DSH 主进程 PID=$($mainProcess.ProcessId)，但 Web 宿主尚未就绪，继续等待。"
    }
    else {
        Write-Info "启动 DSH 桌面版：$exe"
        Start-Process -FilePath $exe | Out-Null
    }
}

if ($NoWait) {
    Write-Warn "已按 -NoWait 跳过等待；稍后可重新运行本脚本确认端口。"
    exit 0
}

# 2) 等待宿主进程 + 动态端口
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $hostProcess = Get-DshHostProcess
    if ($null -ne $hostProcess) {
        $port = Get-DshWebPort -HostProcessId $hostProcess.ProcessId
        if ($null -ne $port) {
            Write-Ok "DSH 已就绪：Web 宿主 PID=$($hostProcess.ProcessId)，端口=$port（127.0.0.1）。"
            Write-Info "提示：桌面版使用动态端口（--port 0），3080 只是 dsh web CLI 的默认端口。"
            Write-Info "未输出访问 token；需要鉴权的 API 请由桌面版窗口内使用。"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 800
}

Write-Fail "等待超时（${TimeoutSec}s）：没有发现 DSH Web 宿主监听 127.0.0.1。"
Write-Fail "请查看桌面版窗口是否报错，或稍后重试：pwsh -File .\start-dsh.ps1 -TimeoutSec 180"
exit 1
