// @ts-nocheck: Gio / GLib are untyped here
// Recovery without the graphical panel: every appearance switch and the GTK integration from a terminal (or a TTY, or ssh).
//   niro-control --appearance-status             one JSON line: the switches and whether the GTK integration is installed
//   niro-control --appearance-safe-mode on|off   solid surfaces and no effects, whatever else is set
//   niro-control --appearance-global on|off      the global switch of Universal Appearance
//   niro-control --appearance-legacy-fade on|off the old whole-window fade (off is the default)
//   niro-control --appearance-restore-gtk        removes the GTK theme integration; gtk.css files come back byte for byte
//   niro-control --appearance-recover            all of the above to plain: safe mode on, shell surfaces off, old fade off, GTK restored
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {restore, status} from './gtkAdapter.js';
import {Stores} from './store.js';

const KEYS = ['universal-enabled', 'safe-mode', 'legacy-global-fade', 'shell-surfaces', 'affect-gtk', 'affect-shell', 'affect-thirdparty', 'preset'];
const SWITCH = {'--appearance-safe-mode': 'safe-mode', '--appearance-global': 'universal-enabled', '--appearance-legacy-fade': 'legacy-global-fade'};

export const gtkConfigDir = () => GLib.getenv('NIRO_GTK_CONFIG_DIR') ?? GLib.get_user_config_dir();
export const gtkBackupRoot = () => `${GLib.getenv('NIRO_CONFIG_DIR') ?? `${GLib.get_user_config_dir()}/niro-control`}/appearance-backups`;

export function appearanceCli(args: string[]): number | null {
    const flag = args.find(a => /^--appearance-/.test(a));
    if (!flag) return null;
    const settings = new Stores().by.niro;
    if (!settings) { printerr('The Niro Control settings schema is not installed.'); return 1; }
    const done = () => Gio.Settings.sync();
    if (flag === '--appearance-status') {
        const s = status(gtkConfigDir(), gtkBackupRoot());
        print(JSON.stringify({...Object.fromEntries(KEYS.map(k => [k, settings.get_value(k).unpack()])), 'gtk-integration': s.installed, 'gtk-backups': s.backups.length}));
        return 0;
    }
    if (flag === '--appearance-restore-gtk') {
        const removed = restore(gtkConfigDir());
        print(removed.length ? `GTK integration removed (${removed.length} file(s) changed or deleted)` : 'The GTK integration was not installed');
        return 0;
    }
    if (flag === '--appearance-recover') {
        settings.set_boolean('safe-mode', true); settings.set_boolean('shell-surfaces', false); settings.set_boolean('legacy-global-fade', false);
        let removed = 0;
        try { removed = restore(gtkConfigDir()).length; } catch (e) { printerr(`GTK integration not removed: ${e.message}`); done(); return 1; }
        done();
        print(`Recovered: safe mode on, shell surfaces off, old fade off, GTK integration removed (${removed} file(s)). Log out and in for the shell to drop its stylesheet; restart applications for GTK.`);
        return 0;
    }
    const key = SWITCH[flag];
    const value = args[args.indexOf(flag) + 1];
    if (!key || !/^(on|off)$/.test(value ?? '')) { printerr(`Usage: ${flag} on|off`); return 2; }
    settings.set_boolean(key, value === 'on'); done();
    print(`${key}: ${value}`);
    return 0;
}
