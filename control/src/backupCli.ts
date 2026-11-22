// @ts-nocheck: Gio / GLib are untyped here
// Backup & Restore without the window. Nothing runs by itself; every command is typed.
//   niro-control --backup-export <file>           write the Niro settings to a JSON file (secrets left out; see --backup-help)
//   niro-control --backup-preview <file>          what importing <file> would change, key by key; writes nothing (exit 1 when refused)
//   niro-control --backup-import <file> [--yes]   import it: write, read back, and put everything back if any key fails. Without --yes
//                                                 it only previews and exits 2.
//   niro-control --backup-help                    what is and is not included
import {appVersion, GioFiles, realEnv} from './backupBackend.js';
import {applyPlan, EXCLUSIONS, exportSettings, MAX_BYTES, parseBackup, planImport, shortValue, SOURCES} from './backupLogic.js';

const HELP = `niro-control backup: export and restore the Niro settings

  --backup-export <file>          write the settings of ${SOURCES.map(s => s[0]).join(', ')} (those installed) to <file> (mode 0600)
  --backup-preview <file>         show what an import would change; writes nothing
  --backup-import <file> [--yes]  import (without --yes: preview only, exit 2); it writes, reads each key back, and restores the
                                  previous values if a write or the read-back fails
  --backup-help                   this text

Left out, always:
${EXCLUSIONS.map(e => `  - ${e}`).join('\n')}

An import refuses the whole file when it has an unknown key, a value of the wrong type or range, a secret-looking entry, a newer
format, a damaged checksum, or is larger than ${MAX_BYTES / 1024} KB. Sources whose extension is not installed are skipped.
`;

export function backupCli(args: string[]): number | null {
    const flag = args.find(a => /^--backup-(export|preview|import|help)$/.test(a));
    if (!flag) return null;
    if (flag === '--backup-help') { print(HELP); return 0; }
    const file = args[args.indexOf(flag) + 1];
    if (!file || file.startsWith('--')) { printerr(`${flag} needs a file.`); return 2; }
    const env = realEnv(appVersion());
    const files = new GioFiles();
    try {
        if (flag === '--backup-export') {
            const r = exportSettings(env);
            if (!r.ok) { printerr(r.error); return 1; }
            files.write(file, r.text);
            print(`Exported ${r.keys} settings from ${r.groups} group(s) to ${file}.`);
            if (r.excluded.length) print(`Left out as secret-looking: ${r.excluded.join(', ')}`);
            if (r.unsupported.length) print(`Not exportable: ${r.unsupported.join(', ')}`);
            return 0;
        }
        const parsed = parseBackup(files.read(file), env);
        if (!parsed.ok) { printerr(parsed.error); return 1; }
        const plan = planImport(parsed.entries, env);
        for (const p of plan.problems) printerr(`refused: ${p}`);
        for (const c of plan.changes) print(`${c.id}: ${shortValue(c.before)} -> ${shortValue(c.after)}`);
        print(`${plan.changes.length} to change, ${plan.unchanged} already the same${plan.skipped.length ? `, skipped (not installed): ${plan.skipped.join(', ')}` : ''}.`);
        if (!plan.ok) { printerr('Nothing was written: the backup was refused.'); return 1; }
        if (flag === '--backup-preview') return 0;
        if (!args.includes('--yes')) { printerr('Run again with --yes to import.'); return 2; }
        const r = applyPlan(plan, env);
        if (!r.ok) { printerr(`Import failed: ${r.error}. ${r.restoreFailed?.length ? `Could not put back: ${r.restoreFailed.join(', ')}` : 'Everything was put back.'}`); return 1; }
        print(`Imported: ${r.written} setting(s) changed.`);
        return 0;
    } catch (e) {
        printerr(e.message);
        return 1;
    }
}
