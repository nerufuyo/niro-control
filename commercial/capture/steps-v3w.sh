# one app per private session (apps launched back to back in one session proved unreliable). WHAT = files | editor | panel | both
mkdir -p /tmp/Studio/{Design,Music,Projects,Wallpapers}
printf '# Studio notes\n\nReview the launch film.\nSend the final cut to the team.\nPick the music for the trailer.\n' > /tmp/Studio/notes.md
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
bg() { ev "(function(){ const G = imports.gi.Gio; const b = new G.Settings({schema_id: 'org.gnome.desktop.background'}); for (const k of ['picture-uri', 'picture-uri-dark']) b.set_string(k, 'file://$ROOT/commercial/assets/bg/$1.png'); return 1; })()" > /dev/null; sleep 2; }
pair() { bg black; shot "$1-k"; bg white; shot "$1-w"; }
away() { ev "global.__move(7400, 2000); 1" > /dev/null; sleep 1.5; }
has() { for i in $(seq 1 170); do o=$(ev "global.get_window_actors().filter(a => /Nautilus|TextEditor|niro/i.test(a.meta_window.get_wm_class() || '') && a.width > 100).length"); [ "${o:-0}" -ge "$1" ] 2>/dev/null && break; sleep 1; done; sleep 5; }
PLAY Play
case "$WHAT" in
 files|both) appenv nautilus --new-window --select /tmp/Studio/notes.md > /dev/null 2>&1 & has 1;;
esac
case "$WHAT" in
 editor|both) appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 & has $([ "$WHAT" = both ] && echo 2 || echo 1); ev "(function(){ const w = global.get_window_actors().map(a => a.meta_window).find(w => /TextEditor/i.test(w.get_wm_class() || '')); w.move_frame(true, 3300, 700); return 1; })()" > /dev/null; sleep 2;;
 panel) appenv env GSK_RENDERER=cairo NIRO_NOBANNER=1 NIRO_SIZE=1180x780 NIRO_PAGE=look niro-control > /dev/null 2>&1 & has 1;;
esac
away; sleep 2
case "$WHAT" in files) pair files;; editor) pair editor;; panel) pair panel-look;; both) pair dock-both;; esac
