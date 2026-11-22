// @ts-nocheck: GLib / Gio are untyped here
// Notification Hub's backend: Search's own D-Bus service (org.niro.Search, /org/niro/Search, RunAction). Every call is asynchronous and none
// starts Search (NO_AUTO_START): "not running" is an answer. The rules are read from the file Search keeps (read only, application ids and
// verdicts); they are never written here, only through the Search actions. No argument and no answer is logged.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseOutcome} from './hubLogic.js';

export const SEARCH_BUS = 'org.niro.Search', SEARCH_PATH = '/org/niro/Search', SEARCH_IFACE = 'org.niro.Search';
const TIMEOUT_MS = 8000;

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export class DBusHubBackend {
    constructor(bus = null, rulesPath = null) {
        this._bus = bus;
        this._rulesPath = rulesPath;
    }

    async run(id, args) {
        try {
            const reply = await (this._bus ?? Gio.DBus.session).call(SEARCH_BUS, SEARCH_PATH, SEARCH_IFACE, 'RunAction',
                new GLib.Variant('(ss)', [id, JSON.stringify(args ?? {})]), null, Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, null);
            return parseOutcome(reply.deepUnpack()[0]);
        } catch (e) {
            throw new Error(`${Gio.DBusError.get_remote_error(e) ?? ''} ${e.message}`);
        }
    }

    async readRules() {
        const path = this._rulesPath ?? `${GLib.get_user_config_dir()}/niro-control/notification-rules.json`;
        try {
            const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
            return new TextDecoder().decode(bytes);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return null;
            throw e;
        }
    }
}
