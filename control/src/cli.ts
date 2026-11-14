// @ts-nocheck: GLib is untyped here
// Command line for the engine, without a window: used by the application search and by scripts.
//   niro-control --list-profiles           one JSON object per line: id, name, description, builtin, active
//   niro-control --apply-profile <id>      applies it; prints what changed; exit 1 on failure (nothing is left half-applied)
//   niro-control --restore-backup latest   puts back the newest backup (made before every apply): the undo
//   niro-control --current-profile         the active profile's id, and "modified" when settings were changed by hand
import {ProfileEngine} from './profiles.js';
import {Stores} from './store.js';

/** Returns the exit code, or null when the arguments are not for the command line. */
export function runCli(args: string[]): number | null {
    const flag = args.find(a => /^--(list-profiles|apply-profile|current-profile|restore-backup)$/.test(a));
    if (!flag) return null;
    const engine = new ProfileEngine(new Stores());
    if (flag === '--list-profiles') {
        const active = engine.active();
        for (const p of engine.list())
            print(JSON.stringify({id: p.id, name: p.name, description: p.description, builtin: Boolean(p.builtin), active: p.id === active}));
        return 0;
    }
    if (flag === '--current-profile') {
        const id = engine.active();
        print(id ? `${id}${engine.modifications().length ? ' modified' : ''}` : 'none');
        return 0;
    }
    if (flag === '--restore-backup') {
        const newest = engine.backups()[0];
        if (!newest) { printerr('No backups yet.'); return 2; }
        const r = engine.restore(newest.file);
        if (!r.ok) { printerr(`Could not restore: ${r.failed.title}: ${r.failed.error}`); return 1; }
        print(`Restored "${newest.label}": ${r.changed.length} setting(s) changed`);
        return 0;
    }
    const id = args[args.indexOf(flag) + 1];
    if (!id || !engine.get(id)) {
        printerr(`No profile "${id ?? ''}". Try --list-profiles.`);
        return 2;
    }
    const result = engine.apply(id);
    if (!result.ok) {
        printerr(`Could not apply "${id}": ${result.failed.title}: ${result.failed.error}. ${result.rolledBack ? 'Nothing was changed.' : 'Some settings could not be put back.'}`);
        return 1;
    }
    print(`Applied "${id}": ${result.changed.length} setting(s) changed`);
    return 0;
}
