#!/bin/bash
# The shell side of Universal Appearance against a real GNOME Shell (headless, settings in memory): NiroSync from this repository's
# build migrates the old whole-window fade without losing it, drives the shell blur switches and puts them back, and keeps the
# GTK stylesheet in step with GNOME's colour scheme, high contrast and the shared look, rewriting only when the content changes.
set -u
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
EXTS="$WORK/share/gnome-shell/extensions"; mkdir -p "$EXTS" "$WORK/config"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$WORK/share/$(basename "$e")"; done
for u in island blur; do cp -r /usr/share/gnome-shell/extensions/$u@niro.local "$EXTS/"; chmod -R u+w "$EXTS/$u@niro.local"; done
cp shell/island/build/src/{niroSync,appearance,appearanceTokens,gtkAdapter,shellTheme}.js "$EXTS/island@niro.local/src/"
cp shell/blur/components/applications/index.js "$EXTS/blur@niro.local/components/applications/index.js"
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"
cat > "$WORK/install.js" <<J
import {install} from 'file://$PWD/control/build/gtkAdapter.js';
install({configDir: '$WORK/config', backupRoot: '$WORK/backups', consent: true, scheme: 'dark', glass: 80, tint: '#1C1C1E', surfaces: {sidebar: 70, content: 85, elevated: 92}});
J
gjs -m "$WORK/install.js" || { echo "could not prepare the GTK config"; exit 1; }
FAILS=0; OUT="$WORK/out.txt"; : > "$OUT"
has() { if grep -q "$2" "$OUT"; then echo "ok   $1"; else echo "FAIL $1 (wanted: $2)"; FAILS=$((FAILS+1)); fi; }
timeout 200 dbus-run-session -- env XDG_DATA_HOME="$WORK/share" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-sync --virtual-monitor 1280x720 > '"$WORK"'/shell.log 2>&1 & SP=$!
sleep 20
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | grep -oP "\x27\K.*(?=\x27)" | tr -d "\""; }
EXT="'"$EXTS"'"
# helpers in the shell: settings of an extension schema, the niro schema
ev "global.__S = (ext, id) => { const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"$EXT/\"+ext+\"/schemas\", G.SettingsSchemaSource.get_default(), false); return new G.Settings({settings_schema: src.lookup(id, false)}); }; global.__N = new imports.gi.Gio.Settings({schema_id: \"org.niro.control\"}); global.__I = new imports.gi.Gio.Settings({schema_id: \"org.gnome.desktop.interface\"}); 1" > /dev/null
APPS="global.__S(\"blur@niro.local\", \"org.gnome.shell.extensions.blur-my-shell.applications\")"
bs() { echo "global.__S(\"blur@niro.local\", \"org.gnome.shell.extensions.blur-my-shell.$1\")"; }
ev "$APPS.set_int(\"opacity\", 204); $(bs panel).set_boolean(\"blur\", false); $(bs overview).set_boolean(\"blur\", true); $(bs popup).set_boolean(\"blur\", false); 1" > /dev/null
ev "import(\"file://$EXT/island@niro.local/src/niroSync.js\").then(m => { const isl = global.__S(\"island@niro.local\", \"org.gnome.shell.extensions.island\"); global.__ns = new m.NiroSync(isl); }); 1" > /dev/null
sleep 2
echo "MIGRATE apps=$(ev "$APPS.get_int(\"opacity\")") saved=$(ev "global.__N.get_int(\"legacy-window-opacity\")")" >> '"$OUT"'
ev "global.__N.set_boolean(\"legacy-global-fade\", true); 1" > /dev/null; sleep 1
echo "LEGACY_ON apps=$(ev "$APPS.get_int(\"opacity\")")" >> '"$OUT"'
ev "global.__N.set_boolean(\"legacy-global-fade\", false); 1" > /dev/null; sleep 1
echo "LEGACY_OFF apps=$(ev "$APPS.get_int(\"opacity\")") saved=$(ev "global.__N.get_int(\"legacy-window-opacity\")")" >> '"$OUT"'
ev "global.__N.set_boolean(\"shell-surfaces\", true); 1" > /dev/null; sleep 1
echo "SURF_ON panel=$(ev "$(bs panel).get_boolean(\"blur\")") overview=$(ev "$(bs overview).get_boolean(\"blur\")") popup=$(ev "$(bs popup).get_boolean(\"blur\")")" >> '"$OUT"'
SHELLCSS="'"$WORK"'/cache/niro/shell-appearance.css"
sheets() { ev "imports.gi.St.ThemeContext.get_for_stage(global.stage).get_theme().get_custom_stylesheets().map(f => f.get_basename()).join(\"+\")"; }
echo "SHELL_ON loaded=$(sheets | grep -c shell-appearance) panel=$(grep -c "#panel { background-color: rgba(28, 28, 30, 0.7" $SHELLCSS) accent=$(grep -c "rgba(232, 71, 43, 1)" $SHELLCSS)" >> '"$OUT"'
ev "global.__N.set_string(\"accent\", \"#33AA55\"); 1" > /dev/null; sleep 1
echo "SHELL_ACCENT $(grep -c "rgba(51, 170, 85, 1)" $SHELLCSS)" >> '"$OUT"'
ev "global.__N.set_string(\"accent\", \"#E8472B\"); global.__N.set_boolean(\"safe-mode\", true); 1" > /dev/null; sleep 1
echo "SHELL_SAFE solid=$(grep -c "#panel { background-color: rgba(28, 28, 30, 1)" $SHELLCSS)" >> '"$OUT"'
echo "SURF_SAFE panel=$(ev "$(bs panel).get_boolean(\"blur\")") overview=$(ev "$(bs overview).get_boolean(\"blur\")") popup=$(ev "$(bs popup).get_boolean(\"blur\")")" >> '"$OUT"'
ev "global.__N.set_boolean(\"safe-mode\", false); 1" > /dev/null; sleep 1
HC="new imports.gi.Gio.Settings({schema_id: \"org.gnome.desktop.a11y.interface\"})"
ev "$HC.set_boolean(\"high-contrast\", true); 1" > /dev/null; sleep 1
echo "SHELL_HC loaded=$(sheets | grep -c shell-appearance)" >> '"$OUT"'
ev "$HC.set_boolean(\"high-contrast\", false); 1" > /dev/null; sleep 1
echo "SHELL_HC_OFF loaded=$(sheets | grep -c shell-appearance)" >> '"$OUT"'
ev "global.__N.set_boolean(\"shell-surfaces\", false); 1" > /dev/null; sleep 1
echo "SHELL_OFF loaded=$(sheets | grep -c shell-appearance)" >> '"$OUT"'
echo "SURF_OFF panel=$(ev "$(bs panel).get_boolean(\"blur\")") overview=$(ev "$(bs overview).get_boolean(\"blur\")") popup=$(ev "$(bs popup).get_boolean(\"blur\")") backup=$(ev "global.__N.get_string(\"shell-surfaces-backup\")")" >> '"$OUT"'
CSS="'"$WORK"'/config/gtk-4.0/niro-glass.css"
sleep 1; echo "GTK_LIGHT $(grep -c "rgba(244, 244, 248" $CSS)" >> '"$OUT"'
ev "global.__I.set_string(\"color-scheme\", \"prefer-dark\"); 1" > /dev/null; sleep 1.5
echo "GTK_DARK $(grep -c "rgba(28, 28, 30" $CSS)" >> '"$OUT"'
M1=$(stat -c %Y.%N $CSS); ev "global.__N.set_string(\"accent\", \"#33AA55\"); 1" > /dev/null; sleep 1.5; M2=$(stat -c %Y.%N $CSS)
[ "$M1" = "$M2" ] && echo "GTK_UNCHANGED_UNTOUCHED yes" >> '"$OUT"' || echo "GTK_UNCHANGED_UNTOUCHED no" >> '"$OUT"'
ev "global.__N.set_string(\"color-scheme\", \"light\"); 1" > /dev/null; sleep 1.5
echo "GTK_FORCED_LIGHT $(grep -c "rgba(244, 244, 248" $CSS)" >> '"$OUT"'
CSS3="'"$WORK"'/config/gtk-3.0/niro-glass.css"
ev "global.__I.set_string(\"gtk-theme\", \"Yaru-olive-dark\"); 1" > /dev/null; sleep 1.5
echo "GTK3_DARKTHEME $(grep -c "rgba(28, 28, 30" $CSS3)" >> '"$OUT"'
ev "global.__I.set_string(\"gtk-theme\", \"Adwaita\"); 1" > /dev/null; sleep 1.5
echo "GTK3_LIGHTTHEME $(grep -c "rgba(244, 244, 248" $CSS3)" >> '"$OUT"'
ev "new imports.gi.Gio.Settings({schema_id: \"org.gnome.desktop.a11y.interface\"}).set_boolean(\"high-contrast\", true); 1" > /dev/null; sleep 1.5
echo "GTK_HC_SOLID $(grep -c "window.background:not(.solid-csd) { background-color: rgba(28, 28, 30, 1)" $CSS)" >> '"$OUT"'
ev "global.__N.set_boolean(\"universal-enabled\", false); 1" > /dev/null; sleep 1.5
echo "GTK_OFF $(grep -c "switched off" $CSS)" >> '"$OUT"'
ev "$HC.set_boolean(\"high-contrast\", false); global.__N.set_boolean(\"shell-surfaces\", true); 1" > /dev/null; sleep 1
echo "UNIVERSAL_OFF_SHELL loaded=$(sheets | grep -c shell-appearance)" >> '"$OUT"'
ev "global.__N.set_boolean(\"universal-enabled\", true); 1" > /dev/null; sleep 1.5
echo "UNIVERSAL_ON_SHELL loaded=$(sheets | grep -c shell-appearance) gtk_back=$(grep -c "window.background" $CSS)" >> '"$OUT"'
# a preset writes seven keys at once: both stylesheets end up solid, from one coherent state
ev "for (const [k, v] of Object.entries({\"opacity\": 100, \"sidebar-opacity\": 100, \"content-opacity\": 100, \"elevated-opacity\": 100})) global.__N.set_int(k, v); global.__N.set_boolean(\"blur\", false); 1" > /dev/null; sleep 1.5
echo "PRESET_SOLID shell=$(grep -c "#panel { background-color: rgba(28, 28, 30, 1)" $SHELLCSS) gtk=$(grep -c "window.background:not(.solid-csd) { background-color: rgba(28, 28, 30, 1)" $CSS)" >> '"$OUT"'
kill $SP' > /dev/null 2>&1
cat "$OUT"; grep -iE "JS ERROR|Island:" "$WORK/shell.log" | head -4
has "legacy fade saved once and windows back to 255" "MIGRATE apps=255 saved=204"
has "the old fade switch restores the saved value" "LEGACY_ON apps=204"
has "and switching it off returns to 255, keeping the saved value" "LEGACY_OFF apps=255 saved=204"
has "shell surfaces: blur on for top bar, Overview, popups" "SURF_ON panel=true overview=true popup=true"
has "shell stylesheet is loaded with the panel surface and the accent" "SHELL_ON loaded=1 panel=1 accent=2"
has "an accent change reaches the shell stylesheet" "SHELL_ACCENT 2"
has "safe mode makes the shell surfaces solid" "SHELL_SAFE solid=1"
has "high contrast unloads it (GNOME's own high-contrast look is left alone)" "SHELL_HC loaded=0"
has "and it returns afterwards" "SHELL_HC_OFF loaded=1"
has "switching shell surfaces off unloads it" "SHELL_OFF loaded=0"
has "safe mode drops the shell blur" "SURF_SAFE panel=false overview=false popup=false"
has "turning it off puts the previous settings back" "SURF_OFF panel=false overview=true popup=false backup={}"
has "GTK stylesheet follows a light system" "GTK_LIGHT 1"
has "GTK stylesheet follows GNOME to dark at once" "GTK_DARK 1"
has "an unrelated change rewrites nothing" "GTK_UNCHANGED_UNTOUCHED yes"
has "Niro's own light/dark choice does not change other applications: GTK 4 stays with GNOME" "GTK_FORCED_LIGHT 0"
has "GTK 3 follows its theme: a dark theme gives dark" "GTK3_DARKTHEME 1"
has "and a light theme gives light" "GTK3_LIGHTTHEME 1"
has "high contrast makes the glass solid" "GTK_HC_SOLID 1"
has "the global switch neutralises the stylesheet" "GTK_OFF 1"
has "the global switch also unloads the shell stylesheet" "UNIVERSAL_OFF_SHELL loaded=0"
has "and switching it back on restores both" "UNIVERSAL_ON_SHELL loaded=1 gtk_back=1"
has "a preset's keys, written together, leave both stylesheets solid and consistent" "PRESET_SOLID shell=1 gtk=1"
if grep -qE "JS ERROR" "$WORK/shell.log"; then echo "FAIL no JS errors in the shell"; grep -E "JS ERROR" "$WORK/shell.log" | head -3; FAILS=$((FAILS+1)); else echo "ok   no JS errors in the shell"; fi
[ $FAILS = 0 ] && echo "niroSync shell checks: all passed" || echo "niroSync shell checks: $FAILS failed"
