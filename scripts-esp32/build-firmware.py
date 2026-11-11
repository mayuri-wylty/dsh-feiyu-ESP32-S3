#!/usr/bin/env python3
"""Build the bread-compact-wifi-lcd firmware with the feiyu ESP32 channel settings.

Runs upstream ``scripts/build.py`` from a pure-ASCII clone of the firmware tree
(``D:\\esp32\\xiaozhi-esp32``) because CMake on this host crashes with
0xC0000409 when any path argument contains non-ASCII characters.

All local customisation stays in this wrapper so the firmware clone remains
pristine (``git status`` clean):

* Panel type -> the physical panel on this board is an ST7735 128x160, not the
  board preset's default ST7789 240x320 (wrong type = garbled screen).
* OTA URL -> this PC's LAN address, served by the DSH host gateway.
* Custom wake word -> ESP-SR MultiNet ("da fei yu" / 大肥鱼), which upstream
  ``--wake-word`` cannot express (it only knows WakeNet model names).

Usage (after activating ESP-IDF; optional ``--dry-run`` skips the build):
    python build-firmware.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

FIRMWARE = Path(r"D:\esp32\xiaozhi-esp32")
BOARD = "bread-compact-wifi-lcd"
VARIANT = "bread-compact-wifi-lcd"
LANGUAGE = "zh-CN"

# Served by the DSH desktop host gateway on this PC (0.0.0.0:8765).
OTA_URL = "http://192.168.10.39:8765/xiaozhi/ota/"

WAKE_WORD_PINYIN = "da fei yu"
WAKE_WORD_DISPLAY = "大肥鱼"
WAKE_WORD_THRESHOLD = 20

# The physical panel is an ST7735 128x160 (upstream option), while the board
# preset pins CONFIG_LCD_ST7789_240X320=y. Driving it as 240x320 garbles the
# display, so the preset's choice is replaced below.
LCD_TYPE_OPTION = "CONFIG_LCD_ST7735_128X160=y"
_REPLACED_LCD_OPTIONS = {
    "CONFIG_LCD_ST7789_240X320",
    "CONFIG_LCD_ST7735_128X160",
}

# Inputs that should map to the custom MultiNet wake word.
_CUSTOM_ALIASES = {
    "da fei yu",
    "dafeiyu",
    "da_fei_yu",
    "大肥鱼",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="resolve and print sdkconfig only; do not invoke idf.py",
    )
    parser.add_argument(
        "--ota-url",
        default=OTA_URL,
        help="override the OTA URL baked into the firmware",
    )
    args = parser.parse_args(argv)

    if not FIRMWARE.is_dir():
        print(f"[ERROR] firmware tree not found: {FIRMWARE}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(FIRMWARE / "scripts"))
    import build as b  # noqa: E402  (upstream scripts/build.py)

    ota_assignment = f'CONFIG_OTA_URL="{args.ota_url}"'

    orig_merge = b._merge_sdkconfig_options

    def merge_with_ota(base_options, override_options):
        merged = orig_merge(base_options, override_options)
        merged = [
            o for o in merged if o.split("=", 1)[0] not in _REPLACED_LCD_OPTIONS
        ]
        merged.append(LCD_TYPE_OPTION)
        if not any(o.startswith("CONFIG_OTA_URL=") for o in merged):
            merged.append(ota_assignment)
        return merged

    orig_wake = b._wake_word_sdkconfig_options

    def wake_with_custom(wake_word, target):
        if wake_word.strip().casefold() in _CUSTOM_ALIASES:
            return (
                "custom_da_fei_yu",
                [
                    "CONFIG_WAKE_WORD_DISABLED=n",
                    "CONFIG_USE_ESP_WAKE_WORD=n",
                    "CONFIG_USE_AFE_WAKE_WORD=n",
                    "CONFIG_USE_CUSTOM_WAKE_WORD=y",
                    f'CONFIG_CUSTOM_WAKE_WORD="{WAKE_WORD_PINYIN}"',
                    f'CONFIG_CUSTOM_WAKE_WORD_DISPLAY="{WAKE_WORD_DISPLAY}"',
                    f"CONFIG_CUSTOM_WAKE_WORD_THRESHOLD={WAKE_WORD_THRESHOLD}",
                    # MultiNet model is required by scripts/build_default_assets.py:
                    # with USE_CUSTOM_WAKE_WORD=y and no SR_MN_* model selected it
                    # aborts the build. esp-sr's Kconfig has no default y.
                    "CONFIG_SR_MN_CN_MULTINET7_QUANT=y",
                ],
                # _validate_configured_symbols only accepts plain `=y` lines,
                # so string/int options must not be listed here.
                ["CONFIG_USE_CUSTOM_WAKE_WORD"],
            )
        return orig_wake(wake_word, target)

    b._merge_sdkconfig_options = merge_with_ota
    b._wake_word_sdkconfig_options = wake_with_custom

    os.chdir(FIRMWARE)

    if args.dry_run:
        _, options, _ = wake_with_custom(WAKE_WORD_PINYIN, "esp32s3")
        merged = merge_with_ota([], options)
        print(f"cwd: {Path.cwd()}")
        print(f"board: {BOARD} / variant: {VARIANT} / language: {LANGUAGE}")
        for item in merged:
            print(f"sdkconfig_append: {item}")
        return 0

    b.build_board(
        BOARD,
        name_filter=VARIANT,
        language=LANGUAGE,
        wake_word=WAKE_WORD_PINYIN,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
