#!/bin/bash
# Builds the Isle-themed shell and installs it over the .deb's /usr/bin/digup-shell (the helpers stay the .deb's).
# Needs: libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential.
set -euo pipefail
cd "$(dirname "$0")/shell/src-tauri"
cargo build --release --features tauri/custom-protocol
[ -e /usr/bin/digup-shell.orig-deb ] || sudo cp /usr/bin/digup-shell /usr/bin/digup-shell.orig-deb
pkill -x digup-shell || true; sleep 1; pkill -x digup || true; sleep 2
sudo install -m 755 target/release/digup-shell /usr/bin/digup-shell
echo "Installed. Start DigUp from the app list, or log out and in."
