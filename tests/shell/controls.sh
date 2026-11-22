#!/bin/bash
# The Controls and Power pages against a real GNOME Shell (headless): they build with no error, the Wi-Fi list shows the networks (the
# joined one first), a new secured network asks its password and says when it is wrong, a right one joins, Disconnect and Forget work, and
# the Power page shows a battery (set by the test: this PC has none) with the time, the level's colour and its health, and hides it with
# none. Wi-Fi goes through a stand-in nmcli (tests/shell/fake); sound, brightness and the radios are never touched.
# Needs the staged extensions (tests/shell/run-staged.sh) or the installed package.
set -u
cd "$(dirname "$0")/../.."
# The test must not write the real ~/.local/share (Search's audit log, snips): run-staged.sh already isolates it, a direct run does here.
[ -n "${NIRO_TEST_ISOLATED:-}" ] || { export XDG_DATA_HOME; XDG_DATA_HOME=$(mktemp -d); }
LOG=$(mktemp); WORK=$(mktemp -d); trap 'rm -f "$LOG"; rm -rf "$WORK"; rm -f /run/user/$UID/gnome-shell-disable-extensions' EXIT
rm -f /run/user/$UID/gnome-shell-disable-extensions
mkdir -p "$WORK/cfg/glib-2.0/settings"
printf "[org/gnome/shell]\nwelcome-dialog-last-shown-version='99'\n" > "$WORK/cfg/glib-2.0/settings/keyfile"
# "Kantor Wifi" is a saved connection for the network Kantor-5G whose password is kept by a login's keyring, as GNOME's own Settings saves it.
echo '{"active":"Home","saved":["Home","Kantor Wifi"],"meta":{"Home":{"ssid":"Home","agent":false,"auto":true},"Kantor Wifi":{"ssid":"Kantor-5G","agent":true,"auto":false}},"log":[]}' > "$WORK/nmcli.json"
export WORK LOG NMCLI_FAKE_STATE="$WORK/nmcli.json" PATH="$PWD/tests/shell/fake:$PATH"
export GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME="$WORK/cfg"
timeout 200 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-controlstest --virtual-monitor 1920x1080 > "$LOG" 2>&1 &
sleep 18
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | sed -E "s/^\(true, .(.*).\)$/\1/; s/^\"(.*)\"$/\1/"; }
for e in island; do ev "Main.extensionManager.enableExtension(\"$e@niro.local\")" >/dev/null; done; sleep 8
ev "Main.overview.hide(); 1" >/dev/null
C="const c=Main.extensionManager.lookup(\"island@niro.local\").stateObj._controller; const pg=c._expanded.pageNamed(\"controls\"); const pw=c._expanded.pageNamed(\"power\");"
state() { python3 -c "import json,sys; d=json.load(open(\"$WORK/nmcli.json\")); print(eval(sys.argv[1]))" "$1"; }
echo "PAGES $(ev "$C (pg ? \"controls\" : \"-\") + (pw ? \" power\" : \" -\")")"
ev "$C c._toggleFromKeyboard(\"controls\"); 1" >/dev/null; sleep 2
echo "TILES $(ev "$C [...pg._tiles.keys()].join(\",\")")"
echo "SLIDERS $(ev "$C [pg._volume, pg._mic, pg._screen].map(r => r.slider._thick).join(\",\")")"
ev "$C pg._show(\"wifi\"); 1" >/dev/null; sleep 4
echo "WIFI $(ev "$C pg._wifi.networks.map(n => n.ssid + (n.active ? \"*\" : \"\")).join(\",\")")"
echo "SIGNALS $(ev "$C let n = 0; const id = pg._wifi.connect(\"changed\", () => n++); pg._wifi.emit(\"changed\"); pg._wifi.disconnect(id); typeof id + \" \" + n")"
echo "NOLEAVE $(state "[l for l in d[\"log\"] if \"disconnect\" in l or \"connect undefined\" in l] == []")"
echo "KNOWNMAP $(ev "$C [...pg._wifi.known].map(([ssid, name]) => ssid + \"=\" + name).join(\",\")")"
echo "WIFIROWS $(ev "$C pg._wifiList.box.get_n_children()")"
ev "$C pg._join(pg._wifi.networks.find(n => n.ssid === \"Cafe Latte\")); 1" >/dev/null; sleep 2
echo "ASKED $(ev "$C pg._prompt.visible + \" \" + pg._promptEntry.hint_text")"
ev "$C pg._promptEntry.text = \"nope\"; pg._submitPassword(); 1" >/dev/null; sleep 3
echo "WRONG $(ev "$C pg._promptError.visible + \" \" + pg._promptError.text + \" \" + pg._prompt.visible")"
echo "NOTSAVED $(state "\"Cafe Latte\" in d[\"saved\"]")"
ev "$C pg._promptEntry.text = \"correct\"; pg._submitPassword(); 1" >/dev/null; sleep 3
echo "JOINED $(state "d[\"active\"]") $(ev "$C pg._prompt.visible")"
echo "CONNECTED $(ev "$C pg._wifi.networks[0].ssid + \" \" + pg._wifi.networks[0].active")"
ev "$C pg._wifi.leave(); 1" >/dev/null; sleep 3
echo "DISCONNECTED \"$(state "d[\"active\"]")\""
ev "$C pg._join(pg._wifi.networks.find(n => n.ssid === \"Home\")); 1" >/dev/null; sleep 3
echo "SAVEDJOIN $(state "d[\"active\"]") $(state "[l for l in d[\"log\"] if \"connection up id Home\" in l] != []")"
echo "AUTOJOINED $(state "d[\"meta\"][\"Cafe Latte\"][\"auto\"]")"
ev "$C pg._join(pg._wifi.networks.find(n => n.ssid === \"Kantor-5G\")); 1" >/dev/null; sleep 4
echo "KEYRING $(ev "$C pg._prompt.visible + \" \" + pg._promptEntry.hint_text")"
ev "$C pg._promptEntry.text = \"correct\"; pg._submitPassword(); 1" >/dev/null; sleep 4
echo "KEYRINGJOIN $(state "d[\"active\"]") $(state "d[\"meta\"][\"Kantor Wifi\"][\"agent\"]") $(state "d[\"meta\"][\"Kantor Wifi\"][\"auto\"]") $(state "len([n for n in d[\"saved\"] if \"Kantor\" in n])")"
ev "$C pg._wifi.forget(\"Cafe Latte\"); 1" >/dev/null; sleep 3
echo "FORGOT $(state "\"Cafe Latte\" in d[\"saved\"]")"
ev "$C pg._show(\"bluetooth\"); pg._show(\"sound\"); pg._show(\"quick\"); 1" >/dev/null; sleep 1
ev "$C c._toggleFromKeyboard(\"power\"); 1" >/dev/null; sleep 2
echo "NOBATTERY $(ev "$C pw._batteryCard.visible")"
ev "$C Object.assign(pw._battery, {available: true, percent: 78, state: \"charging\", timeToFull: 4800, rate: 23.4, health: 91}); pw._battery.emit(\"changed\"); 1" >/dev/null; sleep 1
echo "CHARGING $(ev "$C [pw._batteryCard.visible, pw._percent.text, pw._statusTitle.text, pw._statusDetail.text, pw._facts.text].join(\"|\")")"
ev "$C Object.assign(pw._battery, {percent: 14, state: \"discharging\", timeToEmpty: 2700, timeToFull: 0}); pw._battery.emit(\"changed\"); 1" >/dev/null; sleep 1
echo "LOW $(ev "$C [pw._percent.text, pw._statusTitle.text, pw._statusDetail.text, pw._percent.style_class, pw._level._fill.style_class].join(\"|\")")"
echo "HEIGHTS $(ev "$C [pg.pageHeight, pw.pageHeight, pg.minHeight, pw.minHeight].join(\",\")")"
kill %1' 2>&1 | grep -E "^(PAGES|TILES|SLIDERS|WIFI|WIFIROWS|SIGNALS|NOLEAVE|KNOWNMAP|ASKED|WRONG|NOTSAVED|JOINED|CONNECTED|DISCONNECTED|SAVEDJOIN|AUTOJOINED|KEYRING|KEYRINGJOIN|FORGOT|NOBATTERY|CHARGING|LOW|HEIGHTS) " > "$WORK/out.txt"
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
got() { grep -E "^$1 " "$WORK/out.txt" | head -1 | cut -d" " -f2-; }
check "both pages exist" "$(got PAGES)" "controls power"
check "the quick tiles: Wi-Fi, Bluetooth, Airplane, Do Not Disturb, Night Light, Dark style" "$(got TILES)" "wifi,bluetooth,airplane,dnd,night,dark"
check "the sliders are the thick ones" "$(got SLIDERS)" "true,true,true"
check "Wi-Fi lists the networks, the joined one first" "$(got WIFI)" "Home*,Kantor-5G,Cafe Latte,Guest,Tetangga,Warung"
check "one row per network" "$(got WIFIROWS)" "6"
check "the page listens to Wi-Fi through the signals (connect and disconnect are the EventEmitter's)" "$(got SIGNALS)" "number 1"
check "starting and ending the listening never touches the network" "$(got NOLEAVE)" "True"
check "a saved connection is known by the network it is for, not by its name" "$(got KNOWNMAP)" 'Home=Home,Kantor-5G=Kantor Wifi'
check "a new secured network asks its password" "$(got ASKED)" "true Password for Cafe Latte"
check "a wrong password is said so, and the bar stays" "$(got WRONG)" "true Wrong password true"
check "the failed network is not kept" "$(got NOTSAVED)" "False"
check "the right password joins and closes the bar" "$(got JOINED)" "Cafe Latte false"
check "the joined network is first and active" "$(got CONNECTED)" "Cafe Latte true"
check "Disconnect leaves it" "$(got DISCONNECTED)" '""'
check "a saved network joins with no password" "$(got SAVEDJOIN)" "Home True"
check "a network joined by hand is joined by itself from then on" "$(got AUTOJOINED)" "True"
check "a saved network whose password is in a keyring asks for it, not 'wrong password'" "$(got KEYRING)" "true Password for Kantor-5G"
check "that password joins, is kept for the whole computer, the network joins by itself, and no copy is made" "$(got KEYRINGJOIN)" "Kantor-5G False True 1"
check "Forget removes a saved network" "$(got FORGOT)" "False"
check "no battery, no battery card" "$(got NOBATTERY)" "false"
check "charging: level, state, time to full, health and power" "$(got CHARGING)" "true|78%|Charging|1 h 20 min until full|Health 91% · 23.4 W"
check "low on battery: red level and time left" "$(got LOW)" "14%|On battery|45 min left|island-power-percent island-power-low|island-level-fill island-level-low"
check "both pages keep their own height" "$(got HEIGHTS)" "214,196,214,196"
check "no JS errors in the shell" "$(grep -c 'JS ERROR' "$LOG")" "0"
echo; [ $FAILS -eq 0 ] && echo "controls checks: all passed" || { echo "controls checks: $FAILS failed"; cat "$WORK/out.txt" | head -30; exit 1; }
