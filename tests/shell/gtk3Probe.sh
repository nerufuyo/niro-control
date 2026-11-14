#!/bin/bash
# control/gtk3-probe.js against a real GTK 3 (a headless shell for the display): the effective scheme is read from the colours GTK
# really uses, including a user's gtk-3.0/gtk.css, and a theme whose colours disagree is reported as unknown (opaque fallback).
set -u
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/dark/gtk-3.0" "$WORK/mixed/gtk-3.0" "$WORK/plain"
printf '@define-color theme_bg_color #181818;\n@define-color theme_fg_color #f0f0f0;\n' > "$WORK/dark/gtk-3.0/gtk.css"
printf '@define-color theme_bg_color #181818;\n@define-color theme_fg_color #202020;\n' > "$WORK/mixed/gtk-3.0/gtk.css"
FAILS=0; OUT="$WORK/out.txt"
timeout 120 dbus-run-session -- env GSETTINGS_BACKEND=memory bash -c '
gnome-shell --headless --wayland --no-x11 --wayland-display=niro-probe --virtual-monitor 800x600 > /dev/null 2>&1 & SP=$!
sleep 18
run() { env WAYLAND_DISPLAY=niro-probe GDK_BACKEND=wayland "$@" gjs -m control/gtk3-probe.js 2>/dev/null | tail -1; }
echo "DEFAULT $(run XDG_CONFIG_HOME='"$WORK"'/plain)" > '"$OUT"'
echo "ADWAITA_DARK $(run XDG_CONFIG_HOME='"$WORK"'/plain GTK_THEME=Adwaita:dark)" >> '"$OUT"'
echo "USER_CSS_DARK $(run XDG_CONFIG_HOME='"$WORK"'/dark)" >> '"$OUT"'
echo "DISAGREE $(run XDG_CONFIG_HOME='"$WORK"'/mixed)" >> '"$OUT"'
echo "NO_DISPLAY $(env -u WAYLAND_DISPLAY -u DISPLAY GDK_BACKEND=x11 gjs -m control/gtk3-probe.js 2>/dev/null | tail -1)" >> '"$OUT"'
kill $SP' > /dev/null 2>&1
cat "$OUT"
has() { if grep -q "^$2" "$OUT"; then echo "ok   $1"; else echo "FAIL $1 (wanted: $2)"; FAILS=$((FAILS+1)); fi; }
has "the default theme is light" "DEFAULT light"
has "Adwaita:dark is dark" "ADWAITA_DARK dark"
has "a user gtk.css with dark surfaces and light text is dark (the colours really in use)" "USER_CSS_DARK dark"
has "colours that disagree are not trusted" "DISAGREE unknown"
has "no display: unknown, not a crash" "NO_DISPLAY unknown"
[ $FAILS = 0 ] && echo "gtk3 probe checks: all passed" || echo "gtk3 probe checks: $FAILS failed"
