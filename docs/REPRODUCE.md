# 环境复现指南（REPRODUCE）

本仓库只含 dsh-feiyu 插件代码。DSH 桌面版、GPT-SoVITS、ESP-IDF、小智固件、模型文件**都不在仓库里**，需按下面的版本与来源自行获取。
版本取自 `scripts-esp32/env.md`（2026-11-10 实测快照）与本机 `git rev-parse`（2026-11-12）。

## 1. 版本总表

| 组件 | 版本 / commit | 来源 | 是否入库 |
| --- | --- | --- | --- |
| 操作系统 | Windows 11（10.0.26200）；Windows 10 也可 | — | — |
| PowerShell | 7.x（实测 7.6.9）；固件构建必须用原生 PowerShell | — | — |
| Node（跑测试/开发） | 24.x（实测 v24.14.1），见 `.nvmrc` | nodejs.org | 版本号入库 |
| DSH 桌面版 | 0.2.2-rc.1（Electron 44.7.0，内置 Node v24.21.0） | 闭源，另行获取 | 否 |
| dsh-feiyu 插件 | 0.4.0，分支 `feat/esp32-channel` | 本仓库 | 是 |
| GPT-SoVITS | commit `59c4468`；venv Python 3.10.11 + torch 2.7.1+cu128（CUDA 可用） | https://github.com/RVC-Boss/GPT-SoVITS | 否（21 GB） |
| ESP-IDF | v6.0.1（`8c19b156`），工具目录 `D:\Espressif` | https://github.com/espressif/esp-idf | 否 |
| 小智固件 | v2.5.2 之后 121 个提交，commit `c435f99`（`v2.5.2-121-gc435f99`） | https://github.com/78/xiaozhi-esp32 | 是（`firmware/xiaozhi-esp32/` 原样快照） |
| 开发板 | bread-compact-wifi-lcd，ST7735 128x160 屏 | 物料与接线见 `docs/HARDWARE.md` | 是 |
| 抖音/微信脚本 Python | 3.12.x，依赖见 `scripts/requirements/*.txt` | — | 是（锁定文件） |

> `DEPLOY.md` 里写的 GPT-SoVITS `b4570b8` 是更早的记录，当前实际运行的是 `59c4468`。

## 2. 安装顺序

1. **Node 24**：安装后在仓库根目录 `npm ci`（`node_modules/` 不入库，`package-lock.json` 已锁定）。
2. **验证代码**：`npm test`（无硬件）；`npm run test:e2e`（进程内网关 + 模拟固件）。到这一步不需要 DSH、GPU 或开发板。
3. **DSH 桌面版**：安装 0.2.2-rc.1。把插件以 `link:<本仓库路径>` 装入 desktop profile，启用 `voice-input` bundle（会缓存 SenseVoice 模型到 `~/.dsh/speech-to-text`）。改了 `lib/`、`client.js` 后需重启桌面版，可用 `scripts-esp32/start-dsh.ps1`。
4. **GPT-SoVITS**：
   ```powershell
   git clone https://github.com/RVC-Boss/GPT-SoVITS.git
   cd GPT-SoVITS; git checkout 59c4468
   ```
   按其官方说明建 venv（Python 3.10）并装 torch 2.7.1+cu128 与 `requirements.txt`，下载预训练模型。参考音放 `models\feiyu\feiyu.wav` 与同名 `feiyu.txt`。用 `scripts-esp32/start-sovits.ps1` 启动，监听 `127.0.0.1:9880`。
5. **环境自检**：`scripts-esp32/probe.ps1`（退出码 0 全过 / 1 有失败 / 2 需人工）。
6. **固件（仅需要烧录时）**：
   ```powershell
   git clone https://github.com/espressif/esp-idf.git; cd esp-idf; git checkout v6.0.1; .\install.ps1
   Copy-Item -Recurse firmware\xiaozhi-esp32 C:\esp32\xiaozhi-esp32   # 仓库已收录固件源码，复制到纯 ASCII 路径再构建
   ```
   然后在原生 PowerShell 中构建与烧录（路径必须纯 ASCII，详见 `docs/HARDWARE.md` 第 5 节）：
   ```powershell
   pwsh -File scripts-esp32\build-firmware.ps1 -IdfPath C:\esp\esp-idf -Firmware C:\esp32\xiaozhi-esp32 -OtaUrl http://<你电脑的局域网 IP>:8765/xiaozhi/ota/
   pwsh -File scripts-esp32\flash-firmware.ps1 -Port COM3 -Firmware C:\esp32\xiaozhi-esp32
   ```
   固件克隆本身不改动，屏型、OTA 地址、唤醒词都由构建脚本注入。烧录用 230400 波特率，按分区写，保留 `0x9000` NVS。

## 3. 复现者必须自己改的地方

- 构建脚本的 `-OtaUrl` 必填，填你自己 PC 的局域网 IP；换网络后需重新构建并烧录。
- `scripts-esp32/` 下的脚本不再内置任何本机路径，路径都通过参数或环境变量传入：`FEIYU_IDF_PATH`、`FEIYU_FIRMWARE_DIR`、`FEIYU_OTA_URL`、`FEIYU_FLASH_PORT`、`FEIYU_DSH_DIR`、`FEIYU_SOVITS_ROOT`。
- 配置在 `~/.dsh/feiyu.config.json`，可从仓库根的 `feiyu.config.example.json` 复制起步；数据在 `~/.feiyu-ai/`，均不入库。API Key、Wi-Fi 信息、ESP32 token 自行填写（token 留空会在首次启动时自动生成）。
- ESP32 网关默认端口 8765，Bearer token 必填。

## 4. 已知缺口

- GPT-SoVITS 的 Python 依赖没有 `pip freeze` 锁定文件，只能锁 commit 与 torch 版本。
- 模型权重和参考音不在仓库，也没有公开下载地址。
- DSH 桌面版为闭源，没有公开安装包地址。
- 小智固件的唤醒词 MultiNet 配置由 `build-firmware.py` 注入，依赖上面指定的 commit。
