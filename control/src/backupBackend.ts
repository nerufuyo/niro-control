// @ts-nocheck: GLib / Gio are untyped here
// Backup & Restore's real backend: the settings through Gio.Settings (the schemas store.ts opens, so NIRO_SCHEMA_DIR points tests at a
// temporary one), files through Gio with a size limit, and the checksum through GLib.Checksum. Nothing here starts a process, opens a
// socket or reads anything outside the schemas and the one file the user chose. No value is logged.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MAX_BYTES} from './backupLogic.js';
import {Stores} from './store.js';

export class GioSettingsIO {
    constructor(stores = new Stores()) { this._by = stores.by; }

    sources() { return Object.keys(this._by).filter(s => this._by[s]); }

    keys(source) {
        const schema = this._by[source].settings_schema;
        // The dock's record of what it switched off belongs to this machine: not backed up.
        return Object.fromEntries(schema.list_keys().filter(k => k !== 'disabled-system-docks').map(k => [k, schema.get_key(k).get_value_type().dup_string()]));
    }

    read(source, key) { return this._by[source].get_value(key).print(true); }

    _parse(source, key, text) {
        const k = this._by[source].settings_schema.get_key(key);
        const v = GLib.Variant.parse(k.get_value_type(), text, null, null);
        if (!k.range_check(v)) throw new Error('outside the allowed range');
        return v;
    }

    canon(source, key, text) { return this._parse(source, key, text).print(true); }

    writable(source, key) { return this._by[source].is_writable(key); }

    write(source, key, text) {
        if (!this._by[source].set_value(key, this._parse(source, key, text))) throw new Error('the setting is locked');
        Gio.Settings.sync();
    }
}

export const sha256 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);

export class GioFiles {
    read(path) {
        const f = Gio.File.new_for_path(path);
        let size;
        try { size = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size(); } catch (e) { throw new Error(`cannot read ${path}: ${e.message}`); }
        if (size > MAX_BYTES) throw new Error('the file is larger than 1 MB');
        return new TextDecoder().decode(f.load_contents(null)[1]);
    }

    /** Replaces atomically; the file is readable by its owner only (it describes this desktop). */
    write(path, text) {
        const f = Gio.File.new_for_path(path);
        const out = f.replace(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try { out.write_all(new TextEncoder().encode(text), null); out.close(null); } catch (e) { try { out.close(null); } catch (_e) { /* ignore */ } throw e; }
    }
}

export function realEnv(appVersion = 'unknown') {
    return {settings: new GioSettingsIO(), hash: sha256, appVersion, now: () => new Date().toISOString()};
}

/** The installed version, when the package says (control/VERSION next to the scripts), else 'unknown'. */
export function appVersion() {
    try {
        const dir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
        return new TextDecoder().decode(Gio.File.new_for_path(`${dir}/VERSION`).load_contents(null)[1]).trim() || 'unknown';
    } catch (_e) { return 'unknown'; }
}
