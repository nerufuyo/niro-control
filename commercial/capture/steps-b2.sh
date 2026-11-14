S="Main.extensionManager.lookup('search@niro.local').stateObj"
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
sleep 7; winpos texteditor 1960 520 1500 1050
appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 &
sleep 7; winpos nautilus 520 700 1700 1100
sleep 1; ev "Main.overview.hide(); global.__move(3700, 200); 1" > /dev/null; sleep 2; shot b2-windows
ev "$S._open(); 1" > /dev/null; sleep 1.2; shot s2-open
ev "$S._entry.set_text('fire'); 1" > /dev/null; sleep 1.2; shot s2-fire
ev "$S._entry.set_text('2*pi+17'); 1" > /dev/null; sleep 1.2; shot s2-calc
ev "$S._entry.set_text('dock position'); 1" > /dev/null; sleep 1.2; shot s2-setting
ev "$S._close(); 1" > /dev/null
