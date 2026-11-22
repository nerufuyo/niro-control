#!/bin/bash
# Niro's Shell extensions against a real GNOME Shell (headless, Wayland, its own D-Bus session): they load without errors,
# the action registry answers over D-Bus, the assistant's gateway (island-daemon --niro-action) obeys the same rules, and the
# palette finds what it should. Needs the installed package (the extensions are read from /usr/share) and a built daemon.
# It reads the real dconf (headless.sh only; mascot.sh uses its own) but changes nothing: the only action run is a clipboard copy, and a restart is declined.
set -u
cd "$(dirname "$0")/../.."
# The test must not write the real ~/.local/share (Search's audit log, snips): run-staged.sh already isolates it, a direct run does here.
[ -n "${NIRO_TEST_ISOLATED:-}" ] || { export XDG_DATA_HOME; XDG_DATA_HOME=$(mktemp -d); }
DAEMON="${DAEMON:-$PWD/target/release/island-daemon}"
[ -x "$DAEMON" ] || DAEMON=/usr/bin/island-daemon
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
has() { if [[ "$2" == *"$3"* ]]; then echo "ok   $1"; else echo "FAIL $1: [$2] lacks [$3]"; FAILS=$((FAILS+1)); fi; }

timeout 300 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-test --virtual-monitor 1280x720 > '"$LOG"' 2>&1 & SP=$!
sleep 22
[ -n "${NIRO_EXT_ROOT:-}" ] && { for e in island dock search blur corners emoji emulator tile; do gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "Main.extensionManager.enableExtension(\"$e@niro.local\")" >/dev/null 2>&1; done; sleep 10; }
export DAEMON='"$DAEMON"'
eval_js() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
call() { gdbus call --session --dest org.niro.Search --object-path /org/niro/Search --method org.niro.Search."$@" 2>&1; }
O="Main.extensionManager.lookup(\"search@niro.local\").stateObj"
{
echo "STATE $(for e in island dock search blur corners emoji emulator tile; do echo -n "$e=$(gnome-extensions info $e@niro.local 2>&1 | grep State | tr -d " ") "; done)"
# gdbus prints the JSON string with its quotes escaped when a description holds an apostrophe, so the pattern allows a backslash
echo "ACTIONS $(call ListActions | grep -oE "\"id[\\]*\":[\\]*\"[a-z.-]+" | wc -l)"
echo "NOHANDLER $(call ListActions | grep -cE "\"run[\\]*\":")"
echo "AVAIL $(call Availability profile.apply | grep -o "available\":[a-z]*")"
echo "NETSPEED $(call RunAction system.network.speed "{}" | grep -o "Download [^\\\"]*")"
echo "BATTERY $(call RunAction system.battery.info "{}" | grep -o "\"ok\":[a-z]*")"
echo "ZOOM $(call RunAction system.zoom.toggle "{}" | grep -o "Magnifier o[a-z]*")"
echo "COPY $(call RunAction clipboard.copy "{\"text\":\"niro-headless\"}" | grep -o "\"ok\":[a-z]*")"
echo "UNKNOWN $(call RunAction nope.x "{}" | grep -o "unknown")"
echo "EXTRA $(call RunAction system.lock "{\"evil\":1}" | grep -o "invalid")"
echo "AI_UNKNOWN $($DAEMON --niro-action "system.format-disk" "{}" | grep -o "code\":\"[a-z]*")"
echo "AI_SHELLID $($DAEMON --niro-action "system.lock;rm -rf" "{}" | grep -o "code\":\"[a-z]*")"
echo "AI_ARGS $($DAEMON --niro-action profile.apply "{\"id\":5}" | grep -o "code\":\"[a-z]*")"
echo "MODAL_BASE $(eval_js "Main.modalCount" | grep -oE "[0-9]+.\)$" | grep -oE "^[0-9]+")"
( $DAEMON --niro-action system.restart "{}" > /tmp/niro_restart.txt 2>&1 & ); sleep 2
echo "MODAL $(eval_js "Main.modalCount" | grep -oE "[0-9]+.\)$" | grep -oE "^[0-9]+")"
echo "DUP $($DAEMON --niro-action system.restart "{}" | grep -o "code\":\"[a-z]*")"
eval_js "(function(){ const find=(a)=>{ if (a instanceof imports.gi.St.Button && a.label==\"Cancel\") return a; for (const c of a.get_children?.()??[]) { const r=find(c); if (r) return r; } return null; }; const b=find(Main.uiGroup); if(b) b.emit(\"clicked\", 1); return \"x\"; })()" >/dev/null
sleep 2
echo "DECLINED $(grep -o "code\":\"[a-z]*" /tmp/niro_restart.txt)"
for q in "2*pi" "20 gb to mb" "dock pos" "profile" "qqqzzzxx"; do
  eval_js "$O._open(); $O._entry.set_text(\"$q\"); JSON.stringify($O._results.map(r=>r.section+\":\"+r.title).slice(0,3))" | sed "s/^/QUERY[$q] /"
