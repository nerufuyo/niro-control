# v2 plates: every UI element captured on its own, so it can sit on its own surface in the 3D scene (no baked overlap between windows)
S="Main.extensionManager.lookup('search@niro.local').stateObj"
CLOSE="global.get_window_actors().forEach(a => { if (a.meta_window.get_window_type() == 0) a.meta_window.delete(global.get_current_time()); }); 1"
ev "Main.overview.hide(); global.__move(3700, 200); 1" > /dev/null; sleep 2; shot v-blank
ev "$S._open(); 1" > /dev/null; sleep 1.2; shot v-s-open
ev "$S._entry.set_text('fire'); 1" > /dev/null; sleep 1.2; shot v-s-fire
ev "$S._entry.set_text('2*pi+17'); 1" > /dev/null; sleep 1.2; shot v-s-calc
ev "$S._entry.set_text('dock position'); 1" > /dev/null; sleep 1.2; shot v-s-setting
ev "$S._close(); 1" > /dev/null; sleep 1
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
sleep 7; winpos texteditor 1960 520 1500 1050
ev "global.__move(3700, 200); 1" > /dev/null; sleep 2; shot v-editor
ev "$CLOSE" > /dev/null; sleep 3
appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 &
sleep 7; winpos nautilus 520 700 1700 1100
ev "global.__move(3700, 200); 1" > /dev/null; sleep 2; shot v-files
ev "$CLOSE" > /dev/null; sleep 2
