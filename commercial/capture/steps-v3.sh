# v3 plates (7680x4320 virtual monitor at scale 4 = a 1920x1080 desktop at 4 px per point): every element captured twice over a pure black and a pure white desktop ("pair"), so its translucency can be recovered exactly
# (alpha = 1 - (white capture - black capture) / 255) and the element can then sit on the film's own wallpaper. One session = one accent (ACCENT / TINT env).
mkdir -p /tmp/Studio/{Design,Music,Projects,Wallpapers}
printf '# Studio notes\n\nReview the launch film.\nSend the final cut to the team.\nPick the music for the trailer.\n' > /tmp/Studio/notes.md
S="Main.extensionManager.lookup('search@niro.local').stateObj"
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
CLOSE="global.get_window_actors().forEach(a => { if (a.meta_window.get_window_type() == 0) a.meta_window.delete(global.get_current_time()); }); 1"
bg() { ev "(function(){ const G = imports.gi.Gio; const b = new G.Settings({schema_id: 'org.gnome.desktop.background'}); for (const k of ['picture-uri', 'picture-uri-dark']) b.set_string(k, 'file://$ROOT/commercial/assets/bg/$1.png'); return 1; })()" > /dev/null; sleep 2; }
pair() { bg black; shot "$1-k"; bg white; shot "$1-w"; }
waitwin() { for i in $(seq 1 60); do n=$(ev "global.get_window_actors().filter(a => (a.meta_window.get_wm_class() || '').toLowerCase().includes('$1')).length"); [ "${n:-0}" -ge 1 ] 2>/dev/null && break; sleep 1; done; sleep 4; }
away() { ev "global.__move(7400, 2000); 1" > /dev/null; sleep 1.5; }
PLAY Pause; away; sleep 2
pair pill-paused
PLAY Play; sleep 3; pair pill-playing
ev "global.__move(3840, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(3846, 36); 1" > /dev/null; sleep 3; pair open-playing
PLAY Pause; sleep 2; pair open-paused
PLAY Play; away; sleep 2
ev "$S._open(); 1" > /dev/null; sleep 1.5; pair search-open
ev "$S._entry.set_text('accent'); 1" > /dev/null; sleep 1.5; pair search-accent
ev "$S._close(); 1" > /dev/null; sleep 1
appenv nautilus --new-window --select /tmp/Studio/notes.md > /dev/null 2>&1 &
waitwin nautilus; winpos nautilus 800 760 3400 2200; sleep 1.5; away; sleep 2; pair files
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
waitwin texteditor; winpos texteditor 3300 900 3040 1920; sleep 1.5; away; sleep 2; pair dock-both
ev "$CLOSE" > /dev/null; sleep 3
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
waitwin texteditor; winpos texteditor 3300 900 3040 1920; sleep 1.5; away; sleep 2; pair editor
ev "$CLOSE" > /dev/null; sleep 3
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1180x780 NIRO_PAGE=look niro-control > /dev/null 2>&1 &
waitwin niro; winpos org.niro.control 1480 600 4720 3120; sleep 1.5; away; sleep 2; pair panel-look
ev "$CLOSE" > /dev/null; sleep 2
