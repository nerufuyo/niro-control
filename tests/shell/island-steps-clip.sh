# Content against the surface's edge while the island widens and narrows, in a real shell: every frame, the screen box of the stage (the
# island's clip) and of the content actors that sit near its edges (the closed island's signs and clock, the open island's first tab and
# page), so a jump of the content, or content outside the clip, shows. Judged by tests/shell/island-clip.py.
# Scenarios: compact -> split (a second activity widens the closed island), compact -> expanded -> compact, a sign that comes
# (music) and goes, 20 expand/collapse flips, a retarget in mid-flight, and the same with reduced motion.
source "$HERE/island-steps-lib.sh"
FR="$OUT/clip.json"
MODE=${MODE:-full}
isl_set string auto-hide "'off'"
[ "$MODE" = off ] && ev "$C._settings.set_string('motion-preset', 'off'); 1" > /dev/null
[ "$MODE" = minimal ] && ev "$C._settings.set_string('motion-preset', 'minimal'); 1" > /dev/null
start_player; sleep 3
ev "(function(){ globalThis.__bx = (n, a) => { if (!a || !a.get_stage()) return [n, 0, 0, 0, 0, 0, 0]; const [x, y] = a.get_transformed_position(), [w, h] = a.get_transformed_size();
    return [n, x, y, w, h, a.get_paint_opacity(), a.mapped && a.visible ? 1 : 0]; };
  globalThis.__rows = () => { const c = $C._compact, e = $C._expanded, i = $C._island, s = i._stage;
    return [__bx('stage', s), __bx('island', i), __bx('lead', c._lead.child), __bx('right', c._right.child), __bx('clock', c._clockTime), __bx('compact', c),
            __bx('tab0', (e._tabs.find(t => t.tab.visible) || e._tabs[0]).tab), __bx('tab1', e._tabs.filter(t => t.tab.visible)[1]?.tab), __bx('expanded', e), __bx('page', e.page), i._width.value, i._height.value]; }; return 1; })()" > /dev/null
# One row per painted frame (the stage's after-paint: layout is done, so the boxes are what is on the screen; a timeline's new-frame
# comes before the layout of its frame and reads the one before for the actors the layout moves).
ev "(function(){ const GLib = imports.gi.GLib; globalThis.__fr = {rows: [], label: 'start', expr: () => __rows()};
  __fr.id = global.stage.connect('after-paint', () => __fr.rows.push([GLib.get_monotonic_time() / 1000, __fr.label, __fr.expr()])); return 1; })()" > /dev/null
echo "BOOT $(ev "$C._surface.state + '/' + $C._presentation")"
# a song: its art at the left, the bars at the right
frames_label sign_comes; PLAY Play; sleep 3
frames_label to_split; ev "$C._daemon.call('pomodoro', 'Start'); 1" > /dev/null; sleep 2.5
echo "SPLIT $(ev "$C._surface.state")"
frames_label split_to_expanded; ev "$C.expand('music'); 1" > /dev/null; sleep 2.5; shot clip-expanded
frames_label expanded_to_split; ev "$C.collapse(); 1" > /dev/null; sleep 2.5
frames_label split_to_compact; ev "$C._daemon.call('pomodoro', 'Stop'); 1" > /dev/null; sleep 2.5
frames_label compact_to_expanded; ev "$C.expand('music'); 1" > /dev/null; sleep 2.5
frames_label expanded_to_compact; ev "$C.collapse(); 1" > /dev/null; sleep 2.5
frames_label sign_goes; stop_player; sleep 3
# 20 flips, 120 ms apart: always in flight
frames_label flips
for i in $(seq 1 10); do ev "$C.expand('music'); 1" > /dev/null; sleep 0.12; ev "$C.collapse(); 1" > /dev/null; sleep 0.12; done; sleep 2.5
# a retarget in mid-flight, both ways
frames_label retarget_open; ev "$C.expand('music'); 1" > /dev/null; sleep 0.13; ev "$C.collapse(); 1" > /dev/null; sleep 2.5
frames_label retarget_close; ev "$C.expand('music'); 1" > /dev/null; sleep 2.5; ev "$C.collapse(); 1" > /dev/null; sleep 0.15; ev "$C.expand('music'); 1" > /dev/null; sleep 2.5
ev "$C.collapse(); 1" > /dev/null; sleep 2
frames_label end; sleep 0.3
ev "global.stage.disconnect(__fr.id); imports.gi.GLib.file_set_contents('$FR', JSON.stringify(__fr.rows)); 1" > /dev/null
echo "MODE $MODE"
python3 "$HERE/island-clip.py" "$FR" "$MODE"
