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
const asked = []; let agree = false;
const ctx = {confirm: (t, _b, _l, done) => { asked.push(t); if (agree) done(); }, toast: m => toasts.push(m), openLook: () => {}, inhibitShortcuts: () => {}, takenShortcuts: e => model.takenShortcuts(e), window: null};
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
// rules changed elsewhere since the list was drawn: the button removes the rule it names, not the one now in its place
const bin = () => all(widget, w => w instanceof Gtk.Button && w.tooltip_text === null && w.icon_name === 'user-trash-symbolic')[0] ?? fail('no remove button');
backend.settings.set_string('window-rules', '[]');
entry.set_text('x.X'); action.set_selected(1);
all(widget, w => w instanceof Gtk.Button && w.label === 'Add the rule')[0].emit('clicked');
const stale = bin();
backend.settings.set_string('window-rules', '[{"match":"y.Y","action":"float"},{"match":"x.X","action":"float"}]');
stale.emit('clicked');
if (!/y\.Y/.test(backend.settings.get_string('window-rules')) || /x\.X/.test(backend.settings.get_string('window-rules'))) fail(`removed the wrong rule: ${backend.settings.get_string('window-rules')}`);
backend.settings.set_string('window-rules', '[]');

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

// the raw editors follow a change made elsewhere, never over an unsaved edit, and saving over a newer value asks first
{
    const [mapView, ruleView] = views;
    const textOf = v => { const b = v.get_buffer(); return b.get_text(b.get_start_iter(), b.get_end_iter(), false); };
    const saveRules = () => all(widget, w => w instanceof Gtk.Button && w.label === 'Check and save')[1].emit('clicked');
    backend.settings.set_string('window-rules', '[{"match":"a.A","action":"float"}]');
    widget.emit('map');
    if (!/a\.A/.test(textOf(ruleView))) fail('the editor did not reload');
    mapView.get_buffer().set_text('{}', -1);
    ruleView.get_buffer().set_text('[{"match":"mine","action":"float"}]', -1);
    backend.settings.set_string('window-rules', '[{"match":"b.B","action":"float"}]');
    widget.emit('map');
    if (!/mine/.test(textOf(ruleView))) fail('an unsaved edit was discarded');
    asked.length = 0; agree = false; saveRules();
    if (!asked.length || !/b\.B/.test(backend.settings.get_string('window-rules'))) fail('a newer value was overwritten without asking');
    agree = true; saveRules(); agree = false;
    if (!/mine/.test(backend.settings.get_string('window-rules'))) fail('a confirmed save did not write');
    widget.emit('unmap');
    asked.length = 0;
}
// the chosen scope survives the refresh
{
    const scopeRow = all(widget, w => w instanceof Adw.ComboRow && w.title === 'Apply to')[0];
    scopeRow.set_selected(1);
    widget.emit('map'); widget.emit('unmap');
    if (scopeRow.selected !== 1) fail('the refresh reset "Apply to"');
}
// stored text that is not JSON: the page still builds, shows it as it is, and writes nothing over it
{
    const keep = ['window-rules', 'layout-map'].map(k => [k, backend.settings.get_string(k)]);
    for (const [k] of keep) backend.settings.set_string(k, '{oops');
    const broken = tilingPage(model, ctx);
    if (all(broken, w => w instanceof Gtk.TextView && w.editable).filter(v => { const b = v.get_buffer(); return b.get_text(b.get_start_iter(), b.get_end_iter(), false) === '{oops'; }).length !== 2) fail('the raw text is not shown');
    all(broken, w => w instanceof Adw.EntryRow && w.title === 'Application (window class)')[0].set_text('x');
    all(broken, w => w instanceof Adw.ComboRow && w.title === 'Tiling')[0].set_selected(1);
    all(broken, w => w instanceof Gtk.Button && w.label === 'Add the rule')[0].emit('clicked');
    for (const [k, v] of keep) { if (backend.settings.get_string(k) !== '{oops') fail(`${k} was written over`); backend.settings.set_string(k, v); }
}


