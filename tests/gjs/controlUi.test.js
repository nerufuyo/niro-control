// The control panel against real schemas (a throw-away settings backend): every setting binds, writes, reads back and resets;
// and, with a display, the window builds a row for every setting, none of them with a raw HTML entity.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {CATALOG} from '../../control/build/catalog.js';
import {searchItems} from '../../control/build/logic.js';
import {bindingFor, Stores} from '../../control/build/store.js';

const fail = msg => { throw new Error(msg); };
const stores = new Stores();
for (const s of ['niro', 'island', 'dock', 'blur', 'corners'])
    if (!stores.has(s)) fail(`schema for ${s} not found (NIRO_SCHEMA_DIR)`);

const other = (item, v) => {
    switch (item.kind) {
    case 'switch': return !v;
    case 'slider': case 'stepper': return v === item.min ? item.min + (item.step || 1) : item.min;
    case 'select': return item.options.find(o => String(o.value) !== String(v)).value;
    case 'color': return v === '#112233' ? '#223344' : '#112233';
    case 'list': return ['a', 'b'];
    case 'shortcut': return ['<Super><Alt>z'];
    default: return v === 'x' ? 'y' : 'x';
    }
};

let bound = 0;
for (const item of CATALOG) {
    const b = bindingFor(item, stores);
    if (!b) fail(`${item.id}: no binding`);
    const many = Array.isArray(b) ? b : [b];
    many.forEach((one, n) => {
        const first = one.read();
        if (!one.isDefault()) fail(`${item.id}: a fresh backend should hold the default`);
        let value;
        if (item.kind === 'dict') value = {...first, blurOffset: (first.blurOffset ?? 0) + 5};
        else if (item.kind === 'shortcuts') value = ['<Super><Alt>q'];
        else value = other(item, first);
        one.write(value);
        const back = one.read();
        if (JSON.stringify(back) !== JSON.stringify(value)) fail(`${item.id}[${n}]: wrote ${JSON.stringify(value)}, read ${JSON.stringify(back)}`);
        if (one.isDefault()) fail(`${item.id}[${n}]: should differ from the default after a write`);
        one.reset();
        if (!one.isDefault()) fail(`${item.id}[${n}]: reset did not restore the default`);
    });
    bound++;
}
if (bound !== 146) fail(`bound ${bound} items, expected 146`);

// dictionary fields keep their siblings: changing the radius leaves the rest of the setting as it was
const radius = bindingFor(CATALOG.find(i => i.id === 'corners.global-rounded-corner-settings.borderRadius'), stores);
const keep = bindingFor(CATALOG.find(i => i.id === 'corners.global-rounded-corner-settings.keepRoundedCorners.maximized'), stores);
radius.write(20); keep.write(true);
if (radius.read() !== 20 || keep.read() !== true) fail('nested corner fields did not stick');
const raw = stores.by.corners.get_value('global-rounded-corner-settings').deep_unpack();
for (const k of ['padding', 'smoothing', 'borderColor', 'enabled']) if (!(k in raw)) fail(`corner field ${k} was lost`);

