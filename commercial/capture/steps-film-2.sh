# film shots, part 2: the island opening, the dock, Tile on real windows, the panel, a profile applied and a Flow run. Everything is the real thing.
S="Main.extensionManager.lookup('search@niro.local').stateObj"
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
waitwin() { for i in $(seq 1 60); do n=$(ev "global.get_window_actors().filter(a => (a.meta_window.get_wm_class() || '').toLowerCase().includes('$1')).length"); [ "${n:-0}" -ge 1 ] 2>/dev/null && break; sleep 1; done; sleep 4; }
M() { ev "global.__move($1, $2); 1" > /dev/null; }
away() { M 1700 900; ev "Main.overview.hide(); 1" > /dev/null; sleep 1.5; }
M 500 500; sleep .3; M 500 500; sleep .4          # the first move of a virtual pointer lands at x=0 (the hot corner opens the overview): prime it, then close the overview
ev "Main.overview.hide(); 1" > /dev/null; sleep 2
C="Main.extensionManager.lookup('island@niro.local').stateObj._controller"
CLOSE="global.get_window_actors().forEach(a => { if (a.meta_window.get_window_type() == 0) a.meta_window.delete(global.get_current_time()); }); 1"
mkdir -p /tmp/Studio/{Design,Music,Projects}; printf '# Studio notes\n\nReview the launch film.\nSend the final cut to the team.\nPick the music for the trailer.\n' > /tmp/Studio/notes.md
# ---- the island: closed, then the pointer rests on it and it opens (frames while it grows)
PLAY Pause; away; sleep 2; shot desk
PLAY Play; sleep 3; shot isl-closed
ev "$C.expand(); 1" > /dev/null
for i in 1 2 3 4 5 6 7 8; do shot isl-open-$i; done
sleep 2; shot isl-open
ev "$C.collapse(); 1" > /dev/null; away; sleep 2.5; shot isl-after
# ---- the dock under the pointer
M 700 900; sleep .5; for x in 790 880 960 1040 1130; do M $x 1052; sleep 1.0; shot dock-$x; done
away
# ---- Tile on four real windows
ev "Main.extensionManager.enableExtension('tile@niro.local'); 1" > /dev/null; sleep 4
TS="gsettings --schemadir /usr/share/gnome-shell/extensions/tile@niro.local/schemas set org.gnome.shell.extensions.tile"
appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 & sleep 6
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 & sleep 6
appenv gnome-calculator > /dev/null 2>&1 & sleep 6
appenv nautilus --new-window /tmp/Studio/Design > /dev/null 2>&1 & sleep 6
away; shot tile-off
$TS enabled true; $TS layout dwindle; sleep 3; away; shot tile-dwindle
$TS layout master-left; for i in 1 2 3 4; do shot tile-m-$i; done; sleep 2; shot tile-master
$TS layout grid; for i in 1 2 3 4; do shot tile-g-$i; done; sleep 2; shot tile-grid
$TS enabled false; sleep 2; ev "$CLOSE" > /dev/null; sleep 3
# ---- the panel: Home, then a profile applied for real, then Profiles
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1320x820 NIRO_PAGE=home niro-control > /dev/null 2>&1 &
waitwin niro; winpos org.niro.control 300 130 1320 820; away; sleep 2; shot panel-home
ev "$CLOSE" > /dev/null; sleep 3
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1320x820 NIRO_PAGE=profiles niro-control > /dev/null 2>&1 &
waitwin niro; winpos org.niro.control 300 130 1320 820; away; sleep 2; shot panel-profiles
RA() { gdbus call --session --dest org.niro.Search --object-path /org/niro/Search --method org.niro.Search.RunAction "$1" "$2" 2>&1 | head -c 300; echo; }
RA profile.apply '{"id":"deep-work"}' > "$WORK/apply.log"; sleep 4; shot panel-profiles-applied
ev "$CLOSE" > /dev/null; sleep 3; away; shot desk-deepwork
# ---- Flow: a workflow saved, then run
F="gdbus call --session --dest org.niro.island.Daemon --object-path /org/niro/island/Daemon --method"; Q="'"
WF='{"version":1,"id":"focus-mode","name":"Focus mode","trigger":{"type":"manual"},"allow":["settings"],"steps":[{"kind":"action","id":"s1","name":"system.dnd.toggle","args":{},"next":"s2"},{"kind":"action","id":"s2","name":"profile.apply","args":{"id":"creative"},"next":null}]}'
$F org.niro.Flow1.Save "$Q$WF$Q" > "$WORK/save.log" 2>&1; $F org.niro.Flow1.SetGlobalEnabled true > /dev/null 2>&1; sleep 2
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1320x820 NIRO_PAGE=flow niro-control > /dev/null 2>&1 &
waitwin niro; winpos org.niro.control 300 130 1320 820; away; sleep 3; shot flow-before
$F org.niro.Flow1.RunNow focus-mode > "$WORK/run.log" 2>&1; sleep 5; shot flow-after
ev "$CLOSE" > /dev/null; sleep 3
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1320x820 NIRO_PAGE=flow niro-control > /dev/null 2>&1 &
waitwin niro; winpos org.niro.control 300 130 1320 820; away; sleep 3; shot flow-history
$F org.niro.Flow1.History focus-mode > "$WORK/history.log" 2>&1
ev "$CLOSE" > /dev/null; sleep 3; away; shot desk-flow
cp "$WORK"/*.log "$OUT/" 2>/dev/null
