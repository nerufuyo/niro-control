// Permissions and Connectivity: the D-Bus backend against a stand-in Search on a PRIVATE bus (started and stopped here; the real session
// bus and the real Search extension are never touched), the pages against FAKE backends and a fake confirm dialog, and the pages' place in
// the window. Widgets are found by name and text: nothing here was seen on a screen.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
if (!Gtk.init_check()) { print('permissionsPage: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {DBusPermissionsBackend, SEARCH_BUS, SEARCH_PATH} = await import('../../control/build/permissionsBackend.js');
const {DBusConnectivityBackend} = await import('../../control/build/connectivityBackend.js');
const {permissionsPage} = await import('../../control/build/permissionsPage.js');
const {connectivityPage} = await import('../../control/build/connectivityPage.js');
const {PermError} = await import('../../control/build/permissionsLogic.js');
const {Model} = await import('../../control/build/pages.js');

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const named = (root, name) => all(root, w => w.get_name?.() === name)[0] ?? null;
const need = (root, name) => named(root, name) ?? fail(`no widget named ${name}`);
const texts = root => all(root, w => w instanceof Gtk.Label).map(l => l.get_label() ?? '').concat(all(root, w => w instanceof Adw.PreferencesRow || w instanceof Adw.ActionRow || w instanceof Adw.Banner || w instanceof Adw.PreferencesGroup || w instanceof Adw.StatusPage).flatMap(r => [r.get_title?.() ?? '', r.get_subtitle?.() ?? '', r.get_description?.() ?? '']));
const has = (root, re) => texts(root).some(t => re.test(t));
const tick = (ms = 20) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(10); };
const ctx = {toast: () => {}, openLook: () => {}, go: () => {}, inhibitShortcuts: () => {}, takenShortcuts: () => [], window: null};

// ---- the backend against a stand-in Search on a private bus
let proc;
try { proc = Gio.Subprocess.new(['dbus-daemon', '--session', '--nofork', '--print-address=1'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE); } catch (_e) { proc = null; }
let failure = null;
const backendChecks = async () => {
    const address = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}).read_line_utf8(null)[0];
    if (!address) fail('the private bus did not start');
    const XML = `<node><interface name="org.niro.Search">
  <method name="Availability"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="RunAction"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="ListGrants"><arg type="s" direction="out"/></method>
  <method name="Grant"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Revoke"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="PermissionHistory"><arg type="u" direction="in"/><arg type="s" direction="out"/></method>
  <method name="ClearPermissionHistory"><arg type="s" direction="out"/></method>
</interface></node>`;
    const seen = [];
    const impl = {
        Availability: id => JSON.stringify({id, available: id !== 'system.bluetooth.toggle', reason: id === 'system.bluetooth.toggle' ? 'Bluetooth tools are not installed' : null}),
        RunAction: (id, args) => { seen.push(['RunAction', id, args]); return JSON.stringify({ok: true, message: 'Wi-Fi off'}); },
        ListGrants: () => JSON.stringify({enforced: true, grants: [{subject: 'tool', capability: 'file', scope: 'always'}]}),
        Grant: (s, c, sc) => { seen.push(['Grant', s, c, sc]); return JSON.stringify(sc === 'session' ? {ok: false, code: 'declined', error: 'cancelled'} : {ok: true}); },
        Revoke: (s, c) => { seen.push(['Revoke', s, c]); return JSON.stringify({ok: true}); },
        PermissionHistory: limit => { seen.push(['History', limit]); return JSON.stringify([{at: 5, subject: 'tool', capability: 'file', verdict: 'allow', args: {text: 'SECRET'}}]); },
        ClearPermissionHistory: () => { seen.push(['Clear']); return '{"ok":true}'; },
    };
    const flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;
    const server = Gio.DBusConnection.new_for_address_sync(address, flags, null, null), client = Gio.DBusConnection.new_for_address_sync(address, flags, null, null);
    Gio.DBusExportedObject.wrapJSObject(XML, impl).export(server, SEARCH_PATH);
    const owner = Gio.bus_own_name_on_connection(server, SEARCH_BUS, Gio.BusNameOwnerFlags.NONE, null, null);
    const perms = new DBusPermissionsBackend(client), conn = new DBusConnectivityBackend(client);
    const l = await perms.list();
    eq([l.enforced, l.grants.length], [true, 1], 'ListGrants');
    eq(await perms.grant('tool', 'file', 'always'), {ok: true, declined: false, error: ''}, 'Grant');
    eq((await perms.grant('tool', 'file', 'session')).declined, true, 'a declined grant');
    await perms.revoke('tool', 'file');
    const h = await perms.history(100);
    eq(Object.keys(h[0]).sort(), ['at', 'capability', 'subject', 'verdict'], 'history keeps four fields');
    await perms.clearHistory();
    eq(seen.filter(s => s[0] === 'History')[0], ['History', 100], 'unsigned limit');
    eq((await conn.availability('system.bluetooth.toggle')).available, false, 'Availability');
    eq((await conn.run('system.wifi.toggle')).message, 'Wi-Fi off', 'RunAction');
    eq(seen.find(s => s[0] === 'RunAction'), ['RunAction', 'system.wifi.toggle', '{}'], 'no arguments sent');
    Gio.bus_unown_name(owner);
    for (let i = 0; i < 20; i++) await tick(50);
    try { await perms.list(); fail('a missing Search did not throw'); } catch (e) { if (!(e instanceof PermError) || e.kind !== 'unavailable') fail(`a missing Search was ${e.kind}: ${e.message}`); }
};
if (proc) { try { await backendChecks(); } catch (e) { failure = e; } proc.force_exit(); } else print('permissionsPage: no dbus-daemon, backend checks skipped');
if (failure) fail(failure.stack ?? failure.message);

