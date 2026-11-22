#!/bin/bash
# Renders the project's pictures from their HTML sources in docs/images/src/ with Chrome (headless). Needs Google Chrome or Chromium.
#   scripts/render-banner.sh [banner|poster] [out.png]
# banner: docs/images/niro-banner.png, 1600x800 (exactly 2:1, so it also works as GitHub's social preview)
# poster: docs/images/niro-mascot-poster.png, 1600x1000
set -euo pipefail
cd "$(dirname "$0")/.."
WHICH="${1:-banner}"
case "$WHICH" in
  banner) SRC=niro-banner.html;        DEF=docs/images/niro-banner.png;        W=1600; H=800;;
  poster) SRC=niro-mascot-poster.html; DEF=docs/images/niro-mascot-poster.png; W=1600; H=1000;;
  *) echo "usage: $0 [banner|poster] [out.png]"; exit 1;;
esac
OUT="${2:-$DEF}"
case "$OUT" in /*) ABS="$OUT";; *) ABS="$PWD/$OUT";; esac
CHROME="$(command -v google-chrome google-chrome-stable chromium chromium-browser 2>/dev/null | head -1)"
[ -n "$CHROME" ] || { echo "needs google-chrome or chromium"; exit 1; }
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$W,$H" --screenshot="$ABS" "file://$PWD/docs/images/src/$SRC" 2>&1 | grep -v "Authorization required" || true
python3 - "$OUT" "$W" "$H" <<'PY'
import sys
from PIL import Image
w, h = Image.open(sys.argv[1]).size
sys.exit(0 if (w, h) == (int(sys.argv[2]), int(sys.argv[3])) else f"unexpected size {w}x{h}")
PY
echo "wrote $OUT"
