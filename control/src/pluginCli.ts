// @ts-nocheck: Gio / GLib are untyped here
// niro-plugin: checks a plugin manifest. That is all it does.
//
//   niro-plugin check <dir|manifest.json> [--json]   validate the manifest (a folder means its manifest.json) and list the permissions it asks for
//
// Exit 0 valid, 1 invalid or unreadable, 2 usage. It reads ONE JSON file (64 KB at most). It does not open the entry point, load, import,
// evaluate or start any plugin code, and it does not install anything: Niro has no plugin host (loading third-party code is blocked
// pending a design review). The entry point is checked only as a path string.
import Gio from 'gi://Gio';

import {checkManifestText, formatReport, MAX_MANIFEST_BYTES} from './pluginLogic.js';

export const PLUGIN_HELP = `niro-plugin: check a Niro plugin manifest (validation only)

  check <dir|manifest.json> [--json]   validate the manifest and print the problems and the permissions it asks for
                                       (a folder means <dir>/manifest.json; exit 0 valid, 1 invalid, 2 usage)

This command only READS one JSON file (up to ${MAX_MANIFEST_BYTES / 1024} KB). It never loads, imports or runs plugin code, never opens the
entry point, and installs nothing. There is no plugin host in Niro yet: running third-party plugins is blocked until a design review
approves it, so a valid manifest does not make a plugin runnable.
`;

export function manifestPath(target: string): string {
    const f = Gio.File.new_for_path(target);
    const type = f.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
    return type === Gio.FileType.DIRECTORY ? `${target.replace(/\/+$/, '')}/manifest.json` : target;
}

function readManifest(path: string): string {
    const f = Gio.File.new_for_path(path);
    let size;
    try { size = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size(); } catch (e) { throw new Error(`cannot read ${path}: ${e.message}`); }
    if (size > MAX_MANIFEST_BYTES) throw new Error(`${path} is larger than ${MAX_MANIFEST_BYTES / 1024} KB`);
    return new TextDecoder().decode(f.load_contents(null)[1]);
}

export function runPluginCli(argv: string[]): number {
    const [command, target, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') { print(PLUGIN_HELP); return command ? 0 : 2; }
    if (command !== 'check') { printerr(`Unknown command "${command}".\n${PLUGIN_HELP}`); return 2; }
    if (!target || target.startsWith('--')) { printerr('check needs a folder or a manifest.json.'); return 2; }
    const json = rest.includes('--json');
    try {
        const path = manifestPath(target);
        const report = checkManifestText(readManifest(path));
        if (json) print(JSON.stringify(report, null, 1)); else formatReport(report, path).forEach(l => print(l));
        return report.ok ? 0 : 1;
    } catch (e) {
        printerr(e.message);
        return 1;
    }
}