if (!Gtk.init_check()) {
    print('controlUi: bindings ok; no display, window checks skipped');
} else {
    Adw.init();
    const {buildWindow} = await import('../../control/build/window.js');
    const {resultsPage} = await import('../../control/build/pages.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlTest'});
    app.register(null);
    const {window, model} = buildWindow(app);
    const names = new Set(); let labels = 0;
    const walk = w => {
        if (w.get_name && CATALOG.some(i => i.id === w.get_name())) names.add(w.get_name());
        if (w instanceof Gtk.Label) {
            labels++;
            let shown = w.get_label() ?? '';
            if (w.get_use_markup()) { try { shown = Pango.parse_markup(shown, -1, '\0')[2]; } catch (_e) { /* not markup */ } }
            if (/&(apos|quot|amp|lt|gt|#\d+);/.test(shown)) fail(`raw entity shown: ${shown}`);
        }
        for (let c = w.get_first_child(); c; c = c.get_next_sibling()) walk(c);
    };
    walk(window);
    const missing = CATALOG.filter(i => !names.has(i.id)).map(i => i.id);
    if (missing.length) fail(`no row for: ${missing.join(', ')}`);
    // every search hit builds, and a search for an item's own title finds that item
    for (const item of CATALOG) {
        const found = searchItems(CATALOG, item.title);
        if (!found.some(f => f.id === item.id)) fail(`searching "${item.title}" does not find ${item.id}`);
    }
    const page = resultsPage(model, searchItems(CATALOG, 'blur'), 'blur');
    if (!page) fail('no results page');
    // a shortcut another setting uses is refused, and a setting's own shortcut is not a conflict with itself
    const {findConflict} = await import('../../control/build/logic.js');
    const music = model.binding(CATALOG.find(i => i.id === 'island.shortcut-music'));
    const clash = findConflict('<Super><Alt>n', model.takenShortcuts([music]));
    if (clash?.owner !== 'Island › Shortcut to the Notifications page') fail(`expected a conflict with the notifications shortcut, got ${JSON.stringify(clash)}`);
    if (findConflict('<Super><Alt>m', model.takenShortcuts([music]))) fail('a setting conflicted with its own shortcut');
    if (!findConflict('<Alt><Super>M', model.takenShortcuts([]))) fail('the same keys in another order were not seen as a conflict');
    print(`controlUi: ok (${bound} bindings, ${names.size} rows, ${labels} labels)`);
}

// The shortcut recorder, driven with key events: records, refuses a clash or a bare key, clears, cancels
if (Gtk.init_check()) {
    const {shortcutRecorder} = await import('../../control/build/components.js');
    const {Model} = await import('../../control/build/pages.js');
    const Gdk = (await import('gi://Gdk?version=4.0')).default;
    const toasts = [];
    const ctx = {toast: m => toasts.push(m), openLook: () => {}, inhibitShortcuts: () => {}, takenShortcuts: e => model2.takenShortcuts(e), window: null};
    const model2 = new Model(ctx);
    const music = model2.binding(CATALOG.find(i => i.id === 'island.shortcut-music'));
    const rec = shortcutRecorder('Music', music, ctx);
    const SUPER_ALT = Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.ALT_MASK;
    rec.click();
    if (!rec.press(Gdk.KEY_z, SUPER_ALT)) fail('recorder ignored a key while recording');
    if (music.read()[0] !== '<Super><Alt>z') fail(`recorded ${music.read()}`);
    rec.click(); rec.press(Gdk.KEY_n, SUPER_ALT);                       // Notifications already has Super+Alt+N
    if (music.read()[0] !== '<Super><Alt>z' || !toasts.some(t => /Already used by Island › Shortcut to the Notifications page/.test(t))) fail(`a clash was not refused (${toasts})`);
    rec.press(Gdk.KEY_m, 0);                                            // a bare letter
    if (!toasts.some(t => /at least one modifier/.test(t))) fail('a bare key was not refused');
    rec.press(Gdk.KEY_BackSpace, 0);
    if (music.read().length !== 0) fail('Backspace did not clear the shortcut');
    rec.click(); rec.press(Gdk.KEY_Escape, 0);
    rec.click(); rec.press(Gdk.KEY_q, SUPER_ALT); rec.click(); rec.press(Gdk.KEY_Escape, 0);
    if (music.read()[0] !== '<Super><Alt>q') fail('Escape should leave the shortcut as it was');
    music.reset();
    print('controlUi: shortcut recorder ok');
}

// Simple and Advanced: only what is shown changes. Every setting keeps a row in both modes, and no value moves.
if (Gtk.init_check()) {
    const {buildWindow} = await import('../../control/build/window.js');
    const {ProfileEngine} = await import('../../control/build/profiles.js');
    const {homeData} = await import('../../control/build/homePage.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlModeTest'});
    app.register(null);
    const {window, model} = buildWindow(app);
    const engine = new ProfileEngine(model.stores);
    const rowsNow = () => {
        const names = new Set(); const hidden = [];
        const walk = w => {
            if (w.get_name && CATALOG.some(i => i.id === w.get_name())) { names.add(w.get_name()); if (!w.get_mapped?.() && w.get_visible?.() === false) hidden.push(w.get_name()); }
            for (let c = w.get_first_child(); c; c = c.get_next_sibling()) walk(c);
        };
        walk(window);
        return {names, hidden};
    };
    const values = JSON.stringify(engine.capture());
    model.setMode('simple', false);
    const simple = rowsNow();
    model.setMode('advanced', false);
    const advanced = rowsNow();
    model.setMode('simple', false);
    if (simple.names.size !== 146 || advanced.names.size !== 146) fail(`rows: simple ${simple.names.size}, advanced ${advanced.names.size}`);
    if (JSON.stringify(engine.capture()) !== values) fail('switching mode changed a value');
    if (model.advancedWidgets.length < 5) fail('the Advanced groups were not found');
    // in Simple mode the advanced groups are hidden and a hint says how many are; in Advanced the reverse
    model.setMode('simple', false);
    if (model.advancedWidgets.some(w => w.get_visible())) fail('an Advanced group is shown in Simple mode');
    if (model.simpleHints.some(w => !w.get_visible())) fail('a hint is missing in Simple mode');
    model.setMode('advanced', false);
    if (model.advancedWidgets.some(w => !w.get_visible())) fail('an Advanced group is hidden in Advanced mode');
    model.setMode('simple', false);
    const d = homeData(model, []);
    if (d.config.total !== CATALOG.filter(i => !i.managed).length) fail(`home counts ${d.config.total} settings`);
    if (!d.look.accent || !d.dock.position) fail('home is missing the look or the dock');
    // accessibility audit: a button with an icon and no text must say what it does (a tooltip, which screen readers also use),
    // every entry and switch must be reachable by keyboard
    const unlabeled = [], unfocusable = [];
    const audit = w => {
        const name = w.constructor.name;
        // only the buttons this project makes: GTK's own parts (spin arrows, back button, window controls) label themselves
        const ours = !(w.get_parent() instanceof Gtk.SpinButton) && w.get_parent()?.constructor.name !== 'unknown_AdwBackButton';
        if ((w instanceof Gtk.Button || w instanceof Gtk.MenuButton) && w.get_icon_name?.() && ours && !w.get_tooltip_text()) unlabeled.push(`${name}:${w.get_icon_name()}`);
        if ((w instanceof Gtk.Switch || w instanceof Gtk.Entry || w instanceof Gtk.SearchEntry || w instanceof Gtk.Scale) && !w.get_focusable() && !w.get_can_focus()) unfocusable.push(name);
        for (let c = w.get_first_child(); c; c = c.get_next_sibling()) audit(c);
    };
    audit(window);
    if (unlabeled.length) fail(`icon-only buttons without a tooltip: ${[...new Set(unlabeled)].join(', ')}`);
    if (unfocusable.length) fail(`controls the keyboard cannot reach: ${unfocusable.join(', ')}`);
    // Compatibility: Window fade (with its warning) exists per application, but only in Advanced mode
    const fadeBoxes = model.advancedWidgets.filter(w => { let found = false; const walk = x => { if (x instanceof Gtk.Switch && /Window fade lowers the opacity/.test(x.get_tooltip_text() ?? '')) found = true; for (let c = x.get_first_child?.(); c; c = c.get_next_sibling()) walk(c); }; walk(w); return found; });
    if (!fadeBoxes.length) fail('no Window fade control with its warning was found in Compatibility');
    model.setMode('simple', false);
    if (fadeBoxes.some(w => w.get_visible())) fail('Window fade is shown in Simple mode');
    model.setMode('advanced', false);
    if (fadeBoxes.some(w => !w.get_visible())) fail('Window fade is missing in Advanced mode');
    model.setMode('simple', false);
    const ids = d.health.map(h => h.id);
    if (JSON.stringify(ids) !== JSON.stringify(['configuration', 'extensions', 'service', 'profile', 'recovery', 'restart'])) fail(`health rows: ${ids}`);
    if (d.health.some(h => !['healthy', 'attention', 'recovery', 'unavailable'].includes(h.state))) fail('a health row has no valid state');
    print('controlUi: modes and home ok');
}
