#!/bin/bash
# Niro the slime in a real GNOME Shell (headless): that it costs nothing while it is off or out of sight, that the Niro Device page shows the
# right mood for each case, and that a calm one on screen stays cheap. Run through tests/shell/run-staged.sh (`run-staged.sh mascot`).
# Needs a built daemon. With NIRO_SHOTS=<dir> it also saves a screenshot of each case.
set -u
export GSETTINGS_BACKEND=${GSETTINGS_BACKEND:-memory}   # never the real dconf: the settings the test needs it sets itself
cd "$(dirname "$0")/../.."
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
SHOTS="${NIRO_SHOTS:-}"
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
below() { if awk -v a="$2" -v b="$3" 'BEGIN{exit !(a<b)}'; then echo "ok   $1 ($2 < $3)"; else echo "FAIL $1: $2 is not below $3"; FAILS=$((FAILS+1)); fi; }

timeout 200 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-mascot --virtual-monitor 1440x900 > '"$LOG"' 2>&1 & SP=$!
sleep 22
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "Main.extensionManager.enableExtension(\"island@niro.local\")" >/dev/null 2>&1; sleep 12
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | sed -e "s/^(true, .//" -e "s/.)$//" -e "s/\\\\\"/\"/g"; }
shot() { [ -n "'"$SHOTS"'" ] && gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "'"$SHOTS"'/$1.png" >/dev/null 2>&1; true; }
C="Main.extensionManager.lookup(\"island@niro.local\").stateObj._controller"
PAGE="$C._expanded.pageNamed(\"niro\")"
stat() { ev "JSON.stringify([$PAGE._slime.frames, $PAGE._slime.drives, $PAGE._slime.paintMs])" | tr -d "[]\""; }
inject() { ev "$C._daemon.state.niroDevices=$1; $C._daemon.state.niroPairing=$2; $C._daemon.state.niroRequest=$3; [\"niroDevices\",\"niroPairing\",\"niroRequest\"].forEach(k=>$C._daemon.emit(\"changed\",k)); 1" >/dev/null; }
mood() { ev "$PAGE._slime.mood" | tr -d "\""; }

# 1. Off by default: nothing is drawn and no timer runs.
echo "OFF_HIDDEN $(ev "$PAGE.hidden")"
echo "OFF_FIRST $(stat)"
sleep 10
echo "OFF_LATER $(stat)"

# 2. On: each case has its mood.
ev "$C._settings.set_boolean(\"niro-device-page\", true); $C.expand(\"niro\"); 1" >/dev/null; sleep 3
NONE="[]"; QUIET="{active:false,expires_at_ms:0}"; NOREQ="{pending:false}"
DEV_ON="[{device_id:\"10:b4\",name:\"Desk\",paired_at_ms:1,online:true,status:{battery:80,charging:false}}]"
DEV_OFF="[{device_id:\"10:b4\",name:\"Desk\",paired_at_ms:1,online:false,status:null}]"
DEV_LOW="[{device_id:\"10:b4\",name:\"Desk\",paired_at_ms:1,online:true,status:{battery:9,charging:false}}]"
inject "$NONE" "$QUIET" "$NOREQ"; sleep 2; echo "CASE_NONE $(mood)"; shot mascot-curious
inject "$NONE" "{active:true,expires_at_ms:9999999999999}" "$NOREQ"; sleep 2; echo "CASE_CODE $(mood)"; shot mascot-listening
inject "$NONE" "{active:true,expires_at_ms:9999999999999}" "{pending:true,device_id:\"10:b4\",name:\"Desk\"}"; sleep 2; echo "CASE_ASK $(mood)"; shot mascot-alert
inject "$DEV_ON" "$QUIET" "$NOREQ"; sleep 1.2; echo "CASE_PAIRED $(mood)"; shot mascot-love
sleep 5; echo "CASE_CALM $(mood)"
inject "$DEV_OFF" "$QUIET" "$NOREQ"; sleep 2; echo "CASE_AWAY $(mood)"; shot mascot-sad
inject "$DEV_ON" "$QUIET" "$NOREQ"; sleep 1.2; echo "CASE_BACK $(mood)"; shot mascot-happy
sleep 5
inject "$DEV_LOW" "$QUIET" "$NOREQ"; sleep 2; echo "CASE_LOW $(mood)"; shot mascot-sleepy
inject "$DEV_ON" "$QUIET" "$NOREQ"; sleep 6

# 3. Calm on screen for half a minute: cheap.
A=$(stat); sleep 30; B=$(stat)
echo "CALM $A $B"

# 4. The island closed: nothing is drawn and no timer runs.
ev "$C.collapse(); 1" >/dev/null; sleep 4
A=$(stat); sleep 12; B=$(stat)
echo "CLOSED $A $B"
echo "ERRORS $(grep -c -E "JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError" '"$LOG"')"
kill $SP 2>/dev/null' 2>&1 | grep -E "^(OFF_|CASE_|CALM|CLOSED|ERRORS)" > "$LOG.out"

get() { grep "^$1 " "$LOG.out" | head -1 | cut -d" " -f2-; }
check "off by default: the page is hidden" "$(get OFF_HIDDEN)" "true"
check "off by default: not one frame is drawn" "$(get OFF_LATER | cut -d, -f1)" "0"
check "off by default: no driver wake-up in 10 s" "$(get OFF_LATER | cut -d, -f2)" "$(get OFF_FIRST | cut -d, -f2)"
check "no device: curious" "$(get CASE_NONE)" "curious"
check "a code is open: listening" "$(get CASE_CODE)" "listening"
check "a device asks: alert" "$(get CASE_ASK)" "alert"
check "a device was just paired: love" "$(get CASE_PAIRED)" "love"
check "then calm" "$(get CASE_CALM)" "idle"
check "every device away: sad" "$(get CASE_AWAY)" "sad"
check "a device comes back: happy" "$(get CASE_BACK)" "happy"
check "a low battery: sleepy" "$(get CASE_LOW)" "sleepy"
read -r f0 d0 m0 f1 d1 m1 <<< "$(get CALM | tr "," " ")"
below "a calm slime on screen: frames a second" "$(awk -v a="$f0" -v b="$f1" 'BEGIN{printf "%.1f", (b-a)/30}')" 20
below "a calm slime on screen: milliseconds of drawing a second (a thousandth of a core each)" "$(awk -v a="$m0" -v b="$m1" 'BEGIN{printf "%.1f", (b-a)/30}')" 30
read -r f0 d0 m0 f1 d1 m1 <<< "$(get CLOSED | tr "," " ")"
check "island closed: no frame in 12 s" "$(awk -v a="$f0" -v b="$f1" 'BEGIN{print b-a}')" "0"
check "island closed: no driver wake-up in 12 s" "$(awk -v a="$d0" -v b="$d1" 'BEGIN{print b-a}')" "0"
check "no JS errors in the shell" "$(get ERRORS)" "0"
rm -f "$LOG.out"
echo
[ "$FAILS" = 0 ] && echo "mascot checks: all passed" || { echo "mascot checks: $FAILS failed"; exit 1; }
