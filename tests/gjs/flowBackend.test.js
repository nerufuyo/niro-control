// Niro Flow's D-Bus backend against a stand-in daemon on a PRIVATE bus (a dbus-daemon this test starts and stops itself; the real session bus
// and the real daemon are never touched). Checks that every method is called with the right shape and that failures are classified.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const {DBusFlowBackend, FLOW_BUS, FLOW_PATH} = await import('../../control/build/flowBackend.js');
const {FlowError, createFlow} = await import('../../control/build/flowLogic.js');

let proc;
try {
    proc = Gio.Subprocess.new(['dbus-daemon', '--session', '--nofork', '--print-address=1'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
} catch (_e) {
    print('flowBackend: no dbus-daemon, skipped');
    imports.system.exit(0);
}
const address = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}).read_line_utf8(null)[0];
if (!address) { proc.force_exit(); fail('the private bus did not start'); }

const XML = `<node><interface name="org.niro.Flow1">
  <property name="ApiVersion" type="u" access="read"/><property name="Enabled" type="b" access="read"/>
  <method name="SetGlobalEnabled"><arg type="b" direction="in"/></method>
  <method name="List"><arg type="s" direction="out"/></method>
  <method name="Save"><arg type="s" direction="in"/><arg type="b" direction="out"/><arg type="s" direction="out"/></method>
  <method name="Delete"><arg type="s" direction="in"/></method>
  <method name="SetEnabled"><arg type="s" direction="in"/><arg type="b" direction="in"/></method>
  <method name="DryRun"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="RunNow"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Cancel"><arg type="s" direction="in"/></method>
  <method name="History"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="ClearHistory"/>
  <method name="Templates"><arg type="s" direction="out"/></method>
  <method name="KnownActions"><arg type="s" direction="out"/></method>
</interface></node>`;
const seen = [];
const impl = {
    ApiVersion: 1, Enabled: false,
    SetGlobalEnabled(on) { seen.push(['SetGlobalEnabled', on]); this.Enabled = on; },
    List() { return JSON.stringify({api: 1, flow_enabled: this.Enabled, workflows: [{id: 'a', name: 'A', enabled: true, trigger: {type: 'manual'}, steps: []}], problems: []}); },
    Save(json) { seen.push(['Save', JSON.parse(json).id]); return JSON.parse(json).id === 'bad' ? [false, JSON.stringify(['step "a1": "id" is required'])] : [true, '[]']; },
    Delete(id) { seen.push(['Delete', id]); if (id === 'missing') throw new GLib.Error(Gio.DBusError, Gio.DBusError.FAILED, `no workflow "${id}"`); },
    SetEnabled(id, on) { seen.push(['SetEnabled', id, on]); },
    DryRun(id, vars) { seen.push(['DryRun', id, vars]); return JSON.stringify({ok: true, problems: [], registry: 'ok', flow_enabled: true, workflow: id, steps: []}); },
    RunNow(id) { seen.push(['RunNow', id]); return '7'; },
    Cancel(run) { seen.push(['Cancel', run]); },
    History() { return '[{"id":7,"workflow_id":"a","status":"ok","started_ms":1,"steps":[]}]'; },
    ClearHistory() { seen.push(['ClearHistory']); },
    Templates() { return '[{"id":"t","title":"T","workflow":{"id":"t"}}]'; },
    KnownActions() { return JSON.stringify({ok: true, actions: [{id: 'profile.apply', title: 'Apply', permission: 'none', available: true, params: [], capability: 'settings', flow_can_run: true}]}); },
};

const flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;
const server = Gio.DBusConnection.new_for_address_sync(address, flags, null, null);
const client = Gio.DBusConnection.new_for_address_sync(address, flags, null, null);
const exported = Gio.DBusExportedObject.wrapJSObject(XML, impl);
exported.export(server, FLOW_PATH);
const owner = Gio.bus_own_name_on_connection(server, FLOW_BUS, Gio.BusNameOwnerFlags.NONE, null, null);

const backend = new DBusFlowBackend(client);
let failure = null;
const main = async () => {
    eq(await backend.status(), {apiVersion: 1, enabled: false}, "status");
    await backend.setGlobalEnabled(true);
    eq((await backend.status()).enabled, true, 'the switch reads back');
    const l = await backend.list();
    eq([l.api, l.enabled, l.workflows.map(w => w.id)], [1, true, ['a']], 'list');
    eq(await backend.save({id: 'ok'}), {ok: true, problems: []}, 'save ok');
    eq(await backend.save({id: 'bad'}), {ok: false, problems: ['step "a1": "id" is required']}, 'save refused, in the daemon\'s words');
    await backend.setEnabled('a', false); await backend.remove('a');
    eq((await backend.dryRun('a')).workflow, 'a', 'dry run');
    eq(await backend.runNow('a'), '7', 'run id'); await backend.cancel('7');
    eq((await backend.history('a'))[0].status, 'ok', 'history'); await backend.clearHistory();
    eq((await backend.templates())[0].id, 't', 'templates');
    eq((await backend.knownActions()).actions[0].canRun, true, 'known actions');
    eq(seen.filter(s => s[0] === 'SetEnabled')[0], ['SetEnabled', 'a', false], 'bool argument');
    eq(seen.filter(s => s[0] === 'DryRun')[0], ['DryRun', 'a', ''], 'dry run asks for the current context');
    // the daemon refuses a call: a plain error, with its sentence
    try { await backend.remove('missing'); fail('a failing call did not throw'); } catch (e) {
        if (!(e instanceof FlowError) || e.kind !== 'error' || !/no workflow "missing"/.test(e.message)) fail(`wrong error: ${e.kind} ${e.message}`);
    }
    // the controller on top of the real backend: the whole panel flow
    const flow = createFlow(backend);
    await flow.refresh();
    eq([flow.state.view, flow.state.workflows.length, flow.state.templates.length, flow.state.actions.length], ['ready', 1, 1, 1], 'controller state');
    // the daemon goes away: not running, never started
    Gio.bus_unown_name(owner);
    for (let i = 0; i < 20; i++) { await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; })); }
    try { await backend.status(); fail('a missing daemon did not throw'); } catch (e) {
        if (!(e instanceof FlowError) || e.kind !== 'unavailable') fail(`a missing daemon was ${e.kind}: ${e.message}`);
    }
    await flow.refresh();
    eq(flow.state.view, 'unavailable', 'the controller shows "not running"');
    print('flowBackend: ok');
};
try { await main(); } catch (e) { failure = e; }
proc.force_exit();
if (failure) fail(failure.stack ?? failure.message);
