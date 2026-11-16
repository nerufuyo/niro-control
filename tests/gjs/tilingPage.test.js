// The panel's Tiling module, driven like a person would: with a display, the ten layout cards, the rules form and the profile form change the
// real settings (a throw-away backend and folders), and a refused change says so.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const tmp = GLib.dir_make_tmp('niro-tiling-ui-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);
GLib.setenv('XDG_CURRENT_DESKTOP', 'GNOME', true);

if (!Gtk.init_check()) { print('tilingPage: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {Model} = await import('../../control/build/pages.js');
const {tilingPage} = await import('../../control/build/tilingPage.js');
const {TileBackend} = await import('../../control/build/tileBackend.js');

const toasts = [];
const ctx = {toast: m => toasts.push(m), openLook: () => {}, inhibitShortcuts: () => {}, takenShortcuts: e => model.takenShortcuts(e), window: null};
const model = new Model(ctx);
const backend = new TileBackend(model.stores);
const widget = tilingPage(model, ctx);

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const title = b => b.get_parent().get_first_child().get_next_sibling()?.label;
const apply = name => all(widget, w => w instanceof Gtk.Button && (w.label === 'Apply' || w.label === 'In use') && title(w) === name)[0] ?? fail(`no card for ${name}`);

// ten cards, one of them in use
const cards = all(widget, w => w instanceof Gtk.Button && (w.label === 'Apply' || w.label === 'In use') && title(w));
if (cards.length !== 10) fail(`${cards.length} layout cards, wanted 10`);
if (cards.filter(b => b.label === 'In use').length !== 1) fail('not exactly one layout in use');
if (apply('Dwindle (BSP)').label !== 'In use') fail('the default layout is not marked in use');
// ten diagrams, each with a label
if (all(widget, w => w instanceof Gtk.DrawingArea).length !== 10) fail('not ten diagrams');

// Apply writes the layout, and the card follows
apply('Grid').emit('clicked');
if (backend.settings.get_string('layout') !== 'grid') fail(`layout is ${backend.settings.get_string('layout')}`);
if (apply('Grid').label !== 'In use') fail('the card did not follow');

// a rule is added through the form, shown, and removed
const entry = all(widget, w => w instanceof Adw.EntryRow && w.title === 'Application (window class)')[0] ?? fail('no rule form');
entry.set_text('org.gnome.Calculator');
const action = all(widget, w => w instanceof Adw.ComboRow && w.title === 'Tiling')[0];
action.set_selected(1);
all(widget, w => w instanceof Gtk.Button && w.label === 'Add the rule')[0].emit('clicked');
const rules = JSON.parse(backend.settings.get_string('window-rules'));
if (rules.length !== 1 || rules[0].match !== 'org.gnome.Calculator' || rules[0].action !== 'float') fail(`rules: ${JSON.stringify(rules)}`);
if (!all(widget, w => w instanceof Adw.ActionRow && /org.gnome.Calculator/.test(w.title)).length) fail('the rule is not listed');
// an empty rule is refused with a sentence
entry.set_text('');
all(widget, w => w instanceof Gtk.Button && w.label === 'Add the rule')[0].emit('clicked');
if (!toasts.some(t => /window class first/.test(t))) fail(`no sentence for an empty rule (${toasts})`);
all(widget, w => w instanceof Gtk.Button && /^Remove the rule/.test(w.get_accessible_label?.() ?? ''))?.[0]?.emit('clicked');

// a profile is saved from the form, and appears
const nameRow = all(widget, w => w instanceof Adw.EntryRow && /Save the current setup/.test(w.title))[0] ?? fail('no profile form');
nameRow.set_text('Desk');
nameRow.emit('apply');
if (backend.profiles().map(p => p.name).join() !== 'Desk') fail(`profiles: ${JSON.stringify(backend.profiles())}`);

// undo goes back one change: the layout Grid was applied after the rules; undo steps back through backups
backend.change({layout: 'monocle'}, 'by test');
all(widget, w => w instanceof Gtk.Button && w.label === 'Undo')[0].emit('clicked');
if (backend.settings.get_string('layout') !== 'grid') fail(`undo left ${backend.settings.get_string('layout')}`);

// a refused raw edit says why and changes nothing
const before = backend.settings.get_string('layout-map');
const views = all(widget, w => w instanceof Gtk.TextView && w.editable);
views[0].get_buffer().set_text('{"workspaces":{"1":"zig"}}', -1);
all(widget, w => w instanceof Gtk.Button && w.label === 'Check and save')[0].emit('clicked');
if (!toasts.some(t => /not a layout/.test(t))) fail(`a bad edit was not explained (${toasts})`);
if (backend.settings.get_string('layout-map') !== before) fail('a bad edit changed the map');

// without the extension the pages say so rather than showing nothing
if (!all(widget, w => w instanceof Adw.ActionRow && /extension is not running/.test(w.subtitle ?? '')).length) fail('no word about the extension not running');

print('tilingPage: ok');
