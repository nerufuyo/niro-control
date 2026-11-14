#!/bin/bash
# Screenshots of GNOME Shell's own surfaces (Quick Settings, date menu, a notification, Overview search, app grid) without and
# with Universal Appearance for the Shell, from this repository's build, in a private headless shell with settings in memory.
set -u
cd "$(dirname "$0")/.."
OUT=$(readlink -f "${1:-reports/ui/shell}"); mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
EXTS="$WORK/share/gnome-shell/extensions"; mkdir -p "$EXTS"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$WORK/share/$(basename "$e")"; done
for u in island blur; do cp -r /usr/share/gnome-shell/extensions/$u@niro.local "$EXTS/"; chmod -R u+w "$EXTS/$u@niro.local"; done
cp shell/island/build/src/{niroSync,appearance,appearanceTokens,gtkAdapter,shellTheme}.js "$EXTS/island@niro.local/src/"
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"
export WORK OUT EXTS
timeout 400 dbus-run-session -- env XDG_DATA_HOME="$WORK/share" XDG_CACHE_HOME="$WORK/cache" XDG_CONFIG_HOME="$WORK/config" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-sh --virtual-monitor 1440x900 > /dev/null 2>&1 & SP=$!
sleep 22
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" > /dev/null 2>&1; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
take() { # suffix
  ev "Main.overview.hide(); 1"; sleep 1
  ev "Main.panel.statusArea.quickSettings.menu.open(); 1"; sleep 1.5; shot quick-settings-$1; ev "Main.panel.statusArea.quickSettings.menu.close(); 1"; sleep 1
  ev "Main.panel.statusArea.dateMenu.menu.open(); 1"; sleep 1.5; shot date-menu-$1; ev "Main.panel.statusArea.dateMenu.menu.close(); 1"; sleep 1
  ev "Main.notify(\"Niro Control\", \"Appearance applied: text stays readable over the glass.\"); 1"; sleep 1.2; shot notification-$1; ev "Main.messageTray.getSources().forEach(s => s.destroy()); 1"; sleep 2
  ev "Main.overview.show(); 1"; sleep 2; ev "Main.overview.searchEntry.set_text(\"fi\"); 1"; sleep 2; shot overview-search-$1
  ev "Main.overview.searchEntry.set_text(\"\"); Main.overview.showApps(); 1"; sleep 2.5; shot app-grid-$1
  ev "Main.overview.hide(); 1"; sleep 1
}
[ "${SCHEME:-light}" = dark ] && { ev "new imports.gi.Gio.Settings({schema_id: \"org.gnome.desktop.interface\"}).set_string(\"color-scheme\", \"prefer-dark\"); 1"; sleep 4; }
take before
ev "global.__N = new imports.gi.Gio.Settings({schema_id: \"org.niro.control\"}); global.__N.set_boolean(\"shell-surfaces\", true); 1"
ev "import(\"file://$EXTS/island@niro.local/src/niroSync.js\").then(m => { const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"$EXTS/island@niro.local/schemas\", G.SettingsSchemaSource.get_default(), false); global.__ns = new m.NiroSync(new G.Settings({settings_schema: src.lookup(\"org.gnome.shell.extensions.island\", false)})); }); 1"
sleep 3
take after
kill $SP' > /dev/null 2>&1
ls "$OUT"
