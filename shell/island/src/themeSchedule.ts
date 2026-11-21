// @ts-nocheck: GJS imports, as the other island files
// Light by day, dark by night: flips GNOME's own light/dark choice at the two times set in Niro Control (Look › Schedule).
// The times are "HH:MM". Only the moments of change are acted on, so a manual switch in between is left alone until the next one.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isDarkAt, minutesOf} from './themeRules.js';

export class ThemeSchedule {
    private _shared: Gio.Settings | null = null;
    private _iface: Gio.Settings | null = null;
    private _ids: number[] = [];
    private _timer = 0;
    private _last: boolean | null = null;

    constructor() {
        const source = Gio.SettingsSchemaSource.get_default();
        const schema = source?.lookup('org.niro.control', true);
        if (!schema?.has_key('theme-schedule')) return;          // the package (or its newest schemas) is not installed
        this._shared = new Gio.Settings({schema_id: 'org.niro.control'});
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        for (const key of ['theme-schedule', 'theme-light-from', 'theme-dark-from']) this._ids.push(this._shared.connect(`changed::${key}`, () => { this._last = null; this._tick(); }));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => { this._tick(); return GLib.SOURCE_CONTINUE; });
        this._tick();
    }

    private _tick(): void {
        if (!this._shared || !this._iface) return;
        if (!this._shared.get_boolean('theme-schedule')) { this._last = null; return; }
        const now = GLib.DateTime.new_now_local();
        const dark = isDarkAt(now.get_hour() * 60 + now.get_minute(),
            minutesOf(this._shared.get_string('theme-light-from'), 7 * 60), minutesOf(this._shared.get_string('theme-dark-from'), 18 * 60));
        if (dark === this._last) return;                          // no change of period since the last look
        this._last = dark;
        const want = dark ? 'prefer-dark' : 'default';
        if (this._iface.get_string('color-scheme') !== want) this._iface.set_string('color-scheme', want);
    }

    destroy(): void {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
        for (const id of this._ids) this._shared?.disconnect(id);
        this._ids = [];
        this._shared = this._iface = null;
    }
}
