// @ts-nocheck: GLib is untyped here
// niro-tile: the tiling from a terminal. It shares its backend with the panel.
//
//   niro-tile state [--json]                       the layout, workspaces, monitors and windows now
//   niro-tile layouts [--json]                     the ten layouts
//   niro-tile apply <layout> [--workspace N] [--monitor N]   a layout for the general setting, one workspace (from 1) or one monitor (from 0)
//   niro-tile clear [--workspace N] [--monitor N]  take a workspace's or a monitor's own layout away
//   niro-tile on | off | toggle                    tiling on or off
//   niro-tile profile list | save <name> | load <name> | delete <name> | export <name> <file> | import <file>
//   niro-tile rules check [file]                   check the advanced window rules (or a JSON file of rules), list conflicts (exit 1 when invalid)
//   niro-tile rules apply [--yes]                  run the advanced rules over the windows already open (preview only without --yes; the engine must be on)
//   niro-tile rules dry-run [--app ID] [--title T] [--workspace N] [--monitor N] [--type T] [--rules file]   what the rules would do to such a window; applies nothing
//   niro-tile groups list | create <name> [--window ID] | add <group> [--window ID] | remove <group> --window ID | rename <group> <name>
//                    | delete <group> | remember <group> | activate <group> [--preview] | restore <group> [--preview]
//   niro-tile snapshots take [name] [--pin] | list | delete <id> | pin <id> | unpin <id> | diff <id> [<id>] | plan <id> | restore <id> [--yes] | launch <id> <app> | retain [--max N] [--days N]
//   niro-tile monitors [status] | monitors recovery on|off   monitors, and moving windows back when a monitor returns (off by default)
//   niro-tile validate [file]                      check a profile file, or the settings as they are
//   niro-tile reset [--yes]                        the managed settings back at their defaults (a backup is made first)
//   niro-tile undo                                 put back the settings as they were before the last change
//   niro-tile doctor [--json]                      what works and what does not (exit 1 when something does not)
import Gio from 'gi://Gio';
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
  rules check [file]        check the advanced window rules, and where they disagree
  rules apply [--yes]       preview what the advanced rules would change in the windows now open; --yes applies it (once, nothing repeats)
  rules dry-run [--app ID] [--title T] [--workspace N] [--monitor N] [--type T] [--rules file]
                            what the rules would do to such a window (nothing is applied)
  groups list | create <name> [--window ID] | add <group> [--window ID] | remove <group> --window ID | rename <group> <name>
         | delete <group> | remember <group> | activate <group> [--preview] | restore <group> [--preview]
                            named sets of windows (window ids: see \`state\`; without --window the focused window)
  snapshots take [name] [--pin] | list | delete <id> | pin <id> | unpin <id> | diff <id> [<id>] | plan <id>
         | restore <id> [--yes] | launch <id> <app> | retain [--max N] [--days N]
                            where windows were; restore shows a preview unless --yes, moves running windows only, closes nothing
  monitors [status]         the monitors and what the recovery remembers
  monitors recovery on|off  move windows off a monitor that leaves, and back when it returns (off by default)
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

const text = (args, name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
    return args[i + 1];
};

const readFile = file => {
    try { return new TextDecoder().decode(Gio.File.new_for_path(file).load_contents(null)[1]); } catch (e) { throw new Error(`Cannot read ${file}: ${e.message}`); }
};

const describeActions = a => Object.entries(a).map(([k, v]) => `${k}=${v}`).join(', ');

const windowOption = args => { const v = option(args, '--window'); return v === null ? 0 : v; };
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const itemLine = i => `  ${i.action.padEnd(11)} ${i.appId ?? '-'}${i.title ? `  "${i.title}"` : ''}${i.workspace ? `  -> workspace ${i.workspace}, monitor ${i.monitor}` : ''}${i.noop ? '  (already there)' : ''}${i.reason ? `  (${i.reason})` : ''}${i.note ? `  (${i.note})` : ''}`;

function groupsCommand(backend, rest, json) {
    const [sub, ...a] = rest;
    const need = (v, what) => { if (!v) throw new Error(`${sub} needs ${what}`); return v; };
    let r;
    switch (sub) {
    case undefined: case 'list': {
        const all = backend.groups();
        if (json) return print(JSON.stringify(all, null, 1)) ?? 0;
        if (!all.length) print('no groups');
        for (const g of all) {
            print(`${g.id}  "${g.name}"  ${g.members.length} window(s)${g.offline ? '' : `, ${g.open} open, ${g.closed} closed`}${g.target ? `  place: workspace ${g.target.workspace ?? '-'}, monitor ${g.target.monitorIndex ?? '-'}` : ''}`);
            for (const m of g.members) print(`    ${m.open ? '*' : ' '} ${m.appId || '-'}  ${m.title}${m.open ? `  (window ${m.windowId})` : g.offline ? '' : '  (closed)'}`);
        }
        return 0;
    }
    case 'create': r = backend.createGroup(need(a[0], 'a name'), windowOption(a) ? [windowOption(a)] : null); break;
    case 'add': r = backend.addToGroup(need(a[0], 'a group'), windowOption(a)); break;
    case 'remove': r = backend.removeFromGroup(need(a[0], 'a group'), need(windowOption(a), '--window ID')); break;
    case 'rename': r = backend.renameGroup(need(a[0], 'a group'), need(a[1], 'a new name')); break;
    case 'delete': r = backend.deleteGroup(need(a[0], 'a group')); break;
    case 'remember': r = backend.rememberGroup(need(a[0], 'a group')); break;
    case 'activate': case 'restore': {
        const preview = a.includes('--preview');
        r = sub === 'activate' ? backend.activateGroup(need(a[0], 'a group'), preview) : backend.restoreGroup(need(a[0], 'a group'), preview);
        if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
        print(`${preview ? 'would move' : 'moved'} ${preview ? r.planned : r.applied.length} window(s)${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.focused ? ', focused' : ''}`);
        for (const c of r.closed) print(`  not open: ${c.appId || '-'}  ${c.title}`);
        for (const f of r.failed) print(`  failed: window ${f.windowId}: ${f.reason}`);
        for (const n of r.notes) print(`  ${n}`);
        return r.failed.length ? 1 : 0;
    }
    default: throw new Error(`unknown groups command "${sub}"`);
    }
    if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
    print(r.deleted ? `deleted ${r.deleted}` : `${r.group.id}  "${r.group.name}"  ${r.group.members.length} window(s), ${r.group.open} open`);
    return 0;
}

function snapshotsCommand(backend, rest, json) {
    const [sub, ...a] = rest;
    const id = () => { if (!a[0] || a[0].startsWith('--')) throw new Error(`${sub} needs a snapshot id (see: niro-tile snapshots list)`); return a[0]; };
    let r;
    switch (sub) {
    case undefined: case 'list':
        r = backend.snapshots();
        if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
        if (!r.snapshots.length) print('no snapshots');
        for (const s of r.snapshots) print(`${s.id}  ${when(s.at)}  ${s.pinned ? 'pinned ' : '       '} ${s.windows} window(s)  ${s.name}`);
        if (r.invalid) print(`(${r.invalid} stored snapshot(s) could not be read and are ignored)`);
        return 0;
    case 'take':
        r = backend.takeSnapshot(a.find(x => !x.startsWith('--')) ?? '', a.includes('--pin'));
        if (!json) print(`saved ${r.snapshot.id}: ${r.windows} window(s)${r.dropped ? `, ${r.dropped} old one(s) dropped` : ''}`);
        break;
    case 'delete': r = backend.deleteSnapshot(id()); if (!json) print(`deleted ${r.deleted}`); break;
    case 'pin': case 'unpin': r = backend.pinSnapshot(id(), sub === 'pin'); if (!json) print(`${r.pinned ? 'pinned' : 'unpinned'} ${r.id}`); break;
    case 'diff': {
        r = backend.diffSnapshots(id(), a[1] && !a[1].startsWith('--') ? a[1] : null);
        if (json) break;
        print(`${r.a.name} against ${r.b === 'now' ? 'the windows now' : r.b.name}: ${r.diff.added.length} added, ${r.diff.removed.length} removed, ${r.diff.moved.length} moved`);
        for (const w of r.diff.added) print(`  + ${w.appId || '-'}  ${w.title ?? ''}`);
        for (const w of r.diff.removed) print(`  - ${w.appId || '-'}  ${w.title ?? ''}`);
        for (const m of r.diff.moved) print(`  ~ ${m.appId}: workspace ${m.from.workspace} monitor ${m.from.monitor} -> workspace ${m.to.workspace} monitor ${m.to.monitor}`);
        break;
    }
    case 'plan': case 'restore': {
        const apply = sub === 'restore' && a.includes('--yes');
        r = sub === 'plan' ? backend.planSnapshot(id()) : backend.restoreSnapshot(id(), apply);
        if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
        print(`${r.snapshot.name}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        for (const i of r.items) print(itemLine(i));
        print(r.note);
        if (apply) {
            print(`moved ${r.applied.length} window(s)${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
            for (const f of r.failed) print(`  failed: window ${f.windowId}: ${f.reason}`);
            if (r.counts.relaunch) print('apps that are not running were not started; start one with: niro-tile snapshots launch <id> <app>');
        } else if (sub === 'restore') {
            print('this was a preview: add --yes to move the windows');
        }
        return r.failed?.length ? 1 : 0;
    }
    case 'launch': r = backend.launchFromSnapshot(id(), a[1] ?? (() => { throw new Error('launch needs an app id'); })()); if (!json) print(`started ${r.launched}`); break;
    case 'retain': r = backend.retainSnapshots(option(a, '--max') ?? 20, option(a, '--days') ?? 30); if (!json) print(`kept ${r.kept}, dropped ${r.dropped}`); break;
    default: throw new Error(`unknown snapshots command "${sub}"`);
    }
    if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
    return 0;
}

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
        case 'rules': {
            const [sub, file] = rest;
            if (sub === 'check') {
                const src = file ? readFile(file) : backend.settings.get_string('advanced-rules');
                const report = backend.rulesReport(src);
                const ok = report.problems.length === 0;
                if (json) return print(JSON.stringify({ok, problems: report.problems, rules: report.rules.length, conflicts: report.conflicts, engine: backend.settings.get_boolean('rules-engine')}, null, 1)) ?? (ok ? 0 : 1);
                for (const p of report.problems) printerr(p);
                if (ok) print(report.rules.length ? `valid: ${report.rules.length} rule(s); the engine is ${backend.settings.get_boolean('rules-engine') ? 'on' : 'off'}` : `no rules; the engine is ${backend.settings.get_boolean('rules-engine') ? 'on' : 'off'}`);
                for (const c of report.conflicts) print(c.kind === 'shadowed' ? `conflict: "${c.b}" can never run: "${c.a}" stops first` : `conflict (${c.certain ? 'certain' : 'possible'}): "${c.a}" and "${c.b}" both set ${c.key}; "${c.a}" wins`);
                return ok ? 0 : 1;
            }
            if (sub === 'apply') {
                const yes = rest.includes('--yes') || Boolean(GLib.getenv('NIRO_TILE_YES'));
                const r = backend.applyRules(yes);
                if (json) return print(JSON.stringify(r, null, 1)) ?? 0;
                for (const w of r.applied) print(`${r.dryRun ? 'would change' : 'changed'} ${w.appId || 'window'} "${w.title}" (#${w.windowId}): ${describeActions(w.actions)}`);
                for (const w of r.skipped) print(`skipped ${w.appId || 'window'} #${w.windowId}: ${w.key ? `${w.key}: ` : ''}${w.reason}`);
                for (const n of r.notes ?? []) print(n);
                if (r.dryRun) print(r.applied.length ? 'Preview only. Run again with --yes to apply it.' : 'Nothing to change.');
                return 0;
            }
            if (sub === 'dry-run') {
                const win = {appId: text(rest, '--app') ?? '', title: text(rest, '--title') ?? '', workspace: option(rest, '--workspace'), monitor: option(rest, '--monitor'), type: text(rest, '--type') ?? 'normal'};
                const rulesFile = text(rest, '--rules');
                const src = rulesFile ? readFile(rulesFile) : backend.settings.get_string('advanced-rules');
                const problems = backend.rulesReport(src).problems;
                if (problems.length) { for (const p of problems) printerr(p); printerr('Invalid rules are left out of the dry run.'); }
                const r = backend.dryRun(win, src);
                if (json) return print(JSON.stringify({...r, problems}, null, 1)) ?? 0;
                print(`${r.ruleCount} rule(s)${r.engineOn ? '' : '; the engine is off, so the shell does not apply them yet'}`);
                for (const t of r.trace) print(`  ${t.matched ? 'match ' : 'no     '} ${t.id}${t.skipped ? `: skipped, ${t.skipped}` : t.why ? `: ${t.why.map(w => `${w.key} ${w.ok ? 'ok' : 'no'}`).join(', ')}` : ''}`);
                print(Object.keys(r.actions).length ? `would do: ${describeActions(r.actions)}` : 'would do: nothing');
                for (const k of r.unsupported) print(`not applied on this system: ${k}`);
                return 0;
            }
            throw new Error('rules: check [file] | apply [--yes] | dry-run [--app ID] [--title T] [--workspace N] [--monitor N] [--type T] [--rules file]');
        }
        case 'groups': return groupsCommand(backend, rest, json);
        case 'snapshots': return snapshotsCommand(backend, rest, json);
        case 'monitors': {
            if (rest[0] === 'recovery') {
                if (rest[1] !== 'on' && rest[1] !== 'off') throw new Error('monitors recovery needs on or off');
                backend.setMonitorRecovery(rest[1] === 'on');
                print(`monitor recovery ${rest[1]}`);
                return 0;
            }
            const s = backend.monitorStatus();
            if (json) return print(JSON.stringify(s, null, 1)) ?? 0;
            print(`Monitor recovery: ${s.enabled ? 'on' : 'off'}`);
            for (const m of s.monitors) print(`  monitor ${m.index}${m.primary ? ' (primary)' : ''}  ${m.key}`);
            for (const [k, n] of Object.entries(s.remembered)) print(`  remembered: ${n} window(s) displaced from ${k}`);
            if (s.last) print(`  last change: ${s.last.relocated} moved off, ${s.last.restored} moved back, ${s.last.failed} failed`);
            return 0;
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
