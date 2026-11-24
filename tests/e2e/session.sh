#!/bin/bash
# An isolated, hermetic GNOME Shell 51 (headless, Wayland) with THIS checkout's island, dock and search plus the test-only telemetry
# extension, and NO unsafe mode: nothing in the session can evaluate JavaScript in the shell. Input comes from mutter's RemoteDesktop
# D-Bus API (tests/e2e/rdinput.py); observation from the telemetry extension's fixed read-only methods (tests/e2e/telemetry).
#   usage: tests/e2e/session.sh <outdir> <command...>        (the command runs inside the session; $E2E_OUT, $ROOT are set)
# Own HOME, XDG folders, runtime dir, key-file settings and D-Bus session: the real session's dconf, bus and files are never read or written.
# It refuses to run if it cannot prove it is on its own private bus.
set -u
if [ "${1:-}" = "--inner" ]; then
    shift
    case "$DBUS_SESSION_BUS_ADDRESS" in *"$WORK"*|*dbus-*|*/tmp/*) ;; *) echo "refusing: not on a private bus ($DBUS_SESSION_BUS_ADDRESS)"; exit 3;; esac
    [ "$DBUS_SESSION_BUS_ADDRESS" != "$REAL_BUS" ] || { echo "refusing: this is the real session bus"; exit 3; }
    SCHEMAS="$WORK/data/gnome-shell/extensions/dock@niro.local/schemas"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "'99.0'"
    gsettings set org.gnome.shell enabled-extensions "['island@niro.local','dock@niro.local','search@niro.local','e2e-telemetry@niro.test']"
    gsettings set org.gnome.shell favorite-apps "['org.gnome.Calculator.desktop','org.gnome.Nautilus.desktop','org.gnome.TextEditor.desktop','org.gnome.Settings.desktop','org.gnome.Terminal.desktop']"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    # Stock GNOME binds Super+Space to switching input sources, which competes with Search's default shortcut and makes the first press race.
    # The desktop under test has it unbound (switch-input-source = ['XF86Keyboard']); the session mirrors that, nothing else.
    gsettings set org.gnome.desktop.wm.keybindings switch-input-source "['XF86Keyboard']"
    [ -n "${PRE_SETTINGS:-}" ] && eval "$PRE_SETTINGS"
    [ -n "${DOCK_SETTINGS:-}" ] && GSETTINGS_SCHEMA_DIR="$SCHEMAS" eval "$DOCK_SETTINGS"
    VM=""; for m in ${MONITORS:-1920x1080}; do VM="$VM --virtual-monitor $m"; done
    gnome-shell --headless --wayland --no-x11 --wayland-display="niro-e2e-$PPID" $VM > "$E2E_OUT/shell.log" 2>&1 &
    SP=$!; echo $SP >> "$WORK/pids"
    for i in $(seq 1 60); do busctl --user status org.niro.E2E >/dev/null 2>&1 && break; sleep 1; done
    sleep 3
    DP=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.niro.island.Daemon 2>/dev/null | grep -oE '[0-9]+'); [ -n "$DP" ] && echo "$DP" >> "$WORK/pids"
    "$@"; RC=$?
    echo "SHELL_LOG_ERRORS $(grep -c -E 'JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError|JS WARNING' "$E2E_OUT/shell.log")"
    kill $SP 2>/dev/null; wait $SP 2>/dev/null
    exit $RC
fi

cd "$(dirname "$0")/../.."
ROOT=$PWD; OUT=$(readlink -f "$1"); shift; mkdir -p "$OUT"
for d in shell/island/build/extension.js shell/dock/dist/extension.js shell/search/build/extension.js; do [ -f "$d" ] || { echo "build first: npm run build ($d missing)"; exit 1; }; done
WORK=$(mktemp -d); REAL_BUS="${DBUS_SESSION_BUS_ADDRESS:-}"
export ROOT WORK REAL_BUS E2E_OUT="$OUT" NIRO_E2E="${NIRO_E2E_FORCE:-1}" NIRO_E2E_OUT="$OUT"
mkdir -p "$WORK"/{config,cache,home,data,state,run}; chmod 700 "$WORK/run"; : > "$WORK/pids"
X="$WORK/data/gnome-shell/extensions"; mkdir -p "$X"
# same layout as tests/shell/stage.sh and tests/uat/uat.sh. E2E_PACKAGED=1 skips the three copies so the shell loads the INSTALLED package from /usr/share
# (the same scenarios against the shipped build: how a defect is shown to be pre-existing).
if [ -z "${E2E_PACKAGED:-}" ]; then
E="$X/island@niro.local"; mkdir -p "$E"; (cd shell/island && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled ! -path './build/*' -print0 | cpio -0pdm "$E" 2>/dev/null)
cp -r shell/island/build/. "$E/"; mkdir -p "$E/src/shared"; cp shell/shared/tokens.js shell/shared/motionEngine.js "$E/src/shared/"
E="$X/dock@niro.local"; mkdir -p "$E/shared"; cp -r shell/dock/dist/. "$E/"; cp shell/dock/metadata.json shell/dock/stylesheet.css "$E/"; cp -r shell/dock/schemas "$E/"; cp shell/shared/motionEngine.js "$E/shared/"
E="$X/search@niro.local"; mkdir -p "$E/shared"; cp shell/search/build/*.js shell/search/metadata.json shell/search/stylesheet.css "$E/"; cp shell/shared/*.js "$E/shared/"
fi
E="$X/e2e-telemetry@niro.test"; mkdir -p "$E"; cp tests/e2e/telemetry/* "$E/"
for d in "$X"/*/schemas; do [ -d "$d" ] && { rm -f "$d/gschemas.compiled"; glib-compile-schemas "$d"; }; done
cleanup() { for p in $(cat "$WORK/pids" 2>/dev/null); do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state"
export XDG_RUNTIME_DIR="$WORK/run" GSETTINGS_BACKEND=keyfile NIRO_RESTORE_MARKER="$WORK/state/restored" LC_ALL=C.UTF-8 NIRO_TEST_ISOLATED=1
timeout "${SESSION_TIMEOUT:-420}" dbus-run-session -- bash "$0" --inner "$@" 2>&1 | grep -vE "dbus-daemon|island_daemon|Gdk-Message|Gtk-WARNING|portal|goa-|evolution|fusermount|fuse|keyring|SSH_AUTH|discover_other|^$"
echo "out: $OUT"
