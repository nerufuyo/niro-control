#!/bin/bash
# Screenshots of Niro's pieces in a headless shell: NIRO_SHOTS=<dir> NIRO_JS='js;js' tests/shell/run-staged.sh shots
# NIRO_JS is run in the shell (Looking Glass) before the shot, one statement per line.
set -u
cd "$(dirname "$0")/../.."
export DIR="${NIRO_SHOTS:?set NIRO_SHOTS}"; mkdir -p "$DIR"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
timeout 200 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-shots --virtual-monitor 1440x900 > '"$LOG"' 2>&1 & SP=$!
sleep 22
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
for e in island dock search; do ev "Main.extensionManager.enableExtension(\"$e@niro.local\")" >/dev/null; done
sleep 12
ev "Main.overview.hide(); 1" >/dev/null; sleep 2
ev "Main.layoutManager.modalDialogGroup ? Main.layoutManager.modalDialogGroup.get_children().forEach(c => c.destroy()) : 0; 1" >/dev/null
while IFS= read -r js; do [ -n "$js" ] && { echo "JS> $(ev "$js")"; sleep 1; }; done <<< "${NIRO_JS:-}"
sleep 3
gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$DIR/${NIRO_NAME:-shot}.png" >/dev/null 2>&1
kill $SP 2>/dev/null; wait $SP 2>/dev/null
' 2>&1 | grep -E "^JS>"
grep -E "JS ERROR|Extension .*error" "$LOG" | head -10
