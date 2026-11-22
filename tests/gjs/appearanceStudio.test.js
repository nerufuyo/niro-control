// The Appearance Studio page against real schemas (a throw-away settings backend): a draft writes nothing, Apply writes and reads back,
// a failed write rolls back, an unavailable setting is shown and not forced, and disposing the page leaves no subscription behind.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const tmp = GLib.dir_make_tmp('niro-studio-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);

if (!Gtk.init_check()) { print('appearanceStudio: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {Model} = await import('../../control/build/pages.js');
const {appearanceStudioPage} = await import('../../control/build/appearanceStudio.js');
const {ALL_IDS} = await import('../../control/build/appearanceLogic.js');

const toasts = [];
const ctx = {toast: m => toasts.push(m), openLook: () => {}, go: () => {}, inhibitShortcuts: () => {}, takenShortcuts: () => [], window: null};
const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };

// count the live subscriptions the page makes on the real settings
let live = 0;
const instrument = model => {
    for (const id of ALL_IDS) {
        const b = model.binding(model.item(id));
        if (!b || b._wrapped) continue;
        const sub = b.subscribe.bind(b);
        b.subscribe = cb => { const un = sub(cb); live++; let done = false; return () => { if (!done) { done = true; live--; un(); } }; };
        b._wrapped = true;
    }
};
const settingOf = (model, id) => model.binding(model.item(id));
const rowOf = (widget, id) => all(widget, w => w instanceof Adw.ActionRow && w.get_name() === `studio:${id}`)[0];
const sliderIn = row => all(row, w => w instanceof Gtk.Scale)[0] ?? fail('no scale in the row');
const spinIn = row => all(row, w => w instanceof Gtk.SpinButton)[0] ?? fail('no spin in the row');

// ---- ready: the page reads the real values, writes nothing
{
    const model = new Model(ctx);
    instrument(model);
    const before = live;
    const page = appearanceStudioPage(model, ctx);
    const {widget, studio} = page;
    if (studio.state !== 'ready') fail(`state ${studio.state}`);
    if (widget.get_visible_child_name() !== 'content') fail('content not shown');
    if (live === before) fail('the page did not watch the settings it edits');
    if (studio.changes().length) fail('a fresh page has changes');
    if (page.apply.get_sensitive() || page.cancel.get_sensitive()) fail('Apply or Cancel is active with no draft');
    const size = settingOf(model, 'dock.icon-size');
    const start = size.read();

    // the four components and a label on each control
    const names = all(page.picker, w => w instanceof Gtk.ToggleButton).map(b => b.get_label());
    if (names.join() !== 'Dock,Island,Windows,Panel look') fail(`components: ${names}`);
    for (const w of all(widget, w => w instanceof Gtk.Scale || w instanceof Gtk.DropDown))
        if (!w.get_focusable() && !w.get_can_focus()) fail('a control the keyboard cannot reach');

    // a draft from the control: the preview follows, the settings do not
    sliderIn(rowOf(widget, 'dock.icon-size')).set_value(72);
    if (studio.value('dock.icon-size') !== 72 || size.read() !== start) fail(`draft ${studio.value('dock.icon-size')}, real ${size.read()}`);
    if (!page.apply.get_sensitive() || !page.cancel.get_sensitive()) fail('Apply and Cancel should be active with a draft');
    if (studio.view('dock.icon-size') !== 72) fail('the preview does not read the draft');
    page.before.set_active(true);
    if (studio.view('dock.icon-size') !== start) fail('Before does not show the current settings');
    page.before.set_active(false);

    // Cancel leaves GSettings untouched and the control goes back
    page.cancel.emit('clicked');
    if (size.read() !== start) fail('Cancel changed the settings');
    if (studio.changes().length) fail('Cancel kept the draft');
    if (Math.round(sliderIn(rowOf(widget, 'dock.icon-size')).get_value()) !== start) fail('the control did not go back after Cancel');

    // Apply writes the real setting and reads it back
    sliderIn(rowOf(widget, 'dock.icon-size')).set_value(72);
    spinIn(rowOf(widget, 'dock.dock-border-radius')).set_value(30);
    page.apply.emit('clicked');
    if (studio.state !== 'success') fail(`after Apply: ${studio.state} ${studio.message}`);
    if (size.read() !== 72 || settingOf(model, 'dock.dock-border-radius').read() !== 30) fail('Apply did not persist');
    if (studio.changes().length) fail('the draft was not rebased after Apply');
    // Restore previous puts the old values in the draft; Apply writes them
    if (!page.restore.get_sensitive()) fail('Restore previous is not offered after an Apply');
    page.restore.emit('clicked');
    if (size.read() !== 72) fail('Restore previous wrote without Apply');
    page.apply.emit('clicked');
    if (size.read() !== start) fail('Restore previous then Apply did not bring the old value back');
    // Reset is a draft too
    page.resetAll.emit('clicked');
    if (size.read() !== start) fail('Reset wrote');

    // an outside change shows up in the controls, with no draft pending
    size.write(50);
    if (Math.round(sliderIn(rowOf(widget, 'dock.icon-size')).get_value()) !== 50) fail('an outside change did not reach the control');
    size.reset();

    // motion: a preset writes the Dock's own keys (only on Apply), reduced motion gives 0 ms
    const ms = settingOf(model, 'dock.animation-duration'), bounce = settingOf(model, 'dock.bounce-on-launch');
    page.dropdown.set_selected(3);                                  // Cinematic
    if (ms.read() !== 200) fail('a preset wrote before Apply');
    if (studio.value('dock.animation-duration') !== 400) fail(`Cinematic is ${studio.value('dock.animation-duration')} ms`);
    page.apply.emit('clicked');
    if (ms.read() !== 400 || bounce.read() !== true) fail(`preset applied ${ms.read()} ms`);
    page.reduced.set_active(true);
    if (studio.value('dock.animation-duration') !== 0 || studio.value('dock.bounce-on-launch') !== false) fail('reduced motion did not give 0 ms and no bounce');
    page.cancel.emit('clicked');
    if (ms.read() !== 400) fail('Cancel changed the preset');
    ms.reset(); bounce.reset();
    page.reduced.set_active(false);

    // the accent: an unreadable one is moved and explained, a bad one is refused
    const accent = settingOf(model, 'niro.accent');
    studio.set('niro.accent', '#1D1D1F');
    if (studio.value('niro.accent') === '#1D1D1F') fail('an unreadable accent was kept');
    if (!studio.notes.length) fail('no explanation for the moved accent');
    const refused = studio.set('niro.accent', 'blue');
    if (refused.ok) fail('a bad colour was accepted');
    studio.cancel();
    if (accent.read() !== '#E8472B') fail('the accent setting changed without Apply');

    // dispose leaves no subscription behind
    page.dispose();
    if (live !== before) fail(`subscriptions: ${live} after dispose, ${before} before`);
    print('appearanceStudio: draft, cancel, apply, restore, motion and accent ok');
}

// ---- a failed write rolls back
{
    const model = new Model(ctx);
    instrument(model);
    const failing = {write: (id, v) => { if (id === 'dock.dock-border-radius') throw new Error('locked by the system'); model.binding(model.item(id)).write(v); }};
    const page = appearanceStudioPage(model, ctx, failing);
    const {widget, studio} = page;
    const size = settingOf(model, 'dock.icon-size'), start = size.read(), radius = settingOf(model, 'dock.dock-border-radius').read();
    sliderIn(rowOf(widget, 'dock.icon-size')).set_value(90);
    spinIn(rowOf(widget, 'dock.dock-border-radius')).set_value(5);
    page.apply.emit('clicked');
    if (studio.state !== 'rollback') fail(`state ${studio.state}`);
    if (size.read() !== start || settingOf(model, 'dock.dock-border-radius').read() !== radius) fail('a failed write left a change behind');
    if (!/locked by the system/.test(studio.message)) fail(`unclear message: ${studio.message}`);
    page.dispose();
    print('appearanceStudio: failed write rolled back');
}

// ---- a write that does not stick is caught by the read-back
{
    const model = new Model(ctx);
    const lying = {write: (id, v) => { if (id !== 'dock.dock-border-radius') model.binding(model.item(id)).write(v); }};
    const page = appearanceStudioPage(model, ctx, lying);
    const size = settingOf(model, 'dock.icon-size'), start = size.read();
    sliderIn(rowOf(page.widget, 'dock.icon-size')).set_value(90);
    spinIn(rowOf(page.widget, 'dock.dock-border-radius')).set_value(5);
    page.apply.emit('clicked');
    if (page.studio.state !== 'rollback' || !/Rolled back/.test(page.studio.message)) fail(`read-back: ${page.studio.state} ${page.studio.message}`);
    if (size.read() !== start) fail('the key that stuck was not put back');
    page.dispose();
    print('appearanceStudio: read-back mismatch rolled back');
}

// ---- a setting that cannot be applied is shown unavailable and never forced
{
    const model = new Model(ctx);
    const id = 'corners.global-rounded-corner-settings.borderRadius';
    model.cache.set(model.item(id).id, null);                       // as if the Rounded Corners extension were not installed
    const page = appearanceStudioPage(model, ctx);
    const row = rowOf(page.widget, id) ?? fail('no row for the unavailable setting');
    if (row.get_sensitive()) fail('an unavailable setting can be edited');
    if (!/Unavailable/.test(row.get_subtitle())) fail(`row says: ${row.get_subtitle()}`);
    if (page.studio.state !== 'ready') fail('one missing setting should not disable the page');
    if (page.studio.set(id, 20).ok) fail('an unavailable setting accepted a value');
    if (page.studio.changes().length) fail('an unavailable setting is in the draft');
    page.dispose();
    print('appearanceStudio: unavailable shown, not forced');
}

// ---- nothing available: the page says so
{
    const model = new Model(ctx);
    for (const id of ALL_IDS) model.cache.set(id, null);
    const page = appearanceStudioPage(model, ctx);
    if (page.studio.state !== 'disabled' || page.widget.get_visible_child_name() !== 'unavailable') fail(`disabled page: ${page.studio.state}`);
    page.dispose();
    print('appearanceStudio: disabled state ok');
}
print('appearanceStudio: ok');
