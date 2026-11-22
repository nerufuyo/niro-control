#!/bin/bash
# Search against the Niro Island in a real headless GNOME Shell (both extensions enabled): Search stays clear of an expanded island by 12 px,
# keeps its anchor when the island is compact, restores when it collapses, never overflows the bottom, keeps focus, survives 20 rapid cycles,
# jumps under reduced motion, and leaks nothing over disable/enable x5. Run `npm run build` first.
# usage: [MONITOR=1280x720] [SHOTS=1] tests/shell/search-collision.sh [outdir]      (exit 0 when every check passes and the shell log is clean)
set -u
cd "$(dirname "$0")/../.."
OUT=$(readlink -f "${1:-$(mktemp -d)}"); mkdir -p "$OUT"
WITH_SEARCH=1 tests/shell/island-session.sh tests/shell/search-collision-steps.sh "$OUT" > "$OUT/session.log" 2>&1
python3 -I - "$OUT/session.log" <<'PY'
import ast, json, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^RESULT \((true|false), (.*)\)$", text, re.M)
if not m: print("FAIL no result"); print(text[-1500:]); sys.exit(1)
v = ast.literal_eval(m.group(2))
while isinstance(v, str): v = json.loads(v)
bad = 0
for c in v:
    print(("ok   " if c["ok"] else "FAIL ") + c["name"] + (("  [" + c["detail"] + "]") if c["detail"] else ""))
    bad += not c["ok"]
e = re.search(r"SHELL_LOG_ERRORS (\d+)", text)
errs = int(e.group(1)) if e else -1
print(("ok   " if errs == 0 else "FAIL ") + "shell log errors: %d" % errs)
sys.exit(1 if bad or errs != 0 else 0)
PY
