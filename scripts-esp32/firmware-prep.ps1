# 激活 ESP-IDF 并在固件目录执行一次 reconfigure（拉取 managed_components）
param(
    [string]$Action = 'reconfigure'
)
$ErrorActionPreference = 'Stop'
$idfExport = 'D:\AI_Code\小智机器人\tools\esp-idf\export.ps1'
$proj = 'D:\AI_Code\小智机器人\xiaozhi-esp32-2.5.2'

if (-not (Test-Path $idfExport)) { Write-Error "ESP-IDF export.ps1 not found: $idfExport"; exit 2 }
. $idfExport
# CMake 4.0.3 在本机遇到中文路径会直接 fail-fast 崩溃（0xC0000409）；
# 改用 3.31.6（已实测可处理中文路径），必须放在 IDF 自带 cmake 之前。
$cmake331 = 'D:\Espressif\extra\cmake331\cmake\data\bin'
if (Test-Path "$cmake331\cmake.exe") { $env:PATH = "$cmake331;$env:PATH" }
Set-Location $proj

Write-Host "IDF_PATH=$env:IDF_PATH"
Write-Host "python=$([System.Diagnostics.Process]::GetCurrentProcess().Path)"
Write-Host "cmake=$((Get-Command cmake -ErrorAction SilentlyContinue).Source)"
Write-Host "PATH[:300]=$($env:PATH.Substring(0, [Math]::Min(300, $env:PATH.Length)))"

switch ($Action) {
    'reconfigure' {
        idf.py -DIDF_TARGET=esp32s3 -DBOARD_NAME=bread-compact-wifi-lcd reconfigure
    }
    default { Write-Error "unknown action: $Action"; exit 2 }
}
exit $LASTEXITCODE
