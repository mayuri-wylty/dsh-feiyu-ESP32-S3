# firmware

`xiaozhi-esp32/` 是上游 https://github.com/78/xiaozhi-esp32 的原样快照（MIT 许可，见其 `LICENSE`）。

| 项 | 值 |
| --- | --- |
| 上游 commit | `c435f99`（`v2.5.2-121-gc435f99`） |
| 导出方式 | `git archive c435f99`，未做任何修改 |

屏型、OTA 地址、唤醒词不改源码，由 `scripts-esp32/build-firmware.py` 在构建时注入。

**不要在本目录里直接构建**：本仓库路径若含中文或其他非 ASCII 字符，CMake 可能崩溃（0xC0000409）。把本目录复制到纯 ASCII 路径（如 `C:\esp32\xiaozhi-esp32`）再构建，构建产物（`build/`、`managed_components/`、`sdkconfig`）会写在那份副本里。构建与烧录步骤见 `docs/HARDWARE.md`。

升级固件时，用新的上游 commit 重新导出覆盖本目录，并同步更新上表与 `docs/REPRODUCE.md`。
