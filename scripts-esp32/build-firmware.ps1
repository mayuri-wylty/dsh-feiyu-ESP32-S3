# 构建 bread-compact-wifi-lcd 固件（feiyu ESP32 通道设置）
# 在纯 ASCII 克隆 D:\esp32\xiaozhi-esp32 内构建；本地定制全部由 build-firmware.py 注入。
param(
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$idfExport = 'D:\AI_Code\小智机器人\tools\esp-idf\export.ps1'
$cmake331  = 'D:\Espressif\extra\cmake331\cmake\data\bin'
$python    = 'D:\Espressif\python_env\idf6.0_py3.12_env\Scripts\python.exe'
$wrapper   = 'D:\AI_Code\小智机器人\dsh-feiyu\scripts-esp32\build-firmware.py'
$log       = 'D:\AI_Code\小智机器人\dsh-feiyu\scripts-esp32\build-firmware.log'

if (-not (Test-Path $idfExport)) { Write-Error "ESP-IDF export.ps1 not found: $idfExport"; exit 2 }
. $idfExport

# IDF_PATH 必须是 ASCII：CMake 在本机遇到中文路径会 fail-fast（0xC0000409）
$env:IDF_PATH = 'D:\esp\idf'
# CMake 4.0.3 同样会崩；3.31.6 前置优先
if (Test-Path "$cmake331\cmake.exe") { $env:PATH = "$cmake331;$env:PATH" }

Write-Host "IDF_PATH=$env:IDF_PATH"
Write-Host "cmake=$((Get-Command cmake -ErrorAction SilentlyContinue).Source)"

$argv = @($wrapper)
if ($DryRun) { $argv += '--dry-run' }

Push-Location 'D:\esp32\xiaozhi-esp32'
try {
    & $python @argv 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
Write-Host "BUILD_EXIT=$code"
exit $code
