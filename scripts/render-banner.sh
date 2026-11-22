#!/bin/bash
# Renders docs/images/niro-banner.png (1600x800, exactly 2:1, so it also works as GitHub's social preview) from its HTML source
# in docs/images/src/niro-banner.html. Needs Google Chrome or Chromium. usage: scripts/render-banner.sh [out.png]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-docs/images/niro-banner.png}"
case "$OUT" in /*) ABS="$OUT";; *) ABS="$PWD/$OUT";; esac
CHROME="$(command -v google-chrome google-chrome-stable chromium chromium-browser 2>/dev/null | head -1)"
[ -n "$CHROME" ] || { echo "needs google-chrome or chromium"; exit 1; }
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1600,800 --screenshot="$ABS" "file://$PWD/docs/images/src/niro-banner.html" 2>&1 | grep -v "Authorization required" || true
python3 - "$OUT" <<'PY'
import sys
from PIL import Image
w, h = Image.open(sys.argv[1]).size
sys.exit(0 if (w, h) == (1600, 800) else f"unexpected size {w}x{h}")
PY
echo "wrote $OUT"
