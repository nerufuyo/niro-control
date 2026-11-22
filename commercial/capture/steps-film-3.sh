# film shots, part 3: windows over the wallpaper, apart, so the blur behind them can be seen
waitwin() { for i in $(seq 1 60); do n=$(ev "global.get_window_actors().filter(a => (a.meta_window.get_wm_class() || '').toLowerCase().includes('$1')).length"); [ "${n:-0}" -ge 1 ] 2>/dev/null && break; sleep 1; done; sleep 4; }
M() { ev "global.__move($1, $2); 1" > /dev/null; }
away() { M 1700 900; ev "Main.overview.hide(); 1" > /dev/null; sleep 1.5; }
M 500 500; sleep .3; M 500 500; sleep .4; ev "Main.overview.hide(); 1" > /dev/null; sleep 2
mkdir -p /tmp/Studio; printf '# Studio notes\n\nReview the launch film.\nSend the final cut to the team.\nPick the music for the trailer.\n' > /tmp/Studio/notes.md
appenv gnome-calculator > /dev/null 2>&1 &
waitwin calculator; winpos calculator 330 250 520 640; sleep 1
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
waitwin texteditor; winpos texteditor 960 330 760 520; sleep 1.5; away; sleep 2; shot windows2
