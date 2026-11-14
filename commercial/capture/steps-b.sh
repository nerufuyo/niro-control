# B: real GTK 4 windows with the GTK integration, and the Search palette
S="Main.extensionManager.lookup('search@niro.local').stateObj"
appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 &
sleep 7; winpos nautilus 520 380 1700 1100
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
sleep 6; winpos texteditor 1640 740 1500 1000
appenv gnome-control-center background > /dev/null 2>&1 &
sleep 8; winpos control-center 300 900 1500 1000
sleep 1; ev "Main.overview.hide(); global.__move(3600, 300); 1" > /dev/null; sleep 2; shot b-windows
# the same windows, one at a time in front (raise through the shell's own API)
for w in nautilus texteditor control-center; do ev "(function(){ const w = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() || '').toLowerCase().includes('$w')); if (w) w.activate(global.get_current_time()); return 1; })()" > /dev/null; sleep 1.5; shot b-front-$w; done
# Search: Super+Space opens it; the palette is NIRO's own
ev "$S._open(); 1" > /dev/null; sleep 1.2; shot s-open
ev "$S._entry.set_text('fire'); 1" > /dev/null; sleep 1.2; shot s-fire
ev "$S._entry.set_text('2*pi+17'); 1" > /dev/null; sleep 1.2; shot s-calc
ev "$S._entry.set_text('dock position'); 1" > /dev/null; sleep 1.2; shot s-setting
ev "$S._close(); 1" > /dev/null
