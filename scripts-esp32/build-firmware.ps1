# 构建 bread-compact-wifi-lcd 固件（feiyu ESP32 通道设置）
# 必须用原生 PowerShell（MSYS/Git Bash 无法激活 ESP-IDF），固件克隆与 ESP-IDF 都放在纯 ASCII 路径。
# 本地定制（屏型 / OTA / 唤醒词）全部由 build-firmware.py 注入，固件克隆保持干净。
#
# 示例：
#   pwsh -File build-firmware.ps1 -IdfPath C:\esp\esp-idf -Firmware C:\esp32\xiaozhi-esp32 -OtaUrl http://192.168.1.10:8765/xiaozhi/ota/
#
# 参数也可用环境变量代替：FEIYU_IDF_PATH / FEIYU_FIRMWARE_DIR / FEIYU_OTA_URL / FEIYU_CMAKE_DIR
param(
    [string]$IdfPath = $env:FEIYU_IDF_PATH,       # ESP-IDF 根目录（内含 export.ps1），v6.0.1
    [string]$Firmware = $env:FEIYU_FIRMWARE_DIR,  # xiaozhi-esp32 克隆目录（commit c435f99）
    [string]$OtaUrl = $env:FEIYU_OTA_URL,         # http://<本机局域网 IP>:8765/xiaozhi/ota/
    [string]$CmakeDir = $env:FEIYU_CMAKE_DIR,     # 可选：CMake 3.31.x 的 bin 目录（CMake 4.0.3 在部分机器上会崩溃）
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

foreach ($pair in @(@('IdfPath', $IdfPath), @('Firmware', $Firmware), @('OtaUrl', $OtaUrl))) {
    if (-not $pair[1]) { Write-Error "缺少参数 -$($pair[0])（或对应的 FEIYU_* 环境变量），见脚本头部说明"; exit 2 }
}
$idfExport = Join-Path $IdfPath 'export.ps1'
if (-not (Test-Path $idfExport)) { Write-Error "ESP-IDF export.ps1 not found: $idfExport"; exit 2 }
if (-not (Test-Path $Firmware)) { Write-Error "firmware dir not found: $Firmware"; exit 2 }

$wrapper = Join-Path $PSScriptRoot 'build-firmware.py'
$log     = Join-Path $PSScriptRoot 'build-firmware.log'

. $idfExport
# IDF_PATH 必须是 ASCII：CMake 遇到中文路径可能 fail-fast（0xC0000409）
$env:IDF_PATH = $IdfPath
if ($CmakeDir -and (Test-Path "$CmakeDir\cmake.exe")) { $env:PATH = "$CmakeDir;$env:PATH" }

Write-Host "IDF_PATH=$env:IDF_PATH"
Write-Host "cmake=$((Get-Command cmake -ErrorAction SilentlyContinue).Source)"

$argv = @($wrapper, '--firmware', $Firmware, '--ota-url', $OtaUrl)
if ($DryRun) { $argv += '--dry-run' }

Push-Location $Firmware
try {
    & python @argv 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
Write-Host "BUILD_EXIT=$code"
exit $code
