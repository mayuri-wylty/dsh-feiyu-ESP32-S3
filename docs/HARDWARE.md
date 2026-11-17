# 硬件说明（小智 ESP32-S3 面包板）

本文给出复现所需的硬件清单、接线、屏型注意事项与烧录要点。软件环境见 `docs/REPRODUCE.md`，日常使用见 `docs/esp32-channel-manual.md`。

## 1. 目标板卡

| 项 | 值 |
| --- | --- |
| 固件板卡标识 | `bread-compact-wifi-lcd`（menuconfig 中显示为 `Bread Compact Wi-Fi + LCD (面包板)`） |
| 固件源码 | https://github.com/78/xiaozhi-esp32 ，commit `c435f99`（`v2.5.2-121-gc435f99`） |
| 板卡目录 | 固件源码内 `main/boards/bread-compact-wifi-lcd/` |
| 主控 | ESP32-S3，16 MB Flash（qio），8 MB Octal PSRAM（80 MHz） |
| 音频 | 无独立 Codec，I2S 单工（Simplex）：麦克风与功放各用一组引脚直连 |
| 采样率 | 麦克风 16 kHz，扬声器 24 kHz |
| 显示屏 | ST7735 彩色 LCD，128×160，SPI3，40 MHz |
| 唤醒词 | 自定义 MultiNet「da fei yu」（大肥鱼），阈值 20 |

## 2. 物料清单

| 部件 | 要求 | 备注 |
| --- | --- | --- |
| ESP32-S3 开发板 | 16 MB Flash、8 MB Octal PSRAM（如 N16R8 规格） | 需引出 GPIO 0/4/5/6/7/15/16/18/21/40/41/42/45/47/48 |
| 数字麦克风 | I2S 接口 MEMS 麦克风（标准 I2S，INMP441 一类） | 固件按标准 I2S 驱动，WS/SCK/DIN 三线 |
| 功放 | I2S 输入的 D 类功放（MAX98357A 一类） | DOUT/BCLK/LRCK 三线 |
| 扬声器 | 与功放匹配的喇叭（常用 4–8 Ω） | |
| LCD | 1.8 寸 ST7735 128×160 SPI 彩屏 | 须是 128×160 的 ST7735，见第 4 节 |
| 面包板与杜邦线 | — | |
| USB 数据线 | 能传数据的 Type-C 线 | 烧录和串口日志用 |

> 器件型号取自固件对 I2S 的通用驱动方式，未逐型号验证；若你的模块输出电平、引脚排列不同，请以实测为准。

## 3. 接线

以固件 `config.h` 为准（ST7735 128×160 变体，已与源码逐项核对）。

**音频 I2S（单工）**

| 功能 | 信号 | GPIO |
| --- | --- | --- |
| 麦克风 | WS / LRCK | GPIO4 |
| 麦克风 | SCK / BCLK | GPIO5 |
| 麦克风 | DIN | GPIO6 |
| 扬声器（功放） | DOUT | GPIO7 |
| 扬声器（功放） | BCLK | GPIO15 |
| 扬声器（功放） | LRCK | GPIO16 |

**LCD（ST7735，SPI3，40 MHz）**

| 信号 | GPIO |
| --- | --- |
| MOSI（SDA） | GPIO47 |
| CLK（SCL） | GPIO21 |
| CS | GPIO41 |
| DC | GPIO40 |
| RST | GPIO45 |
| BL（背光） | GPIO42 |

**按键与指示灯**

| 功能 | GPIO |
| --- | --- |
| BOOT 键（对话触发 / 打断） | GPIO0 |
| 板载 LED | GPIO48 |
| TOUCH / VOLUME_UP / VOLUME_DOWN | 未接 |
| LAMP（MCP 演示灯控，可不接） | GPIO18 |

所有器件需共地，麦克风、功放、屏幕按各自模块要求供电（3.3 V 或 5 V）。

## 4. 屏型注意事项

板卡预设默认是 ST7789 240×320。本硬件是 ST7735 128×160，按预设编译会**花屏**。

- 用 `scripts-esp32/build-firmware.py`（或 `build-firmware.ps1`）构建，它会把屏型替换为 `CONFIG_LCD_ST7735_128X160=y`。
- 不要手动 `idf.py build` 后烧录。手动 `idf.py menuconfig` 时，必须在 `LCD Type` 里选 `ST7735 128×160`。
- 如果你的屏幕不是 ST7735 128×160，需要改 `build-firmware.py` 里的 `LCD_TYPE_OPTION`，并对照 `config.h` 里对应型号的宽高、镜像、偏移参数。

## 5. 构建与烧录

固件克隆和 ESP-IDF 都放在纯 ASCII 路径下，并在原生 PowerShell 中操作（Git Bash/MSYS 无法激活 ESP-IDF）。

```powershell
# 构建：ESP-IDF 路径、固件克隆路径、你电脑的局域网 IP 都按自己的填
. C:\esp\esp-idf\export.ps1
pwsh -File scripts-esp32\build-firmware.ps1 `
  -IdfPath C:\esp\esp-idf -Firmware C:\esp32\xiaozhi-esp32 `
  -OtaUrl http://192.168.1.10:8765/xiaozhi/ota/

# 先列串口，再烧录
pwsh -File scripts-esp32\flash-firmware.ps1 -Ports
pwsh -File scripts-esp32\flash-firmware.ps1 -Port COM3 -Firmware C:\esp32\xiaozhi-esp32
```

要点：

- `-OtaUrl` 里的 IP 是**运行 DSH 的电脑**的局域网 IP，端口 8765。换网络或换电脑后，必须重新构建并烧录。
- 烧录脚本按 `build/flash_args` 的分区偏移逐个写入，保留 `0x9000` 的 NVS（Wi-Fi 配置）。不要烧 `merged-binary.bin`，它会覆盖 NVS。
- 波特率默认 230400；460800 实测会中途掉 USB。
- 路径参数也可以用环境变量代替：`FEIYU_IDF_PATH`、`FEIYU_FIRMWARE_DIR`、`FEIYU_OTA_URL`、`FEIYU_FLASH_PORT`。
- 在部分机器上 CMake 4.0.x 遇到中文路径或特定路径会崩溃（0xC0000409）。遇到时安装 CMake 3.31.x，用 `-CmakeDir <其 bin 目录>` 传给构建脚本。

## 6. 首次联网

1. 烧录完成后设备重启，按固件提示用手机连设备热点配置 Wi-Fi。
2. 设备启动时访问固件里写死的 OTA 地址，从 DSH 网关拿到 WebSocket 地址和令牌。
3. 在 DSH 的「大肥鱼」面板的 ESP32 卡里，应能看到设备在线。点卡头「自检」可确认网关、OTA、握手和令牌。
4. 对着设备说「大肥鱼」，或按 BOOT 键开始对话。

本板没有回声消除，播放期间不上行音频，所以不支持开口打断，只能用 BOOT 键或唤醒词打断。
