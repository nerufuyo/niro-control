#!/bin/bash
# Tile's window groups, session snapshots and monitor recovery against a real GNOME Shell (headless), with real windows, over org.niro.Tile.
# The monitor "unplug" is simulated (the layout manager's monitor list is cut and 'monitors-changed' emitted); the display is not reconfigured.
# Needs the staged extensions (tests/shell/run-staged.sh) or the installed package. The workspace cores (shell/shared/windowGroups.js,
# snapshot.js, monitorManager.js) must sit in tile@niro.local/shared; for a staged run they are copied there when missing.
set -u
cd "$(dirname "$0")/../.."
# The test must not write the real ~/.local/share (Search's audit log, snips): run-staged.sh already isolates it, a direct run does here.
[ -n "${NIRO_TEST_ISOLATED:-}" ] || { export XDG_DATA_HOME; XDG_DATA_HOME=$(mktemp -d); }
LOG=$(mktemp); WORK=$(mktemp -d); trap 'rm -f "$LOG"; rm -rf "$WORK"; rm -f /run/user/$UID/gnome-shell-disable-extensions' EXIT
rm -f /run/user/$UID/gnome-shell-disable-extensions
if [ -n "${NIRO_EXT_ROOT:-}" ] && [ ! -f "$NIRO_EXT_ROOT/tile@niro.local/shared/windowGroups.js" ]; then
  mkdir -p "$NIRO_EXT_ROOT/tile@niro.local/shared"
  cp shell/shared/windowGroups.js shell/shared/snapshot.js shell/shared/monitorManager.js "$NIRO_EXT_ROOT/tile@niro.local/shared/"
fi
cat > "$WORK/app.js" <<'J'
imports.gi.versions.Gtk = "4.0"; const {Gtk} = imports.gi; Gtk.init(); const id = ARGV[0];
const a = new Gtk.Application({application_id: "org.niro.TileTest" + id});
a.connect("activate", () => { const w = new Gtk.ApplicationWindow({application: a, title: "w" + String(id).padStart(2, "0")}); w.set_default_size(300, 200); w.set_child(new Gtk.Label({label: "window " + id})); w.present(); });
a.run([]);
J
mkdir -p "$WORK/cfg/glib-2.0/settings" "$WORK/cfg/niro"
printf "[org/gnome/shell]\nwelcome-dialog-last-shown-version='99'\n" > "$WORK/cfg/glib-2.0/settings/keyfile"
cat > "$WORK/j.py" <<'J'
# j.py EXPR: reads what `gdbus call` / Eval printed, `('{"a":1}',)` or `(true, '"..."')`, and prints eval(EXPR) with d = the JSON it carries
import ast, json, sys
raw = sys.stdin.read().strip()
try:
    for lead in ("(true, ", "(false, "):
        if raw.startswith(lead): raw = "(" + raw[len(lead):]
    t = ast.literal_eval(raw)
    s = t[0] if isinstance(t, tuple) else t
    d = json.loads(s)
    if isinstance(d, str): d = json.loads(d)
    print(eval(sys.argv[1]))
except Exception as e:
    print("ERR " + str(e) + " <<" + raw[:200] + ">>")
