// Runtime checks for Search keeping clear of the Niro Island, evaluated inside a live headless GNOME Shell with BOTH extensions enabled
// (tests/shell/search-collision.sh). Only valid in unsafe mode (global, Main, imports). No backslashes: gdbus parses the Eval argument as GVariant text.
// Result in global.__searchCollision as JSON [{name, ok, detail}] (or the string 'running'). Geometry is read from the real actors.
(function () {
const GLib = imports.gi.GLib, Clutter = imports.gi.Clutter, Gio = imports.gi.Gio, St = imports.gi.St;
const EM = Main.extensionManager;
const SEARCH = 'search@niro.local', ISLAND = 'island@niro.local';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const out = [];
const check = (name, ok, detail) => out.push({name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail)});
const GAP = 12, EPS = 0.75;
global.__searchCollision = 'running';

(async () => {
    const S = () => EM.lookup(SEARCH).stateObj;
    const C = () => EM.lookup(ISLAND).stateObj._controller;
    const findIsland = () => { const walk = a => { if (a.get_name() === 'islandIsland') return a; for (const c of a.get_children()) { const h = walk(c); if (h) return h; } return null; }; return walk(Main.layoutManager.uiGroup); };
    const ext = a => { const r = a.get_transformed_extents(); return {x: r.get_x(), y: r.get_y(), w: r.get_width(), h: r.get_height(), b: r.get_y() + r.get_height()}; };
    const seat = global.stage.context.get_backend().get_default_seat();
    const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const key = k => { const t = GLib.get_monotonic_time(); kbd.notify_keyval(t, k, Clutter.KeyState.PRESSED); kbd.notify_keyval(t + 4000, k, Clutter.KeyState.RELEASED); };
    const ifs = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    ifs.set_boolean('enable-animations', true);
    Main.overview.hide();
    await sleep(500);

    const mon = Main.layoutManager.primaryMonitor;
    const monH = mon.height, monW = mon.width;
    const work = Main.layoutManager.getWorkAreaForMonitor(mon.index);
    const scale = global.display.get_monitor_scale ? global.display.get_monitor_scale(mon.index) : 1;
    check('both extensions enabled', EM.lookup(SEARCH).state === 1 && EM.lookup(ISLAND).state === 1, 'search ' + EM.lookup(SEARCH).state + ' island ' + EM.lookup(ISLAND).state);
    let isl = findIsland();
    check('island actor is found by its name in the shell chrome', Boolean(isl));
    if (!isl) { global.__searchCollision = JSON.stringify(out); return; }
    const settleIsland = async () => { await sleep(1300); };
    const collapse = async () => { C().collapse(); await settleIsland(); };
    const expand = async () => { C().expand(); await settleIsland(); };
    const gap = (s) => ext(s._box).y - ext(isl).b;
    const detail = () => { const s = S(), b = ext(s._box), i = ext(isl); return 'monitor ' + monW + 'x' + monH + ' scale ' + scale + ' island bottom ' + i.b.toFixed(1) + ' search top ' + b.y.toFixed(1) + ' default ' + s._defaultY + ' dodge ' + s._motion.dodge.value.toFixed(2); };

    await collapse();
    let s = S();
    // ---- 1. compact island: nothing moves
    s._open(); await sleep(900);
    check('compact island: Search sits at its normal anchor, no offset', Math.abs(ext(s._box).y - s._defaultY) < EPS && s._motion.dodge.value === 0 && s._motion.dodge.target === 0, detail());
    const box0 = ext(s._box), entryY0 = ext(s._entry).y - box0.y;
    check('compact island: island bottom is above Search (precondition)', ext(isl).b < box0.y, 'island bottom ' + ext(isl).b);

    // ---- 2. island expands while Search is open: Search moves clear, smoothly
    const samples = [];
    const paintId = global.stage.connect('after-paint', () => samples.push({t: GLib.get_monotonic_time() / 1000, top: ext(s._box).y, ib: ext(isl).b, ty: s._box.translation_y}));
    let evals = 0;
    const origPlace = s._placeNow.bind(s);
    s._placeNow = function (i) { evals++; return origPlace(i); };
    C().expand();
    await sleep(60);
    for (const ch of 'ab') { key(ch.charCodeAt(0)); await sleep(20); }          // type while it moves
    await settleIsland();
    global.stage.disconnect(paintId);
    s._placeNow = origPlace;
    const g = gap(s);
    check('island expanded: Search top >= island bottom + 12', g >= GAP - EPS, 'gap ' + g.toFixed(2) + ' ' + detail());
    check('island expanded: Search is not pushed further than needed (gap <= 12 + 1)', g <= GAP + 1.5, 'gap ' + g.toFixed(2));
    check('entry stays in place relative to the panel while it moves', Math.abs(ext(s._entry).y - ext(s._box).y - entryY0) < EPS, 'entry offset ' + (ext(s._entry).y - ext(s._box).y).toFixed(2) + ' vs ' + entryY0.toFixed(2));
    check('keyboard focus is still in the entry and the typed letters landed', global.stage.key_focus === s._entry.clutter_text && s._entry.get_text() === 'ab', 'text "' + s._entry.get_text() + '"');
    const tops = samples.map(r => r.top);
    let back = 0, maxStep = 0;
    for (let i = 1; i < tops.length; i++) { back += Math.max(0, tops[i - 1] - tops[i]); maxStep = Math.max(maxStep, Math.abs(tops[i] - tops[i - 1])); }
    check('Search moved with the island, not in one jump (no frame moves it more than 60 px; it ends lower than it began)', maxStep < 60 && tops[tops.length - 1] > tops[0] + 10, 'frames ' + tops.length + ' max step ' + maxStep.toFixed(1) + ' total ' + (tops[tops.length - 1] - tops[0]).toFixed(1));
    const maxIb = Math.max(...samples.map(r => r.ib));
    check('Search follows the island without overshoot of its own (never lower than the lowest island bottom + gap, backward travel <= 6 px: the island springs past its size a little)', Math.max(...tops) <= maxIb + GAP + 0.5 && back <= 6, 'max top ' + Math.max(...tops).toFixed(2) + ' island max bottom ' + maxIb.toFixed(2) + ' backward ' + back.toFixed(2));
    check('one placement evaluation per frame at most while the island morphs', evals <= samples.length + 2, evals + ' evaluations in ' + samples.length + ' painted frames');
    const holeFrames = samples.filter(r => r.top < r.ib - 0.5).length;
    check('while the island grows Search never overlaps its bottom edge on a painted frame (<= 2 of the frames)', holeFrames <= 2, holeFrames + ' of ' + samples.length + ' frames overlapping, worst ' + Math.min(...samples.map(r => r.top - r.ib)).toFixed(1) + ' px');

    // ---- 3. island collapses: the normal anchor returns
    const sel = s._selected, adjV = s._scroll.vadjustment ? s._scroll.vadjustment.value : 0;
    await collapse();
    check('island collapsed: Search restores its normal anchor (no stuck offset)', Math.abs(ext(s._box).y - s._defaultY) < EPS && s._motion.dodge.value === 0 && s._motion.dodge.target === 0, detail());
    check('restoring keeps selection and scroll position', s._selected === sel && (s._scroll.vadjustment ? s._scroll.vadjustment.value : 0) === adjV, 'selected ' + s._selected + ' scroll ' + adjV);
    check('keyboard focus still in the entry after the island collapsed', global.stage.key_focus === s._entry.clutter_text);
    key('c'.charCodeAt(0)); await sleep(80);
    check('typing after restoring still lands', s._entry.get_text() === 'abc', s._entry.get_text());
    s._close(); await sleep(700);

    // ---- 4. island already expanded when Search opens: clear from the first frame, never under the island
    await expand();
    const opening = [];
    const pid = global.stage.connect('after-paint', () => { if (s._box.visible) opening.push(ext(s._box).y - ext(isl).b); });
    s._open();
    opening.push(ext(s._box).y - ext(isl).b);
    await sleep(900);
    global.stage.disconnect(pid);
    check('island open first, then Search: top >= island bottom + 12 at rest', gap(s) >= GAP - EPS, detail());
    check('island open first, then Search: never overlaps the island on any frame of the opening', Math.min(...opening) >= -0.5, 'min gap on opening frames ' + Math.min(...opening).toFixed(2));
    check('focus on open with the island expanded', global.stage.key_focus === s._entry.clutter_text);

    // ---- 5. a tall result list: no overflow at the bottom, entry remains visible
    for (let i = 0; i < 40; i++) s._list.add_child(new St.Label({text: 'filler row ' + i, style: 'padding: 8px; font-size: 14px;'}));
    s._queuePlace();
    await sleep(900);
    let bb = ext(s._box), wa = work.y + work.height;
    check('tall list with the island expanded: panel bottom inside the work area', bb.b <= wa + 0.5, 'bottom ' + bb.b.toFixed(1) + ' work bottom ' + wa);
    check('tall list: entry visible inside the monitor and below the island', ext(s._entry).y >= ext(isl).b + GAP - EPS && ext(s._entry).b <= monH, 'entry ' + ext(s._entry).y.toFixed(1) + '..' + ext(s._entry).b.toFixed(1));
    check('tall list: results list is shorter than its content (it scrolls)', ext(s._scroll).h < s._list.get_preferred_height(680)[1] - 1, 'scroll ' + ext(s._scroll).h.toFixed(1) + ' content ' + s._list.get_preferred_height(680)[1].toFixed(1));
    const shrunk = s._scrollMax < Math.round(monH * 0.5);
    if (monH <= 640) check('small monitor: the results list was shrunk to fit under the island (cap ' + s._scrollMax + ' < ' + Math.round(monH * 0.5) + ')', shrunk && bb.b <= wa + 0.5 && bb.b >= wa - 3, 'bottom ' + bb.b.toFixed(1));
    await collapse();
    bb = ext(s._box);
    check('tall list, island collapsed: normal anchor, the list cap is back to the usual 50% of the monitor', Math.abs(bb.y - s._defaultY) < EPS && s._scrollMax === Math.round(monH * 0.5) && bb.b <= wa + 0.5, 'top ' + bb.y.toFixed(1) + ' cap ' + s._scrollMax + ' bottom ' + bb.b.toFixed(1) + ' (list had been shrunk: ' + shrunk + ')');
    s._close(); await sleep(700);

    // ---- 6. rapid expand/collapse while Search is open, 20 cycles, both end states
    s._open(); await sleep(800);
    for (const end of ['collapsed', 'expanded']) {
        for (let i = 0; i < 20; i++) { C().expand(); await sleep(30 + (i * 37) % 90); C().collapse(); await sleep(30 + (i * 53) % 110); }
        if (end === 'expanded') { C().expand(); }
        await sleep(1800);
        const d = detail();
        if (end === 'collapsed') check('20 rapid expand/collapse cycles then collapsed: back at the normal anchor, nothing stuck', Math.abs(ext(s._box).y - s._defaultY) < EPS && s._motion.dodge.value === 0 && !s._motion.animator.active, d);
        else check('20 rapid cycles then expanded: Search clear of the island by the gap, nothing stuck', gap(s) >= GAP - EPS && gap(s) <= GAP + 1.5 && !s._motion.animator.active, d);
        check('rapid cycles (' + end + '): focus intact and typing lands', (() => { key('x'.charCodeAt(0)); return true; })() && global.stage.key_focus === s._entry.clutter_text);
        await sleep(80);
    }
    check('typed letters from the rapid-cycle phase reached the entry', s._entry.get_text().indexOf('xx') >= 0, s._entry.get_text());
    check('frame loop stopped once everything is at rest', !s._frames, 'timeline ' + Boolean(s._frames));
    await collapse();
    s._close(); await sleep(700);

    // ---- 7. reduced motion: the correction jumps
    ifs.set_boolean('enable-animations', false);
    await collapse();
    s._open(); await sleep(300);
    await (async () => { C().expand(); await sleep(700); })();
    const dj = s._motion.dodge;
    check('animations off: offset equals its target (jumped) and no frame source is running', dj.value === dj.target && dj.target > 0 && !s._frames && !s._motion.animator.active, 'value ' + dj.value + ' target ' + dj.target);
    check('animations off: Search clear of the island', gap(s) >= GAP - EPS, detail());
    s._motion.place(0); s._motion.place(37);
    check('animations off: a retarget is applied at once', s._motion.dodge.value === 37 && !s._motion.animator.active);
    s._placeNow(false);
    await collapse();
    check('animations off: collapse restores at once', s._motion.dodge.value === 0 && Math.abs(ext(s._box).y - s._defaultY) < EPS, detail());
    s._close(); await sleep(300);
    ifs.set_boolean('enable-animations', true);
    await sleep(300);

    // ---- 8. no obstacle when the island is hidden or elsewhere
    await expand();
    s._open(); await sleep(900);
    const off1 = s._motion.dodge.target;
    isl.hide(); await sleep(300);
    check('island hidden while Search is open: no offset (treated as no collision)', off1 > 0 && s._motion.dodge.target === 0, 'before ' + off1 + ' after ' + s._motion.dodge.target);
    isl.show(); await sleep(900);
    check('island shown again: Search moves clear again', gap(s) >= GAP - EPS, detail());
    s._close(); await sleep(600);
    await collapse();

    // ---- 9. disable / enable x5: no leaked connections on the island actor or the chrome group, no stray frame loops
    const live = new Set();
    const oc = isl.connect.bind(isl), od = isl.disconnect.bind(isl);
    isl.connect = (...a) => { const id = oc(...a); live.add(id); return id; };
    isl.disconnect = id => { live.delete(id); return od(id); };
    const grp = Main.layoutManager.uiGroup;
    const gc = grp.connect.bind(grp), gd = grp.disconnect.bind(grp);
    const gLive = new Set();
    grp.connect = (...a) => { const id = gc(...a); gLive.add(id); return id; };
    grp.disconnect = id => { gLive.delete(id); return gd(id); };
    let maxLive = 0, okCycles = 0;
    for (let i = 0; i < 5; i++) {
        EM.disableExtension(SEARCH); await sleep(400);
        EM.enableExtension(SEARCH); await sleep(1500);
        const ns = S();
        if (!ns) continue;
        await expand();
        ns._open(); await sleep(700);
        maxLive = Math.max(maxLive, live.size);
        if (i % 2 === 0) { ns._close(); await sleep(600); }          // odd cycles are disabled while still open
        await collapse();
        okCycles++;
    }
    EM.disableExtension(SEARCH); await sleep(500);
    check('disable/enable x5: extension toggled every time', okCycles === 5, okCycles);
    check('while open Search watched the island actor (precondition of the leak check)', maxLive >= 5, 'max live ' + maxLive);
    check('after disable: no signal connections made by Search remain on the island actor', live.size === 0, live.size + ' left');
    check('after disable: no signal connection left on the chrome group', gLive.size === 0, gLive.size + ' left');
    EM.enableExtension(SEARCH); await sleep(1500);
    check('after the cycles Search works again and finds the island', EM.lookup(SEARCH).state === 1 && (S()._open(), S()._island === isl) && (S()._close(), true));
    await sleep(600);
    delete isl.connect; delete isl.disconnect; delete grp.connect; delete grp.disconnect;

    check('summary of the monitor used', true, 'monitor ' + monW + 'x' + monH + ' scale ' + scale + ' work ' + work.y + '..' + (work.y + work.height));
    global.__searchCollision = JSON.stringify(out);
})().catch(e => { out.push({name: 'script error', ok: false, detail: String(e) + ' ' + String(e.stack).slice(0, 300)}); global.__searchCollision = JSON.stringify(out); });
return 1;
})()
