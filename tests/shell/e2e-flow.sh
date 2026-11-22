#!/bin/bash
# Niro Flow end to end: the REAL Search extension (in a headless nested GNOME Shell) and the REAL island-daemon Flow service,
# on one private D-Bus session. A workflow is saved through org.niro.Flow1, run with RunNow, and the answer is checked in
# four places: the run history, the real clipboard of the shell, Search's own audit log, and the refusals (a denied
# capability, an action Flow has no capability for, an unknown action, Flow switched off).
#
# Run it through the staged tree:   bash tests/shell/run-staged.sh e2e-flow     (needs: cargo build --release -p island-daemon)
# Nothing of the real desktop is touched: its own D-Bus session, and HOME plus every XDG folder in a scratch folder (so
# ~/.config/niro, ~/.local/state/niro and Search's audit log are never read or written), settings in memory.
# The one action that runs is clipboard.copy (harmless; undone with clipboard.clear at the end).
set -u
cd "$(dirname "$0")/../.."
[ -n "${NIRO_EXT_ROOT:-}" ] || { echo "run this through tests/shell/run-staged.sh e2e-flow (it needs the staged extensions)"; exit 2; }
DAEMON="${DAEMON:-$PWD/target/release/island-daemon}"
[ -x "$DAEMON" ] || { echo "no daemon at $DAEMON (cargo build --release -p island-daemon)"; exit 2; }
"$DAEMON" --flow help >/dev/null 2>&1 || { echo "$DAEMON has no --flow: rebuild it (cargo build --release -p island-daemon)"; exit 2; }
WORK=$(mktemp -d); OUT="$WORK/out.txt"; : > "$OUT"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/config" "$WORK/data" "$WORK/state" "$WORK/cache"
REAL_NIRO="$HOME/.config/niro"; BEFORE=$(find "$REAL_NIRO" -printf '%p %T@ %s\n' 2>/dev/null | sort | md5sum)
FAILS=0
has() { if grep -qF -- "$2" "$OUT"; then echo "ok   $1"; else echo "FAIL $1 (wanted: $2)"; FAILS=$((FAILS+1)); fi; }
export DAEMON WORK OUT

timeout 240 dbus-run-session -- env HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" XDG_CACHE_HOME="$WORK/cache" \
  bash -c '
Q=$(printf "\047")
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-e2e --virtual-monitor 1280x720 > "$WORK/shell.log" 2>&1 & SP=$!
sleep 20
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
ev "Main.extensionManager.enableExtension(\"search@niro.local\")" >/dev/null; sleep 6
search() { gdbus call --session --dest org.niro.Search --object-path /org/niro/Search --method org.niro.Search."$@" 2>&1; }
D="--session --dest org.niro.island.Daemon --object-path /org/niro/island/Daemon"
flow() { gdbus call $D --method org.niro.Flow1."$@" 2>&1; }
prop() { gdbus call $D --method org.freedesktop.DBus.Properties.Get org.niro.Flow1 "$1" 2>&1 | grep -o "true\|false"; }
put() { echo "$1 $2" >> "$OUT"; }
now() { date +%s%N; }
clip() { ev "global.__clip = \"unset\"; const St = imports.gi.St; St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (c, t) => { global.__clip = t; }); 1" >/dev/null; sleep 1; ev "global.__clip"; }

gdbus wait --session --timeout 30 org.niro.Search
for i in $(seq 20); do search ListActions | grep -q "clipboard.copy" && break; sleep 0.5; done
put SEARCH_UP "$(search ListActions | grep -c "clipboard.copy")"
# the daemon, Flow OFF (the default): the binary the package ships, isolated HOME and XDG folders
env -u NIRO_FLOW_ENABLED "$DAEMON" > "$WORK/daemon.log" 2>&1 & DP=$!
gdbus wait --session --timeout 30 org.niro.island.Daemon
for i in $(seq 40); do flow Get nothing | grep -q "no workflow" && break; sleep 0.5; done

