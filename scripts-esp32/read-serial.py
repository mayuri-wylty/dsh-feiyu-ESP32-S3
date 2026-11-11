#!/usr/bin/env python3
"""Read the ESP32 serial log for a while, optionally resetting the board first.

Usage:
    python read-serial.py --port COM3 --seconds 30 --reset
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import serial


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM3")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--reset", action="store_true", help="toggle RTS/DTR to reboot into run mode")
    ap.add_argument("--out", default="serial.log")
    args = ap.parse_args()

    ser = serial.Serial()
    ser.port = args.port
    ser.baudrate = args.baud
    ser.timeout = 0.2
    ser.open()

    if args.reset:
        # EN=RTS low pulse, IO0(DTR)=high -> normal boot
        ser.dtr = False
        ser.rts = True
        time.sleep(0.15)
        ser.rts = False
        time.sleep(0.05)

    deadline = time.monotonic() + args.seconds
    chunks: list[bytes] = []
    while time.monotonic() < deadline:
        data = ser.read(4096)
        if data:
            chunks.append(data)
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    ser.close()

    blob = b"".join(chunks)
    Path(args.out).write_bytes(blob)
    print(f"\n[read-serial] {len(blob)} bytes -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
