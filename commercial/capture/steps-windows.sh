appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 &
sleep 7; winpos nautilus 520 380 1700 1100
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
sleep 6; winpos texteditor 1700 760 1500 1000
appenv gnome-control-center background > /dev/null 2>&1 &
sleep 8; winpos control-center 180 800 1500 1000
sleep 2; ev "Main.overview.hide(); 1" > /dev/null; ev "global.__move(3500, 300); 1" > /dev/null; sleep 1; shot windows-three
