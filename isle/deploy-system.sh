#!/bin/bash
# Installs gnome-extension/ system-wide (/usr/local/share/gnome-shell/extensions/<uuid>), schemas compiled.
# A copy in ~/.local/share/gnome-shell/extensions/<uuid> shadows it: remove that one first.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/gnome-extension"
UUID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['uuid'])" "$SRC/metadata.json")
DEST="/usr/local/share/gnome-shell/extensions/$UUID"
sudo rm -rf "$DEST"
sudo mkdir -p "$DEST"
sudo cp -r "$SRC"/. "$DEST"/
sudo glib-compile-schemas "$DEST/schemas"
sudo find "$DEST" -type d -exec chmod 755 {} + && sudo find "$DEST" -type f -exec chmod 644 {} +
echo "Installed $UUID to $DEST. Log out and in to load it."
