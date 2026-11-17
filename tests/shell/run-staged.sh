#!/bin/bash
# The shell tests against this checkout, no installed package needed: stages it, then runs each tests/shell/*.sh with the
# stage first in XDG_DATA_DIRS. Needs a built daemon (cargo build --release -p island-daemon).
set -u
cd "$(dirname "$0")/../.."
P=$(tests/shell/stage.sh) || exit 1
# The headless shells must not touch the real session's state: the session restore of the island would read the real snapshot, start those apps in the
# test shell and write its own snapshot over it.
STATE=$(mktemp -d); trap 'rm -rf "$P" "$STATE"' EXIT
export XDG_STATE_HOME="$STATE" NIRO_RESTORE_MARKER="$STATE/restored"
export PATH="$P/bin:$PATH"
export NIRO_BUILTIN_DIR="$P/share/niro-control/profiles"
export NIRO_EXT_ROOT="$P/share/gnome-shell/extensions" XDG_DATA_DIRS="$P/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export LC_ALL=C.UTF-8 LANGUAGE=C   # the tests grep English output
export GSETTINGS_BACKEND=memory   # the extensions are enabled by the test; the real dconf is never written
export DAEMON="${DAEMON:-$PWD/target/release/island-daemon}"
rc=0; for t in "${@:-gtk3Probe niroSync appearance headless tile controls}"; do for n in $t; do echo "=== $n"; tests/shell/$n.sh || rc=1; done; done
exit $rc