J
export WORK LOG
export GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME="$WORK/cfg"
timeout 280 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-tilews --virtual-monitor 1280x720 --virtual-monitor 800x600 > "$LOG" 2>&1 &
sleep 16
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
tc() { gdbus call --session --dest org.niro.Tile --object-path /org/niro/Tile --method "org.niro.Tile.$1" "${@:2}" 2>&1; }
J() { python3 "$WORK/j.py" "$1"; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; fi; }
OPEN() { WAYLAND_DISPLAY=niro-tilews GDK_BACKEND=wayland gjs "$WORK/app.js" $1 >/dev/null 2>&1 & echo $! >> "$WORK/pids"; }
TS="gsettings set org.gnome.shell.extensions.tile"
[ -n "${NIRO_EXT_ROOT:-}" ] && TS="gsettings --schemadir $NIRO_EXT_ROOT/tile@niro.local/schemas set org.gnome.shell.extensions.tile"
ev "Main.extensionManager.enableExtension(\"tile@niro.local\")" >/dev/null; sleep 4; ev "Main.overview.hide(); 1" >/dev/null
$TS enabled false
for n in 1 2 3; do OPEN $n; sleep 2.5; ev "Main.overview.hide(); 1" >/dev/null; done
sleep 1
WIN() { ev "JSON.stringify(global.get_window_actors().map(a=>a.meta_window).filter(w=>w.title===\"$1\").map(w=>({id:w.get_id(),ws:w.get_workspace().index()+1,mon:w.get_monitor()}))[0]||null)" | J "d[\"$2\"]"; }
ID1=$(WIN w01 id); ID2=$(WIN w02 id); ID3=$(WIN w03 id)
check "three real windows are open" "$([ -n "$ID1" ] && [ -n "$ID2" ] && [ -n "$ID3" ] && echo yes)" yes

