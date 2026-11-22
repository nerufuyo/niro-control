// The Notifications page (Notification Hub) against a FAKE backend and fake settings (no D-Bus, no real settings), the backend against a
// stand-in org.niro.Search on a PRIVATE bus this test starts and stops, and the Look page's contrast warning. Widgets are found by name and
// text, not by how they look: nothing here was seen on a screen.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const tmp = GLib.dir_make_tmp('niro-hub-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);
if (!Gtk.init_check()) { print('hubPage: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {hubPage} = await import('../../control/build/hubPage.js');
const {DBusHubBackend, SEARCH_BUS, SEARCH_PATH} = await import('../../control/build/hubBackend.js');
const {Model, lookPickers, TONES} = await import('../../control/build/pages.js');
const {colorAdvice} = await import('../../control/build/appearanceLogic.js');

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const named = (root, name) => all(root, w => w.get_name?.() === name)[0] ?? null;
const need = (root, name) => named(root, name) ?? fail(`no widget named ${name}`);
const texts = root => all(root, w => w instanceof Gtk.Label).map(l => l.get_label() ?? '').concat(all(root, w => w instanceof Adw.PreferencesRow || w instanceof Adw.ActionRow).flatMap(r => [r.get_title?.() ?? '', r.get_subtitle?.() ?? '']));
const has = (root, re) => texts(root).some(t => re.test(t));
const tick = (ms = 20) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(10); };
const toasts = [];
const ctx = {toast: m => toasts.push(m), openLook: () => {}, go: () => {}, inhibitShortcuts: () => {}, takenShortcuts: () => [], window: null};
const ok = message => ({ok: true, message, error: '', code: ''});

function fake({hub = true, apply = false, rules = {rules: [], quiet: null}} = {}) {
    const f = {
        hub, apply, files: rules, calls: [], fail: null, outcome: null, gate: null,
        settings: {hubOn: () => f.hub, applyOn: () => f.apply, setHub: v => { f.hub = v; }, setApply: v => { f.apply = v; }},
        backend: {
            async run(id, args) {
                f.calls.push([id, args]);
                if (f.gate) await f.gate;
                if (f.fail) throw f.fail;
                if (f.outcome) return f.outcome;
                if (id === 'notifications.summary') return ok(`3 notifications seen; ${f.files?.rules.length ?? 0} rules; rules are only counted\norg.a: 3`);
                return ok('done');
            },
            async readRules() { return f.files === null ? null : JSON.stringify(f.files); },
        },
    };
    return f;
}
const make = async (f, load = true) => {
    const model = new Model(ctx);
    const page = hubPage(model, ctx, f.backend, f.settings);
    if (load) { await page.ensure(); await settle(); }
    return {page, root: page.widget};
};
const shown = p => p.stack.get_visible_child_name();

// ---- loading, then ready with a rule
{
    const f = fake({rules: {rules: [{app: 'org.a', verdict: 'silent'}], quiet: {from: '22:00', to: '07:00'}}});
    let release; f.gate = new Promise(r => { release = r; });
    const {page, root} = await make(f, false);
    page.ensure(); await tick();
    if (shown(page) !== 'status' || !has(root, /Looking for the Notification Hub/)) fail('no loading screen');
    release(); await settle();
    if (shown(page) !== 'main') fail('not ready');
    need(root, 'hub-rule:org.a'); need(root, 'hub-app:org.a');
    if (!has(root, /Quiet from 22:00 to 07:00/)) fail('quiet hours not shown');
    if (need(root, 'hub-switch').get_active() !== true) fail('hub switch off');
    page.dispose();
}

// ---- empty
{
    const {page, root} = await make(fake({rules: {rules: [], quiet: null}}));
    need(root, 'hub-no-rules');
    if (!has(root, /Quiet hours are off/)) fail('no quiet-off text');
    page.dispose();
}

// ---- disabled: no call to Search, the switch is there, the rest is not; turning it on loads the page
{
    const f = fake({hub: false});
    const {page, root} = await make(f);
    need(root, 'hub-disabled');
    if (f.calls.length) fail('Search was called while the hub is off');
    if (named(root, 'hub-rule-app')) fail('rule form shown while disabled');
    if (need(root, 'hub-apply-switch').get_sensitive()) fail('apply switch usable while the hub is off');
    need(root, 'hub-switch').set_active(true); await settle();
    if (!f.hub) fail('the setting was not written');
    need(root, 'hub-rule-app');
    page.dispose();
}

// ---- unavailable, permission, error: a status screen with a retry that recovers
for (const [err, re] of [['org.freedesktop.DBus.Error.ServiceUnknown', /Search is not running/], ['AccessDenied', /needs permission/], ['strange failure', /could not be read/]]) {
    const f = fake(); f.fail = new Error(err);
    const {page, root} = await make(f);
    if (shown(page) !== 'status' || !has(root, re)) fail(`${err}: wrong screen`);
    f.fail = null; need(root, 'hub-retry').emit('clicked'); await settle();
    if (shown(page) !== 'main') fail(`${err}: retry did not recover`);
    page.dispose();
}

// ---- add a rule: validation message first, then applying, then success and the new row
{
    const f = fake();
    const {page, root} = await make(f);
    need(root, 'hub-rule-add').emit('clicked'); await settle();
    if (!has(root, /Write the application/)) fail('no validation message for an empty app');
    if (f.calls.some(c => c[0] === 'notifications.rule')) fail('an invalid rule reached Search');
    need(root, 'hub-rule-app').set_text('org.b');
    need(root, 'hub-rule-verdict').set_selected(2);
    let release; f.gate = new Promise(r => { release = r; });
    need(root, 'hub-rule-add').emit('clicked'); await tick();
    need(root, 'hub-applying');
    if (need(root, 'hub-rule-add').get_sensitive()) fail('Add stays usable while applying');
    release(); await settle();
    eq(f.calls.filter(c => c[0] === 'notifications.rule').map(c => c[1]), [{app: 'org.b', verdict: 'hide'}], 'rule sent');
    need(root, 'hub-rule:org.b');
    if (!has(root, /org\.b: hide/)) fail('no success notice');
    // remove it
    f.gate = null;
    need(root, 'hub-remove:org.b').emit('clicked'); await settle();
    if (named(root, 'hub-rule:org.b')) fail('rule row stays after removal');
    page.dispose();
}

// ---- quiet hours and snooze validation
{
    const f = fake();
    const {page, root} = await make(f);
    need(root, 'hub-quiet-from').set_text('25:00');
    need(root, 'hub-quiet-set').emit('clicked'); await settle();
    if (!has(root, /HH:MM in 24 hours/)) fail('no quiet validation');
    need(root, 'hub-quiet-from').set_text('22:00'); need(root, 'hub-quiet-to').set_text('07:00');
    need(root, 'hub-quiet-set').emit('clicked'); await settle();
    if (!has(root, /Quiet from 22:00 to 07:00/)) fail('quiet hours not shown after set');
    need(root, 'hub-quiet-off').emit('clicked'); await settle();
    if (!has(root, /Quiet hours are off/)) fail('quiet hours not cleared');
    need(root, 'hub-snooze-minutes').set_text('9999');
    need(root, 'hub-snooze-go').emit('clicked'); await settle();
    if (!has(root, /1 to 1440 minutes/)) fail('no snooze validation (and no app)');
    need(root, 'hub-snooze-app').set_text('org.a'); need(root, 'hub-snooze-minutes').set_text('30');
    need(root, 'hub-snooze-go').emit('clicked'); await settle();
    eq(f.calls.filter(c => c[0] === 'notifications.snooze').map(c => c[1]), [{app: 'org.a', minutes: 30}], 'snooze sent');
    need(root, 'hub-clear').emit('clicked'); await settle();
    if (!f.calls.some(c => c[0] === 'notifications.clear')) fail('clear not sent');
    page.dispose();
}

// ---- Search refuses: its words are shown; the page stays
{
    const f = fake();
    const {page, root} = await make(f);
    f.outcome = {ok: false, message: '', error: 'at most 50 rules', code: 'failed'};
    need(root, 'hub-rule-app').set_text('org.z');
    need(root, 'hub-rule-add').emit('clicked'); await settle();
    if (!has(root, /at most 50 rules/)) fail('the refusal is not shown');
    page.dispose();
}

// ---- the backend against a stand-in Search on a private bus
let proc;
try {
    proc = Gio.Subprocess.new(['dbus-daemon', '--session', '--nofork', '--print-address=1'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
} catch (_e) { proc = null; }
if (proc) {
    try {
        const address = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}).read_line_utf8(null)[0];
        const XML = `<node><interface name="org.niro.Search"><method name="RunAction"><arg type="s" direction="in" name="id"/><arg type="s" direction="in" name="args_json"/><arg type="s" direction="out" name="outcome_json"/></method></interface></node>`;
        const flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;
        const server = Gio.DBusConnection.new_for_address_sync(address, flags, null, null);
        const client = Gio.DBusConnection.new_for_address_sync(address, flags, null, null);
        const seen = [];
        const exported = Gio.DBusExportedObject.wrapJSObject(XML, {RunAction(id, args) {
            seen.push([id, JSON.parse(args)]);
            return JSON.stringify(id === 'notifications.rule' && JSON.parse(args).app === 'bad' ? {ok: false, code: 'failed', error: 'nope'} : {ok: true, message: 'fine'});
        }});
        exported.export(server, SEARCH_PATH);
        const owner = Gio.bus_own_name_on_connection(server, SEARCH_BUS, Gio.BusNameOwnerFlags.NONE, null, null);
        await tick(200);
        const rulesFile = `${tmp}/rules.json`;
        const backend = new DBusHubBackend(client, rulesFile);
        eq(await backend.run('notifications.rule', {app: 'a', verdict: 'hide'}), {ok: true, message: 'fine', error: '', code: ''}, 'run');
        eq((await backend.run('notifications.rule', {app: 'bad', verdict: 'hide'})).error, 'nope', 'a refusal is an outcome');
        eq(seen[0], ['notifications.rule', {app: 'a', verdict: 'hide'}], 'arguments reach Search as JSON');
        eq(await backend.readRules(), null, 'no rules file');
        GLib.file_set_contents(rulesFile, '{"rules":[]}');
        eq(await backend.readRules(), '{"rules":[]}', 'rules file read');
        Gio.bus_unown_name(owner);
        for (let i = 0; i < 20; i++) await tick(50);
        let threw = null;
        try { await backend.run('notifications.summary', {}); } catch (e) { threw = e; }
        if (!threw || !/ServiceUnknown|NameHasNoOwner|not provided/.test(threw.message)) fail(`a missing Search was not reported as such: ${threw?.message}`);
    } finally { proc.force_exit(); }
} else print('hubPage: no dbus-daemon, backend part skipped');

// ---- Look: an accent that cannot be seen is warned about with ratio and suggestion, and asks; a weak one warns; nothing is changed silently
{
    const model = new Model(ctx);
    const {lookPage} = await import('../../control/build/pages.js');
    const root = lookPage(model);
    const note = need(root, 'look-contrast-note');
    model.binding(model.item('niro.tint')).write('#1C1C1E');
    model.binding(model.item('niro.accent')).write('#30D158');
    if (note.get_visible()) fail('a readable accent shows a warning');
    // a weak accent (3..4.5): warn, written as chosen
    model.binding(model.item('niro.accent')).write('#6A6A6C');
    if (!note.get_visible() || !/:1 on the panel surface #1C1C1E/.test(note.get_subtitle())) fail(`no ratio in the warning: ${note.get_subtitle()}`);
    eq(model.read('niro.accent'), '#6A6A6C', 'a weak accent is not changed');
    // an unreadable accent typed in: asks; "cancel" leaves the old colour, "keep" writes it as typed
    const picker = lookPickers['niro.accent'];
    const bad = '#222224';
    const advice = colorAdvice(bad, '#1C1C1E');
    if (advice?.level !== 'unreadable') fail('the test colour is not unreadable');
    picker.entry.set_text(bad);
    // the default confirmation is a dialog: drive the same path with the gate's own confirm to check both answers
    const asked = [];
    for (const answer of ['cancel', 'suggested', 'keep']) {
        const m2 = new Model(ctx);
        m2.binding(m2.item('niro.tint')).write('#1C1C1E'); m2.binding(m2.item('niro.accent')).write('#30D158');
        const {colorPicker} = await import('../../control/build/components.js');
        const it = m2.item('niro.accent');
        const p = colorPicker(it, m2.binding(it), ctx, true, {own: true, advise: v => colorAdvice(v, '#1C1C1E'), confirm: async a => { asked.push(a.text); return answer; }});
        const result = await p.commit(bad);
        const now = m2.read('niro.accent');
        if (answer === 'cancel' && (result !== 'cancel' || now !== '#30D158')) fail(`cancel changed the colour: ${now}`);
        if (answer === 'suggested' && now !== advice.suggestion) fail(`suggested wrote ${now}`);
        if (answer === 'keep' && now !== bad.toUpperCase()) fail(`keep wrote ${now}`);
    }
    if (asked.length !== 3 || !/:1/.test(asked[0])) fail('the confirmation did not carry the ratio');
    // a readable colour never asks
    {
        const m3 = new Model(ctx);
        const {colorPicker} = await import('../../control/build/components.js');
        const it = m3.item('niro.accent');
        let called = false;
        const p = colorPicker(it, m3.binding(it), ctx, true, {own: true, advise: v => colorAdvice(v, '#1C1C1E'), confirm: async () => { called = true; return 'keep'; }});
        await p.commit('#FFFFFF');
        if (called || m3.read('niro.accent') !== '#FFFFFF') fail('a readable colour asked or was not written');
    }
    for (const [name, a, t] of TONES) if (colorAdvice(a, t)?.level === 'unreadable') fail(`the ${name} tone is unreadable on its own tint`);
}

// ---- the window: Notifications is in System, Connectivity now has its page and heading
{
    const {buildWindow} = await import('../../control/build/window.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlHubTest'});
    app.register(null);
    const {window, shared} = buildWindow(app);
    const row = all(window, w => w instanceof Gtk.ListBoxRow && w.get_name() === 'notifications')[0] ?? fail('Notifications is not in the sidebar');
    const rows = all(row.get_parent(), w => w instanceof Gtk.ListBoxRow && w.get_parent() === row.get_parent()).map(r => r.get_name());
    if (rows.indexOf('notifications') < rows.indexOf('search') || rows.indexOf('notifications') > rows.indexOf('compat')) fail(`Notifications is not between Intelligence and Advanced: ${rows}`);
    if (!/Ctrl\+\d/.test(row.get_tooltip_text() ?? '') && rows.indexOf('notifications') < 9) fail('no Ctrl+N hint in the tooltip');
    const headings = all(window, w => w instanceof Gtk.Label && w.has_css_class('caption-heading')).map(l => l.get_label());
    if (!headings.includes('Connectivity')) fail('Connectivity has a page but no heading');
    if (!shared.hub?.hub) fail('the window has no hub page');
    window.close();
}
print('hubPage: ok');