// ---- the Permissions page against a fake backend
const fakePerm = (init = []) => {
    const st = {grants: [...init], calls: []};
    return {st,
        list: async () => ({enforced: false, grants: [...st.grants]}),
        grant: async (s, c, sc) => { st.calls.push(['grant', s, c, sc]); st.grants = st.grants.filter(g => !(g.subject === s && g.capability === c)).concat({subject: s, capability: c, scope: sc}); return {ok: true, declined: false, error: ''}; },
        revoke: async (s, c) => { st.calls.push(['revoke', s, c]); st.grants = st.grants.filter(g => !(g.subject === s && g.capability === c)); return {ok: true, declined: false, error: ''}; },
        history: async () => [{at: Date.now(), subject: 'tool', capability: 'file', verdict: 'deny'}],
        clearHistory: async () => { st.calls.push(['clear']); return {ok: true, declined: false, error: ''}; }};
};
{
    const b = fakePerm([{subject: 'tool', capability: 'file', scope: 'always'}]);
    let asked = 0, answer = false;
    const page = permissionsPage(new Model(ctx), ctx, b, async () => { asked++; return answer; });
    await page.ensure(); await settle();
    const root = page.widget;
    if (page.stack.get_visible_child_name() !== 'main') fail('Permissions did not load');
    need(root, 'perm-grant:tool:file'); need(root, 'perm-history');
    if (!has(root, /Not enforced yet/)) fail('the page does not say the settings are not enforced');
    if (!has(root, /Arguments and content are never recorded/)) fail('the history promise is missing');
    // allowing: the confirmation is asked and refusing it writes nothing
    await page.requestGrant('other', 'network', 'always'); await settle();
    if (asked !== 1 || b.st.calls.length) fail('a refused confirmation still wrote');
    answer = true;
    await page.requestGrant('other', 'network', 'always'); await settle();
    eq(b.st.calls, [['grant', 'other', 'network', 'always']], 'confirmed grant');
    // deny: no confirmation
    asked = 0;
    need(page.widget, 'perm-deny:tool:file').emit('clicked'); await settle();
    if (asked !== 0) fail('deny asked for a confirmation');
    eq(b.st.calls.at(-1), ['grant', 'tool', 'file', 'deny'], 'deny went straight through');
    need(page.widget, 'perm-revoke:tool:file').emit('clicked'); await settle();
    eq(b.st.calls.at(-1), ['revoke', 'tool', 'file'], 'revoke');
    need(page.widget, 'perm-clear').emit('clicked'); await settle();
    eq(b.st.calls.at(-1), ['clear'], 'clear history');
    page.dispose();
}
{   // Search not running
    const bad = {list: async () => { throw new PermError('unavailable', 'Niro Search is not running'); }, history: async () => []};
    const page = permissionsPage(new Model(ctx), ctx, bad, async () => true);
    await page.ensure(); await settle();
    if (page.stack.get_visible_child_name() !== 'status' || !has(page.widget, /Niro Search is not running/)) fail('absent Search is not shown');
    page.dispose();
}

// ---- the Connectivity page
{
    const ran = [];
    const b = {availability: async id => id === 'system.bluetooth.toggle' ? {available: false, reason: 'Bluetooth tools are not installed'} : {available: true, reason: null},
        run: async id => { ran.push(id); return {ok: true, message: 'Wi-Fi off', code: '', error: ''}; }};
    let answer = false;
    const page = connectivityPage(new Model(ctx), ctx, b, async () => answer);
    await page.ensure(); await settle();
    const root = page.widget;
    if (!has(root, /Not available: Bluetooth tools are not installed/)) fail('unavailable reason not shown');
    if (need(root, 'conn-toggle-bluetooth').get_sensitive()) fail('an unavailable switch is usable');
    if (!has(root, /Search has no read-only action/)) fail('the limits are not stated');
    need(root, 'conn-toggle-wifi').emit('clicked'); await settle();
    if (ran.length) fail('a refused confirmation ran the action');
    answer = true;
    need(root, 'conn-toggle-wifi').emit('clicked'); await settle();
    eq(ran, ['system.wifi.toggle'], 'confirmed toggle');
    if (!has(root, /Wi-Fi off/)) fail('the answer is not shown');
    page.dispose();
}

// ---- the window: Permissions in System (after Backup, before About), Connectivity in its own group, neither among the first nine
{
    const {buildWindow} = await import('../../control/build/window.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlPermissionsTest'});
    app.register(null);
    const {window, shared} = buildWindow(app);
    const row = all(window, w => w instanceof Gtk.ListBoxRow && w.get_name() === 'permissions')[0] ?? fail('Permissions is not in the sidebar');
    const rows = all(row.get_parent(), w => w instanceof Gtk.ListBoxRow && w.get_parent() === row.get_parent()).map(r => r.get_name());
    if (rows.indexOf('permissions') < rows.indexOf('backup') || rows.indexOf('permissions') > rows.indexOf('about')) fail(`not in System: ${rows}`);
    if (rows.indexOf('connectivity') < rows.indexOf('about')) fail(`Connectivity is not after System: ${rows}`);
    if (rows.indexOf('permissions') < 9 || rows.indexOf('connectivity') < 9) fail('a page moved into the first nine (Ctrl+N would shift)');
    if (!shared.permissions?.flow || !shared.connectivity?.flow) fail('the window lacks the pages');
    window.close();
}
print('permissionsPage: ok');
