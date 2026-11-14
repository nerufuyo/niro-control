#!/bin/bash
# Niro's Shell extensions against a real GNOME Shell (headless, Wayland, its own D-Bus session): they load without errors,
# the action registry answers over D-Bus, the assistant's gateway (island-daemon --niro-action) obeys the same rules, and the
# palette finds what it should. Needs the installed package (the extensions are read from /usr/share) and a built daemon.
# It reads the real dconf but changes nothing: the only action run is a clipboard copy, and a restart is declined.
set -u
cd "$(dirname "$0")/../.."
DAEMON="${DAEMON:-$PWD/target/release/island-daemon}"
[ -x "$DAEMON" ] || DAEMON=/usr/bin/island-daemon
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
has() { if [[ "$2" == *"$3"* ]]; then echo "ok   $1"; else echo "FAIL $1: [$2] lacks [$3]"; FAILS=$((FAILS+1)); fi; }

timeout 150 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --virtual-monitor 1280x720 > '"$LOG"' 2>&1 & SP=$!
sleep 22
export DAEMON='"$DAEMON"'
eval_js() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
call() { gdbus call --session --dest org.niro.Search --object-path /org/niro/Search --method org.niro.Search."$@" 2>&1; }
O="Main.extensionManager.lookup(\"search@niro.local\").stateObj"
{
echo "STATE $(for e in island dock search blur corners emoji emulator; do echo -n "$e=$(gnome-extensions info $e@niro.local 2>&1 | grep State | tr -d " ") "; done)"
echo "ACTIONS $(call ListActions | grep -o "\"id\":\"[a-z.-]*\"" | wc -l)"
echo "NOHANDLER $(call ListActions | grep -c "\"run\":")"
echo "AVAIL $(call Availability profile.apply | grep -o "available\":[a-z]*")"
echo "COPY $(call RunAction clipboard.copy "{\"text\":\"niro-headless\"}" | grep -o "\"ok\":[a-z]*")"
echo "UNKNOWN $(call RunAction nope.x "{}" | grep -o "unknown")"
echo "EXTRA $(call RunAction system.lock "{\"evil\":1}" | grep -o "invalid")"
echo "AI_UNKNOWN $($DAEMON --niro-action "system.format-disk" "{}" | grep -o "code\":\"[a-z]*")"
echo "AI_SHELLID $($DAEMON --niro-action "system.lock;rm -rf" "{}" | grep -o "code\":\"[a-z]*")"
echo "AI_ARGS $($DAEMON --niro-action profile.apply "{\"id\":5}" | grep -o "code\":\"[a-z]*")"
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
echo "HISTORY $(call History 50 | grep -o "\"caller\":\"[a-z-]*\"" | sort -u | tr "\n" " ")"
} 2>&1 | grep -E "^(STATE|ACTIONS|NOHANDLER|AVAIL|COPY|UNKNOWN|EXTRA|AI_|MODAL|DUP|DECLINED|QUERY|HISTORY)"
kill $SP; wait $SP 2>/dev/null' > /tmp/niro_headless.out 2>&1

OUT=$(grep -E "^(STATE|ACTIONS|NOHANDLER|AVAIL|COPY|UNKNOWN|EXTRA|AI_|MODAL|DUP|DECLINED|QUERY|HISTORY)" /tmp/niro_headless.out)
has "all seven extensions active" "$OUT" "island=State:ACTIVE dock=State:ACTIVE search=State:ACTIVE blur=State:ACTIVE corners=State:ACTIVE emoji=State:ACTIVE emulator=State:ACTIVE"
has "twelve actions listed" "$OUT" "ACTIONS 12"
has "no handlers exposed" "$OUT" "NOHANDLER 0"
has "availability answers" "$OUT" 'available":true'
has "harmless action runs" "$OUT" 'COPY "ok":true'
has "unknown action refused" "$OUT" "UNKNOWN unknown"
has "extra argument refused" "$OUT" "EXTRA invalid"
has "assistant: invented id refused" "$OUT" 'AI_UNKNOWN code":"unknown'
has "assistant: shell-shaped id refused" "$OUT" 'AI_SHELLID code":"unknown'
has "assistant: bad arguments refused" "$OUT" 'AI_ARGS code":"invalid'
has "restart waits for confirmation (a modal dialog opens)" "$OUT" "MODAL 2"
has "the same request twice is refused" "$OUT" 'DUP code":"duplicate'
has "declining returns declined, nothing ran" "$OUT" 'DECLINED code":"declined'
has "palette: calculator first" "$OUT" "Calculator:6.283185307"
has "palette: conversion" "$OUT" "Conversion:20,000 MB"
has "palette: settings" "$OUT" "Settings:Dock position"
has "palette: profiles" "$OUT" "Profiles:Everyday"
has "palette: nothing found is empty" "$OUT" 'QUERY[qqqzzzxx] (true, '"'"'"[]"'
has "audit names the caller" "$OUT" '"caller":"island-daemon"'
check "no JS errors in the shell" "$(grep -c 'JS ERROR' "$LOG")" "0"
echo; [ $FAILS -eq 0 ] && echo "headless shell checks: all passed" || { echo "headless shell checks: $FAILS failed"; echo "$OUT" | head -40; exit 1; }
