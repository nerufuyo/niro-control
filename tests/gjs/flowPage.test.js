// The Niro Flow page against a FAKE daemon (no D-Bus, no real settings): every state it can be in, the editor, previews, runs, deletion with
// confirmation, the "applying" state, and the grouped sidebar of the window. Nothing here is shown on a screen anyone looks at: it checks
// widgets by name and text, not how they look.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const tmp = GLib.dir_make_tmp('niro-flow-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);
if (!Gtk.init_check()) { print('flowPage: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {flowPage} = await import('../../control/build/flowPage.js');
const {FlowError} = await import('../../control/build/flowLogic.js');
const {Model} = await import('../../control/build/pages.js');

const ACTIONS = [
    {id: 'profile.apply', title: 'Apply a profile', permission: 'none', available: true, reason: null, params: [{name: 'id', type: 'string', required: true, maxLength: 80}], capability: 'settings', flow_can_run: true},
    {id: 'layout.restore', title: 'Restore a layout', permission: 'none', available: true, reason: null, params: [{name: 'name', type: 'string', required: true, maxLength: 24}], capability: 'window', flow_can_run: true},
    {id: 'process.kill', title: 'Quit a process', permission: 'confirm', available: true, reason: null, params: [{name: 'pid', type: 'number', required: true}], capability: null, flow_can_run: false},
];
const TEMPLATE = {version: 1, id: 'coding-focus', name: 'Coding focus', enabled: false, allow: ['settings'], trigger: {type: 'app_focused', app: 'code'}, steps: [{kind: 'action', id: 'profile', name: 'profile.apply', args: {id: 'deep-work'}, next: null}]};
const {parseActions} = await import('../../control/build/flowLogic.js');

const clone = v => JSON.parse(JSON.stringify(v));
function fake() {
    const f = {
        api: 1, enabled: true, workflows: [], runs: {}, fail: null, refuse: null, gate: null, calls: [],
        async _do(name, fn) { f.calls.push(name); if (f.gate) await f.gate; if (f.fail) throw f.fail; return fn(); },
        status() { return f._do('status', () => ({apiVersion: f.api, enabled: f.enabled})); },
        list() { return f._do('list', () => ({api: f.api, enabled: f.enabled, workflows: clone(f.workflows), problems: []})); },
        templates() { return f._do('templates', () => [{id: 'coding-focus', title: 'Coding focus', workflow: TEMPLATE}]); },
        knownActions() { return f._do('knownActions', () => parseActions(JSON.stringify({ok: true, actions: ACTIONS}))); },
        save(wf) { return f._do('save', () => { if (f.refuse) return {ok: false, problems: f.refuse}; const i = f.workflows.findIndex(w => w.id === wf.id); if (i >= 0) f.workflows[i] = clone(wf); else f.workflows.push(clone(wf)); return {ok: true, problems: []}; }); },
        remove(id) { return f._do('remove', () => { f.workflows = f.workflows.filter(w => w.id !== id); }); },
        setEnabled(id, on) { return f._do('setEnabled', () => { f.workflows.find(w => w.id === id).enabled = on; }); },
        setGlobalEnabled(on) { return f._do('setGlobalEnabled', () => { f.enabled = on; }); },
        dryRun(id) { return f._do('dryRun', () => ({ok: true, problems: [], registry: 'ok', flow_enabled: f.enabled, workflow: id, steps: [{kind: 'action', step: 'profile', action: 'profile.apply', args: {id: 'deep-work', api_token: 'SECRET-VALUE'}, permission: 'allowed', available: true}]})); },
        runNow(id) { return f._do('runNow', () => { (f.runs[id] ??= []).push({id: 1, workflow_id: id, started_ms: Date.now(), status: 'ok', error: null, steps: []}); return '1'; }); },
        cancel() { return f._do('cancel', () => {}); },
        history(id) { return f._do('history', () => clone(f.runs[id] ?? [])); },
        clearHistory() { return f._do('clearHistory', () => { f.runs = {}; }); },
    };
    return f;
}

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const named = (root, name) => all(root, w => w.get_name?.() === name)[0] ?? null;
const need = (root, name) => named(root, name) ?? fail(`no widget named ${name}`);
const texts = root => all(root, w => w instanceof Gtk.Label).map(l => l.get_label() ?? '').concat(all(root, w => w instanceof Adw.PreferencesRow || w instanceof Adw.ActionRow).flatMap(r => [r.get_title?.() ?? '', r.get_subtitle?.() ?? '']));
const tick = (ms = 20) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(10); };
const click = (root, name) => { need(root, name).emit('clicked'); };
const shown = page => page.stack.get_visible_child_name();
const toasts = [];
const ctx = {toast: m => toasts.push(m), openLook: () => {}, go: () => {}, inhibitShortcuts: () => {}, takenShortcuts: () => [], window: null};
const make = async (b, load = true) => { const model = new Model(ctx); const page = flowPage(model, ctx, b); if (load) { await page.ensure(); await settle(); } return {page, model, root: page.widget}; };

// ---- loading: the first thing seen, before the daemon answered
{
    const b = fake(); let release; b.gate = new Promise(r => (release = r));
    const {page, root} = await make(b, false);
    const p = page.ensure();
    if (shown(page) !== 'status') fail(`loading shows ${shown(page)}`);
    if (!need(root, 'flow-status').get_title().includes('Looking')) fail('loading has no title');
    if (need(root, 'flow-retry').get_visible()) fail('there is nothing to retry while loading');
    release(); b.gate = null; await p; await settle();
    if (shown(page) !== 'main') fail(`after loading: ${shown(page)} ${page.flow.state.view} ${page.flow.state.message}`);
    page.dispose();
}

// ---- empty: nothing yet, templates offered; Flow is on
{
    const b = fake();
    const {page, root} = await make(b);
    need(root, 'flow-empty'); need(root, 'flow-template:coding-focus'); need(root, 'flow-new');
    if (need(root, 'flow-global').get_active() !== true) fail('the global switch does not show Flow on');
    page.dispose();
}

// ---- disabled (the default): Flow off, still editable, no run
{
    const b = fake(); b.enabled = false; b.workflows = [{...TEMPLATE, enabled: true}];
    const {page, root} = await make(b);
    if (page.flow.state.view !== 'disabled') fail('view should be disabled');
    if (need(root, 'flow-global').get_active()) fail('Flow must start off');
    need(root, 'flow:coding-focus');
    click(root, 'flow-run:coding-focus'); await settle();
    if (b.calls.includes('runNow')) fail('Run now reached the daemon while Flow was off');
    if (!texts(root).some(t => /Flow is off/.test(t))) fail('no sentence says Flow is off');
    // the switch turns it on
    need(root, 'flow-global').set_active(true); await settle();
    if (!b.enabled || page.flow.state.view !== 'ready') fail('switching Flow on did not reach the daemon');
    page.dispose();
}

// ---- template, enable switch, preview (secrets masked), run, history, delete with confirmation
{
    const b = fake();
    const {page, root} = await make(b);
    click(root, 'flow-use:coding-focus'); await settle();
    if (b.workflows.length !== 1 || b.workflows[0].enabled !== false) fail('the template was not saved switched off');
    need(root, 'flow:coding-focus');
    if (need(root, 'flow-enable:coding-focus').get_active()) fail('a template workflow starts switched off');
    need(root, 'flow-enable:coding-focus').set_active(true); await settle();
    if (b.workflows[0].enabled !== true) fail('the enable switch did not reach the daemon');
    click(root, 'flow-preview:coding-focus'); await settle();
    need(root, 'flow-preview-head:coding-focus');
    const text = texts(root).join('\n');
    if (/SECRET-VALUE/.test(text)) fail('a secret reached a label');
    if (!/would run/.test(text)) fail('the preview does not say what would run');
    click(root, 'flow-run:coding-focus'); await settle();
    if (!named(root, 'flow-run-row:coding-focus')) fail('no run in the history after Run now');
    if (!texts(root).some(t => /Succeeded/.test(t))) fail('the result is not shown');
    // delete: asks first
    click(root, 'flow-delete:coding-focus'); await settle();
    need(root, 'flow-delete-confirm:coding-focus');
    if (b.workflows.length !== 1) fail('deleted without asking');
    click(root, 'flow-keep:coding-focus'); await settle();
    if (named(root, 'flow-delete-confirm:coding-focus')) fail('Keep did not close the question');
    click(root, 'flow-delete:coding-focus'); await settle(); click(root, 'flow-delete-confirm:coding-focus'); await settle();
    if (b.workflows.length !== 0) fail('not deleted'); need(root, 'flow-empty');
    page.dispose();
}

// ---- the editor: make a workflow from nothing; problems are listed, not swallowed
{
    const b = fake();
    const {page, root} = await make(b);
    click(root, 'flow-new'); await settle();
    if (shown(page) !== 'editor') fail('New workflow did not open the editor');
    const set = (n, v) => need(root, n).set_text(v);
    click(root, 'flow-form-save'); await settle();
    const problems = () => all(root, w => /^flow-problem:/.test(w.get_name?.() ?? '')).length;
    if (!problems() || b.workflows.length) fail(`an empty form was saved or showed no problems (${problems()})`);
    set('flow-form-name', 'Night mode');
    if (need(root, 'flow-form-id').get_text() !== 'night-mode') fail(`id not made from the name: ${need(root, 'flow-form-id').get_text()}`);
    need(root, 'flow-form-trigger').set_selected(7);                       // At a time of day
    set('flow-form-trigger-field', '22:15');
    click(root, 'flow-form-add-action'); await settle();
    if (named(root, 'flow-form-action-pick:0') === null) fail('no action after Add');
    const arg = need(root, 'flow-form-arg:0:id');
    arg.set_text('everyday');
    // only runnable actions are in the choices: process.kill needs a confirmation
    const choices = need(root, 'flow-form-action-pick:0').get_model();
    if (choices.get_n_items() !== 2) fail(`expected 2 choosable actions, got ${choices.get_n_items()}`);
    b.refuse = ['step "a1": "id" is not a known profile'];
    click(root, 'flow-form-save'); await settle();
    if (shown(page) !== 'editor') fail('the editor closed on a refusal');
    if (!texts(root).some(t => /not a known profile/.test(t))) fail('the daemon\'s words were not shown');
    b.refuse = null;
    click(root, 'flow-form-save'); await settle();
    if (shown(page) !== 'main') fail('the editor stayed open after a good save');
    const wf = b.workflows[0];
    if (JSON.stringify(wf.trigger) !== '{"type":"schedule","at":"22:15"}' || wf.steps[0].args.id !== 'everyday' || wf.allow.join() !== 'settings' || wf.enabled !== false) fail(`wrong workflow saved: ${JSON.stringify(wf)}`);
    // edit it again: the form shows what was saved, the id cannot change
    click(root, 'flow-edit:night-mode'); await settle();
    if (need(root, 'flow-form-name').get_text() !== 'Night mode' || need(root, 'flow-form-id').get_sensitive()) fail('edit form does not show the saved workflow');
    if (need(root, 'flow-form-trigger-field').get_text() !== '22:15') fail('the trigger field was lost');
    click(root, 'flow-form-cancel'); await settle();
    if (shown(page) !== 'main') fail('Cancel did not leave the editor');
    page.dispose();
}

// ---- a workflow the form cannot show is read-only in the form, so Save cannot damage it
{
    const b = fake(); b.workflows = [{...TEMPLATE, id: 'waiter', steps: [{kind: 'delay', id: 'w', seconds: 3, next: 'profile'}, ...TEMPLATE.steps]}];
    const {page, root} = await make(b);
    click(root, 'flow-edit:waiter'); await settle();
    need(root, 'flow-form-lossy');
    if (need(root, 'flow-form-save').get_sensitive()) fail('Save is enabled for a workflow the form would damage');
    page.dispose();
}

// ---- opening the editor fills a required choice, never an optional one
{
    const b = fake();
    const params = [{name: 'must', type: 'enum', required: true, enum: ['a', 'b']}, {name: 'may', type: 'enum', enum: ['x', 'y']}];
    b.knownActions = async () => parseActions(JSON.stringify({ok: true, actions: [{id: 'demo.set', title: 'Demo', params, capability: 'settings', flow_can_run: true}]}));
    b.workflows = [{...TEMPLATE, id: 'enums', steps: [{kind: 'action', id: 'a1', name: 'demo.set', args: {}, next: null}]}];
    const {page, root} = await make(b);
    click(root, 'flow-edit:enums'); await settle();
    const may = need(root, 'flow-form-arg:0:may');
    if (may.get_selected() !== 0 || may.get_model().get_string(0) !== 'Not set') fail('an optional choice does not start as Not set');
    click(root, 'flow-form-save'); await settle();
    const args = JSON.stringify(b.workflows[0].steps[0].args);
    if (args !== '{"must":"a"}') fail(`opening the editor filled the wrong arguments: ${args}`);
    page.dispose();
}

// ---- applying: while a change is out, the page says so and cannot be pressed
{
    const b = fake(); b.workflows = [TEMPLATE];
    const {page, root} = await make(b);
    let release; b.gate = new Promise(r => (release = r));
    const done = page.flow.setGlobal(false); await tick(10);
    if (!need(root, 'flow-banner').get_revealed() || !need(root, 'flow-banner').get_title().includes('Working')) fail('no "applying" message');
    if (need(root, 'flow:coding-focus').is_sensitive()) fail('the page can be used while a change is out');
    release(); b.gate = null; await done; await settle();
    if (need(root, 'flow-banner').get_title().includes('Working')) fail('"applying" stayed');
    if (!/Flow is off/.test(need(root, 'flow-banner').get_title())) fail('no success message');
    page.dispose();
}

// ---- the error screens, and "try again" recovering
for (const [error, title, rx] of [
    [new Error('org.freedesktop.DBus.Error.ServiceUnknown: not activatable'), 'The Niro daemon is not running', /not running/],
    [new FlowError('permission', 'The session bus refused this panel.'), 'Flow needs permission', /refused/],
    [new FlowError('unsupported', 'The daemon has no Flow interface.'), 'This daemon does not match this panel', /no Flow interface/],
    [new FlowError('error', 'Flow sent an unreadable workflow list.'), 'Flow could not be read', /unreadable/],
]) {
    const b = fake(); b.fail = error;
    const {page, root} = await make(b);
    if (shown(page) !== 'status') fail(`${title}: shows ${shown(page)}`);
    const st = need(root, 'flow-status');
    if (st.get_title() !== title || !rx.test(st.get_description())) fail(`${title}: got "${st.get_title()}" / "${st.get_description()}"`);
    if (!need(root, 'flow-retry').get_visible()) fail(`${title}: no retry`);
    b.fail = null; click(root, 'flow-retry'); await settle();
    if (shown(page) !== 'main') fail(`${title}: retry did not recover`);
    page.dispose();
}
{
    const b = fake(); b.api = 2;
    const {page, root} = await make(b);
    if (page.flow.state.view !== 'unsupported' || !/version 2/.test(need(root, 'flow-status').get_description())) fail('a version mismatch is not reported');
    page.dispose();
}

// ---- Advanced mode shows the raw files; Simple hides them
{
    const b = fake(); b.workflows = [TEMPLATE];
    const {page, model, root} = await make(b);
    const raw = need(root, 'flow-raw');
    model.setMode('simple', false); if (raw.get_visible()) fail('raw files shown in Simple');
    model.setMode('advanced', false); if (!raw.get_visible()) fail('raw files hidden in Advanced');
    model.setMode('simple', false);
    page.dispose();
}

// ---- the window: grouped sidebar, no page lost, Flow under Automation
{
    const {buildWindow, GROUPS} = await import('../../control/build/window.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlFlowTest'});
    app.register(null);
    const {window, shared} = buildWindow(app);
    const sidebar = all(window, w => w instanceof Gtk.ListBoxRow && w.get_name() === 'flow')[0]?.get_parent() ?? fail('no sidebar');
    const rows = all(sidebar, w => w instanceof Gtk.ListBoxRow && w.get_parent() === sidebar).map(r => r.get_name());
    for (const id of ['home', 'look', 'studio', 'island', 'dock', 'windows', 'search', 'tiling', 'compat', 'profiles', 'about', 'flow', 'notifications', 'backup'])
        if (!rows.includes(id)) fail(`the sidebar lost "${id}"`);
    if (rows.length !== 16) fail(`expected 16 pages, found ${rows.length}`);
    const groupOf = {home: 'Home', look: 'Appearance', studio: 'Appearance', island: 'Desktop', dock: 'Desktop', windows: 'Desktop', tiling: 'Desktop', flow: 'Automation', profiles: 'Automation', search: 'Intelligence', about: 'System', notifications: 'System', backup: 'System', permissions: 'System', connectivity: 'Connectivity', compat: 'Advanced'};
    const order = rows.map(r => GROUPS.indexOf(groupOf[r]));
    if (order.some((g, i) => i && g < order[i - 1])) fail(`the pages are not in group order: ${rows}`);
    const headers = all(window, w => w instanceof Gtk.Label && w.has_css_class('caption-heading')).map(l => l.get_label());
    if (JSON.stringify(headers) !== JSON.stringify(['Appearance', 'Desktop', 'Automation', 'Intelligence', 'System', 'Connectivity', 'Advanced'])) fail(`group headings: ${headers}`);
    if (!shared.flow?.flow) fail('the window has no Flow page');
    window.close();
}

print('flowPage: ok');