// ---- Advanced Rules: the engine switch, a rule list with add/edit/remove, conflicts and a dry run that applies nothing
const entryOf = t => all(widget, w => w instanceof Adw.EntryRow && w.title === t)[0] ?? fail(`no entry "${t}"`);
const spinOf = t => all(widget, w => w instanceof Adw.SpinRow && w.title === t)[0] ?? fail(`no spin "${t}"`);
const comboOf = t => all(widget, w => w instanceof Adw.ComboRow && w.title === t)[0] ?? fail(`no combo "${t}"`);
const btn = l => all(widget, w => w instanceof Gtk.Button && w.label === l)[0] ?? fail(`no button "${l}"`);
// a rule's buttons are found through its row (the accessible label is checked separately below)
const inRow = (id, test) => { const row = rows(new RegExp(`^${id}$`))[0] ?? fail(`no row for ${id}`); return all(row, test)[0] ?? fail(`nothing in row ${id}`); };
const ruleButton = (id, icon) => inRow(id, w => w instanceof Gtk.Button && w.icon_name === icon);
const rows = t => all(widget, w => w instanceof Adw.ActionRow && w.title && t.test(w.title));
const adv = () => JSON.parse(backend.settings.get_string('advanced-rules'));

if (!rows(/No advanced rules yet/).length) fail('no empty state for the advanced rules');
if (!rows(/There are no rules to compare|No conflicts/).length && !all(widget, w => w instanceof Adw.ActionRow && w.title === 'No conflicts').length) fail('no empty state for conflicts');
// the engine switch writes the setting, and is off to start with
const engine = all(widget, w => w instanceof Adw.SwitchRow && w.title === 'Use the advanced rules')[0] ?? fail('no engine switch');
if (engine.active || backend.settings.get_boolean('rules-engine')) fail('the engine is not off by default');
engine.set_active(true);
if (!backend.settings.get_boolean('rules-engine')) fail('the switch did not write rules-engine');
engine.set_active(false);
if (backend.settings.get_boolean('rules-engine')) fail('the switch did not turn it off');
// an empty name, and a rule with no condition, are refused with a sentence and write nothing
btn('Add the advanced rule').emit('clicked');
if (!toasts.some(t => /name first/.test(t))) fail(`no sentence for a nameless rule (${toasts})`);
entryOf('Rule name (letters, digits, dot, dash)').set_text('empty');
comboOf('Action: tiling').set_selected(1);
btn('Add the advanced rule').emit('clicked');
if (!toasts.some(t => /Not saved: .*no condition/.test(t))) fail(`a rule without a condition was not explained (${toasts})`);
if (adv().length) fail('a refused rule was written');
// a valid rule is added, listed, and the form is cleared
entryOf('Rule name (letters, digits, dot, dash)').set_text('calc');
entryOf('Condition: application (window class)').set_text('org.gnome.Calculator');
comboOf('Action: tiling').set_selected(1);
spinOf('Priority').set_value(5);
spinOf('Action: opacity').set_value(0.8);
btn('Add the advanced rule').emit('clicked');
let list = adv();
if (list.length !== 1 || list[0].id !== 'calc' || list[0].conditions.appId !== 'org.gnome.Calculator' || list[0].actions.tile !== 'float' || list[0].priority !== 5 || list[0].actions.opacity !== 0.8) fail(`rules: ${JSON.stringify(list)}`);
if (!rows(/^calc$/).length) fail('the rule is not listed');
if (entryOf('Rule name (letters, digits, dot, dash)').get_text() !== '') fail('the form was not cleared');
// a duplicate name is refused
entryOf('Rule name (letters, digits, dot, dash)').set_text('calc');
entryOf('Condition: application (window class)').set_text('firefox');
comboOf('Action: tiling').set_selected(2);
btn('Add the advanced rule').emit('clicked');
if (!toasts.some(t => /already a rule named "calc"/.test(t))) fail(`a duplicate was not explained (${toasts})`);
// a second rule that disagrees shows up under Conflicts
entryOf('Rule name (letters, digits, dot, dash)').set_text('calc-tile');
entryOf('Condition: application (window class)').set_text('org.gnome.Calculator');
comboOf('Action: tiling').set_selected(2);
spinOf('Action: move to workspace').set_value(3);
btn('Add the advanced rule').emit('clicked');
if (adv().length !== 2) fail(`two rules expected: ${JSON.stringify(adv())}`);
if (!rows(/&quot;calc&quot; and &quot;calc-tile&quot; both set tile/).length) fail('the conflict is not listed');
// the dry run: matched, trace, what would be done; nothing marked as not applied; nothing written
const before2 = backend.settings.get_string('advanced-rules');
entryOf('Dry run: application (window class)').set_text('org.gnome.calculator');
btn('Run the dry run').emit('clicked');
if (!rows(/^calc: matched$/).length || !rows(/^calc-tile: matched$/).length) fail('the trace does not show the matches');
if (!rows(/^Would do$/).some(r => /tile float \(from calc\)/.test(r.subtitle) && /workspace 3 \(from calc-tile\)/.test(r.subtitle))) fail('the result is not shown');
if (rows(/not applied on this system/).length) fail('an action is marked as not applied, but every rule action is applied now');
if (!rows(/The engine is off/).length) fail('the dry run does not say the engine is off');
if (backend.settings.get_string('advanced-rules') !== before2 || backend.settings.get_boolean('rules-engine')) fail('the dry run changed a setting');
// a window no rule matches
entryOf('Dry run: application (window class)').set_text('firefox');
btn('Run the dry run').emit('clicked');
if (!rows(/^Would do nothing$/).length || !rows(/^calc: did not match$/).length) fail('no result for an unmatched window');
// editing keeps the name and changes the rule in place
ruleButton('calc-tile', 'document-edit-symbolic').emit('clicked');
if (entryOf('Rule name (letters, digits, dot, dash)').get_text() !== 'calc-tile') fail('the form did not load the rule');
if (btn('Save the advanced rule') === null) fail('no save button while editing');
spinOf('Priority').set_value(9);
btn('Save the advanced rule').emit('clicked');
list = adv();
if (list.length !== 2 || list[1].id !== 'calc-tile' || list[1].priority !== 9 || list[1].actions.workspace !== 3) fail(`edit: ${JSON.stringify(list)}`);
// the per-rule switch
const sw = inRow('calc', w => w instanceof Gtk.Switch);
sw.emit('state-set', false);
if (adv()[0].enabled !== false) fail('the rule switch did not write');
// removing asks first; a no leaves it, a yes removes it
ruleButton('calc', 'user-trash-symbolic').emit('clicked');
if (asked.length !== 1 || adv().length !== 2) fail('removing did not ask first');
agree = true;
ruleButton('calc', 'user-trash-symbolic').emit('clicked');
if (adv().length !== 1 || adv()[0].id !== 'calc-tile') fail(`remove: ${JSON.stringify(adv())}`);
// a stored list that is not valid is shown as a problem, not hidden
backend.settings.set_string('advanced-rules', '[{"id":"broken"}]');
engine.set_active(true);   // any change redraws from what is stored
if (!all(widget, w => w instanceof Adw.ActionRow && w.title === 'Invalid').length) fail('a stored invalid rule is not reported');
backend.settings.set_string('advanced-rules', '[]');
engine.set_active(false);
if (!rows(/No advanced rules yet/).length) fail('the empty state did not come back');

