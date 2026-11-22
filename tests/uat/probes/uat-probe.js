// Read-only observer for the desktop UAT (docs/motion/uat/README.md). It is pasted into the real session through Looking Glass
// (Alt+F2, `lg`, Evaluator tab) with the one-liner the UAT guide gives, so it needs no unsafe mode and changes nothing in the
// extensions: it only connects signals on the stage and on actors it finds by their names or style classes, and disconnects
// them all in __uat.stop(). It lives in the shell process until you stop it or log out.
//
//   __uat.start('frames')   compositor frame pacing: the interval between paints of the stage (real GPU, real refresh rate)
//   __uat.start('search')   Search: key-to-text and key-to-paint latency of real key presses, lost characters, the open motion, the gap to the island
//   __uat.start('dock')     Dock: icon scales and centres every paint while a real pointer moves, neighbour overlap, magnification left on after the pointer rests
//   __uat.start('island')   Island: surface size and position every paint, content outside the surface, content moving relative to it
//   __uat.census()          counts the actors under the stage (run before and after enable/disable cycles: the total must come back)
//   __uat.mark('text')      puts a label in the rows (what you are about to do), so the file can be read afterwards
//   __uat.stop()            stops, writes ~/niro-uat/<time>-<kind>.json and returns a summary (also logged to the journal as "[niro-uat]")
//
// Not measured, by design: the time from the key or pointer hardware to the compositor (kernel, libinput) and from the paint to the
// photons (scan-out). Phone slow-motion video covers that end to end. Every number here is evidence for a person to read, not a verdict:
// the UAT never changes an animation parameter because of one of them.
(function () {
    const {GLib, Clutter, St} = imports.gi;
    const now = () => GLib.get_monotonic_time() / 1000;
    if (globalThis.__uat && globalThis.__uat.stop) { try { globalThis.__uat.stop(true); } catch (e) { /* the old probe is gone */ } }

    const U = globalThis.__uat = {version: 1, kind: null, rows: [], marks: [], conns: [], label: '', out: null};
    const log = m => console.log('[niro-uat] ' + m);

    // ---- finding actors without Main: the extensions name or class their own
    const walk = (a, f) => { if (f(a)) return a; for (const c of a.get_children()) { const r = walk(c, f); if (r) return r; } return null; };
    const byName = n => walk(global.stage, a => a.name === n);
    const byClass = c => walk(global.stage, a => a.style_class === c);
    const ext = a => { const [x, y] = a.get_transformed_position(), [w, h] = a.get_transformed_size(); return {x, y, w, h, r: x + w, b: y + h}; };
    const connect = (obj, sig, cb) => { const id = obj.connect(sig, cb); U.conns.push([obj, id]); return id; };
    const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
    const stats = arr => arr.length ? {n: arr.length, min: pct(arr, 0), p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99), max: pct(arr, 1)} : {n: 0};

    // ---- frame pacing, shared by every kind: the paint timestamps
    const paints = [];
    const startPaints = () => connect(global.stage, 'after-paint', () => { paints.push(now()); if (paints.length > 200000) paints.shift(); });

    // Intervals inside bursts of activity only: a still desktop paints nothing, so a long gap there is not a stall. A burst ends at a gap over 100 ms.
    const pacing = (ts, nominalHz) => {
        const iv = [], bursts = [];
        let cur = [];
        for (let i = 1; i < ts.length; i++) {
            const d = ts[i] - ts[i - 1];
            if (d > 100) { if (cur.length > 3) bursts.push(cur); cur = []; } else { iv.push(d); cur.push(d); }
        }
        if (cur.length > 3) bursts.push(cur);
        const nominal = nominalHz ? 1000 / nominalHz : pct(iv, 0.5);
        return {intervals: stats(iv), nominal_ms: nominal ? +nominal.toFixed(2) : null,
            late_over_1_5x: nominal ? iv.filter(d => d > nominal * 1.5).length : null,
            late_over_2x: nominal ? iv.filter(d => d > nominal * 2).length : null,
            worst_ms: iv.length ? +Math.max(...iv).toFixed(2) : null, bursts: bursts.length};
    };

    // ---- search
    const startSearch = () => {
        const box = byClass('niro-search'), entry = byClass('niro-search-entry');
        if (!box || !entry) throw new Error('Search is not loaded: no actor with style class niro-search (is search@niro.local enabled?)');
        const text = entry.clutter_text;
        const keys = [];            // pending printable key presses: {t, ch}
        const lat = [], latPaint = [], extra = {printable: 0, backspace: 0, other: 0, duringOpen: 0, matched: 0, unmatched: 0};
        let prevLen = text.get_text().length, openAt = 0, opening = false;
        // key presses as the focused entry sees them (this signal runs before the entry's own handler inserts the character)
        connect(text, 'key-press-event', (a, ev) => {
            const sym = ev.get_key_symbol(), uni = ev.get_key_unicode();
            const t = now();
            const printable = uni && uni >= 32 && uni !== 127 && !(ev.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK));
            if (sym === Clutter.KEY_BackSpace) extra.backspace++;
            else if (printable) { extra.printable++; keys.push({t, ch: String.fromCodePoint(uni)}); if (opening) extra.duringOpen++; }
            else extra.other++;
            U.rows.push({k: 'key', t: +t.toFixed(2), sym, ch: printable ? String.fromCodePoint(uni) : null, label: U.label});
            return Clutter.EVENT_PROPAGATE;
        });
        connect(text, 'text-changed', () => {
            const t = now(), len = text.get_text().length;
            if (len > prevLen) {
                // a character appeared: pair it with the oldest key press that has no text yet (input methods may commit a little later)
                const k = keys.shift();
                if (k) {
                    extra.matched++; lat.push(t - k.t);
                    const paintAt = () => { const n = paints.find(p => p >= t); if (n) latPaint.push(n - k.t); };
                    GLib.idle_add(GLib.PRIORITY_LOW, () => { paintAt(); return GLib.SOURCE_REMOVE; });
                } else extra.unmatched++;
            }
            prevLen = len;
            U.rows.push({k: 'text', t: +t.toFixed(2), len});
        });
        // the open motion: pose per paint while visible
        let wasVisible = box.visible;
        const pose = () => {
            const t = now();
            if (box.visible && !wasVisible) { openAt = t; opening = true; U.rows.push({k: 'open', t: +t.toFixed(2)}); }
            if (!box.visible && wasVisible) U.rows.push({k: 'close', t: +t.toFixed(2)});
            wasVisible = box.visible;
            if (!box.visible) return;
            const e = ext(box), isl = byName('islandIsland'), ie = isl && isl.visible && isl.opacity > 8 ? ext(isl) : null;
            const overlapX = ie && e.x < ie.r && ie.x < e.r;
            const gap = ie && overlapX ? e.y - ie.b : null;                            // negative: Search overlaps the island
            if (opening && t - openAt > 700) opening = false;
            U.rows.push({k: 'pose', t: +t.toFixed(2), x: +e.x.toFixed(2), y: +e.y.toFixed(2), w: +e.w.toFixed(1), h: +e.h.toFixed(1), op: box.opacity,
                focus: global.stage.key_focus === text, gap: gap === null ? null : +gap.toFixed(2)});
        };
        connect(global.stage, 'after-paint', pose);
        startPaints();
        U.finish = () => {
            const poses = U.rows.filter(r => r.k === 'pose');
            let maxStepY = 0, noFocus = 0, minGap = null, overlapFrames = 0;
            for (let i = 0; i < poses.length; i++) {
                if (!poses[i].focus) noFocus++;
                if (poses[i].gap !== null) { minGap = minGap === null ? poses[i].gap : Math.min(minGap, poses[i].gap); if (poses[i].gap < 0) overlapFrames++; }
                if (i && poses[i].t - poses[i - 1].t < 50) maxStepY = Math.max(maxStepY, Math.abs(poses[i].y - poses[i - 1].y));
            }
            const finalLen = text.get_text().length;
            const hookWarning = extra.printable === 0 && extra.unmatched > 0 ? 'The entry showed text but its key-press-event never fired, so key latency was NOT measured. Record this as a finding (what kind of keyboard/input method?) and fall back to the video method.' : null;
            return {
                keys: extra, final_text_length: finalLen, key_hook_warning: hookWarning,
                lost_characters_estimate: Math.max(0, extra.printable - extra.matched - keys.length) + keys.length,
                key_to_text_ms: stats(lat), key_to_next_paint_ms: stats(latPaint),
                poses: poses.length, frames_without_input_focus: noFocus, max_y_step_per_frame_px: +maxStepY.toFixed(2),
                min_gap_to_island_px: minGap, frames_overlapping_island: overlapFrames,
                pacing: pacing(paints),
                note: 'key_to_text is compositor time only (capture to text-changed). lost_characters_estimate counts printable key presses that never produced text; deleting text does not affect it.'};
        };
    };

    // ---- dock
    const startDock = () => {
        const dock = byClass('dock-container');
        if (!dock) throw new Error('Dock is not loaded: no actor with style class dock-container (is dock@niro.local enabled?)');
        let lastMove = now(), lastPtr = global.get_pointer().slice(0, 2);
        let prev = null;
        const sample = timer => {
            const t = now();
            const [px, py] = global.get_pointer();
            if (px !== lastPtr[0] || py !== lastPtr[1]) { lastMove = t; lastPtr = [px, py]; }
            if (!dock.visible) return;
            const kids = dock.get_children().filter(c => c.visible && c.width > 0 && c.get_n_children !== undefined);
            const icons = kids.map(c => { const e = ext(c); return {s: +c.scale_x.toFixed(4), l: +e.x.toFixed(2), r: +e.r.toFixed(2), cx: +(e.x + e.w / 2).toFixed(2), ty: +c.translation_y.toFixed(2)}; });
            const row = {k: 'dock', src: timer ? 't' : 'p', t: +t.toFixed(2), px: Math.round(lastPtr[0]), py: Math.round(lastPtr[1]), idle: +(t - lastMove).toFixed(0), icons};
            if (prev && prev.icons.length === icons.length && t - prev.t < 50) {
                row.dScale = +Math.max(0, ...icons.map((c, i) => Math.abs(c.s - prev.icons[i].s))).toFixed(4);
                row.dCx = +Math.max(0, ...icons.map((c, i) => Math.abs(c.cx - prev.icons[i].cx))).toFixed(2);
            }
            let overlap = 0;
            for (let i = 1; i < icons.length; i++) overlap = Math.max(overlap, icons[i - 1].r - icons[i].l);
            row.overlap = +overlap.toFixed(2);
            U.rows.push(row); prev = row;
        };
        connect(global.stage, 'after-paint', () => sample(false));
        // a still screen paints nothing, so rest is sampled by a timer as well (rows marked src 't' are left out of the pacing)
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => { sample(true); return GLib.SOURCE_CONTINUE; });
        U.conns.push([{disconnect: id => GLib.source_remove(id)}, timer]);
        startPaints();
        U.finish = () => {
            const rows = U.rows.filter(r => r.k === 'dock');
            const moving = rows.filter(r => r.src === 'p' && r.idle < 120);
            const rest = rows.filter(r => r.idle > 1200);
            const dS = moving.map(r => r.dScale).filter(v => v !== undefined), dC = moving.map(r => r.dCx).filter(v => v !== undefined);
            const stuck = rest.filter(r => r.icons.some(c => c.s > 1.02));
            return {
                paints_with_dock: rows.filter(r => r.src === 'p').length, paints_while_pointer_moving: moving.length,
                max_scale_step_per_frame: dS.length ? +Math.max(...dS).toFixed(4) : null, max_centre_step_per_frame_px: dC.length ? +Math.max(...dC).toFixed(2) : null,
                max_neighbour_overlap_px: rows.length ? Math.max(...rows.map(r => r.overlap)) : null,
                frames_over_1px_overlap: rows.filter(r => r.overlap > 1).length,
                rest_frames_with_magnified_icon: stuck.length, rest_frames: rest.length,
                pacing_while_moving: pacing(moving.map(r => r.t)),
                note: 'Rest = pointer still for over 1.2 s: any icon above scale 1.02 then is a stuck magnification. Overlap is the rendered right edge of an icon minus the left edge of the next one.'};
        };
    };

    // ---- island: voice, peek (alert) and the other surfaces
    const startIsland = () => {
        const isl = byName('islandIsland');
        if (!isl) throw new Error('Island is not loaded: no actor named islandIsland (is island@niro.local enabled?)');
        let prev = null;
        const finite = e => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.w) && Number.isFinite(e.h);
        const leaves = () => { const out = []; walk(isl, a => { if (a !== isl && a.get_n_children() === 0 && /^(Clutter_Text|St_Icon|St_Label|BotIcon)$/.test(a.constructor.name) && a.mapped && a.get_paint_opacity() > 8 && a.width > 0 && a.height > 0) out.push(a); return false; }); return out; };
        connect(global.stage, 'after-paint', () => {
            const t = now();
            if (!isl.visible || isl.opacity < 8) return;
            const e = ext(isl);
            if (!finite(e)) return;
            let outside = 0, outsideN = 0;
            const rel = new Map();
            for (const a of leaves()) {
                const x = ext(a);
                if (!finite(x)) continue;
                // a leaf wholly outside the surface is hidden by the clip and is no defect; one that straddles the edge is drawn cut off
                const straddles = x.x < e.r && x.r > e.x && x.y < e.b && x.b > e.y;
                const o = straddles ? Math.max(0, e.x - x.x, x.r - e.r, e.y - x.y, x.b - e.b) : 0;
                if (o > 0.5) outsideN++;
                outside = Math.max(outside, o);
                rel.set(a, {cx: x.x + x.w / 2 - (e.x + e.w / 2)});
            }
            let jump = 0;
            if (prev && t - prev.t < 50) {
                // content that moves with the surface keeps its offset from the surface centre; a jump is an offset change beyond what the surface's own edge moved
                const dEdge = Math.max(Math.abs(e.x - prev.e.x), Math.abs(e.r - prev.e.r));
                for (const [a, r] of rel) { const p = prev.rel.get(a); if (!p) continue; jump = Math.max(jump, Math.abs(r.cx - p.cx) - dEdge); }
            }
            const views = (isl._views || []).filter(v => v.visible && v.opacity > 8).map(v => v.constructor.name);
            const row = {k: 'island', t: +t.toFixed(2), x: +e.x.toFixed(1), y: +e.y.toFixed(1), w: +e.w.toFixed(1), h: +e.h.toFixed(1), views, label: U.label,
                outside: +outside.toFixed(2), outsideN, jump: +jump.toFixed(2)};
            U.rows.push(row); prev = {t, e, rel};
        });
        startPaints();
        U.finish = () => {
            const rows = U.rows.filter(r => r.k === 'island');
            const byLabel = {};
            for (const r of rows) { const g = byLabel[r.label || '(none)'] ||= {frames: 0, maxOutside: 0, framesOutside3: 0, maxJump: 0, views: new Set()}; g.frames++; g.maxOutside = Math.max(g.maxOutside, r.outside); if (r.outside > 3) g.framesOutside3++; g.maxJump = Math.max(g.maxJump, r.jump); r.views.forEach(v => g.views.add(v)); }
            for (const g of Object.values(byLabel)) { g.views = [...g.views]; g.maxOutside = +g.maxOutside.toFixed(2); g.maxJump = +g.maxJump.toFixed(2); }
            const sizeChanging = rows.filter((r, i) => i && (Math.abs(r.w - rows[i - 1].w) > 0.3 || Math.abs(r.h - rows[i - 1].h) > 0.3)).map(r => r.t);
            return {frames: rows.length, per_label: byLabel, pacing_while_shape_changes: pacing(sizeChanging),
                note: 'outside = how far the worst visible leaf that straddles the surface edge is cut off by it (px; only text and icon leaves, and leaves wholly outside are clipped away and do not count). jump = most a leaf moved relative to the surface centre beyond the surface edge motion (px). The headless runs judged outside<=3 and jump<=edge+4 for the closed/expanded morph; peek, alert and voice have no such reference, so read the file together with the video and decide.'};
        };
    };

    // Actor census for the enable/disable cycles: constructor name -> count under the stage, compare before and after N cycles
    U.census = () => { const c = {}; let total = 0; walk(global.stage, a => { c[a.constructor.name] = (c[a.constructor.name] || 0) + 1; total++; return false; }); return JSON.stringify({total, byType: c}); };
    U.start = kind => {
        if (U.kind) throw new Error('already recording ' + U.kind + ': call __uat.stop() first');
        U.kind = kind; U.rows = []; U.marks = []; paints.length = 0; U.t0 = now();
        if (kind === 'frames') startPaints();
        else if (kind === 'search') startSearch();
        else if (kind === 'dock') startDock();
        else if (kind === 'island') startIsland();
        else { U.kind = null; throw new Error('unknown kind ' + kind + ' (frames, search, dock, island)'); }
        if (kind === 'frames') U.finish = () => ({pacing: pacing(paints), note: 'Intervals between paints inside bursts of activity (a still screen paints nothing). Move something on screen while this runs.'});
        log('recording ' + kind);
        return 'recording ' + kind;
    };
    U.mark = text => { U.label = text; U.rows.push({k: 'mark', t: +now().toFixed(2), text}); return 'mark: ' + text; };
    U.stop = quiet => {
        for (const [o, id] of U.conns) { try { o.disconnect(id); } catch (e) { /* the actor is already gone */ } }
        U.conns = [];
        if (!U.kind) return 'nothing recording';
        let summary = {};
        try { summary = U.finish(); } catch (e) { summary = {error: String(e)}; }
        const doc = {kind: U.kind, probe_version: U.version, started_ms: U.t0, stopped_ms: now(), summary, rows: U.rows};
        const dir = GLib.get_home_dir() + '/niro-uat', stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let file = null;
        try { GLib.mkdir_with_parents(dir, 0o755); file = dir + '/' + stamp + '-' + U.kind + '.json'; GLib.file_set_contents(file, JSON.stringify(doc)); } catch (e) { file = 'NOT WRITTEN: ' + e; }
        U.out = file; const k = U.kind; U.kind = null; U.rows = [];
        const text = k + ' -> ' + file + '\n' + JSON.stringify(summary, null, 1);
        if (!quiet) log(text);
        return text;
    };
    return 'niro-uat probe ready: __uat.start("frames"|"search"|"dock"|"island"), __uat.mark(text), __uat.stop()';
})();
