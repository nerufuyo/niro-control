// Loaded into the shell's eval scope by dock-motion-steps.sh: probes for the dock's motion tests. Everything hangs off global.__t.
// Pointer input is the compositor's own virtual pointer (Clutter virtual input device), so stage motion events are real.
(function () {
    const C = imports.gi.Clutter, G = imports.gi.GLib;
    const T = global.__t = {};
    const now = () => G.get_monotonic_time() / 1000;
    T.now = now;
    T.dm = () => Main.extensionManager.lookup('dock@niro.local').stateObj._dockManager;
    T.vis = () => T.dm()._visibility;
    T.mag = () => T.dm()._magnification;
    T.im = () => T.dm()._iconManager;
    T.box = () => T.dm()._container;
    T.log = [];
    T.frames = [];
    T.move = (x, y) => global.__ptr.notify_absolute_motion(G.get_monotonic_time(), x, y);
    T.click = () => { const t = G.get_monotonic_time(); global.__ptr.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global.__ptr.notify_button(t + 40000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); };
    // log every state-machine event the visibility code dispatches, with the state it ended in and the slide spring
    T.patch = () => {
        const v = T.vis();
        if (v.__patched) return;
        v.__patched = true;
        const orig = v._dispatch.bind(v);
        v._dispatch = (e) => { const before = v._state; orig(e); T.log.push({t: now(), e, from: before, to: v._state, slide: +v._slide.value.toFixed(4), vel: +v._slide.velocity.toFixed(3)}); };
        if (!T.paintId) T.paintId = global.stage.connect('after-paint', () => { T.frames.push(now()); });
    };
    T.reset = () => { T.patch(); T.log = []; T.frames = []; };
    T.snap = () => { const v = T.vis(), b = T.box(); return {state: v._state, shown: v._shown, slide: +v._slide.value.toFixed(4), ty: +b.translation_y.toFixed(2), op: b.opacity, vis: b.visible, anim: v._slideTimeline !== null, edge: v._edgeLatched}; };
    T.pointer = () => global.get_pointer().slice(0, 2);
    // icon rows: layout position, size and applied transform of each dock child, and the rendered horizontal extent
    T.geom = () => {
        const b = T.box(), [bx, by] = b.get_position();
        const kids = b.get_children().map((c, i) => {
            const [x, y] = c.get_position(), w = c.get_width(), h = c.get_height();
            const s = c.scale_x, tx = c.translation_x, ty = c.translation_y;
            const cx = x + w / 2 + tx; // pivot x is 0.5: the centre moves only by the translation
            return {i, x, y, w, h, s: +s.toFixed(4), tx: +tx.toFixed(3), ty: +ty.toFixed(2), cx: +cx.toFixed(2), left: +(cx - w * s / 2).toFixed(2), right: +(cx + w * s / 2).toFixed(2), name: c.style_class || ''};
        });
        return {bx, by, bw: b.get_width(), bh: b.get_height(), kids};
    };
    // timer-driven pointer sweep at ~125 Hz of events: from (x0,y) to (x1,y) and back, `n` laps over `ms` per lap
    T.sweep = (x0, x1, y, ms, laps) => {
        const t0 = now(); T.sweepDone = false; let nev = 0;
        const id = G.timeout_add(G.PRIORITY_DEFAULT, 8, () => {
            const el = now() - t0, lap = el / ms, k = Math.floor(lap);
            if (k >= laps) { T.sweepDone = true; T.sweepEvents = nev; return G.SOURCE_REMOVE; }
            const f = lap - k, p = f < 0.5 ? f * 2 : (1 - f) * 2;
            T.move(Math.round(x0 + (x1 - x0) * p), y); nev++;
            return G.SOURCE_CONTINUE;
        });
        return 1;
    };
    // frame interval stats between two timestamps
    T.frameStats = (from, to) => {
        const f = T.frames.filter(t => t >= from && t <= to), d = [];
        for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
        d.sort((a, b) => a - b);
        const n = d.length; if (!n) return {frames: f.length};
        return {frames: f.length, mean: +(d.reduce((a, b) => a + b, 0) / n).toFixed(2), p50: +d[Math.floor(n / 2)].toFixed(2), p95: +d[Math.floor(n * 0.95)].toFixed(2), max: +d[n - 1].toFixed(2)};
    };
    // sample the dock's own actor on every frame while something runs (opacity, translation, state)
    T.samples = [];
    T.sampling = (on) => {
        if (on && !T.sampId) { T.samples = []; T.sampId = global.stage.connect('after-paint', () => { const b = T.box(); T.samples.push([+now().toFixed(1), +b.translation_y.toFixed(2), b.opacity, T.vis()._state]); }); }
        if (!on && T.sampId) { global.stage.disconnect(T.sampId); T.sampId = 0; }
        return 1;
    };
    // smallest gap between neighbours' rendered extents (negative = overlap) and the largest scale, tracked on every frame
    T.minGap = () => { const k = T.geom().kids, g = []; for (let i = 1; i < k.length; i++) g.push(k[i].left - k[i - 1].right); return g.length ? Math.min(...g) : 99; };
    T.gap = {min: 99, maxScale: 1, n: 0};
    T.gapSampling = (on) => {
        if (on && !T.gapId) { T.gap = {min: 99, maxScale: 1, n: 0}; T.gapId = global.stage.connect('after-paint', () => { if (!T.box().visible) return; const k = T.geom().kids; let m = 99, ms = 1; for (let i = 0; i < k.length; i++) { ms = Math.max(ms, k[i].s); if (i) m = Math.min(m, k[i].left - k[i - 1].right); } T.gap.min = Math.min(T.gap.min, m); T.gap.maxScale = Math.max(T.gap.maxScale, ms); T.gap.n++; }); }
        if (!on && T.gapId) { global.stage.disconnect(T.gapId); T.gapId = 0; }
        return 1;
    };
    // sample an actor's translation_y every `ms` for `dur` ms (a bounce), result in T.bounce
    T.watchBounce = (actor, ms, dur) => { const t0 = now(); T.bounce = []; const id = G.timeout_add(G.PRIORITY_DEFAULT, ms, () => { T.bounce.push([+(now() - t0).toFixed(0), +actor.translation_y.toFixed(2)]); return (now() - t0 < dur) ? G.SOURCE_CONTINUE : G.SOURCE_REMOVE; }); return 1; };
    T.out = '';
    T.save = (name, obj) => { imports.gi.Gio.File.new_for_path(`${T.out}/${name}.json`).replace_contents(JSON.stringify(obj), null, false, imports.gi.Gio.FileCreateFlags.NONE, null); return 1; };
    return 1;
})()
