# 把构建好的固件烧录到面包板（ESP32-S3）
# 用法：
#   pwsh -File flash-firmware.ps1 -Ports                          # 只列串口
#   pwsh -File flash-firmware.ps1 -Port COM3 -Firmware C:\esp32\xiaozhi-esp32
#
# 注意：不要烧 build/merged-binary.bin —— 它从 0x0 连续写入，会把 0x9000 的
# NVS（Wi-Fi 凭据）一并覆盖。这里按 build/flash_args 的分区偏移逐镜像写入，
# 与 idf.py flash 等价，不会动 NVS。
# 需先激活 ESP-IDF（. <IDF>\export.ps1），使 python 指向带 esptool 的 IDF 环境。
# 波特率默认 230400：460800 实测会中途掉 USB。
param(
    [string]$Port = $env:FEIYU_FLASH_PORT,
    [string]$Firmware = $env:FEIYU_FIRMWARE_DIR,
    [int]$Baud = 230400,
    [switch]$Ports
)
$ErrorActionPreference = 'Stop'

Write-Host '=== 串口列表 ==='
Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Description | Format-Table -AutoSize
if ($Ports) { exit 0 }

if (-not $Port) { Write-Error '缺少 -Port（例如 COM3，或设置 FEIYU_FLASH_PORT）'; exit 2 }
if (-not $Firmware) { Write-Error '缺少 -Firmware（或设置 FEIYU_FIRMWARE_DIR）'; exit 2 }
$build = Join-Path $Firmware 'build'
$flashArgs = Join-Path $build 'flash_args'
if (-not (Test-Path $flashArgs)) { Write-Error "flash_args 不存在: $flashArgs（先构建）"; exit 2 }
Write-Host "烧录（按 flash_args 分区偏移）-> $Port @ $Baud"

Push-Location $build
try {
    & python -m esptool --chip esp32s3 -p $Port -b $Baud --before default-reset --after hard-reset write-flash "@flash_args"
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
Write-Host "FLASH_EXIT=$code"
exit $code
