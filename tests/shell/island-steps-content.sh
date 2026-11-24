# The content that moves with the shape, in a real shell: the split's second zone, the music page's staggered reveal and its reverse when the
# track goes (and a retreat turned round half way), an alert's spring and reveal by priority, and a burst of volume events coalesced.
# Judged by tests/shell/island-reveal.py.
source "$HERE/island-steps-lib.sh"
FR="$OUT/frames.json"
MP="$C._expanded.pageNamed('music')"
isl_set string auto-hide "'off'"
start_player; sleep 3; PLAY Play; sleep 3
frames_start
# ---- split: the second zone fades in after the shape made room, the first sign is already there
frames_expr "(function(){ const c = $C._compact; return [c._lead.child ? c._lead.child.opacity : -1, c._right.child ? c._right.child.opacity : -1, [...c._ghosts][0] ? [...c._ghosts][0].opacity : -1]; })()"
frames_label split_in; ev "$C._daemon.call('pomodoro', 'Start'); 1" > /dev/null; sleep 2.5
frames_label split_out; ev "$C._daemon.call('pomodoro', 'Stop'); 1" > /dev/null; sleep 2.5
# ---- the music page: cover, words, progress, controls in turn
frames_expr "(function(){ const p = $MP; return (p._shownPieces() || []).map(a => a.opacity); })()"
frames_label reveal_open; ev "$C.expand('music'); 1" > /dev/null; sleep 2; shot shot-music-open
echo "PIECES $(ev "JSON.stringify($MP._shownPieces().map(a => a.constructor.name + ':' + a.opacity + ':' + a.translation_y))")"
# a retreat turned round half way: the track is still there, so it comes back from where each piece is, not from nothing
frames_label retreat_turned; ev "$MP._retreat(); 1" > /dev/null; sleep 0.14
echo "TURN $(ev "JSON.stringify($MP._shownPieces().map(a => a.opacity)) + ' retreating=' + $MP._retreating")"
ev "$MP._update(); 1" > /dev/null; sleep 1.5
echo "TURNED $(ev "JSON.stringify($MP._shownPieces().map(a => a.opacity + ':' + a.translation_y)) + ' retreating=' + $MP._retreating")"
# the track goes: its pieces leave in reverse, then the empty page
frames_label retreat_gone; stop_player; sleep 3
echo "GONE $(ev "'track=' + JSON.stringify(Boolean($C._daemon.state.nowPlaying?.title)) + ' empty=' + $MP._empty.visible + ' retreating=' + $MP._retreating + ' emptyOpacity=' + $MP._empty.opacity")"
shot shot-music-empty
frames_label reveal_again; start_player; sleep 2; PLAY Play; sleep 3
echo "BACKAGAIN $(ev "JSON.stringify($MP._shownPieces().map(a => a.opacity + ':' + a.translation_y)) + ' empty=' + $MP._empty.visible")"
shot shot-music-again
ev "$C.collapse(); 1" > /dev/null; sleep 2
# ---- alerts: the spring and the reveal by priority
frames_expr "(function(){ const p = $C._peek; return [p._lead.opacity, p._texts.opacity, p._accessory.opacity]; })()"
ALERT_R="{key: 'rt-routine', kind: 'notification', title: 'Build finished', subtitle: 'Three warnings', icon: 'dialog-information-symbolic', duration: 3000}"
ALERT_C="{key: 'rt-critical', kind: 'notification', priority: 'instant', tone: 'warning', title: 'Battery critically low', subtitle: '4% left, plug in', icon: 'dialog-warning-symbolic', duration: 3000}"
frames_label alert_routine; echo "ALERT_ROUTINE $(ev "$C._post($ALERT_R); JSON.stringify([$C._island._lastPlan.size, $C._presentation])")"; sleep 0.5; shot shot-alert-routine; sleep 3.5
frames_label alert_critical; echo "ALERT_CRITICAL $(ev "$C._post($ALERT_C); JSON.stringify([$C._island._lastPlan.size, $C._presentation])")"; sleep 0.5; shot shot-alert-critical; sleep 3.5
echo "AFTER_ALERT $(ev "JSON.stringify([$C._island._lastPlan.size, $C._presentation, $C._surface.state])")"
# ---- a burst of volume events: 60 in 480 ms, as key repeat would send; how many were applied, and which one won
ev "(function(){ const GLib = imports.gi.GLib; let n = 0; const orig = $C._showOsdNow.bind($C); $C._showOsdNow = (...a) => { n++; orig(...a); }; globalThis.__osd = {applied: () => n, sent: 0};
  let i = 0; GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => { i++; __osd.sent = i; $C._postOsd(new imports.gi.Gio.ThemedIcon({name: 'audio-volume-high-symbolic'}), 'Volume', i / 60, 1); return i < 60 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE; }); return 1; })()" > /dev/null
sleep 0.9
echo "VOLUME $(ev "JSON.stringify({sent: __osd.sent, applied: __osd.applied(), shownLevel: $C._alert ? $C._alert.level : null, lastSent: 1, key: $C._alert?.key, held: $C._osdHeld})")"
sleep 2.5
frames_stop "$FR"
python3 "$HERE/island-reveal.py" "$FR"
