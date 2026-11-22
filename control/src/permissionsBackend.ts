// @ts-nocheck: GLib / Gio are untyped here
// Permissions' backend: org.niro.Search on the session bus (object /org/niro/Search), the Search extension of the shell. Every call is
// asynchronous with a timeout, and none starts anything (NO_AUTO_START): "Search is not running" is an answer, not a side effect.
// Grant waits for the on-screen confirmation Search shows, so its timeout is long. No argument or answer is ever logged here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {classifyError, parseGrants, parseHistory, parseOutcome} from './permissionsLogic.js';

export const SEARCH_BUS = 'org.niro.Search', SEARCH_PATH = '/org/niro/Search', SEARCH_IFACE = 'org.niro.Search';
const TIMEOUT_MS = 6000, CONFIRM_TIMEOUT_MS = 120000;

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

/** One call to Search; the error is classified. Shared with the Connectivity page. */
export class SearchBus {
    constructor(bus = null) { this._bus = bus; }

    async call(method, params = null, timeout = TIMEOUT_MS) {
        try {
            const reply = await (this._bus ?? Gio.DBus.session).call(SEARCH_BUS, SEARCH_PATH, SEARCH_IFACE, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, timeout, null);
            return reply.deepUnpack();
        } catch (e) {
            throw classifyError(new Error(`${Gio.DBusError.get_remote_error(e) ?? ''} ${e.message}`));
        }
    }
}

export class DBusPermissionsBackend {
    constructor(bus = null) { this._search = new SearchBus(bus); }

    async list() { return parseGrants((await this._search.call('ListGrants'))[0]); }
    async grant(subject, capability, scope) {
        return parseOutcome((await this._search.call('Grant', new GLib.Variant('(sss)', [subject, capability, scope]), scope === 'deny' ? TIMEOUT_MS : CONFIRM_TIMEOUT_MS))[0]);
    }
    async revoke(subject, capability) { return parseOutcome((await this._search.call('Revoke', new GLib.Variant('(ss)', [subject, capability])))[0]); }
    async history(limit) { return parseHistory((await this._search.call('PermissionHistory', new GLib.Variant('(u)', [limit])))[0]); }
    async clearHistory() { return parseOutcome((await this._search.call('ClearPermissionHistory'))[0]); }
}
