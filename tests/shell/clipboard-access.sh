#!/usr/bin/env bash
# Starts island-daemon on a private bus, with a throwaway home, and checks who may read the clipboard list.
# Usage: tests/shell/clipboard-access.sh [path to island-daemon]
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
daemon=$(realpath "${1:-$root/target/debug/island-daemon}")
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
HOME=$home XDG_RUNTIME_DIR=$home GIO_USE_VFS=local XDG_DATA_HOME=$home XDG_CONFIG_HOME=$home XDG_CACHE_HOME=$home XDG_STATE_HOME=$home \
    dbus-run-session -- bash -c '"$1" >"$HOME/daemon.log" 2>&1 & P=$!; trap "kill $P" EXIT; sleep 2; gjs -m "$2"' \
    _ "$daemon" "$root/tests/shell/clipboard-access.js"
