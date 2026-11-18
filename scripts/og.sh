#!/usr/bin/env bash
# Regenerate assets/og.png (1200x630) from assets/og.svg.
# Uses rsvg-convert, inkscape or a headless Chrome/Chromium, whichever is found first.
# Text is rendered with the fonts installed on this machine (see the font lists in og.svg).
set -euo pipefail
cd "$(dirname "$0")/.."
src=assets/og.svg
out=assets/og.png

if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 1200 -h 630 "$src" -o "$out"
elif command -v inkscape >/dev/null; then
  inkscape "$src" --export-type=png --export-filename="$out" -w 1200 -h 630
else
  chrome=""
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null; then chrome="$c"; break; fi
  done
  [ -n "$chrome" ] || { echo "no SVG renderer found (rsvg-convert, inkscape, chrome)" >&2; exit 1; }
  profile="$(mktemp -d)"
  trap 'rm -rf "$profile"' EXIT
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$profile" --force-device-scale-factor=1 \
    --window-size=1200,630 --screenshot="$PWD/$out" "file://$PWD/$src" 2>/dev/null
fi

if command -v optipng >/dev/null; then optipng -quiet -o2 "$out"; fi
python3 -c "import struct,sys;b=open('$out','rb').read(24);print('$out', *struct.unpack('>II',b[16:24]), len(open('$out','rb').read())//1024, 'KB')"
