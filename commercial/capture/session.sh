#!/bin/bash
# A private headless GNOME Shell for capturing NIRO as it really is, at 3840x2160 (scale 2), with a demo wallpaper, a demo media player and the
# NIRO extensions on, in its own HOME and settings (the real HOME and settings are never touched). Source it, then call `ev` and `shot`.
#   usage: capture/session.sh <steps-script> [outdir]   (the steps script is sourced with ev, shot, wait_ms defined)
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
STEPS=$1; export OUT=$(readlink -f "${2:-$HERE/../assets/shots}"); mkdir -p "$OUT"
export HERE ROOT STEPS
WORK=$(mktemp -d); export WORK; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/config" "$WORK/cache" "$WORK/home" "$WORK/data"
# Hermetic: its own HOME and XDG folders and a key-file settings backend (no dconf service), set on the environment of the bus itself so nothing
# it starts can reach the real HOME or the real settings. (An earlier version set them after the bus started and wrote into the real dconf.)
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" GSETTINGS_BACKEND=keyfile
REAL_HOME=${REAL_HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}; export REAL_HOME
timeout 1500 dbus-run-session -- bash -c '
source "$HERE/seed.sh" > "$WORK/seed.log" 2>&1
[ -s "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" ] && [ "$HOME" != "$REAL_HOME" ] || { echo "REFUSING TO RUN: settings are not isolated"; exit 1; }
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-film --virtual-monitor ${MONITOR:-3840x2160} > "$WORK/shell.log" 2>&1 & SP=$!
sleep 22
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | grep -oP "\x27\K.*(?=\x27)" ; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
wait_ms() { sleep $(awk "BEGIN{print $1/1000}"); }
export -f ev shot wait_ms
source "$HERE/prepare.sh"
source "$STEPS"
kill $SP' 2>&1 | grep -vE "Gtk-WARNING|portal|dbus-daemon|goa-|evolution|fusermount|fuse|keyring|SSH_AUTH|discover_other|^$" | head -20
ls "$OUT"