WF() { # id allow-json action args-json
  echo "{\"version\":1,\"id\":\"$1\",\"name\":\"$1\",\"trigger\":{\"type\":\"manual\"},\"allow\":$2,\"steps\":[{\"kind\":\"action\",\"id\":\"s1\",\"name\":\"$3\",\"args\":$4,\"next\":null}]}"
}
save() { flow Save "$Q$1$Q"; }
waitrun() { # workflow id: prints the history JSON once its run is no longer running
  local r=""
  for i in $(seq 40); do
    r=$(flow History "$1" | unesc)
    case "$r" in *"\"status\":\"running\""*|"(${Q}[]${Q},)"|"") sleep 0.25;; *) echo "$r"; return;; esac
  done; echo "$r"
}
# gdbus escapes the double quotes when the string also holds an apostrophe
unesc() { sed "s/\\\\\"/\"/g"; }
st() { grep -o "\"status\":\"[a-z]*\"" | tail -1; }

put FLOW_OFF_PROP "$(prop Enabled)"
TEXT="niro-e2e-flow-$$"
put SAVE_OK "$(save "$(WF e2e-copy "[\"clipboard.copy\"]" clipboard.copy "{\"text\":\"$TEXT\"}")" | grep -o "(true")"
put RUN_WHILE_OFF "$(flow RunNow e2e-copy | grep -o "turned off")"
flow SetGlobalEnabled true >/dev/null
put FLOW_ON_PROP "$(prop Enabled)"

# the real run
T0=$(now); RID=$(flow RunNow e2e-copy | grep -oE "[0-9]+"); R=$(waitrun e2e-copy); T1=$(now)
put RUN_ID "${RID:+yes}"
put RUN_MS "$(( (T1 - T0) / 1000000 ))"
put RUN_STATUS "$(echo "$R" | st)"
put RUN_STEP "$(echo "$R" | grep -o "\"name\":\"clipboard.copy\"")"
put RUN_STEP_ERR "$(echo "$R" | grep -o "\"error\":null" | head -1)"
put CLIPBOARD "$(clip | grep -o "$TEXT")"
A=$(search History 50)
put AUDIT_CALLER "$(echo "$A" | grep "clipboard.copy" | grep -o "\"caller\":\"[a-z-]*\"" | sort -u)"
put AUDIT_OK "$(echo "$A" | grep "clipboard.copy" | grep -o "\"ok\":true" | head -1)"
put AUDIT_TEXT_LEAK "$(echo "$A" | grep -c "$TEXT")"

