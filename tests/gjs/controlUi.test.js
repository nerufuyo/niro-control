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
if (bound !== 132) fail(`bound ${bound} items, expected 132`);

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