check "the workspace API answers, version 1" "$(tc GetWorkspaceApi | J "d[\"api\"], d[\"ok\"]")" "(1, True)"
check "monitor recovery is off by default" "$(tc GetWorkspaceApi | J "d[\"monitorRecovery\"]")" "False"
check "an unknown operation is an answer, not a crash" "$(tc GroupsCall bogus "" | J "d[\"ok\"]")" "False"
check "bad arguments are an answer, not a crash" "$(tc GroupsCall list "{nope" | J "d[\"ok\"]")" "False"

# ---- groups
check "a group is created from two windows" "$(tc GroupsCall create "{\"name\":\"Work\",\"windowIds\":[$ID1,$ID2]}" | J "d[\"ok\"], len(d[\"group\"][\"members\"])")" "(True, 2)"
check "the third window is added by id" "$(tc GroupsCall add "{\"id\":\"work\",\"windowId\":$ID3}" | J "len(d[\"group\"][\"members\"])")" "3"
check "the group is stored as JSON in the user config dir" "$(python3 -c "import json; print(len(json.load(open(\"$WORK/cfg/niro/tile-groups.json\"))[\"groups\"][0][\"members\"]))")" "3"
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w02\").change_workspace_by_index(1,false); 1" >/dev/null; sleep 1.5
check "w02 was moved to workspace 2 (set-up)" "$(WIN w02 ws)" "2"
check "a preview plans one move and moves nothing" "$(tc GroupsCall activate "{\"id\":\"work\",\"preview\":true}" | J "d[\"planned\"], d[\"preview\"]")" "(1, True)"
check "...really nothing moved" "$(WIN w02 ws)" "2"
check "activate reports one moved window" "$(tc GroupsCall activate "{\"id\":\"work\"}" | J "len(d[\"applied\"]), len(d[\"failed\"]), d[\"focused\"]")" "(1, 0, True)"
sleep 1.5
check "...and w02 is back on workspace 1" "$(WIN w02 ws)" "1"
check "the group is renamed" "$(tc GroupsCall rename "{\"id\":\"work\",\"name\":\"Job\"}" | J "d[\"group\"][\"name\"]")" "Job"
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w03\").delete(global.get_current_time()); 1" >/dev/null; sleep 3
check "a closed window is reported as closed" "$(tc GroupsCall list "" | J "d[\"groups\"][0][\"open\"], d[\"groups\"][0][\"closed\"]")" "(2, 1)"
check "activating with a closed member is ok" "$(tc GroupsCall activate "{\"id\":\"work\"}" | J "d[\"ok\"], len(d[\"closed\"])")" "(True, 1)"
check "an unknown group is an error answer" "$(tc GroupsCall activate "{\"id\":\"nope\"}" | J "d[\"ok\"]")" "False"

# ---- snapshots
check "a snapshot is taken" "$(tc SnapshotsCall take "{\"name\":\"Base\"}" | J "d[\"ok\"], d[\"windows\"]")" "(True, 2)"
SID=$(tc SnapshotsCall list "" | J "d[\"snapshots\"][0][\"id\"]")
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w01\").change_workspace_by_index(1,false); 1" >/dev/null; sleep 1.5
check "the diff sees w01 moved" "$(tc SnapshotsCall diff "{\"a\":\"$SID\"}" | J "len(d[\"diff\"][\"moved\"])")" "1"
check "the plan places both open windows, one of them already in place" "$(tc SnapshotsCall plan "{\"id\":\"$SID\"}" | J "d[\"counts\"][\"place\"], len([i for i in d[\"items\"] if i.get(\"noop\")])")" "(2, 1)"
check "restore without confirm is a preview" "$(tc SnapshotsCall restore "{\"id\":\"$SID\"}" | J "d[\"preview\"]")" "True"
check "...and nothing moved" "$(WIN w01 ws)" "2"
check "a confirmed restore places the window" "$(tc SnapshotsCall restore "{\"id\":\"$SID\",\"confirm\":true}" | J "len(d[\"applied\"]), len(d[\"failed\"])")" "(1, 0)"
sleep 1.5
check "...w01 is back on workspace 1" "$(WIN w01 ws)" "1"
# an app closed since: listed for relaunch, never started by restore
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w02\").delete(global.get_current_time()); 1" >/dev/null; sleep 3
check "the closed app is listed as relaunch" "$(tc SnapshotsCall plan "{\"id\":\"$SID\"}" | J "d[\"counts\"][\"place\"], d[\"counts\"][\"relaunch\"]")" "(1, 1)"
check "a restore does not start it" "$(tc SnapshotsCall restore "{\"id\":\"$SID\",\"confirm\":true}" | J "d[\"counts\"].get(\"relaunch\"), len(d[\"failed\"])")" "(1, 0)"
sleep 2
check "...it is still not running" "$(ev "global.get_window_actors().map(a=>a.meta_window).filter(w=>w.title===\"w02\").length" | J "d")" "0"
check "launching an app with no desktop entry is reported, not fatal" "$(tc SnapshotsCall launch "{\"id\":\"$SID\",\"appId\":\"org.niro.TileTest2\"}" | J "d[\"ok\"], \"desktop entry\" in d[\"error\"]")" "(False, True)"
check "launching an app the snapshot does not name is refused" "$(tc SnapshotsCall launch "{\"id\":\"$SID\",\"appId\":\"evil.App\"}" | J "d[\"ok\"]")" "False"
check "a snapshot is deleted" "$(tc SnapshotsCall delete "{\"id\":\"$SID\"}" | J "d[\"ok\"]")" "True"

# ---- monitor recovery (the unplug is simulated on the layout manager)
OPEN 4; sleep 3; ev "Main.overview.hide(); 1" >/dev/null
ID4=$(WIN w04 id)
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w04\").move_to_monitor(1); 1" >/dev/null; sleep 2
check "w04 is on monitor 1 (set-up)" "$(WIN w04 mon)" "1"
UNPLUG="globalThis.__mons = Main.layoutManager.monitors; Main.layoutManager.monitors = [__mons[0]]; Main.layoutManager.emit(\"monitors-changed\"); 1"
REPLUG="Main.layoutManager.monitors = globalThis.__mons; Main.layoutManager.emit(\"monitors-changed\"); 1"
ev "$UNPLUG" >/dev/null; sleep 1.5
check "recovery off: an unplug moves no window" "$(WIN w04 mon)" "1"
ev "$REPLUG" >/dev/null
$TS monitor-recovery true; sleep 1
check "recovery on is reported" "$(tc MonitorStatus | J "d[\"enabled\"]")" "True"
ev "$UNPLUG" >/dev/null; sleep 2
check "recovery on: the window of the vanished monitor goes to the primary" "$(WIN w04 mon)" "0"
check "the status says one window was relocated" "$(tc MonitorStatus | J "d[\"last\"][\"relocated\"], list(d[\"remembered\"].values())")" "(1, [1])"
ev "$REPLUG" >/dev/null; sleep 2
check "the monitor returns: the window goes back" "$(WIN w04 mon)" "1"
check "...and nothing is left remembered" "$(tc MonitorStatus | J "d[\"remembered\"], d[\"last\"][\"restored\"]")" "({}, 1)"

# ---- window rules: opacity, and the `profile` condition (compositor only, so Tile may stay off)
Q=$(printf "\047")
OPA() { ev "global.get_window_actors().find(a=>a.meta_window.title===\"$1\").opacity" | J "d"; }
RULES() { $TS advanced-rules "$Q$1$Q"; sleep 1.6; }
check "w01 starts fully opaque" "$(OPA w01)" "255"
RULES "[{\"id\":\"dim\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"opacity\":0.5}}]"
check "rules engine off: the opacity rule does nothing" "$(OPA w01)" "255"
$TS rules-engine true; sleep 1.6
check "rules engine on: w01 gets half opacity" "$(OPA w01)" "128"
check "...and w04, which no rule matches, is untouched" "$(OPA w04)" "255"
RULES "[{\"id\":\"dim-p\",\"conditions\":{\"title\":\"w01\",\"profile\":\"focus\"},\"actions\":{\"opacity\":0.4}}]"
check "a rule that no longer matches puts the opacity back" "$(OPA w01)" "255"
mkdir -p "$WORK/cfg/niro-control"; echo "{\"active\":\"focus\"}" > "$WORK/cfg/niro-control/state.json"; sleep 2
check "the profile condition matches the active profile (state.json)" "$(OPA w01)" "102"
echo "{\"active\":\"gaming\"}" > "$WORK/cfg/niro-control/state.json"; sleep 2
check "another profile becomes active: the opacity is restored" "$(OPA w01)" "255"
echo "{\"active\":\"focus\"}" > "$WORK/cfg/niro-control/state.json"; sleep 2
check "the first profile again: dimmed again" "$(OPA w01)" "102"
RULES "[{\"id\":\"low\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"opacity\":0.1}}]"
check "the lowest opacity is a tenth" "$(OPA w01)" "26"
RULES "[{\"id\":\"bad\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"opacity\":0.01}}]"
check "an opacity below 0.1 is a refused rule: nothing is dimmed" "$(OPA w01)" "255"
RULES "[{\"id\":\"dim\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"opacity\":0.5}}]"
check "dimmed once more before disable" "$(OPA w01)" "128"

# ---- applying the rules to windows that are already open (ApplyRules / ApplyRulesPreview), and the full-screen action
FS() { ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"$1\").fullscreen" | J "d"; }
check "the workspace API lists the rules methods" "$(tc GetWorkspaceApi | J "\",\".join(d[\"rules\"])")" "ApplyRules,ApplyRulesPreview"
$TS rules-engine false; sleep 1
RULES "[{\"id\":\"mv\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"workspace\":2}},{\"id\":\"fs\",\"conditions\":{\"title\":\"w04\"},\"actions\":{\"fullscreen\":true}}]"
check "engine off: ApplyRules is refused in words" "$(tc ApplyRules | J "d[\"ok\"], \"engine is off\" in d[\"error\"]")" "(False, True)"
check "engine off: the preview is refused too" "$(tc ApplyRulesPreview | J "d[\"ok\"]")" "False"
check "...and w01 was not moved" "$(WIN w01 ws)" "1"
check "...and w04 is not full screen" "$(FS w04)" "False"
$TS rules-engine true; sleep 1.6
check "rules on, windows already open: they are not touched by themselves" "$(WIN w01 ws), $(FS w04)" "1, False"
check "the preview lists two windows and says it is a preview" "$(tc ApplyRulesPreview | J "d[\"ok\"], d[\"dryRun\"], len(d[\"applied\"]), \",\".join(sorted(k for a in d[\"applied\"] for k in a[\"actions\"])) == \"fullscreen,workspace\"")" "(True, True, 2, True)"
check "...and nothing changed" "$(WIN w01 ws), $(FS w04)" "1, False"
check "ApplyRules applies both" "$(tc ApplyRules | J "d[\"ok\"], d[\"dryRun\"], len(d[\"applied\"]), len(d[\"skipped\"])")" "(True, False, 2, 0)"
sleep 2
check "w01 moved to workspace 2" "$(WIN w01 ws)" "2"
check "w04 is full screen" "$(FS w04)" "True"
check "a second call is a no-op" "$(tc ApplyRules | J "d[\"ok\"], len(d[\"applied\"])")" "(True, 0)"
check "...and so is the preview" "$(tc ApplyRulesPreview | J "len(d[\"applied\"])")" "0"
RULES "[{\"id\":\"fs\",\"conditions\":{\"title\":\"w04\"},\"actions\":{\"fullscreen\":false}}]"
check "fullscreen false: one window would be taken out of full screen" "$(tc ApplyRules | J "len(d[\"applied\"]), d[\"applied\"][0][\"actions\"][\"fullscreen\"]")" "(1, False)"
sleep 2
check "w04 left full screen" "$(FS w04)" "False"
check "...and again nothing is pending" "$(tc ApplyRules | J "len(d[\"applied\"])")" "0"
RULES "[{\"id\":\"far\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"workspace\":30}}]"
check "a workspace that does not exist is reported as skipped, not applied" "$(tc ApplyRules | J "len(d[\"applied\"]), d[\"skipped\"][0][\"key\"] == \"workspace\"")" "(0, True)"
RULES "[{\"id\":\"fs5\",\"conditions\":{\"title\":\"w05\"},\"actions\":{\"fullscreen\":true}}]"
OPEN 5; sleep 3.5; ev "Main.overview.hide(); 1" >/dev/null
check "a window opened after the rule is made full screen when first seen" "$(FS w05)" "True"
RULES "[{\"id\":\"dim\",\"conditions\":{\"title\":\"w01\"},\"actions\":{\"opacity\":0.5}}]"
check "an opacity rule can be applied by hand too (nothing pending: the loop already did it)" "$(tc ApplyRules | J "len(d[\"applied\"])")" "0"
check "dimmed once more before disable (after the apply tests)" "$(OPA w01)" "128"

# ---- disable removes everything
ev "Main.extensionManager.disableExtension(\"tile@niro.local\")" >/dev/null; sleep 2
check "after disable the dimmed window is opaque again" "$(OPA w01)" "255"
ev "Main.layoutManager.emit(\"monitors-changed\"); 1" >/dev/null; sleep 1
check "after disable ApplyRules is gone with the name" "$(tc ApplyRules | grep -c "ServiceUnknown\|not provided")" "1"
check "after disable the D-Bus name is gone" "$(tc GetWorkspaceApi | grep -c "ServiceUnknown\|not provided")" "1"
kill $(cat "$WORK/pids" 2>/dev/null) 2>/dev/null; kill %1' 2>&1 | grep -E "^(ok|FAIL)" | tee "$WORK/out.txt"
echo "log: $(grep -c "JS ERROR" "$LOG") JS ERROR line(s), $(grep -c "Tile:" "$LOG") Tile warning line(s)"
grep -E "JS ERROR|Tile:" "$LOG" | head -5
FAILS=$(grep -c "^FAIL" "$WORK/out.txt"); OKS=$(grep -c "^ok" "$WORK/out.txt")
echo
[ "$OKS" -ge 70 ] || { echo "FAIL only $OKS checks ran, wanted 70"; FAILS=$((FAILS+1)); }
[ "$FAILS" = 0 ] && echo "tile workspace checks: all passed ($OKS)" || { echo "tile workspace checks: $FAILS failed"; exit 1; }
