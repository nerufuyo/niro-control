// @ts-nocheck: GLib is untyped here
// niro-tile: the tiling from a terminal. It shares its backend with the panel.
//
//   niro-tile state [--json]                       the layout, workspaces, monitors and windows now
//   niro-tile layouts [--json]                     the ten layouts
//   niro-tile apply <layout> [--workspace N] [--monitor N]   a layout for the general setting, one workspace (from 1) or one monitor (from 0)
//   niro-tile clear [--workspace N] [--monitor N]  take a workspace's or a monitor's own layout away
//   niro-tile on | off | toggle                    tiling on or off
//   niro-tile profile list | save <name> | load <name> | delete <name> | export <name> <file> | import <file>
//   niro-tile validate [file]                      check a profile file, or the settings as they are
//   niro-tile reset [--yes]                        the managed settings back at their defaults (a backup is made first)
//   niro-tile undo                                 put back the settings as they were before the last change
//   niro-tile doctor [--json]                      what works and what does not (exit 1 when something does not)
import GLib from 'gi://GLib';

import {LAYOUT_IDS} from './tile/layouts.js';
import {TileBackend} from './tileBackend.js';

const HELP = `niro-tile: window tiling for GNOME (Niro)

  state [--json]            the layout, workspaces, monitors and windows now
  layouts [--json]          the ten layouts: ${LAYOUT_IDS.join(', ')}
  apply <layout> [--workspace N] [--monitor N]
  clear [--workspace N] [--monitor N]
  on | off | toggle
  profile list | save <name> | load <name> | delete <name> | export <name> <file> | import <file>
  validate [file]
  reset [--yes]             the managed settings at their defaults (backup first)
  undo                      back to before the last change
  doctor [--json]           what works and what does not
`;

const option = (args, name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = Number(args[i + 1]);
    if (!Number.isInteger(v)) throw new Error(`${name} needs a number`);
    return v;
};

export function runTileCli(argv) {
    const args = argv.filter(a => a !== '--json');
    const json = argv.includes('--json');
    const [command, ...rest] = args;
    if (!command || command === 'help' || command === '--help')
        return print(HELP) ?? 0;
    const backend = new TileBackend();
    if (!backend.available) {
        printerr('The tiling is not installed (no org.gnome.shell.extensions.tile schema).');
        return 2;
    }
    try {
        switch (command) {
        case 'state': {
            const live = backend.state();
            const state = live ?? {...backend.settingsState(), live: false};
            if (json) return print(JSON.stringify(state, null, 1)) ?? 0;
            print(`Tiling: ${state.enabled ? 'on' : 'off'}    layout: ${state.layout}${live ? '' : '    (the extension is not running: settings only)'}`);
            if (live) {
                for (const m of live.monitors) print(`Monitor ${m.index}${m.primary ? ' (primary)' : ''}: ${m.width}x${m.height} at ${m.x},${m.y}, scale ${m.scale}, layout ${m.layout}, ${m.tiled} tiled`);
                for (const w of live.workspaces) print(`Workspace ${w.index}${w.name ? ` "${w.name}"` : ''}${w.active ? ' *' : ''}: layout ${w.layout}, ${w.windows} window(s)`);
                for (const w of live.windows) print(`  window ${w.id}  ws ${w.workspace}  mon ${w.monitor}  ${w.tiled ? 'tiled ' : w.floating ? 'float ' : 'free  '} ${w.class || '-'}  ${w.title}`);
            }
            return 0;
        }
        case 'layouts': {
            const all = backend.layouts();
            if (json) return print(JSON.stringify(all, null, 1)) ?? 0;
            for (const l of all) print(`${l.id.padEnd(14)} ${l.title}: ${l.description}`);
            return 0;
        }
        case 'apply': {
            if (!rest[0]) throw new Error('apply needs a layout');
            const ok = backend.apply(rest[0], {workspace: option(rest, '--workspace'), monitor: option(rest, '--monitor')});
            if (!ok) throw new Error('the shell refused the layout');
            print(`${rest[0]} applied`);
            return 0;
        }
        case 'clear':
            backend.clear({workspace: option(rest, '--workspace'), monitor: option(rest, '--monitor')});
            print('cleared');
            return 0;
        case 'on': case 'off':
            backend.setEnabled(command === 'on');
            print(`tiling ${command}`);
            return 0;
        case 'toggle':
            backend.setEnabled(!backend.settings.get_boolean('enabled'));
            print(`tiling ${backend.settings.get_boolean('enabled') ? 'on' : 'off'}`);
            return 0;
        case 'profile': {
            const [sub, a, b] = rest;
            if (sub === 'list') {
                const list = backend.profiles();
                if (json) return print(JSON.stringify(list, null, 1)) ?? 0;
                if (!list.length) print('No profiles yet. Save the current layout with: niro-tile profile save <name>');
                for (const p of list) print(`${p.name}\t${p.layout}\t${p.saved}`);
                return 0;
            }
            if (sub === 'save' && a) { print(`saved "${backend.saveProfile(a)}"`); return 0; }
            if (sub === 'load' && a) { const c = backend.loadProfile(a); print(c.length ? `loaded "${a}": ${c.join(', ')} changed` : `loaded "${a}": nothing changed`); return 0; }
            if (sub === 'delete' && a) { backend.deleteProfile(a); print(`deleted "${a}"`); return 0; }
            if (sub === 'export' && a && b) { backend.exportProfile(a, b); print(`written ${b}`); return 0; }
            if (sub === 'import' && a) { print(`imported "${backend.importProfile(a)}"`); return 0; }
            throw new Error('profile: list | save <name> | load <name> | delete <name> | export <name> <file> | import <file>');
        }
        case 'validate': {
            const problems = rest[0] ? (() => { try { backend.readProfile(rest[0]); return []; } catch (e) { return [e.message]; } })() : backend.validate(backend.current());
            if (json) return print(JSON.stringify({ok: problems.length === 0, problems})) ?? (problems.length ? 1 : 0);
            if (!problems.length) { print('valid'); return 0; }
            for (const p of problems) printerr(p);
            return 1;
        }
        case 'reset': {
            if (!rest.includes('--yes') && !GLib.getenv('NIRO_TILE_YES')) { printerr('This puts the layout, gaps, sizes, rules and the floating list back at their defaults. Run again with --yes; `niro-tile undo` goes back.'); return 2; }
            const c = backend.reset();
            print(c.length ? `reset: ${c.join(', ')}` : 'already at the defaults');
            return 0;
        }
        case 'undo':
            print(`undone: ${backend.undo()}`);
            return 0;
        case 'doctor': {
            const checks = backend.doctor();
            if (json) return print(JSON.stringify(checks, null, 1)) ?? (checks.every(c => c.ok) ? 0 : 1);
            for (const c of checks) print(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
            return checks.every(c => c.ok) ? 0 : 1;
        }
        default:
            printerr(`Unknown command "${command}".\n${HELP}`);
            return 2;
        }
    } catch (e) {
        printerr(e.message);
        return 1;
    }
}
