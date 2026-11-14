# sourced inside the session: scale 2, wallpaper, Look settings, favourite apps, extensions, demo player
G="imports.gi.Gio"
ev "(function(){ const Gio=imports.gi.Gio; return 1; })()" > /dev/null
# integer scale 2 on the virtual monitor: UI is drawn at 1920x1080 logical points into 3840x2160 pixels
python3 - <<'P'
import subprocess, re
D = ['gdbus','call','--session','--dest','org.gnome.Mutter.DisplayConfig','--object-path','/org/gnome/Mutter/DisplayConfig']
out = subprocess.run(D + ['--method','org.gnome.Mutter.DisplayConfig.GetCurrentState'], capture_output=True, text=True).stdout
serial = re.match(r'\(uint32 (\d+),', out).group(1)
conn = re.search(r"\(\('([^']+)'", out).group(1)
mode = re.search(r"\('(" + __import__('os').environ.get('MONITOR','3840x2160') + r"@[0-9.]+)'", out).group(1)
r = subprocess.run(D + ['--method','org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig', serial, '1', f"[(0, 0, {__import__('os').environ.get('SCALE','2')}.0, uint32 0, true, [('{conn}', '{mode}', {{}})])]", '{}'], capture_output=True, text=True)
print('scale 2:', (r.stdout.strip() or r.stderr.strip())[:120])
P
sleep 3
# the demo player, the wallpaper, the look, the dock's apps, then the NIRO extensions
(gjs -m "$HERE/fake-player.js" "$ROOT/commercial/assets/album.png" > /dev/null 2>&1 &)
(gjs -m "$HERE/fake-player.js" "$ROOT/commercial/assets/album.png" > /dev/null 2>&1 &)
ev "(function(){ const G = imports.gi.Gio; const b = new G.Settings({schema_id: 'org.gnome.desktop.background'}); for (const k of ['picture-uri', 'picture-uri-dark']) b.set_string(k, 'file://$ROOT/commercial/assets/wallpaper.png'); b.set_string('picture-options', 'zoom'); return 1; })()" > /dev/null
ev "Main.overview.hide(); 1" > /dev/null
sleep 6
ev "(function(){ const C = imports.gi.Clutter, G = imports.gi.GLib; global.__ptr = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); global.__move = (x, y) => global.__ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); global.__click = () => { const t = G.get_monotonic_time(); global.__ptr.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global.__ptr.notify_button(t + 50000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); }; return 1; })()" > /dev/null
# real GTK 4 apps with NIRO's GTK integration, installed into this session's private config only
cat > "$WORK/install.js" <<J
import {install} from 'file://$ROOT/control/build/gtkAdapter.js';
install({configDir: '$WORK/config', backupRoot: '$WORK/backups', consent: true, scheme: 'dark', glass: ${GLASS:-70}, tint: '${TINT:-#0A1030}', surfaces: {sidebar: ${SURF_S:-70}, content: ${SURF_C:-85}, elevated: ${SURF_E:-92}}});
J
gjs -m "$WORK/install.js" > /dev/null 2>&1
appenv() { env WAYLAND_DISPLAY=niro-film GDK_BACKEND=wayland ADW_DEBUG_COLOR_SCHEME=prefer-dark "$@"; }
export -f appenv
winpos() { # app-id-substring x y w h
  ev "(function(){ const w = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('$1')); if (!w) return 'none'; if (w.maximized_horizontally) w.unmaximize(3); w.move_resize_frame(true, $2, $3, $4, $5); return 'ok'; })()" > /dev/null
}
export -f winpos
ev "(function(){ const C = imports.gi.Clutter, G = imports.gi.GLib; global.__kbd = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); global.__key = k => { const t = G.get_monotonic_time(); global.__kbd.notify_keyval(t, k, C.KeyState.PRESSED); global.__kbd.notify_keyval(t + 40000, k, C.KeyState.RELEASED); }; return 1; })()" > /dev/null
# the built-in profiles with the film's accent and tint (a copy: the shipped files are not touched); the engine reads NIRO_BUILTIN_DIR
mkdir -p "$WORK/builtin"; cp "$ROOT"/control/profiles/*.json "$WORK/builtin/"
sed -i 's/"niro.accent": "#E8472B"/"niro.accent": "#8E9BFF"/; s/"niro.tint": "#1C1C1E"/"niro.tint": "#0A1030"/' "$WORK"/builtin/*.json
sed -i 's/"niro.accent": "#[0-9A-Fa-f]*"/"niro.accent": "#8FD3FF"/' "$WORK/builtin/2-deep-work.json"
export NIRO_BUILTIN_DIR="$WORK/builtin"