# denied: the workflow allows another capability, so the same action is refused before it reaches Search
OTHER="niro-e2e-denied-$$"
put SAVE_DENY "$(save "$(WF e2e-denied "[\"window\"]" clipboard.copy "{\"text\":\"$OTHER\"}")" | grep -o "(true")"
flow RunNow e2e-denied >/dev/null; R2=$(waitrun e2e-denied)
put DENIED_STATUS "$(echo "$R2" | st)"
put DENIED_WHY "$(echo "$R2" | grep -o "permission denied: clipboard" | head -1)"
put DENIED_CLIPBOARD "$(clip | grep -c "$OTHER")"
put SAVE_EMPTY "$(save "$(WF e2e-empty "[]" clipboard.copy "{\"text\":\"$OTHER\"}")" | grep -o "(true")"
flow RunNow e2e-empty >/dev/null; put EMPTY_STATUS "$(waitrun e2e-empty | st)"
# no capability: a registry action Flow never runs (power/session) is refused when saving...
NC=$(save "$(WF e2e-nocap "[\"system.restart\"]" system.restart "{}")")
put NOCAP_SAVE "$(echo "$NC" | grep -o "(false")"
put NOCAP_SAVE_WHY "$(echo "$NC" | grep -o "Flow never runs" | head -1)"
# ...and again when a hand-written file gets past Save: it loads, but the run is denied and nothing reaches Search
echo "$(WF e2e-nocap "[\"system.restart\"]" system.restart "{}")" > "$WORK/config/niro/flow/workflows/e2e-nocap.json"
flow Reload >/dev/null
MB=$(ev "Main.modalCount" | grep -oE "[0-9]+" | tail -1)
put NOCAP_FILE_RUN "$(flow RunNow e2e-nocap | cut -c1-80)"
R3=$(waitrun e2e-nocap); sleep 1
put NOCAP_STATUS "$(echo "$R3" | st)"
put NOCAP_WHY "$(echo "$R3" | grep -o "is not an action Flow runs" | head -1)"
put NOCAP_DIALOG "$([ "$(ev "Main.modalCount" | grep -oE "[0-9]+" | tail -1)" = "$MB" ] && echo none)"
put NOCAP_IN_AUDIT "$(search History 100 | grep -c "system.restart")"
# unlisted: an action the registry does not know cannot even be saved
UNK=$(save "$(WF e2e-unknown "[\"clipboard\"]" nope.x "{}")")
put SAVE_UNKNOWN "$(echo "$UNK" | grep -o "(false")"
put SAVE_UNKNOWN_WHY "$(echo "$UNK" | grep -o "nope.x" | head -1)"
put SAVE_SHELLISH "$(save "$(WF e2e-shell "[\"clipboard\"]" "system.lock;rm -rf" "{}")" | grep -o "(false")"
put RUN_UNKNOWN_WORKFLOW "$(flow RunNow does-not-exist | grep -o "no workflow")"
put SAVE_BADID "$(save "$(WF "../evil" "[\"clipboard\"]" clipboard.copy "{\"text\":\"x\"}")" | grep -o "(false")"
put WORKFLOW_FILES "$(ls "$WORK/config/niro/flow/workflows" | tr "\n" " ")"
put STATE_FILES "$(ls "$WORK/state/niro/flow" 2>&1 | tr "\n" " ")"
put HISTORY_RUNS "$(flow History "" | grep -o "\"workflow_id\":\"[a-z-]*\"" | sort | uniq -c | tr -s " " | tr "\n" ";")"

# desktop events: with `flow-events` on, a REAL workspace switch in the shell reaches the daemon (Notify) and starts a workflow whose trigger is workspace_changed
EVT="niro-e2e-event-$$"
put EVENT_SAVE "$(save "{\"version\":1,\"id\":\"e2e-event\",\"name\":\"e2e-event\",\"trigger\":{\"type\":\"workspace_changed\"},\"allow\":[\"clipboard.copy\"],\"steps\":[{\"kind\":\"action\",\"id\":\"s1\",\"name\":\"clipboard.copy\",\"args\":{\"text\":\"$EVT\"},\"next\":null}]}" | grep -o "(true")"
search RunAction clipboard.clear "{}" >/dev/null
ev "global.workspace_manager.append_new_workspace(false, global.get_current_time()); global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); 1" >/dev/null; sleep 3
put EVENT_OFF_NO_RUN "$(clip | grep -c "$EVT")"
ev "new imports.gi.Gio.Settings({schema_id: \"org.niro.control\"}).set_boolean(\"flow-events\", true); 1" >/dev/null; sleep 1
ev "global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); 1" >/dev/null; sleep 3
put EVENT_RUN "$(waitrun e2e-event | st)"
put EVENT_CLIPBOARD "$(clip | grep -o "$EVT")"
ev "new imports.gi.Gio.Settings({schema_id: \"org.niro.control\"}).set_boolean(\"flow-events\", false); 1" >/dev/null; sleep 1
search RunAction clipboard.clear "{}" >/dev/null
N0=$(flow History e2e-event | unesc | grep -o "\"status\"" | wc -l)
ev "global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); 1" >/dev/null; sleep 3
put EVENT_AFTER_OFF "$([ "$(flow History e2e-event | unesc | grep -o "\"status\"" | wc -l)" = "$N0" ] && echo same)"

# put the clipboard back, then switch Flow off: RunNow is refused again
search RunAction clipboard.clear "{}" >/dev/null
flow SetGlobalEnabled false >/dev/null
put RUN_AFTER_OFF "$(flow RunNow e2e-copy | grep -o "turned off")"
put JS_ERRORS "$(grep -c "JS ERROR" "$WORK/shell.log")"
kill $DP 2>/dev/null; wait $DP 2>/dev/null
kill $SP; wait $SP 2>/dev/null' > "$WORK/run.out" 2>&1

sed 's/^/     raw: /' "$OUT"
has "Search is up on the private bus and lists clipboard.copy" "SEARCH_UP 1"
has "Flow is off by default" "FLOW_OFF_PROP false"
has "a workflow with a registry action and a matching allow list saves" "SAVE_OK (true"
has "RunNow is refused while Flow is off" "RUN_WHILE_OFF turned off"
has "SetGlobalEnabled turns Flow on" "FLOW_ON_PROP true"
has "RunNow returns a run id" "RUN_ID yes"
has "the run finishes ok" 'RUN_STATUS "status":"ok"'
has "history holds the clipboard.copy step" 'RUN_STEP "name":"clipboard.copy"'
has "the step has no error" 'RUN_STEP_ERR "error":null'
has "REAL result: the shell clipboard holds the text" "CLIPBOARD niro-e2e-flow-"
has "REAL audit: Search recorded the call from the daemon" 'AUDIT_CALLER "caller":"island-daemon"'
has "REAL audit: the call is recorded as ok" 'AUDIT_OK "ok":true'
# Known finding (reported, not fixed here): Search's audit log keeps the arguments of clipboard.copy, i.e. the copied text.
# It is printed as a warning; NIRO_E2E_STRICT_AUDIT=1 makes it a failure.
if grep -q "^AUDIT_TEXT_LEAK 0" "$OUT"; then echo "ok   the audit holds no copied text"
elif [ "${NIRO_E2E_STRICT_AUDIT:-0}" = 1 ]; then echo "FAIL the audit holds the copied text"; FAILS=$((FAILS+1))
else echo "WARN the audit log keeps the arguments of clipboard.copy (the copied text); NIRO_E2E_STRICT_AUDIT=1 to fail on it"; fi
has "denied: a workflow without the capability still saves" "SAVE_DENY (true"
has "denied: the run ends in error" 'DENIED_STATUS "status":"error"'
has "denied: the reason names the capability" "DENIED_WHY permission denied: clipboard"
has "denied: the clipboard was not changed" "DENIED_CLIPBOARD 0"
has "denied: an empty allow list runs nothing" 'EMPTY_STATUS "status":"error"'
has "no capability: system.restart is refused when saving" "NOCAP_SAVE (false"
has "no capability: the reason says Flow never runs it" "NOCAP_SAVE_WHY Flow never runs"
has "no capability: a hand-written file is still not run (error)" 'NOCAP_STATUS "status":"error"'
has "no capability: refused as not an action Flow runs" "NOCAP_WHY is not an action Flow runs"
has "no capability: no confirmation dialog appeared" "NOCAP_DIALOG none"
has "no capability: Search never saw the action" "NOCAP_IN_AUDIT 0"
has "unlisted: an unknown action cannot be saved" "SAVE_UNKNOWN (false"
has "unlisted: the problem names the action" "SAVE_UNKNOWN_WHY nope.x"
has "unlisted: a shell-shaped action id cannot be saved" "SAVE_SHELLISH (false"
has "an unknown workflow is refused" "RUN_UNKNOWN_WORKFLOW no workflow"
has "a path-shaped workflow id cannot be saved" "SAVE_BADID (false"
has "workflow files are under the isolated config folder" "e2e-copy.json"
has "the history file is under the isolated state folder" "history.json"
has "history lists the runs" "e2e-copy"
has "events: flow-events off, a workspace switch starts no workflow" "EVENT_OFF_NO_RUN 0"
has "events: flow-events on, a real workspace switch starts the workflow (it ends ok)" 'EVENT_RUN "status":"ok"'
has "events: ...and its action ran (the shell clipboard holds the text)" "EVENT_CLIPBOARD niro-e2e-event-"
has "events: switched off again, a workspace switch starts nothing more" "EVENT_AFTER_OFF same"
has "RunNow is refused again once Flow is off" "RUN_AFTER_OFF turned off"
has "no JS errors in the shell" "JS_ERRORS 0"
AFTER=$(find "$REAL_NIRO" -printf '%p %T@ %s\n' 2>/dev/null | sort | md5sum)
if [ "$BEFORE" = "$AFTER" ]; then echo "ok   the real ~/.config/niro was not touched"; else echo "FAIL the real ~/.config/niro changed"; FAILS=$((FAILS+1)); fi
grep "^RUN_MS" "$OUT" | sed 's/^/info /; s/$/ (RunNow to finished history, nested shell, includes polling)/'
echo; [ $FAILS -eq 0 ] && echo "e2e flow checks: all passed" || { echo "e2e flow checks: $FAILS failed"; tail -15 "$WORK/run.out"; tail -15 "$WORK/daemon.log" 2>/dev/null; exit 1; }
