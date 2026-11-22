#!/bin/bash
# A private, hermetic headless GNOME Shell for driving Search at runtime: its own HOME, XDG folders, D-Bus session, Wayland socket and a key-file
# settings backend (the real dconf is never read or written). The staged extensions come from tests/shell/stage.sh.
# usage: search-session.sh <stage-prefix> <workdir>
# Writes <workdir>/env (source it to talk to the session) and <workdir>/shell.log; runs until <workdir>/stop exists. It kills only the shell it started.
set -u
STAGE=$1; WORK=$2; mkdir -p "$WORK"/{home,config,data,state}
# a short cache path: ibus binds a unix socket under it, and a long path makes that fail
CACHE=$(mktemp -d "${TMPDIR:-/tmp}/ns.XXXXXX")
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$CACHE" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state"
export XDG_DATA_DIRS="$STAGE/share:/usr/local/share:/usr/share" GSETTINGS_BACKEND=keyfile LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export NIRO_EXT_ROOT="$STAGE/share/gnome-shell/extensions" NIRO_TEST_ISOLATED=1 WORK
rm -f "$WORK/stop" "$WORK/env"
cat > "$WORK/inner.sh" <<'INNER'
echo "export DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" > "$WORK/env"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "'99.0'"     # no welcome tour: its modal dialog would hold the keyboard
gsettings set org.gnome.shell enabled-extensions "['search@niro.local']"
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display="niro-search-$$" --virtual-monitor "${MONITOR:-1280x720}" > "$WORK/shell.log" 2>&1 &
SP=$!
echo "export SHELL_PID=$SP" >> "$WORK/env"
while [ ! -e "$WORK/stop" ]; do sleep 1; done
kill $SP; wait $SP 2>/dev/null
INNER
dbus-run-session -- bash "$WORK/inner.sh"
rm -rf "$CACHE"
