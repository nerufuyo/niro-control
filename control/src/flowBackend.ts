// @ts-nocheck: GLib / Gio are untyped here
// Niro Flow's backend: org.niro.Flow1 on the session bus, object /org/niro/island/Daemon (the Niro daemon). Every call is asynchronous, so a
// slow or absent daemon never freezes the panel, and none starts the daemon (NO_AUTO_START): "not running" is an answer, not a side effect.
// What is sent is a workflow the user wrote; what comes back is parsed by flowLogic. No argument or answer is ever logged here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {classifyError, parseActions, parseHistory, parseList, parseTemplates} from './flowLogic.js';

export const FLOW_BUS = 'org.niro.island.Daemon', FLOW_PATH = '/org/niro/island/Daemon', FLOW_IFACE = 'org.niro.Flow1';
const TIMEOUT_MS = 6000;

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

export class DBusFlowBackend {
    constructor(bus = null) {
        this._bus = bus;
    }

    _connection() {
        return this._bus ?? Gio.DBus.session;
    }

    async _call(method, params = null, iface = FLOW_IFACE) {
        try {
            const reply = await this._connection().call(FLOW_BUS, FLOW_PATH, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, null);
            return reply.deepUnpack();
        } catch (e) {
            // the remote error name (org.freedesktop.DBus.Error.ServiceUnknown ...) is kept in front of the text so it can be classified
            throw classifyError(new Error(`${Gio.DBusError.get_remote_error(e) ?? ''} ${e.message}`));
        }
    }

    async _property(name) {
        const [value] = await this._call('Get', new GLib.Variant('(ss)', [FLOW_IFACE, name]), 'org.freedesktop.DBus.Properties');
        return value.deepUnpack();
    }

    async status() {
        return {apiVersion: Number(await this._property('ApiVersion')), enabled: Boolean(await this._property('Enabled'))};
    }

    async list() { return parseList((await this._call('List'))[0]); }
    async templates() { return parseTemplates((await this._call('Templates'))[0]); }
    async knownActions() { return parseActions((await this._call('KnownActions'))[0]); }

    /** Resolves `{ok, problems}`: the daemon's own checking, in its words. */
    async save(workflow) {
        const [ok, problems] = await this._call('Save', new GLib.Variant('(s)', [JSON.stringify(workflow)]));
        let list = [];
        try { list = JSON.parse(problems); } catch (_e) { list = [String(problems)]; }
        return {ok, problems: (Array.isArray(list) ? list : [list]).map(String)};
    }

    async remove(id) { await this._call('Delete', new GLib.Variant('(s)', [id])); }
    async setEnabled(id, on) { await this._call('SetEnabled', new GLib.Variant('(sb)', [id, on])); }
    async setGlobalEnabled(on) { await this._call('SetGlobalEnabled', new GLib.Variant('(b)', [on])); }
    async dryRun(id) {
        const text = (await this._call('DryRun', new GLib.Variant('(ss)', [id, ''])))[0];
        try { return JSON.parse(text); } catch (_e) { throw classifyError(new Error('Flow sent an unreadable preview.')); }
    }
    async runNow(id) { return String((await this._call('RunNow', new GLib.Variant('(s)', [id])))[0]); }
    async cancel(runId) { await this._call('Cancel', new GLib.Variant('(s)', [String(runId)])); }
    async history(id) { return parseHistory((await this._call('History', new GLib.Variant('(s)', [id])))[0]); }
    async clearHistory() { await this._call('ClearHistory'); }
}
