#!/bin/bash
# Search's motion against a real GNOME Shell (headless, its own D-Bus session, HOME and settings): opening/closing springs (no overshoot, one step per
# painted frame, frame source stops at rest), typing during the opening animation, late results that keep the selected row where it is, rapid toggles,
# Escape/Enter afterwards, activation not waiting for the fade, reduced motion, and disable/enable x5 without leaks. Builds nothing: run `npm run build` first.
# usage: tests/shell/search-motion.sh        (exit 0 when every check passes and the shell log holds no errors from the extension)
set -u
cd "$(dirname "$0")/../.."
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/sm.XXXXXX")
STAGE=$(DAEMON="${DAEMON:-/usr/bin/island-daemon}" tests/shell/stage.sh "$SCRATCH/stage") || exit 1
WORK="$SCRATCH/w"
tests/shell/search-session.sh "$STAGE" "$WORK" > "$SCRATCH/session.out" 2>&1 &
SESSION=$!
cleanup() { touch "$WORK/stop"; wait "$SESSION" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT
for _ in $(seq 60); do [ -s "$WORK/env" ] && grep -q SHELL_PID "$WORK/env" && break; sleep 1; done
. "$WORK/env"
sleep 20
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
ev "$(< tests/shell/search-motion.js)" > /dev/null
RESULT=""
for _ in $(seq 120); do
  R=$(ev "global.__searchMotion")
  case "$R" in *running*) sleep 1;; *) RESULT=$R; break;; esac
done
python3 -I - "$RESULT" <<'PY'
import ast, json, re, sys
m = re.match(r"\((true|false), (.*)\)$", sys.argv[1].strip(), re.S)
if not m: print("FAIL no result:", sys.argv[1][:200]); sys.exit(1)
v = ast.literal_eval(m.group(2))
while isinstance(v, str): v = json.loads(v)
bad = 0
for c in v:
    print(("ok   " if c["ok"] else "FAIL ") + c["name"] + (("  [" + c["detail"] + "]") if c["detail"] else ""))
    bad += not c["ok"]
sys.exit(1 if bad else 0)
PY
RC=$?
# nothing from the extension may have been logged as an error or exception (the Gio.DesktopAppInfo deprecation warning is known and unrelated)
if grep -E "JS ERROR|Gjs-CRITICAL|search@niro.local.*(rror|xception)|Unhandled|TypeError|ReferenceError" "$WORK/shell.log" | grep -v "Gio.DesktopAppInfo"; then echo "FAIL shell log holds errors"; RC=1; else echo "ok   shell log holds no errors from the extension"; fi
exit $RC
