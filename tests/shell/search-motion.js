// Runtime checks for Search's motion, evaluated inside a live (headless) GNOME Shell by tests/shell/search-motion.sh.
// Only valid in unsafe mode (global, Main, imports). No backslashes in this file: gdbus parses the Eval argument as GVariant text.
// The result is left in global.__searchMotion as JSON: [{name, ok, detail}].
(function () {
const GLib = imports.gi.GLib, C = imports.gi.Clutter, Gio = imports.gi.Gio, St = imports.gi.St;
const UUID = 'search@niro.local';
const EM = Main.extensionManager;
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const now = () => GLib.get_monotonic_time() / 1000;
const out = [];
const check = (name, ok, detail) => out.push({name, ok: Boolean(ok), detail: detail ?? ''});
global.__searchMotion = 'running';

(async () => {
    const S = () => EM.lookup(UUID).stateObj;
    check('extension enabled', EM.lookup(UUID).state === 1, 'state ' + EM.lookup(UUID).state);
    const seat = (C.get_default_backend ? C.get_default_backend() : global.stage.context.get_backend()).get_default_seat();
    const kbd = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
    const key = k => { const t = GLib.get_monotonic_time(); kbd.notify_keyval(t, k, C.KeyState.PRESSED); kbd.notify_keyval(t + 4000, k, C.KeyState.RELEASED); };
    const ifs = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    ifs.set_boolean('enable-animations', true);
    Main.overview.hide();
    await sleep(500);

    // ---- opening: sample at every paint and every motion step
    let s = S();
    const rec = [];
    let on = false, t0 = 0;
    const snap = tag => ({tag, t: now() - t0, op: s._box.opacity, sx: s._box.scale_x, ty: s._box.translation_y});
    const paintId = global.stage.connect('after-paint', () => { if (on) rec.push(snap('paint')); });
    const origDraw = s._drawMotion.bind(s);
    const origTick = s._motion.tick.bind(s._motion);
    s._motion.tick = function (ms) { if (on) rec.push(snap('tick')); return origTick(ms); };      // one per frame-clock step
    t0 = now(); on = true;
    s._open();
    const focusAtOnce = global.stage.key_focus === s._entry.clutter_text;
    await sleep(40);
    for (const ch of 'ace') { key(ch.charCodeAt(0)); await sleep(15); }
    await sleep(60);                                       // the input method commits each key a moment after it is sent
    const typedWhileOpening = s._entry.get_text();
    const stateWhileTyping = s._sm.state;
    await sleep(900);
    on = false;
    const paints = rec.filter(r => r.tag === 'paint'), draws = rec.filter(r => r.tag === 'tick');
    check('keyboard focus is in the entry on the first frame', focusAtOnce);
    check('typing during the opening animation lands in the entry', typedWhileOpening === 'ace' && stateWhileTyping === 'Opening', 'text "' + typedWhileOpening + '" in state ' + stateWhileTyping);
    const ops = paints.map(r => r.op);
    check('opening never overshoots (opacity <= 255, scale <= 1, translation_y <= 0)', Math.max(...ops) <= 255 && Math.max(...paints.map(r => r.sx)) <= 1.000001 && Math.max(...paints.map(r => r.ty)) <= 1e-6);
    check('opening opacity is monotone', ops.every((v, i) => i === 0 || v >= ops[i - 1]));
    check('opening converges to the rest pose', ops[ops.length - 1] === 255 && paints[paints.length - 1].sx === 1 && paints[paints.length - 1].ty === 0, 'last ' + ops[ops.length - 1]);
    const per = paints.slice(1).map((p, i) => draws.filter(d => d.t > paints[i].t && d.t <= p.t).length);
    const histogram = {};
    per.forEach(c => { histogram[c] = (histogram[c] ?? 0) + 1; });
    check('one motion step per painted frame (frame clock, no beating; keys typed mid-open may stall a frame)', per.length > 10 && per.every(c => c === 1), JSON.stringify(histogram));
    const quiet = paints.filter(p => p.t > 250);          // after the typed keys (each one rebuilds the list, about 10 ms)
    const gaps = quiet.slice(1).map((p, i) => p.t - quiet[i].t);
    check('frame pacing steady once nothing else is happening (max paint gap < 40 ms)', Math.max(...gaps) < 40, 'max ' + Math.max(...gaps).toFixed(1) + ' ms, mean ' + (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2));
    check('frame source stops when idle', !s._frames && !s._motion.animator.active, 'timeline ' + Boolean(s._frames));
    check('state settles', ['Ready', 'ResultsExpanded'].includes(s._sm.state), s._sm.state);

    // ---- escape through the virtual keyboard closes; the grab is released at once
    key(0xff1b);
    await sleep(60);
    check('Escape (virtual keyboard) dismisses, modal grab released within 60 ms', s._sm.state === 'Dismissing' && !s._grab && Main.modalCount === 0, s._sm.state + ' modal ' + Main.modalCount);
    await sleep(900);
    check('closed: hidden, no frames', s._sm.state === 'Closed' && !s._box.visible && !s._frames);

    // ---- a late answer: rows arrive above and below the selected one; the selected row must not move in the viewport
    s._open(); s._entry.set_text('e'); await sleep(800);
    const adj = s._scroll.vadjustment;
    for (let i = 0; i < 12; i++) s._select(s._selected + 1);
    await sleep(300);
    const viewportY = () => { const r = s._rows[s._selected]; return r ? +(r.get_allocation_box().y1 - adj.value).toFixed(1) : null; };
    const painted = [];
    const pid2 = global.stage.connect('after-paint', () => painted.push(viewportY()));
    const real = s._collect.bind(s);
    const extra = (title, section) => [1, 2, 3].map(i => ({section, title: title + i, subtitle: 'x', iconName: 'text-x-generic-symbolic', action: 'file.open', args: {path: '/' + title + i}, score: 1}));
    const keyBefore = s._keys[s._selected], yBefore = viewportY(), offsetBefore = adj.value;
    s._collect = q => real(q).concat(extra('late-', 'Files'));
    s._refresh();
    await sleep(250);
    check('late rows BELOW: same result selected, offset and position unchanged', s._keys[s._selected] === keyBefore && viewportY() === yBefore && adj.value === offsetBefore, 'y ' + yBefore + ' -> ' + viewportY());
    s._collect = q => extra('early-', 'Actions').concat(real(q));
    s._refresh();
    await sleep(250);
    check('late rows ABOVE: same result selected and held at the same viewport position', s._keys[s._selected] === keyBefore && viewportY() === yBefore && adj.value > offsetBefore, 'y ' + yBefore + ' -> ' + viewportY() + ', offset ' + offsetBefore + ' -> ' + adj.value);
    check('selected row never moved on any painted frame', painted.length > 5 && painted.every(y => y === yBefore), 'frames ' + painted.length + ', min ' + Math.min(...painted) + ', max ' + Math.max(...painted));
    s._collect = real;
    s._refresh();
    await sleep(250);
    check('rows removed again: still the same result, offset within the new extent', s._keys[s._selected] === keyBefore && adj.value <= adj.upper - adj.page_size + 0.5, 'offset ' + adj.value + ', upper ' + adj.upper);
    global.stage.disconnect(pid2);
    s._close(); await sleep(900);

    // ---- rapid open / close: 20 toggles at irregular gaps
    const gapsMs = [7, 90, 33, 15, 120, 45, 5, 70, 28, 11, 100, 60, 19, 85, 8, 140, 38, 25, 52, 13];
    let bad = '';
    for (let i = 0; i < 20; i++) {
        s._toggle(); await sleep(gapsMs[i]);
        if (s._sm.state === 'Closed' && s._box.visible) bad += ' closed-but-visible@' + i;
        if (s._live() && !s._grab) bad += ' live-without-grab@' + i;
        if (!s._live() && s._grab) bad += ' grab-while-not-live@' + i;
    }
    await sleep(1200);
    check('20 rapid toggles: invariants held on every step', bad === '', bad);
    check('after the rapid toggles the state is sane and at rest', ['Closed', 'Ready', 'ResultsExpanded'].includes(s._sm.state) && !s._frames && Main.modalCount === (s._grab ? 1 : 0), s._sm.state + ' frames ' + Boolean(s._frames) + ' modal ' + Main.modalCount);
    if (s._sm.state === 'Closed') { s._open(); await sleep(700); }
    key(0xff1b); await sleep(900);
    check('Escape still works afterwards', s._sm.state === 'Closed' && Main.modalCount === 0);
    let runs = 0;
    const origRun = s._registry.run.bind(s._registry);
    s._registry.run = function (...a) { runs++; return origRun(...a); };
    s._open(); s._entry.set_text('2+2'); await sleep(700);
    const enter = { get_key_symbol: () => 0xff0d, get_state: () => 0 };   // synthetic: the virtual keyboard's Return is swallowed by the input-method filter in a headless session
    const tEnter = now();
    s._onKey(enter); s._onKey(enter);
    const runDelay = now() - tEnter;
    await sleep(900);
    s._registry.run = origRun;
    check('Enter (synthetic key event) still runs the action exactly once', runs === 1 && s._sm.state === 'Closed', 'runs ' + runs);

    // ---- activation is not delayed by the dismiss animation
    s._open(); s._entry.set_text('calculator'); await sleep(800);
    let callAt = 0, stateAtCall = '';
    const origRun2 = s._registry.run.bind(s._registry);
    s._registry.run = function (...a) { if (!callAt) { callAt = now(); stateAtCall = s._sm.state; } return origRun2(...a); };
    const tE = now(); s._onKey(enter);
    const dismissStart = now();
    while (s._sm.state !== 'Closed' && now() - tE < 3000) await sleep(5);
    const animMs = now() - tE;
    s._registry.run = origRun2;
    check('Enter -> action call is far shorter than the dismiss animation', callAt && (callAt - tE) < 50 && animMs > 200, 'call after ' + (callAt - tE).toFixed(1) + ' ms (state ' + stateAtCall + '), animation ' + animMs.toFixed(0) + ' ms');
    await sleep(1500);
    global.get_window_actors().forEach(a => a.meta_window.delete(global.get_current_time()));
    await sleep(500);

    // ---- reduced motion: St enable-animations off => jump, no frame source
    ifs.set_boolean('enable-animations', false); await sleep(200);
    let wakes = 0;
    const origWake = s._wakeFrames.bind(s);
    s._wakeFrames = function () { wakes++; return origWake(); };
    s._open(); s._entry.set_text('ac'); s._select(2);
    check('reduced motion: opens fully drawn at once, no frame source', St.Settings.get().enable_animations === false && s._box.opacity === 255 && s._box.scale_x === 1 && !s._frames && wakes === 0, 'wakes ' + wakes);
    s._close();
    check('reduced motion: closes at once', s._sm.state === 'Closed' && !s._box.visible && !s._frames && wakes === 0);
    s._wakeFrames = origWake;
    ifs.set_boolean('enable-animations', true); await sleep(200);
    s._motion.tick = origTick;
    global.stage.disconnect(paintId);

    // ---- disable / enable x5, with instrumentation on GLib sources and signal handlers of shell objects
    const GObject = imports.gi.GObject;
    const live = new Map();
    const orig = {to: GLib.timeout_add, tos: GLib.timeout_add_seconds, idle: GLib.idle_add, rm: GLib.source_remove};
    const wrap = fn => function (...a) {
        const cb = a[a.length - 1]; let id = 0;
        a[a.length - 1] = (...x) => { const r = cb(...x); if (r !== GLib.SOURCE_CONTINUE) live.delete(id); return r; };
        id = fn.apply(GLib, a); live.set(id, 1); return id;
    };
    GLib.timeout_add = wrap(orig.to); GLib.timeout_add_seconds = wrap(orig.tos); GLib.idle_add = wrap(orig.idle);
    GLib.source_remove = id => { live.delete(id); return orig.rm.call(GLib, id); };
    const sig = new Set();
    const tag = o => o === global.stage ? 'stage' : o === global.display ? 'display' : o === Main.layoutManager ? 'layout' : o === global.window_manager ? 'wm' : null;
    const oc = GObject.Object.prototype.connect, od = GObject.Object.prototype.disconnect;
    GObject.Object.prototype.connect = function (n, cb) { const id = oc.call(this, n, cb); const t = tag(this); if (t) sig.add(t + id); return id; };
    GObject.Object.prototype.disconnect = function (id) { const t = tag(this); if (t) sig.delete(t + id); return od.call(this, id); };
    const owned = () => Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', ['org.niro.Search']), null, Gio.DBusCallFlags.NONE, -1, null).deepUnpack()[0];
    const children0 = Main.layoutManager.uiGroup.get_n_children();
    let leaks = '';
    for (let i = 1; i <= 5; i++) {
        EM.disableExtension(UUID); await sleep(400);
        if (live.size || sig.size || Main.modalCount || owned() || Main.layoutManager.uiGroup.get_n_children() >= children0) leaks += ' cycle' + i + ':disabled(sources ' + live.size + ', signals ' + sig.size + ', modal ' + Main.modalCount + ', dbus ' + owned() + ', children ' + Main.layoutManager.uiGroup.get_n_children() + ')';
        EM.enableExtension(UUID); await sleep(800);
        const t = S();
        t._open(); t._entry.set_text('acc'); await sleep(600); t._close(); await sleep(700);
        if (live.size || sig.size || Main.modalCount || t._frames) leaks += ' cycle' + i + ':after-use(sources ' + live.size + ', signals ' + sig.size + ', modal ' + Main.modalCount + ')';
        if (EM.lookup(UUID).state !== 1) leaks += ' cycle' + i + ':state ' + EM.lookup(UUID).state;
    }
    check('disable/enable x5: no leaked sources, signal handlers, modal grabs, D-Bus names or actors', leaks === '', leaks);
    const t5 = S(); t5._open(); t5._entry.set_text('a'); await sleep(120);
    EM.disableExtension(UUID); await sleep(500);
    check('disable while the panel is open and animating: everything released', !live.size && !sig.size && !Main.modalCount && !owned(), 'sources ' + live.size + ', signals ' + sig.size + ', modal ' + Main.modalCount);
    EM.enableExtension(UUID); await sleep(800);
    check('enabled again after that', EM.lookup(UUID).state === 1);
    Object.assign(GLib, {timeout_add: orig.to, timeout_add_seconds: orig.tos, idle_add: orig.idle, source_remove: orig.rm});
    GObject.Object.prototype.connect = oc; GObject.Object.prototype.disconnect = od;
    global.__searchMotion = JSON.stringify(out);
})().catch(e => { check('script ran to the end', false, String(e) + ' ' + (e.stack ?? '')); global.__searchMotion = JSON.stringify(out); });
return 'started';
})()
