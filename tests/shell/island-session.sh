#!/bin/bash
# A private headless GNOME Shell with THIS checkout's island extension (shell/island/build, built by `npm run build`) in its own
# HOME, XDG folders, runtime dir, key-file settings and D-Bus session, so it can run beside other headless sessions without touching
# them or the real user's. Runs a steps script inside it with `ev`, `shot`, `wait_ms`, `PLAY` defined.
#   usage: tests/shell/island-session.sh <steps-script> [outdir]
# The steps script is sourced; its stdout is the report. Everything started here is stopped by PID on the way out.
# Limitation (headless): the virtual pointer cannot hover the island (the Search entry sits on top), so the island is opened and
# closed with controller.expand()/collapse(), which is what a hover ends up calling.
set -u

if [ "${1:-}" = "--inner" ]; then
    # Inside the private D-Bus session.
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "'99.0'"
    gsettings set org.gnome.shell enabled-extensions "['island@niro.local'${WITH_SEARCH:+, 'search@niro.local'}]"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    [ -n "${PRE_SETTINGS:-}" ] && eval "$PRE_SETTINGS"
    gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display="niro-isl-$PPID" --virtual-monitor "${MONITOR:-1920x1080}" > "$OUT/shell.log" 2>&1 &
    SP=$!; echo $SP >> "$WORK/pids"
    sleep 20
    ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | grep -oP "\x27\K.*(?=\x27)"; }
    shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
    wait_ms() { sleep "$(awk "BEGIN{print $1/1000}")"; }
    C='Main.extensionManager.lookup("island@niro.local").stateObj._controller'
    PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player."$1" >/dev/null 2>&1; }
    start_player() { gjs -m "$ROOT/commercial/capture/fake-player.js" "$ROOT/commercial/assets/album.png" > /dev/null 2>&1 & echo $! >> "$WORK/pids"; PLAYER_PID=$!; }
    stop_player() { [ -n "${PLAYER_PID:-}" ] && kill "$PLAYER_PID" 2>/dev/null; PLAYER_PID=; }
    export -f ev shot wait_ms PLAY
    # A headless shell starts in the Overview, where the closed island steps aside: leave it before anything is measured.
    ev "Main.overview.hide(); 1" > /dev/null; sleep 3
    # island-daemon was started by the bus for this session only; found by the bus name, never by pattern.
    DAEMON_PID=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.niro.island.Daemon 2>/dev/null | grep -oE '[0-9]+')
    [ -n "$DAEMON_PID" ] && echo "$DAEMON_PID" >> "$WORK/pids"
    source "$STEPS"
    stop_player
    # Counted while the shell still runs: its own teardown (a GC sweep as it quits) is not the extension's.
    echo "SHELL_LOG_ERRORS $(grep -c -E 'JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError|JS WARNING' "$OUT/shell.log")"
    kill $SP 2>/dev/null; wait $SP 2>/dev/null
    exit 0
fi

cd "$(dirname "$0")/../.."
ROOT=$PWD; HERE=$ROOT/tests/shell
STEPS=$(readlink -f "$1"); OUT=$(readlink -f "${2:-$(mktemp -d)}"); mkdir -p "$OUT"
[ -f shell/island/build/extension.js ] || { echo "build first: npm run build"; exit 1; }
WORK=$(mktemp -d)
export ROOT HERE STEPS OUT WORK
mkdir -p "$WORK"/{config,cache,home,data,state,run}; chmod 700 "$WORK/run"; : > "$WORK/pids"
EXT="$WORK/data/gnome-shell/extensions/island@niro.local"
mkdir -p "$EXT"
(cd shell/island && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled ! -path './build/*' -print0 | cpio -0pdm "$EXT" 2>/dev/null)
cp -r shell/island/build/. "$EXT/"
mkdir -p "$EXT/src/shared"; cp shell/shared/tokens.js shell/shared/motionEngine.js "$EXT/src/shared/"
rm -f "$EXT/schemas/gschemas.compiled"; glib-compile-schemas "$EXT/schemas"
if [ -n "${WITH_SEARCH:-}" ]; then   # the search extension beside it, for scenarios where both are enabled
    SX="$WORK/data/gnome-shell/extensions/search@niro.local"; mkdir -p "$SX/shared"
    cp shell/search/build/*.js shell/search/metadata.json shell/search/stylesheet.css "$SX/"; cp shell/shared/*.js "$SX/shared/"
fi
cleanup() { for p in $(cat "$WORK/pids" 2>/dev/null); do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT
# Hermetic: every location the shell or the daemon may write is under $WORK, set on the environment of the bus itself.
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state"
export XDG_RUNTIME_DIR="$WORK/run" GSETTINGS_BACKEND=keyfile NIRO_RESTORE_MARKER="$WORK/state/restored" LC_ALL=C.UTF-8
timeout "${SESSION_TIMEOUT:-420}" dbus-run-session -- bash "$0" --inner 2>&1 | grep -vE "dbus-daemon|island_daemon|Gdk-Message|Gtk-WARNING|portal|goa-|evolution|fusermount|fuse|keyring|SSH_AUTH|discover_other|^$"
echo "out: $OUT"
