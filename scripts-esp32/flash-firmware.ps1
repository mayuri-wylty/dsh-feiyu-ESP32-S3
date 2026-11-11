# 把构建好的固件烧录到面包板（ESP32-S3, COM3）
# 用法：
#   pwsh -File flash-firmware.ps1              # 烧录（保留 NVS/Wi-Fi 配置）
#   pwsh -File flash-firmware.ps1 -Ports       # 只列串口
#
# 注意：不要烧 build/merged-binary.bin —— 它从 0x0 连续写入，会把 0x9000 的
# NVS（Wi-Fi 凭据）一并覆盖。这里按 build/flash_args 的分区偏移逐镜像写入，
# 与 idf.py flash 等价，不会动 NVS。
param(
    [string]$Port = 'COM3',
    [int]$Baud = 460800,
    [switch]$Ports
)
$ErrorActionPreference = 'Stop'

$python  = 'D:\Espressif\python_env\idf6.0_py3.12_env\Scripts\python.exe'
$build   = 'D:\esp32\xiaozhi-esp32\build'
$flashArgs = Join-Path $build 'flash_args'

Write-Host '=== 串口列表 ==='
Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Description | Format-Table -AutoSize
if ($Ports) { exit 0 }

if (-not (Test-Path $flashArgs)) { Write-Error "flash_args 不存在: $flashArgs"; exit 2 }
Write-Host "烧录（按 flash_args 分区偏移）-> $Port @ $Baud"

Push-Location $build
try {
    & $python -m esptool --chip esp32s3 -p $Port -b $Baud --before default-reset --after hard-reset write-flash "@flash_args"
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
Write-Host "FLASH_EXIT=$code"
exit $code
