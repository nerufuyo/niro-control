# Helpers for the island runtime scripts (sourced by the steps; needs ev, shot, wait_ms, $C from island-session.sh).
# The recorder wraps the island's `_sync`, which the spring driver calls once per frame right after it stepped the springs, so a row's
# actor size and spring value/velocity are one coherent sample (a separate timeline may tick before or after the driver). One row a frame:
#   [ms, width, height, x, y, opacity, label, views, springW, springH, springR, velW, velH, state, pieces]
# (the first eight are tests/shell/motion.py's rows). `pieces` is whatever expression `rec_pieces` set, read every frame: opacities
# and offsets of the content that is revealed in turn. Rows exist only while the shape moves; `rec_sample` adds one on demand.

rec_start() {
    ev "(function(){ const GLib = imports.gi.GLib; const isl = $C._island; globalThis.__rec = {rows: [], label: 'start', pieces: () => []};
      const row = () => { const kids = []; isl._views.forEach((c, i) => kids.push(['view' + i + c.constructor.name, c.visible ? 1 : 0, c.opacity, c.translation_y, c.x, c.width]));
        __rec.rows.push([GLib.get_monotonic_time() / 1000, isl.width, isl.height, isl.x, isl.y, isl.opacity, __rec.label, kids,
          isl._width.value, isl._height.value, isl._radius.value, isl._width.velocity, isl._height.velocity, $C._surface.state, __rec.pieces()]); };
      __rec.row = row; __rec.orig = isl._sync; isl._sync = function() { __rec.orig.call(this); row(); }; return 1; })()" > /dev/null
}
rec_label() { ev "__rec.label = '$1'; 1" > /dev/null; }
rec_pieces() { ev "__rec.pieces = () => ($1); 1" > /dev/null; }
rec_stop() { ev "imports.gi.GLib.file_set_contents('$1', JSON.stringify(__rec.rows)); delete $C._island._sync; 1" > /dev/null; }

# Frames of `shot` while something moves: n shots as fast as the screenshot service allows (each is a real frame of the screen).
shots() { local name=$1 n=$2; for i in $(seq 1 "$n"); do shot "$name-$i"; done; }

# gsettings of the island extension, in the session's own key file.
isl_set() { ev "$C._settings.set_$1('$2', $3); 1" > /dev/null; }

# A second recorder for content that is not the shape: one row a frame, [ms, label, expression()], on a timeline tied to the island.
frames_start() {
    ev "(function(){ const Clutter = imports.gi.Clutter, GLib = imports.gi.GLib; globalThis.__fr = {rows: [], label: 'start', expr: () => []};
      const t = new Clutter.Timeline({actor: $C._island, duration: 1000, repeat_count: -1});
      t.connect('new-frame', () => __fr.rows.push([GLib.get_monotonic_time() / 1000, __fr.label, __fr.expr()])); t.start(); __fr.t = t; return 1; })()" > /dev/null
}
frames_label() { ev "__fr.label = '$1'; 1" > /dev/null; }
frames_expr() { ev "__fr.expr = () => ($1); 1" > /dev/null; }
frames_stop() { ev "imports.gi.GLib.file_set_contents('$1', JSON.stringify(__fr.rows)); __fr.t.stop(); __fr.t = null; 1" > /dev/null; }
