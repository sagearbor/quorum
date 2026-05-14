#!/usr/bin/env python3
"""Generate QR codes for Duke Tech Expo 2026 stations + display projection.

Usage:
  python3 scripts/generate-qr.py [--host HOST] [--slug SLUG] [--out DIR]

Defaults:
  HOST  = https://quorum-web-sage-arbors-projects.vercel.app  (env: HOST)
  SLUG  = duke-expo-2026                                       (env: SLUG)
  DIR   = /tmp/quorum-qr                                       (env: OUT)

Writes 6 PNGs:
  station-1.png .. station-5.png  -> <HOST>/event/<SLUG>?station=N
  display.png                     -> <HOST>/display/<SLUG>
And one index.html that previews them all for quick printing.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import qrcode  # type: ignore[import-untyped]
except ImportError:
    print("qrcode not installed.  Run:  python3 -m pip install --user 'qrcode[pil]'",
          file=sys.stderr)
    sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HOST", ""))
    ap.add_argument("--slug", default=os.environ.get("SLUG", "duke-expo-2026"))
    ap.add_argument("--out",  default=os.environ.get("OUT", "/tmp/quorum-qr"))
    ap.add_argument("--stations", type=int, default=5)
    args = ap.parse_args()

    if not args.host:
        print("error: --host is required (or set HOST env)", file=sys.stderr)
        return 2

    host = args.host.rstrip("/")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    targets: list[tuple[str, str]] = []
    for n in range(1, args.stations + 1):
        url = f"{host}/event/{args.slug}?station={n}"
        targets.append((f"station-{n}.png", url))
    targets.append(("display.png", f"{host}/display/{args.slug}"))

    print(f"Generating {len(targets)} QR codes -> {out}")
    for filename, url in targets:
        img = qrcode.make(url, box_size=10, border=4)
        path = out / filename
        img.save(path)
        print(f"  {filename:18s} {url}")

    # Print-friendly preview page
    index = out / "index.html"
    parts: list[str] = [
        "<!doctype html><meta charset=utf-8>",
        "<title>Quorum expo QR codes</title>",
        "<style>",
        "body{font-family:system-ui;margin:40px;}",
        ".card{display:inline-block;text-align:center;margin:16px;"
        "border:1px solid #ccc;padding:16px;border-radius:8px;width:260px;"
        "vertical-align:top;}",
        ".card img{width:240px;height:240px;}",
        ".card code{font-size:11px;word-break:break-all;display:block;"
        "margin-top:8px;color:#555;}",
        "h1{margin-bottom:8px;}",
        "</style>",
        f"<h1>Quorum @ Duke Tech Expo 2026</h1>",
        f"<p>Event slug: <code>{args.slug}</code> &middot; Host: <code>{host}</code></p>",
    ]
    for filename, url in targets:
        parts.append(
            f"<div class=card><div><b>{filename.replace('.png','')}</b></div>"
            f"<img src='{filename}'>"
            f"<code>{url}</code></div>"
        )
    index.write_text("\n".join(parts))
    print(f"  index.html         (preview: file://{index})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