// without the extension the pages say so rather than showing nothing
if (!all(widget, w => w instanceof Adw.ActionRow && /extension is not running/.test(w.subtitle ?? '')).length) fail('no word about the extension not running');


// ---- Groups, Snapshots and monitor recovery, against the real workspace service behind a fake transport
{
    const {installFakeShell} = await import('./tileFakeShell.js');
    const {TileBackend: TB} = await import('../../control/build/tileBackend.js');
    const shell = installFakeShell(TB, {windows: [
        {id: 1, appId: 'org.a.Edit', title: 'one', workspace: 1, monitor: 0}, {id: 2, appId: 'org.b.Term', title: 'sh', workspace: 2, monitor: 1}]});
    const w2 = tilingPage(model, ctx);
    const sections = all(w2, w => w instanceof Gtk.Label && ['Groups', 'Snapshots'].includes(w.label)).length;
    if (sections < 2) fail('the Groups and Snapshots sections are not in the list');
    const rowsOf = re => all(w2, w => w instanceof Adw.ActionRow && re.test(w.title ?? ''));
    const entryW = t2 => all(w2, w => w instanceof Adw.EntryRow && w.title === t2)[0] ?? fail(`no entry ${t2}`);
    const button = l => all(w2, w => w instanceof Gtk.Button && w.label === l)[0] ?? null;
    const expanders = () => all(w2, w => w instanceof Adw.ExpanderRow);
    const reread = () => w2.emit('map');   // the page follows the shell when it is shown

    // monitor recovery: off, and the switch writes the setting
    const rec = all(w2, w => w instanceof Adw.SwitchRow && /Move windows off a monitor/.test(w.title))[0] ?? fail('no monitor recovery switch');
    if (rec.active) fail('monitor recovery is not off by default');
    rec.set_active(true);
    if (!backend.settings.get_boolean('monitor-recovery')) fail('the recovery switch did not write');
    rec.set_active(false);

    // groups: create (empty), add an open window, activate, delete
    reread();
    entryW('New group (empty)').set_text('Work');
    entryW('New group (empty)').emit('apply');
    if (!backend.groups().some(g => g.name === 'Work')) fail('the group was not created');
    const ex = expanders().find(e => e.title === 'Work') ?? fail('the group is not listed');
    if (backend.groups()[0].members.length !== 0) fail('a group made in the panel must not contain the panel window');
    const pick = all(ex, w => w instanceof Adw.ComboRow && w.title === 'Add a window')[0] ?? fail('no add-a-window row');
    pick.set_selected(1);
    all(pick, w => w instanceof Gtk.Button && w.label === 'Add')[0].emit('clicked');
    if (backend.groups()[0].members[0]?.windowId !== 2) fail(`the chosen window was not added: ${JSON.stringify(backend.groups()[0].members)}`);
    shell.wins.find(w => w.id === 2).workspace = 3;
    all(expanders().find(e => e.title === 'Work'), w => w instanceof Gtk.Button && w.label === 'Activate')[0].emit('clicked');
    if (!shell.moved.length) fail('Activate did not move the window');
    if (!toasts.some(t => /^Moved 1 window/.test(t))) fail(`no sentence for the activation (${toasts.slice(-3)})`);
    shell.wins = shell.wins.filter(w => w.id !== 2);   // the app is closed: still not an error
    toasts.length = 0;
    all(expanders().find(e => e.title === 'Work'), w => w instanceof Gtk.Button && w.label === 'Activate')[0].emit('clicked');
    if (!toasts.some(t => /1 not open/.test(t))) fail(`a closed window is not reported (${toasts})`);
    agree = false; asked.length = 0;
    all(expanders().find(e => e.title === 'Work'), w => w instanceof Gtk.Button && /^Delete the group/.test(w.tooltip_text ?? ''))[0].emit('clicked');
    if (!asked.some(a => /Delete the group/.test(a)) || !backend.groups().length) fail('deleting did not ask first');
    agree = true;
    all(expanders().find(e => e.title === 'Work'), w => w instanceof Gtk.Button && /^Delete the group/.test(w.tooltip_text ?? ''))[0].emit('clicked');
    if (backend.groups().length) fail('the group was not deleted after yes');

    // snapshots: take, preview (nothing moves), restore after a yes, partial results
    shell.wins = [{id: 1, appId: 'org.a.Edit', title: 'one', workspace: 1, monitor: 0}, {id: 3, appId: 'org.c.Gone', title: 'g', workspace: 2, monitor: 0}];
    entryW('Take a snapshot now (a name is optional)').set_text('Morning');
    entryW('Take a snapshot now (a name is optional)').emit('apply');
    if (backend.snapshots().snapshots.length !== 1) fail('the snapshot was not taken');
    shell.wins = [{id: 1, appId: 'org.a.Edit', title: 'one', workspace: 3, monitor: 0}];   // moved, and one app closed
    const snap = expanders().find(e => e.title === 'Morning') ?? fail('the snapshot is not listed');
    const restoreB = all(snap, w => w instanceof Gtk.Button && w.label === 'Restore…')[0];
    if (restoreB.sensitive) fail('Restore is enabled before a preview');
    shell.moved.length = 0;
    all(snap, w => w instanceof Gtk.Button && w.label === 'Preview')[0].emit('clicked');
    if (shell.moved.length) fail('a preview moved a window');
    if (!restoreB.sensitive) fail('Restore stayed disabled after a preview with work to do');
    if (!all(snap, w => w instanceof Adw.ActionRow && /not running/.test(w.subtitle ?? '')).length) fail('the app that is not running is not listed');
    const startB = all(snap, w => w instanceof Gtk.Button && w.label === 'Start')[0] ?? fail('no Start button for an app that is not running');
    if (shell.launched.length) fail('something was launched before Start was pressed');
    agree = false; asked.length = 0;
    restoreB.emit('clicked');
    if (shell.moved.length || !asked.length) fail('restore did not ask first');
    agree = true;
    restoreB.emit('clicked');
    if (shell.moved.length !== 1 || shell.moved[0].workspace !== 1) fail(`restore moved ${JSON.stringify(shell.moved)}`);
    if (shell.launched.length) fail('restore launched an app');
    startB.emit('clicked');
    if (shell.launched.join() !== 'org.c.gone') fail(`Start launched ${shell.launched}`);
    // advanced rules over the open windows: the fullscreen action in the form, a preview first, a confirmation, then the shell applies it once
    shell.wins = [{id: 1, appId: 'org.a.Edit', title: 'one', workspace: 1, monitor: 0}];
    const sw = all(w2, w => w instanceof Adw.SwitchRow && w.title === 'Action: make full screen')[0] ?? fail('no fullscreen action switch');
    entryW('Rule name (letters, digits, dot, dash)').set_text('full');
    entryW('Condition: application (window class)').set_text('org.a.Edit');
    sw.set_active(true);
    all(w2, w => w instanceof Gtk.Button && w.label === 'Add the advanced rule')[0].emit('clicked');
    if (!adv().some(r => r.id === 'full' && r.actions.fullscreen === true)) fail(`the fullscreen action was not saved: ${JSON.stringify(adv())}`);
    const applyBtn = all(w2, w => w instanceof Gtk.Button && w.label === 'Apply to open windows')[0] ?? fail('no Apply to open windows button');
    shell.ruleCalls.length = 0; asked.length = 0; agree = false;
    applyBtn.emit('clicked');
    if (shell.ruleCalls.join() !== 'ApplyRulesPreview') fail(`the button must preview first: ${shell.ruleCalls}`);
    if (!asked.some(a => /Apply the rules to 1 open window/.test(a))) fail(`no confirmation (${asked})`);
    if (shell.wins[0].workspace !== 1) fail('a window moved before the person confirmed');
    if (!all(w2, w => w instanceof Adw.ActionRow && /fullscreen true/.test(w.title ?? '')).length) fail('the preview does not list what would change');
    agree = true;
    applyBtn.emit('clicked');
    if (shell.ruleCalls.join() !== 'ApplyRulesPreview,ApplyRulesPreview,ApplyRules') fail(`calls: ${shell.ruleCalls}`);
    if (!toasts.some(t => /^Applied to 1 window/.test(t))) fail(`no sentence after applying (${toasts.slice(-3)})`);
    toasts.length = 0;
    shell.wins[0].workspace = 2;   // nothing left to change
    applyBtn.emit('clicked');
    if (!toasts.some(t => /Nothing to change/.test(t))) fail('a run with nothing pending is not said');
    shell.engine = false; toasts.length = 0;
    applyBtn.emit('clicked');
    if (!toasts.some(t => /engine is off/.test(t))) fail(`the engine being off is not explained (${toasts})`);
    shell.engine = true;
    // without the shell the sections still draw and say why
    shell.on = false;
    reread();
}

print('tilingPage: ok');
