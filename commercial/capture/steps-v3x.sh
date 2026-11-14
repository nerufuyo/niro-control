# extras (accent A only): the Search palette while typing, so the typing can be shown with real frames
S="Main.extensionManager.lookup('search@niro.local').stateObj"
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
bg() { ev "(function(){ const G = imports.gi.Gio; const b = new G.Settings({schema_id: 'org.gnome.desktop.background'}); for (const k of ['picture-uri', 'picture-uri-dark']) b.set_string(k, 'file://$ROOT/commercial/assets/bg/$1.png'); return 1; })()" > /dev/null; sleep 2; }
pair() { bg black; shot "$1-k"; bg white; shot "$1-w"; }
PLAY Play; ev "global.__move(7400, 2000); 1" > /dev/null; sleep 3
ev "$S._open(); 1" > /dev/null; sleep 1.5
ev "$S._entry.set_text('a'); 1" > /dev/null; sleep 1.5; pair search-a
ev "$S._entry.set_text('acc'); 1" > /dev/null; sleep 1.5; pair search-acc
ev "$S._close(); 1" > /dev/null
