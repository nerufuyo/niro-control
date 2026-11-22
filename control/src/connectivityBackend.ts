// @ts-nocheck: GLib / Gio are untyped here
// Connectivity's backend: Search's Availability and RunAction over org.niro.Search (see permissionsBackend.SearchBus). It only runs the three
// toggle actions the logic names; no command is built here and no argument is sent.
import GLib from 'gi://GLib';

import {parseAvailability, parseOutcome} from './connectivityLogic.js';
import {SearchBus} from './permissionsBackend.js';

const RUN_TIMEOUT_MS = 120000;     // an on-screen confirmation may be waiting

export class DBusConnectivityBackend {
    constructor(bus = null) { this._search = new SearchBus(bus); }

    async availability(actionId) { return parseAvailability((await this._search.call('Availability', new GLib.Variant('(s)', [actionId])))[0]); }
    async run(actionId) { return parseOutcome((await this._search.call('RunAction', new GLib.Variant('(ss)', [actionId, '{}']), RUN_TIMEOUT_MS))[0]); }
}