done
eval_js "$O._close()" >/dev/null
# the keyboard: the first result is selected, the hint says Enter asks to confirm for a protected action, and a second activation is refused
eval_js "$O._open(); $O._entry.set_text(\"restart\"); \"SEL=\"+$O._selected+\" HINT=\"+$O._hint.text" | sed "s/^/KEYS /"
eval_js "$O._close(); \"x\"" >/dev/null
echo "ONCE $(eval_js "(function(){ const o=$O._once; return [o.begin(), o.begin()].join(); })()" | grep -o "true,false")"
eval_js "$O._once.end()" >/dev/null
# focus comes back to the window that had it when the palette closes
( WAYLAND_DISPLAY=niro-test GDK_BACKEND=wayland gjs -c "imports.gi.versions.Gtk=\"4.0\"; const {Gtk,GLib}=imports.gi; Gtk.init(); new Gtk.Window({title:\"focus-probe\"}).present(); GLib.MainLoop.new(null,false).run();" >/dev/null 2>&1 & echo $! > /tmp/niro_probe.pid ); sleep 5
eval_js "global.get_window_actors().find(a=>a.meta_window.title==\"focus-probe\").meta_window.activate(global.get_current_time()); \"x\"" >/dev/null; sleep 2
echo "FOCUS_BEFORE $(eval_js "global.display.focus_window ? global.display.focus_window.title : \"none\"" | grep -o "focus-probe\|none")"
eval_js "$O._open(); \"x\"" >/dev/null; sleep 1; eval_js "$O._close(); \"x\"" >/dev/null; sleep 1
echo "PREF $(eval_js "$O._pref(\"weather-days\", -1) + \"|\" + $O._pref(\"tools-above-apps\", \"missing\") + \"|\" + $O._lang()")"
echo "SWITCHER $(eval_js "$O._switcher.open(); const n = $O._switcher._windows.length; const was = $O._switcher.isOpen; $O._switcher.close(); n + \":\" + was + \":\" + $O._switcher.isOpen")"
echo "FOCUS_AFTER $(eval_js "global.display.focus_window ? global.display.focus_window.title : \"none\"" | grep -o "focus-probe\|none")"
echo "ADAPTIVE $(eval_js "$O._pref = (k, f) => k === \"adaptive-suggestions\" ? true : f; const r = $O._adaptiveSuggestion(); delete $O._pref; String(r)")"
echo "ADAPTROW $(eval_js "$O._adaptive = {profile: {id: \"deep-work\", name: \"Deep Work\"}, reason: \"Code is in front\"}; const t = $O._suggestions()[0]; $O._adaptive = null; t.title + \"|\" + t.action")"
# ---- Search runtime: permissions, planner, macros, adaptive (the settings are the real ones, in the shell'"'"'s own memory backend; config files go to a scratch dir)
CFG=/tmp/niro-headless-cfg; rm -rf $CFG
eval_js "$O._configPath = n => \"$CFG/\" + n; \"x\"" >/dev/null
setpref() { eval_js "new imports.gi.Gio.Settings({schema_id: \"org.niro.control\"}).set_boolean(\"$1\", $2); \"x\"" >/dev/null; }
click() { eval_js "(function(){ const find=(a)=>{ if (a instanceof imports.gi.St.Button && a.label==\"$1\") return a; for (const c of a.get_children?.()??[]) { const r=find(c); if (r) return r; } return null; }; const b=find(Main.uiGroup); if(b) b.emit(\"clicked\", 1); return b ? \"clicked\" : \"nobutton\"; })()" | grep -o "clicked\|nobutton"; }
# ask: runs a call that opens a dialog, presses a button, and prints the call'"'"'s answer
ask() { local btn="$1"; shift; ( call "$@" > /tmp/niro_ask.txt 2>&1 & ); sleep 1.5; click "$btn" >/dev/null; sleep 1.5; cat /tmp/niro_ask.txt; }
echo "PERM_OFF_LIST $(call ListGrants | grep -o "enforced\":[a-z]*")"
echo "PERM_OFF_RUN $(call RunAction clipboard.copy "{\"text\":\"p0\"}" | grep -o "\"ok\":[a-z]*")"
setpref permissions-enforced true
echo "PERM_ON_LIST $(call ListGrants | grep -o "enforced\":[a-z]*")"
echo "PERM_DENIED $(ask Deny RunAction clipboard.copy "{\"text\":\"p1\"}" | grep -o "code\":\"[a-z]*")"
echo "PERM_NOCAP $(call RunAction url.clean "{\"url\":\"https://a.com/?utm_source=x\"}" | grep -o "\"ok\":[a-z]*")"
echo "PERM_ALWAYS $(ask "Always allow" RunAction clipboard.copy "{\"text\":\"p2\"}" | grep -o "\"ok\":[a-z]*")"
echo "PERM_REMEMBERED $(call RunAction clipboard.copy "{\"text\":\"p3\"}" | grep -o "\"ok\":[a-z]*")"
echo "PERM_GRANTS $(call ListGrants | grep -o "gdbus[^}]*")"
echo "PERM_FILE $(grep -o "clipboard\",\"scope\":\"always" $CFG/permissions.json)"
echo "PERM_OTHERCAP $(ask Deny RunAction system.battery.info "{}" | grep -o "code\":\"[a-z]*")"
echo "GRANT_DENY $(call Grant gdbus window deny | grep -o "\"ok\":[a-z]*")"
echo "GRANT_WINDOW_BLOCKED $(call RunAction window.activate "{\"id\":123456}" | grep -o "code\":\"[a-z]*")"
echo "GRANT_BADCAP $(call Grant gdbus teleport always | grep -o "code\":\"[a-z]*")"
echo "GRANT_ALLOW_DECLINED $(ask Cancel Grant gdbus file always | grep -o "code\":\"[a-z]*")"
echo "REVOKE $(call Revoke gdbus clipboard | grep -o "\"ok\":[a-z]*")"
echo "PERM_AFTER_REVOKE $(ask Deny RunAction clipboard.copy "{\"text\":\"p4\"}" | grep -o "code\":\"[a-z]*")"
echo "PERM_HISTORY $(call PermissionHistory 50 | grep -o "\"verdict\":\"[a-z]*" | sort -u | tr "\n" " ")"
echo "PERM_HISTORY_NOARGS $(call PermissionHistory 50 | grep -c "p1\|p2\|p3")"
call Revoke gdbus "" >/dev/null
echo "PERM_REVOKED_ALL $(call ListGrants | grep -o "grants\":[^}]*")"
echo "PERM_CLEARED $(call ClearPermissionHistory | grep -o "\"ok\":[a-z]*") $(call PermissionHistory 50 | grep -o "\[\]")"
setpref permissions-enforced false
echo "PERM_BACK_OFF $(call RunAction clipboard.copy "{\"text\":\"p5\"}" | grep -o "\"ok\":[a-z]*")"
echo "PLAN_PREVIEW $(call RunAction plan.preview "{\"text\":\"open firefox then mute\"}" | grep -o "Nothing was run")"
echo "PLAN_NOTUNDERSTOOD $(call RunAction plan.preview "{\"text\":\"make me a sandwich\"}" | grep -o "Not understood")"
echo "PLAN_COPY $(call RunAction plan.preview "{\"text\":\"copy hello to clipboard\"}" | grep -o "Copy text text=.*hello" | head -1)"
echo "PLAN_HINT $(call RunAction plan.preview "{\"text\":\"brew me a coffee\"}" | tr -d "\\\\" | cut -c1-300)"
echo "PLAN_RUN_DECLINED $(ask Cancel RunAction plan.run "{\"text\":\"open firefox\"}" | grep -o "code\":\"[a-z]*")"
q() { local s=${1//\\/\\\\}; printf "\047%s\047" "$s"; }   # a GVariant string literal, so gdbus takes the backslashes of the JSON as they are
echo "MACRO_SAVE $(call RunAction macro.save "$(q "{\"name\":\"speed\",\"steps\":\"[{\\\"action\\\":\\\"system.network.speed\\\"}]\"}")" | grep -o "saved")"
echo "MACRO_SENSITIVE $(call RunAction macro.save "$(q "{\"name\":\"bad\",\"steps\":\"[{\\\"action\\\":\\\"app.launch\\\",\\\"args\\\":{\\\"id\\\":\\\"x\\\",\\\"password\\\":\\\"hunter2\\\"}}]\"}")" | grep -o "\"ok\":[a-z]*")"
echo "MACRO_LIST $(call RunAction macro.list "{}" | grep -o "speed: 1 steps")"
echo "MACRO_LOOPCAP $(call RunAction macro.play "{\"name\":\"speed\",\"loops\":99}" | grep -o "code\":\"[a-z]*")"
echo "MACRO_PLAY $(ask "Play a macro" RunAction macro.play "{\"name\":\"speed\"}" | grep -o "All 1 step done")"
echo "MACRO_STOP $(call RunAction macro.stop "{}" | grep -o "No macro is playing")"
setpref adaptive-suggestions true
setpref adaptive-live true
echo "ADAPT_LIVE_ON $(eval_js "String($O._liveIds && $O._liveIds.length)")"
setpref adaptive-live false
echo "ADAPT_LIVE_OFF $(eval_js "String($O._liveIds)")"
setpref adaptive-suggestions false
eval_js "$O._lastSuggestion = {ruleId: \"code\", profile: \"deep-work\"}; \"x\"" >/dev/null
echo "ADAPT_DISMISS $(call RunAction adaptive.dismiss "{}" | grep -o "Dismissed")"
echo "ADAPT_HISTORY $(call RunAction adaptive.history "{}" | grep -o "dismissed  code  deep-work")"
sleep 2
echo "ADAPT_LOCK $(call RunAction adaptive.lock "{\"state\":\"lock\"}" | grep -o "Suggestions locked")"
sleep 2
echo "ADAPT_LOCKED_HISTORY $(call RunAction adaptive.history "{}" | grep -o "Suggestions are locked")"
call RunAction adaptive.lock "{\"state\":\"unlock\"}" >/dev/null
echo "ADAPT_NOROW $(eval_js "$O._adaptive = null; String($O._suggestions().some(r => r.action === \"adaptive.dismiss\"))")"
# ---- Flow events (opt-in): nothing is connected while off; on, the real Shell signals feed the emitter; off again, everything is gone
echo "FLOWEV_OFF $(eval_js "String($O._flow)")"
setpref flow-events true
echo "FLOWEV_ON $(eval_js "String($O._flow && $O._flow.sources.connected())")"
eval_js "global.workspace_manager.append_new_workspace(false, global.get_current_time()); global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); \"x\"" >/dev/null; sleep 2
echo "FLOWEV_SENT $(eval_js "String($O._flow && $O._flow.emitter.stats().attempted)")"
setpref flow-events false
echo "FLOWEV_GONE $(eval_js "String($O._flow)")"
# ---- System Experience: every part is opt-in; off means the actions are unavailable and nothing listens (config files go to the same scratch dir)
echo "SX_OFF $(call RunAction audio.devices "{}" | grep -o "code\":\"[a-z]*")"
echo "SX_PERF $(call RunAction perf.report "{}" | grep -o "Memory [0-9.]* GB")"
echo "SX_PERF_EXPORT $(call RunAction perf.export "{}" | grep -o "unavailable")"
setpref shelf-collections true
echo "SX_SHELF_NEW $(call RunAction collection.create "{\"name\":\"Trip\"}" | grep -o "created")"
echo "SX_SHELF_ADD $(call RunAction collection.add "{\"name\":\"Trip\",\"kind\":\"url\",\"value\":\"https://example.org\"}" | grep -o "Added to Trip")"
echo "SX_SHELF_SECRET $(call RunAction collection.add "{\"name\":\"Trip\",\"kind\":\"text\",\"value\":\"password: hunter2hunter2\"}" | grep -o "looks like a secret")"
echo "SX_SHELF_LIST $(call RunAction collection.list "{}" | grep -o "Trip: 1 item")"
echo "SX_SHELF_FILE $(grep -c example.org $CFG/shelf-collections.json) $(grep -c hunter2 $CFG/shelf-collections.json)"
echo "SX_SHELF_DELETE_ASKS $(ask Cancel RunAction collection.delete "{\"name\":\"Trip\"}" | grep -o "code\":\"[a-z]*")"
setpref shelf-collections false
echo "SX_SHELF_OFF $(call RunAction collection.list "{}" | grep -o "code\":\"[a-z]*")"
setpref universal-hud true
echo "SX_HUD $(call RunAction hud.show "{\"kind\":\"battery\",\"label\":\"Battery 40%\",\"level\":40}" | grep -o "\"ok\":[a-z]*")"
setpref universal-hud false
setpref privacy-dashboard true
echo "SX_PRIVACY_LISTEN $(eval_js "String($O._watchers.screen._remote !== null)")"
echo "SX_PRIVACY $(call RunAction privacy.status "{}" | grep -o "Microphone: [a-z]*")"
setpref privacy-dashboard false
echo "SX_PRIVACY_STOPPED $(eval_js "String($O._watchers.screen._remote)")"
setpref notification-hub true
echo "SX_NOTIF_LISTEN $(eval_js "String($O._watchers.notifications.active)")"
call RunAction notifications.rule "{\"app\":\"System\",\"verdict\":\"silent\"}" >/dev/null
eval_js "Main.notify(\"probe-one\", \"x\"); \"x\"" >/dev/null; sleep 1
SUMMARY=$(call RunAction notifications.summary "{}")      # one call: the same request twice within 1.5 s is refused as a duplicate
echo "SX_NOTIF_COUNTED $(echo "$SUMMARY" | grep -o "System: [0-9]*")"
echo "SX_NOTIF_RAW $(echo "$SUMMARY" | head -c 200)"
echo "SX_NOTIF_NOT_APPLIED $(eval_js "String(Main.messageTray.getSources().flatMap(s => s.notifications).filter(n => n.source.title == \"System\").some(n => n.acknowledged))")"
setpref notification-hub-apply true
eval_js "Main.notify(\"probe-two\", \"x\"); \"x\"" >/dev/null; sleep 1
echo "SX_NOTIF_SILENCED $(eval_js "String(Main.messageTray.getSources().flatMap(s => s.notifications).filter(n => n.source.title == \"System\").some(n => n.acknowledged))")"
call RunAction notifications.rule "{\"app\":\"System\",\"verdict\":\"hide\"}" >/dev/null
eval_js "Main.notify(\"probe-three\", \"x\"); \"x\"" >/dev/null; sleep 2
echo "SX_NOTIF_HIDDEN $(eval_js "String(Main.messageTray.getSources().flatMap(s => s.notifications).filter(n => n.source.title == \"System\" && n.title == \"probe-three\").length)")"
echo "SX_NOTIF_NOTEXT $(grep -c "probe-" $CFG/notification-rules.json)"
setpref notification-hub-apply false
setpref notification-hub false
echo "SX_NOTIF_STOPPED $(eval_js "String($O._watchers.notifications.active)")"
echo "SX_LOOPS_OFF $(eval_js "JSON.stringify($O._hub._state().loops)")"
setpref smart-clipboard true
setpref perf-recording true
echo "SX_LOOPS_ON $(eval_js "$O._hub._state().loops.sort().join(\"+\")")"
setpref smart-clipboard false
setpref perf-recording false
echo "SX_LOOPS_CLEARED $(eval_js "JSON.stringify($O._hub._state().loops)")"
eval_js "delete $O._configPath; \"x\"" >/dev/null; rm -rf $CFG
kill $(cat /tmp/niro_probe.pid) 2>/dev/null
echo "HISTORY $(call History 50 | grep -o "\"caller\":\"[a-z-]*\"" | sort -u | tr "\n" " ")"
} 2>&1 | grep -E "^(STATE|ACTIONS|NOHANDLER|AVAIL|NETSPEED|BATTERY|ZOOM|PREF|SWITCHER|ADAPTIVE|ADAPTROW|PERM_|GRANT_|REVOKE|PLAN_|FLOWEV_|MACRO_|ADAPT_|SX_|COPY|UNKNOWN|EXTRA|AI_|MODAL|MODAL_BASE|DUP|DECLINED|QUERY|HISTORY|KEYS|ONCE|FOCUS_)"
kill $SP; wait $SP 2>/dev/null' > /tmp/niro_headless.out 2>&1

OUT=$(grep -E "^(STATE|ACTIONS|NOHANDLER|AVAIL|NETSPEED|BATTERY|ZOOM|PREF|SWITCHER|ADAPTIVE|ADAPTROW|PERM_|GRANT_|REVOKE|PLAN_|FLOWEV_|MACRO_|ADAPT_|SX_|COPY|UNKNOWN|EXTRA|AI_|MODAL|MODAL_BASE|DUP|DECLINED|QUERY|HISTORY|KEYS|ONCE|FOCUS_)" /tmp/niro_headless.out)
has "all eight extensions active" "$OUT" "island=State:ACTIVE dock=State:ACTIVE search=State:ACTIVE blur=State:ACTIVE corners=State:ACTIVE emoji=State:ACTIVE emulator=State:ACTIVE tile=State:ACTIVE"
has "seventy-eight actions listed" "$OUT" "ACTIONS 78"
has "no handlers exposed" "$OUT" "NOHANDLER 0"
has "availability answers" "$OUT" 'available":true'
has "network speed answers" "$OUT" "NETSPEED Download"
has "magnifier toggles" "$OUT" "ZOOM Magnifier on"
has "battery action answers, with or without a battery" "$OUT" 'BATTERY "ok"'
has "harmless action runs" "$OUT" 'COPY "ok":true'
has "unknown action refused" "$OUT" "UNKNOWN unknown"
has "extra argument refused" "$OUT" "EXTRA invalid"
has "assistant: invented id refused" "$OUT" 'AI_UNKNOWN code":"unknown'
has "assistant: shell-shaped id refused" "$OUT" 'AI_SHELLID code":"unknown'
has "assistant: bad arguments refused" "$OUT" 'AI_ARGS code":"invalid'
# the confirmation dialog takes one more modal grab than the shell holds already (that base differs between versions)
BASE=$(echo "$OUT" | grep -oP "^MODAL_BASE \K[0-9]+" | head -1)
has "restart waits for confirmation (a modal dialog opens)" "$OUT" "MODAL $((BASE + 1))"
has "the same request twice is refused" "$OUT" 'DUP code":"duplicate'
has "declining returns declined, nothing ran" "$OUT" 'DECLINED code":"declined'
has "palette: calculator first" "$OUT" "Calculator:6.283185307"
has "palette: conversion" "$OUT" "Conversion:20,000 MB"
has "palette: settings" "$OUT" "Settings:Dock position"
has "palette: profiles" "$OUT" "Profiles:Everyday"
has "palette: nothing found is empty" "$OUT" 'QUERY[qqqzzzxx] (true, '"'"'"[]"'
has "keyboard: first result selected, protected action says Enter asks to confirm" "$OUT" "SEL=0 HINT=Enter asks to confirm"
has "a second activation is refused" "$OUT" "ONCE true,false"
has "Search reads the new settings (days, tools first, language)" "$OUT" 'PREF (true, '"'"'"3|true|en"'"'"')'
has "adaptive: no rule fits an unknown window, and nothing fails" "$OUT" 'ADAPTIVE (true, '"'"'"null"'"'"')'
has "adaptive: the suggestion shows first in Search, applying a profile" "$OUT" 'ADAPTROW (true, '"'"'"Switch to Deep Work?|profile.apply"'"'"')'
has "the switcher opens on the open windows and closes again" "$OUT" 'SWITCHER (true, '"'"'"1:true:false"'"'"')'
has "focus returns to the window that had it" "$OUT" "FOCUS_AFTER focus-probe"
has "permissions: off by default, an outside program is not asked" "$OUT" 'PERM_OFF_LIST enforced":false'
has "permissions: off keeps today's behaviour" "$OUT" 'PERM_OFF_RUN "ok":true'
has "permissions: on after the setting" "$OUT" 'PERM_ON_LIST enforced":true'
has "permissions: a program that is denied is refused" "$OUT" 'PERM_DENIED code":"denied'
has "permissions: an action with no capability needs none" "$OUT" 'PERM_NOCAP "ok":true'
has "permissions: Always allow runs the action" "$OUT" 'PERM_ALWAYS "ok":true'
has "permissions: an always grant is not asked again" "$OUT" 'PERM_REMEMBERED "ok":true'
has "permissions: the grant is listed with the caller" "$OUT" 'gdbus","capability":"clipboard","scope":"always"'
has "permissions: only always/deny are in the file" "$OUT" 'PERM_FILE clipboard","scope":"always'
has "permissions: another capability asks separately" "$OUT" 'PERM_OTHERCAP code":"denied'
has "grant: a program can restrict itself without a dialog" "$OUT" 'GRANT_DENY "ok":true'
has "grant: the denial blocks the next call" "$OUT" 'GRANT_WINDOW_BLOCKED code":"denied'
has "grant: an unknown capability is refused" "$OUT" 'GRANT_BADCAP code":"invalid'
has "grant: more access needs a yes on screen (declined)" "$OUT" 'GRANT_ALLOW_DECLINED code":"declined'
has "revoke answers" "$OUT" 'REVOKE "ok":true'
has "revoke is enforced on the next call" "$OUT" 'PERM_AFTER_REVOKE code":"denied'
has "permission history keeps verdicts" "$OUT" 'PERM_HISTORY "verdict":"allow "verdict":"ask "verdict":"deny'
has "permission history holds no arguments" "$OUT" 'PERM_HISTORY_NOARGS 0'
has "revoke all leaves nothing" "$OUT" 'PERM_REVOKED_ALL grants":[]'
has "history clears" "$OUT" 'PERM_CLEARED "ok":true []'
has "permissions off again: unchanged behaviour" "$OUT" 'PERM_BACK_OFF "ok":true'
has "plan.preview shows steps and runs nothing" "$OUT" 'PLAN_PREVIEW Nothing was run'
has "plan.preview says when it did not understand" "$OUT" 'PLAN_NOTUNDERSTOOD Not understood'
has "plan.preview understands copy X to clipboard" "$OUT" 'PLAN_COPY Copy text text='
has "plan.preview, when it does not understand, lists a phrasing that works" "$OUT" 'for example: "copy hello to clipboard"'
has "flow-events: nothing is connected while it is off" "$OUT" 'FLOWEV_OFF (true, '"'"'"null"'"'"')'
has "flow-events: on, five real listeners" "$OUT" 'FLOWEV_ON (true, '"'"'"5"'"'"')'
has "flow-events: a real workspace switch reaches the emitter" "$OUT" 'FLOWEV_SENT (true, '"'"'"1"'"'"')'
has "flow-events: off again, everything is dropped" "$OUT" 'FLOWEV_GONE (true, '"'"'"null"'"'"')'
has "plan.run asks first and cancelling runs nothing" "$OUT" 'PLAN_RUN_DECLINED code":"declined'
has "macro.save keeps a valid macro" "$OUT" 'MACRO_SAVE saved'
has "macro.save refuses a sensitive step" "$OUT" 'MACRO_SENSITIVE "ok":false'
has "macro.list lists it" "$OUT" 'MACRO_LIST speed: 1 steps'
has "macro loop cap" "$OUT" 'MACRO_LOOPCAP code":"invalid'
has "macro.play asks, then plays through the registry" "$OUT" 'MACRO_PLAY All 1 step done'
has "macro.stop with nothing playing" "$OUT" 'MACRO_STOP No macro is playing'
has "adaptive-live listens only while on" "$OUT" 'ADAPT_LIVE_ON (true, '"'"'"2"'"'"')'
has "adaptive-live removes its listeners when turned off" "$OUT" 'ADAPT_LIVE_OFF (true, '"'"'"null"'"'"')'
has "adaptive.dismiss answers" "$OUT" 'ADAPT_DISMISS Dismissed'
has "adaptive history shows the dismissal" "$OUT" 'ADAPT_HISTORY dismissed  code  deep-work'
has "adaptive lock" "$OUT" 'ADAPT_LOCK Suggestions locked'
has "adaptive lock shows in the history" "$OUT" 'ADAPT_LOCKED_HISTORY Suggestions are locked'
has "no dismiss row without a suggestion" "$OUT" 'ADAPT_NOROW (true, '"'"'"false"'"'"')'
has "system experience: off by default, the action is unavailable" "$OUT" 'SX_OFF code":"unavailable'
has "performance: a reading on demand" "$OUT" 'SX_PERF Memory'
has "performance: the export lists what it cannot read" "$OUT" 'SX_PERF_EXPORT unavailable'
has "shelf: a collection is made" "$OUT" 'SX_SHELF_NEW created'
has "shelf: a web address is added" "$OUT" 'SX_SHELF_ADD Added to Trip'
has "shelf: a secret is refused" "$OUT" 'SX_SHELF_SECRET looks like a secret'
has "shelf: the list shows it" "$OUT" 'SX_SHELF_LIST Trip: 1 item'
has "shelf: saved, and the secret is not in the file" "$OUT" 'SX_SHELF_FILE 1 0'
has "shelf: deleting asks first" "$OUT" 'SX_SHELF_DELETE_ASKS code":"declined'
has "shelf: off again, unavailable" "$OUT" 'SX_SHELF_OFF code":"unavailable'
has "hud: shows through the on-screen display" "$OUT" 'SX_HUD "ok":true'
has "privacy: the screen-share listener starts with the setting" "$OUT" 'SX_PRIVACY_LISTEN (true, '"'"'"true"'"'"')'
has "privacy: the microphone is reported" "$OUT" 'SX_PRIVACY Microphone:'
has "privacy: the listener is gone when it is off" "$OUT" 'SX_PRIVACY_STOPPED (true, '"'"'"null"'"'"')'
has "notifications: the watcher starts with the setting" "$OUT" 'SX_NOTIF_LISTEN (true, '"'"'"true"'"'"')'
has "notifications: counted by application" "$OUT" 'SX_NOTIF_COUNTED System: 1'
has "notifications: a silent rule changes nothing until apply is on" "$OUT" 'SX_NOTIF_NOT_APPLIED (true, '"'"'"false"'"'"')'
has "notifications: a silent rule acknowledges the notification (no banner)" "$OUT" 'SX_NOTIF_SILENCED (true, '"'"'"true"'"'"')'
has "notifications: a hide rule removes it" "$OUT" 'SX_NOTIF_HIDDEN (true, '"'"'"0"'"'"')'
has "notifications: no notification text in the rules file" "$OUT" 'SX_NOTIF_NOTEXT 0'
has "notifications: the watcher is gone when it is off" "$OUT" 'SX_NOTIF_STOPPED (true, '"'"'"false"'"'"')'
has "no loops run while everything is off" "$OUT" 'SX_LOOPS_OFF (true, '"'"'"[]"'"'"')'
has "clipboard clean-up and performance recording start with their settings" "$OUT" 'SX_LOOPS_ON (true, '"'"'"clipboard+perf"'"'"')'
has "and stop with them" "$OUT" 'SX_LOOPS_CLEARED (true, '"'"'"[]"'"'"')'
has "audit names the caller" "$OUT" '"caller":"island-daemon"'
grep "JS ERROR" "$LOG" | head -3
check "no JS errors in the shell" "$(grep -c 'JS ERROR' "$LOG")" "0"
echo; [ $FAILS -eq 0 ] && echo "headless shell checks: all passed" || { echo "headless shell checks: $FAILS failed"; echo "$OUT" | head -40; exit 1; }
