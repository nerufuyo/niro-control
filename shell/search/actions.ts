// @ts-nocheck: GNOME Shell's modules are untyped here
// The actions Niro knows, and the shell-side helpers they and the search share. Everything that touches the desktop is here;
// registry.ts holds the rules.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {Registry} from './registry.js';
import {registerSharedActions} from './sharedActions.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import {qrMatrix, qrPng} from './qrmatrix.js';
import Soup from 'gi://Soup?version=3.0';
import {habitLog, markDone, noteLine, todoLine} from './notes.js';
import {planMoves, type SavedWindow} from './layouts.js';
import {serviceFor, validBase, validEntity} from './homeAssistant.js';
import {autostartOverride, batteryReport, formatRate, netTotals, parseDesktop, parseNeighbours, parseVpns} from './sysinfo.js';

export const PAGES = ['look', 'island', 'dock', 'windows', 'search', 'profiles', 'about'];
const NIRO = () => GLib.find_program_in_path('niro-control');
const CONFIG = `${GLib.get_user_config_dir()}/niro-control`;
const BUILTIN = GLib.getenv('NIRO_BUILTIN_DIR') ?? '/usr/share/niro-control/profiles';

const decoder = new TextDecoder();
export const readJson = (path: string) => JSON.parse(decoder.decode(GLib.file_get_contents(path)[1]));

/** Runs a program; resolves with its output, rejects with its error text (or the exit status). */
export function run(argv: string[], env: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
        for (const [k, v] of Object.entries(env)) launcher.setenv(k, v, true);
        let proc;
        try { proc = launcher.spawnv(argv); } catch (e) { reject(e); return; }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                if (p.get_successful()) resolve((out ?? '').trim());
                else reject(new Error((err || out || `${argv[0]} exited with ${p.get_exit_status()}`).trim()));
            } catch (e) { reject(e); }
        });
    });
}

// ---- What the desktop offers
export function profiles(): {id: string; name: string; description: string; builtin: boolean; active: boolean}[] {
    let active = null;
    try { active = readJson(`${CONFIG}/state.json`).active; } catch (_e) { /* none yet */ }
    const out = [];
    for (const [dir, builtin] of [[BUILTIN, true], [`${CONFIG}/profiles`, false]]) {
        try {
            const it = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
            const names = [];
            for (let i = it.next_file(null); i; i = it.next_file(null)) if (i.get_name().endsWith('.json')) names.push(i.get_name());
            for (const n of names.sort()) {
                try {
                    const p = readJson(`${dir}/${n}`);
                    if (p.format === 'niro-profile' && typeof p.id === 'string' && typeof p.name === 'string' && !out.some(o => o.id === p.id))
                        out.push({id: p.id, name: p.name, description: p.description ?? '', builtin, active: p.id === active});
                } catch (_e) { /* not a profile */ }
            }
        } catch (_e) { /* no such folder */ }
    }
    return out;
}

/** The island's clipboard history (text only): what it keeps in its data folder, newest first. Read only. */
export function clipboardHistory(): {text: string; app: string; at: number}[] {
    try {
        const data = readJson(`${GLib.get_user_data_dir()}/island/clipboard.json`);
        return (data.items ?? []).filter(i => i.clip?.kind === 'text' && typeof i.clip.text === 'string')
            .map(i => ({text: i.clip.text, app: i.app_id ?? '', at: i.at_ms ?? 0})).sort((a, b) => b.at - a.at);
    } catch (_e) {
        return [];
    }
}

export function windows(): {id: number; title: string; app: string; icon: any}[] {
    const tracker = Shell.WindowTracker.get_default();
    return global.get_window_actors().map(a => a.meta_window)
        .filter(w => w && w.get_window_type() === Meta.WindowType.NORMAL && !w.skip_taskbar && !w.get_title()?.startsWith('Niro'))
        .map(w => {
            const app = tracker.get_window_app(w);
            return {id: w.get_id(), title: w.get_title() ?? '', app: app?.get_name() ?? '', icon: app?.get_icon() ?? null};
        });
}

/** Closes `dialog` and answers `fallback` once `seconds` pass with no answer (a caller that has gone must not leave a dialog on the screen). 0 waits for ever. */
function answerByDefault<T>(dialog: any, seconds: number, fallback: T, resolve: (v: T) => void): () => void {
    if (seconds <= 0) return () => {};
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => { try { dialog.close(); } catch (_e) { /* already closed */ } resolve(fallback); return GLib.SOURCE_REMOVE; });
    return () => GLib.source_remove(id);
}

// ---- Asking before something that ends the session
/** `timeoutSeconds` > 0: no answer in that time counts as Cancel and the dialog closes. The default (0) waits, which an action that ends the session wants. */
export function confirm(title: string, question: string, verb: string, timeoutSeconds = 0): Promise<boolean> {
    return new Promise(resolve => {
        const dialog = new ModalDialog({styleClass: 'niro-confirm', destroyOnClose: true});
        dialog.contentLayout.add_child(new St.Label({text: title, style_class: 'niro-confirm-title'}));
        dialog.contentLayout.add_child(new St.Label({text: question, style_class: 'niro-confirm-body'}));
        const stop = answerByDefault(dialog, timeoutSeconds, false, resolve);
        dialog.setButtons([
            {label: 'Cancel', action: () => { stop(); dialog.close(); resolve(false); }, key: 0xff1b},
            {label: verb, action: () => { stop(); dialog.close(); resolve(true); }, default: true},
        ]);
        dialog.open();
    });
}

/** Asks whether a program that called Search over D-Bus may use a kind of thing: 'deny', 'once' or 'always' (Esc denies). */
export function askPermission(subject: string, doing: string, timeoutSeconds = 60): Promise<'deny' | 'once' | 'always'> {
    return new Promise(resolve => {
        const dialog = new ModalDialog({styleClass: 'niro-confirm', destroyOnClose: true});
        dialog.contentLayout.add_child(new St.Label({text: 'A program asks for permission', style_class: 'niro-confirm-title'}));
        dialog.contentLayout.add_child(new St.Label({text: `"${subject}" wants to ${doing}. You can change this later (org.niro.Search Revoke).`, style_class: 'niro-confirm-body'}));
        const stop = answerByDefault<'deny' | 'once' | 'always'>(dialog, timeoutSeconds, 'deny', resolve);
        const answer = (a: 'deny' | 'once' | 'always') => () => { stop(); dialog.close(); resolve(a); };
        dialog.setButtons([
            {label: 'Deny', action: answer('deny'), key: 0xff1b},
            {label: 'Always allow', action: answer('always')},
            {label: 'Allow once', action: answer('once'), default: true},
        ]);
        dialog.open();
    });
}

// ---- The registry
/** Presentation mode keeps the screen awake and the banners away until it is turned off (or the shell stops: the inhibitor goes with its connection). */
let presenting: {cookie: number; hadBanners: boolean} | null = null;
export function endPresentation(): void {
    if (!presenting) return;
    const {cookie, hadBanners} = presenting;
    presenting = null;
    try { Gio.DBus.session.call_sync('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Uninhibit',
        new GLib.Variant('(u)', [cookie]), null, Gio.DBusCallFlags.NONE, 2000, null); } catch (_e) { /* the session is ending */ }
    try { new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}).set_boolean('show-banners', hadBanners); } catch (_e) { /* nothing to put back */ }
}

/** The pointer's spotlight: a soft circle that follows it, for demos. */
let spotlight: {actor: any; timer: number} | null = null;
export function endSpotlight(): void {
    if (!spotlight) return;
    GLib.source_remove(spotlight.timer);
    spotlight.actor.destroy();
    spotlight = null;
}

const readText = (path: string): string | null => { try { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); } catch (_e) { return null; } };
const readNumber = (path: string): number => { const t = readText(path); return t === null ? 0 : Number(t) || 0; };
const sleep = (ms: number) => new Promise<void>(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));

/** The user's autostart entries: their own folder first, then the system's, one per file name. */
export function autostartEntries(): {id: string; name: string; off: boolean; path: string}[] {
    const seen = new Map<string, {id: string; name: string; off: boolean; path: string}>();
    for (const dir of [`${GLib.get_user_config_dir()}/autostart`, ...GLib.get_system_config_dirs().map(d => `${d}/autostart`)]) {
        try {
            const it = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let i = it.next_file(null); i; i = it.next_file(null)) {
                const id = i.get_name();
                if (!id.endsWith('.desktop') || seen.has(id)) continue;
                const entry = parseDesktop(readText(`${dir}/${id}`) ?? '');
                if (entry) seen.set(id, {id, name: entry.name, off: entry.hidden, path: `${dir}/${id}`});
            }
            it.close(null);
        } catch (_e) { /* no such folder */ }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Documents/Niro, where notes, to-dos and habits are kept as plain files. */
export function niroFolder(): string {
    const dir = `${GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir()}/Niro`;
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}
/** Adds one line (it ends with a newline) to a file, after what is there. */
const appendLine = (path: string, line: string) => {
    const old = readText(path);
    const base = old ?? '';
    GLib.file_set_contents(path, `${base}${base === '' || base.endsWith('\n') ? '' : '\n'}${line}`);
};
const today = () => GLib.DateTime.new_now_local().format('%Y-%m-%d');
export const layoutsPath = () => `${GLib.get_user_config_dir()}/niro-search/layouts.json`;
export function savedLayouts(): Record<string, SavedWindow[]> {
    try { return JSON.parse(readText(layoutsPath()) ?? '{}'); } catch (_e) { return {}; }
}
const normalWindows = () => global.get_window_actors().map((a: any) => a.meta_window).filter((w: any) => w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar());

export function buildRegistry() {
    const r = new Registry();
    const needNiro = () => NIRO() ? null : 'Niro Control is not installed';
    const notify = (t, b) => Main.notify(t, b);

    r.register({id: 'app.launch', title: 'Open application', description: 'Starts an installed application', category: 'Applications', keywords: ['launch', 'start', 'run'],
        params: [{name: 'id', type: 'string', required: true, maxLength: 200}], permission: 'none',
        run: async ({id}) => {
            const app = Shell.AppSystem.get_default().lookup_app(id);
            if (!app) throw new Error(`no application "${id}"`);
            app.activate();
            return `Opened ${app.get_name()}`;
        }});
    r.register({id: 'file.open', title: 'Open file', description: 'Opens a file from the home folder in its application', category: 'Files', keywords: ['file', 'open'],
        params: [{name: 'path', type: 'string', required: true, maxLength: 1000}], permission: 'none',
        run: async ({path}) => {
            const home = GLib.get_home_dir();
            if (!path.startsWith(`${home}/`) || path.includes('/../')) throw new Error('only files in the home folder open from here');
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) throw new Error('that file is gone');
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
            return `Opened ${file.get_basename()}`;
        }});
    r.register({id: 'qr.make', title: 'Make a QR code', description: 'Draws the text as a QR code and opens it in Niro Snip', category: 'Tools', keywords: ['qr', 'code'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 1000}], permission: 'none',
        run: async ({text}) => {
            const cells = qrMatrix(text);
            if (!cells) throw new Error('that text is too long for a QR code');
            const dir = `${GLib.get_user_cache_dir()}/niro-search`;
            GLib.mkdir_with_parents(dir, 0o700);
            const path = `${dir}/qr-${Date.now()}.png`;
            GLib.file_set_contents(path, qrPng(cells));
            Gio.Subprocess.new(['niro-snip', path], Gio.SubprocessFlags.NONE);
            return 'QR code opened';
        }});
    r.register({id: 'process.kill', title: 'Stop a process', description: 'Asks a process of yours to quit (TERM)', category: 'System', keywords: ['kill', 'quit', 'matikan'],
        params: [{name: 'pid', type: 'number', required: true, min: 2}, {name: 'name', type: 'string', required: true, maxLength: 80}], permission: 'confirm',
        confirm: 'Stop this process? Unsaved work in it is lost.', ask: ({pid, name}) => `Stop ${name} (process ${pid})? Unsaved work in it is lost.`,
        run: async ({pid, name}) => {
            // the number may be stale: it must still be this name, and the person's own
            const comm = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/comm`)[1]).trim();
            if (comm !== name) throw new Error('that process is gone or has changed');
            await run(['kill', '-TERM', String(pid)]);
            return `Asked ${name} to quit`;
        }});
    r.register({id: 'system.vpn.toggle', title: 'Toggle VPN', description: 'Turns the VPN on (the first one set up) or off', category: 'System', keywords: ['vpn', 'wireguard', 'tunnel'], permission: 'none',
        run: async () => {
            const vpns = parseVpns(await run(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show']));
            if (!vpns.length) throw new Error('no VPN is set up in NetworkManager');
            const up = vpns.filter(v => v.active);
            if (up.length) { for (const v of up) await run(['nmcli', 'connection', 'down', 'id', v.name]); return `VPN off (${up.map(v => v.name).join(', ')})`; }
            await run(['nmcli', 'connection', 'up', 'id', vpns[0].name]);
            return `VPN on (${vpns[0].name})`;
        }});
    r.register({id: 'system.battery.info', title: 'Battery health', description: 'Health, charge cycles and the time left', category: 'System', keywords: ['battery', 'baterai', 'health', 'cycles'], permission: 'none',
        run: async () => {
            const dir = ['BAT0', 'BAT1', 'BAT2'].map(n => `/sys/class/power_supply/${n}`).find(p => readText(`${p}/status`) !== null);
            if (!dir) throw new Error('this computer has no battery');
            const e = readText(`${dir}/energy_full`) !== null;
            const unit = e ? 'energy' : 'charge', rate = e ? 'power_now' : 'current_now';
            const cycles = readText(`${dir}/cycle_count`);
            return batteryReport({fullNow: readNumber(`${dir}/${unit}_full`), fullDesign: readNumber(`${dir}/${unit}_full_design`), now: readNumber(`${dir}/${unit}_now`),
                rate: readNumber(`${dir}/${rate}`), status: (readText(`${dir}/status`) ?? '').trim(), cycles: cycles === null ? null : Number(cycles)});
        }});
    r.register({id: 'system.network.speed', title: 'Network speed now', description: 'Download and upload over one second', category: 'System', keywords: ['network', 'speed', 'bandwidth', 'internet', 'jaringan'], permission: 'none',
        run: async () => {
            const a = netTotals(readText('/proc/net/dev') ?? '');
            await sleep(1000);
            const b = netTotals(readText('/proc/net/dev') ?? '');
            return `Download ${formatRate(b.rx - a.rx)}, upload ${formatRate(b.tx - a.tx)}`;
        }});
    r.register({id: 'system.network.devices', title: 'Devices on the network', description: 'The other devices this computer has talked to lately', category: 'System', keywords: ['network', 'devices', 'lan', 'jaringan', 'perangkat'], permission: 'none',
        run: async () => {
            const list = parseNeighbours(await run(['ip', '-4', 'neigh']));
            if (!list.length) return 'No other devices seen yet';
            return `${list.length} device${list.length === 1 ? '' : 's'}: ${list.slice(0, 6).map(d => d.ip).join(', ')}${list.length > 6 ? '…' : ''}`;
        }});
    r.register({id: 'system.clean.trash', title: 'Empty the trash', description: 'Permanently deletes what is in the trash', category: 'System', keywords: ['trash', 'sampah', 'clean', 'bersihkan'], permission: 'confirm',
        confirm: 'Empty the trash? Its files are deleted for good.', run: async () => { await run(['gio', 'trash', '--empty']); return 'Trash emptied'; }});
    r.register({id: 'system.clean.thumbnails', title: 'Clear the thumbnail cache', description: 'Removes cached previews of pictures and files (they are made again when needed)', category: 'System', keywords: ['cache', 'thumbnails', 'clean', 'bersihkan'], permission: 'confirm',
        confirm: 'Clear the thumbnail cache? Previews are made again when needed.', run: async () => { await run(['rm', '-rf', `${GLib.get_user_cache_dir()}/thumbnails`]); return 'Thumbnail cache cleared'; }});
    r.register({id: 'autostart.toggle', title: 'Turn an autostart entry on or off', description: 'Whether an application starts when you log in', category: 'System', keywords: ['autostart', 'startup', 'login'],
        params: [{name: 'id', type: 'string', required: true, maxLength: 200}], permission: 'none',
        run: async ({id}) => {
            const entry = autostartEntries().find(e => e.id === id);
            if (!entry) throw new Error('that entry is gone');
            const dir = `${GLib.get_user_config_dir()}/autostart`;
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(`${dir}/${id}`, autostartOverride(readText(entry.path) ?? '', !entry.off));
            return `${entry.name} ${entry.off ? 'starts at login again' : 'will not start at login'}`;
        }});
    r.register({id: 'window.above.toggle', title: 'Keep window on top', description: 'Keeps the focused window above the others, or lets it go back', category: 'Windows', keywords: ['above', 'on top', 'pin', 'always'], permission: 'none',
        run: async () => {
            const win = global.display.focus_window;
            if (!win) throw new Error('no window has the focus');
            if (win.is_above()) { win.unmake_above(); return 'The window is no longer kept on top'; }
            win.make_above();
            return 'The window stays on top';
        }});
    r.register({id: 'system.spotlight.toggle', title: 'Pointer spotlight', description: 'A soft circle around the pointer, for demos', category: 'System', keywords: ['spotlight', 'pointer', 'cursor', 'highlight', 'demo'], permission: 'none',
        run: async () => {
            if (spotlight) { endSpotlight(); return 'Pointer spotlight off'; }
            const actor = new St.Widget({style: 'background-color: rgba(255, 214, 0, 0.28); border: 2px solid rgba(255, 214, 0, 0.6); border-radius: 40px;', width: 80, height: 80, reactive: false});
            Main.uiGroup.add_child(actor);
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => { const [x, y] = global.get_pointer(); actor.set_position(x - 40, y - 40); return GLib.SOURCE_CONTINUE; });
            spotlight = {actor, timer};
            return 'Pointer spotlight on';
        }});
    r.register({id: 'system.zoom.toggle', title: 'Screen magnifier', description: 'The GNOME screen magnifier, on or off', category: 'System', keywords: ['zoom', 'magnifier', 'magnify', 'perbesar'], permission: 'none',
        run: async () => {
            const s = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.applications'});
            const on = s.get_boolean('screen-magnifier-enabled');
            s.set_boolean('screen-magnifier-enabled', !on);
            return on ? 'Magnifier off' : 'Magnifier on';
        }});
    r.register({id: 'snip.open', title: 'Open a snip', description: 'Opens a kept screenshot in Niro Snip', category: 'Tools', keywords: ['snip', 'screenshot'],
        params: [{name: 'path', type: 'string', required: true, maxLength: 600}], permission: 'none',
        run: async ({path}) => {
            const dir = `${GLib.get_user_data_dir()}/niro-snip/history/`;
            if (!path.startsWith(dir) || path.includes('..')) throw new Error('only kept snips open from here');
            Gio.Subprocess.new(['niro-snip', path], Gio.SubprocessFlags.NONE);
            return 'Snip opened';
        }});
    r.register({id: 'system.record', title: 'Record the screen', description: 'Opens the desktop screen recorder: pick an area or the whole screen, then start', category: 'System', keywords: ['record', 'screencast', 'video', 'rekam'], permission: 'none',
        run: async () => { Main.screenshotUI.open(1); return 'Screen recorder opened'; }});
    r.register({id: 'note.add', title: 'Save a note', description: 'Adds a line to Documents/Niro/notes.md', category: 'Tools', keywords: ['note', 'catat'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 500}], permission: 'none',
        run: async ({text}) => { appendLine(`${niroFolder()}/notes.md`, noteLine(GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M'), text)); return 'Note saved'; }});
    r.register({id: 'todo.add', title: 'Add a to-do', description: 'Adds an open item to Documents/Niro/todo.md', category: 'Tools', keywords: ['todo', 'tugas'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 300}], permission: 'none',
        run: async ({text}) => { appendLine(`${niroFolder()}/todo.md`, todoLine(text)); return 'To-do added'; }});
    r.register({id: 'todo.done', title: 'Tick off a to-do', description: 'Marks an item of Documents/Niro/todo.md as done', category: 'Tools', keywords: ['todo', 'done'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 300}], permission: 'none',
        run: async ({text}) => {
            const f = `${niroFolder()}/todo.md`;
            const out = markDone(readText(f) ?? '', text);
            if (out === null) throw new Error('that item is no longer open');
            GLib.file_set_contents(f, out);
            return 'Done';
        }});
    r.register({id: 'habit.log', title: 'Log a habit', description: 'Ticks a habit for today in Documents/Niro/habits.tsv', category: 'Tools', keywords: ['habit', 'kebiasaan'],
        params: [{name: 'name', type: 'string', required: true, maxLength: 30}], permission: 'none',
        run: async ({name}) => {
            const f = `${niroFolder()}/habits.tsv`;
            const line = habitLog(readText(f) ?? '', today(), name);
            if (line === null) return `${name}: already done today`;
            appendLine(f, line);
            return `${name}: done for today`;
        }});
    r.register({id: 'ha.call', title: 'Switch something in Home Assistant', description: 'Toggles a light, switch or scene on your Home Assistant', category: 'Home', keywords: ['home assistant', 'light', 'lampu'],
        params: [{name: 'id', type: 'string', required: true, maxLength: 80}], permission: 'confirm',
        confirm: 'Switch this on your Home Assistant?', ask: ({id}) => `Switch ${id} on your Home Assistant?`,
        run: async ({id}) => {
            if (!validEntity(id)) throw new Error('that is not a switchable thing');
            const base = validBase(new Gio.Settings({schema_id: 'org.niro.control'}).get_string('ha-url'));
            const token = readText(`${GLib.get_user_config_dir()}/niro-control/ha-token`)?.trim();
            if (!base || !token) throw new Error('set the Home Assistant address in Niro Control › Search, and put the token in ~/.config/niro-control/ha-token');
            const {domain, service} = serviceFor(id);
            const msg = Soup.Message.new('POST', `${base}/api/services/${domain}/${service}`);
            msg.get_request_headers().append('Authorization', `Bearer ${token}`);
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify({entity_id: id}))));
            const session = new Soup.Session({timeout: 8});
            await new Promise<void>((resolve, reject) => session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s: any, res: any) => {
                try { s.send_and_read_finish(res); if (msg.get_status() >= 300) throw new Error(`Home Assistant answered ${msg.get_status()}`); resolve(); } catch (e) { reject(e); } finally { session.abort(); }
            }));
            return `${id}: done`;
        }});
    r.register({id: 'layout.save', title: 'Save the window layout', description: 'Remembers where the open windows are, under a name', category: 'Windows', keywords: ['layout', 'workspace', 'save'],
        params: [{name: 'name', type: 'string', required: true, maxLength: 24}], permission: 'none',
        run: async ({name}) => {
            const saved: SavedWindow[] = normalWindows().map((w: any) => {
                const f = w.get_frame_rect();
                return {cls: w.get_wm_class() ?? '', x: f.x, y: f.y, w: f.width, h: f.height, ws: w.get_workspace()?.index() ?? 0, max: !!(w.is_maximized?.() ?? (w.maximized_horizontally && w.maximized_vertically))};
            }).filter((w: SavedWindow) => w.cls);
            if (!saved.length) throw new Error('there are no windows to remember');
            const all = savedLayouts();
            all[name] = saved;
            GLib.mkdir_with_parents(`${GLib.get_user_config_dir()}/niro-search`, 0o700);
            GLib.file_set_contents(layoutsPath(), JSON.stringify(all));
            return `Layout "${name}" saved (${saved.length} windows)`;
        }});
    r.register({id: 'layout.restore', title: 'Restore a window layout', description: 'Puts the open windows back where a saved layout had them', category: 'Windows', keywords: ['layout', 'restore'],
        params: [{name: 'name', type: 'string', required: true, maxLength: 24}], permission: 'none',
        run: async ({name}) => {
            const saved = savedLayouts()[name];
            if (!saved) throw new Error(`no layout called "${name}"`);
            const open = normalWindows();
            const moves = planMoves(saved, open.map((w: any) => ({cls: w.get_wm_class() ?? ''})));
            for (const {index, saved: s} of moves) {
                const w = open[index];
                try {
                    if (s.ws < global.workspace_manager.get_n_workspaces()) w.change_workspace_by_index(s.ws, false);
                    try { w.unmaximize(Meta.MaximizeFlags.BOTH); } catch (_e) { w.unmaximize(); }
                    if (s.max) w.maximize(Meta.MaximizeFlags.BOTH);
                    else w.move_resize_frame(false, s.x, s.y, s.w, s.h);
                } catch (_e) { try { w.move_resize_frame(false, s.x, s.y, s.w, s.h); } catch (_e2) { /* leave it */ } }
            }
            return `Layout "${name}": ${moves.length} of ${saved.length} windows placed`;
        }});
    r.register({id: 'window.activate', title: 'Switch to window', description: 'Brings an open window to the front', category: 'Windows', keywords: ['focus', 'switch'],
        params: [{name: 'id', type: 'number', required: true, min: 0}], permission: 'none',
        run: async ({id}) => {
            const win = global.get_window_actors().map(a => a.meta_window).find(w => w.get_id() === id);
            if (!win) throw new Error('that window is gone');
            Main.activateWindow(win);
            return `Switched to ${win.get_title()}`;
        }});
    r.register({id: 'settings.open', title: 'Open Niro Control', description: 'Opens a page of the control panel, or a setting found by name', category: 'Niro', keywords: ['settings', 'preferences', 'control panel'],
        params: [{name: 'page', type: 'enum', required: true, enum: PAGES}, {name: 'query', type: 'string', maxLength: 120}], permission: 'none',
        available: needNiro,
        run: async ({page, query}) => {
            const env = {NIRO_PAGE: page};
            if (query) env.NIRO_SEARCH = query;
            run([NIRO()], env).catch(e => notify('Niro Control', e.message));   // the panel stays open: don't wait for it
            return `Opened ${page}`;
        }});
    r.register({id: 'profile.apply', title: 'Apply profile', description: 'Switches the whole desktop to a saved profile (a backup is made first)', category: 'Niro', keywords: ['profile', 'preset', 'theme', 'mode'],
        params: [{name: 'id', type: 'string', required: true, maxLength: 60}], permission: 'none', available: needNiro,
        run: async ({id}) => {
            const known = profiles().find(p => p.id === id);
            if (!known) throw new Error(`no profile "${id}"`);
            const out = await run([NIRO(), '--apply-profile', id]);
            return out || `Applied ${known.name}`;
        }});
    r.register({id: 'profile.undo', title: 'Undo last profile change', description: 'Puts back the settings saved before the last profile was applied', category: 'Niro', keywords: ['revert', 'restore', 'backup'],
        permission: 'none', available: needNiro, run: async () => run([NIRO(), '--restore-backup', 'latest'])});
    r.register({id: 'clipboard.copy', title: 'Copy text', description: 'Puts text on the clipboard', category: 'Clipboard', keywords: ['copy'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 10000}], permission: 'none',
        run: async ({text}) => { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text); return 'Copied'; }});
    r.register({id: 'system.lock', title: 'Lock screen', description: 'Locks the session', category: 'System', keywords: ['secure', 'away'], permission: 'none',
        available: () => Main.screenShield ? null : 'The screen shield is not available',
        run: async () => { Main.screenShield.lock(true); return 'Locked'; }});
    r.register({id: 'system.dnd.toggle', title: 'Toggle Do Not Disturb', description: 'Hides notification banners, or shows them again', category: 'System', keywords: ['dnd', 'silence', 'notifications', 'focus'], permission: 'none',
        run: async () => {
            const s = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            const on = s.get_boolean('show-banners');          // banners shown now: turning DND on hides them
            s.set_boolean('show-banners', !on);
            return on ? 'Do Not Disturb on' : 'Do Not Disturb off';
        }});
    r.register({id: 'system.presentation.toggle', title: 'Presentation mode', description: 'Keeps the screen awake and hides notification banners, until you turn it off', category: 'System', keywords: ['presentation', 'present', 'demo', 'meeting', 'awake', 'caffeine'], permission: 'none',
        run: async () => {
            if (presenting) { endPresentation(); return 'Presentation mode off'; }
            const reply = Gio.DBus.session.call_sync('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Inhibit',
                new GLib.Variant('(susu)', ['Niro Control', 0, 'Presentation mode', 8]), null, Gio.DBusCallFlags.NONE, 3000, null);   // 8: do not go idle
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            presenting = {cookie: reply.deepUnpack()[0], hadBanners: settings.get_boolean('show-banners')};
            settings.set_boolean('show-banners', false);
            return 'Presentation mode on: the screen stays awake and banners are hidden';
        }});
    r.register({id: 'system.wifi.toggle', title: 'Toggle Wi-Fi', description: 'Turns the Wi-Fi radio off, or on again', category: 'System', keywords: ['wifi', 'wireless', 'network', 'internet'], permission: 'none',
        available: () => GLib.find_program_in_path('nmcli') ? null : 'NetworkManager (nmcli) is not installed',
        run: async () => {
            const on = (await run(['nmcli', 'radio', 'wifi'])) === 'enabled';
            await run(['nmcli', 'radio', 'wifi', on ? 'off' : 'on']);
            return on ? 'Wi-Fi off' : 'Wi-Fi on';
        }});
    r.register({id: 'system.bluetooth.toggle', title: 'Toggle Bluetooth', description: 'Turns Bluetooth off, or on again', category: 'System', keywords: ['bluetooth', 'bt', 'pair'], permission: 'none',
        available: () => GLib.find_program_in_path('bluetoothctl') ? null : 'Bluetooth tools are not installed',
        run: async () => {
            const on = /Powered:\s*yes/.test(await run(['bluetoothctl', 'show']));
            await run(['bluetoothctl', 'power', on ? 'off' : 'on']);
            return on ? 'Bluetooth off' : 'Bluetooth on';
        }});
    r.register({id: 'system.mute.toggle', title: 'Mute or unmute sound', description: 'Silences the speakers, or brings the sound back', category: 'System', keywords: ['mute', 'volume', 'audio', 'silence', 'unmute'], permission: 'none',
        available: () => GLib.find_program_in_path('wpctl') ? null : 'PipeWire tools (wpctl) are not installed',
        run: async () => {
            await run(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
            return /MUTED/.test(await run(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'])) ? 'Sound muted' : 'Sound on';
        }});
    r.register({id: 'system.nightlight.toggle', title: 'Toggle Night Light', description: 'Warms the screen colours, or turns it off', category: 'System', keywords: ['night light', 'warm', 'blue light', 'eyes'], permission: 'none',
        run: async () => {
            const s = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
            const on = !s.get_boolean('night-light-enabled');
            s.set_boolean('night-light-enabled', on);
            return on ? 'Night Light on' : 'Night Light off';
        }});
    r.register({id: 'system.snip', title: 'Snip and edit a screenshot', description: 'Takes a screenshot, then opens it to draw on, add text or hide parts', category: 'System', keywords: ['snipping', 'screenshot', 'capture', 'annotate', 'edit', 'markup'], permission: 'none',
        available: () => GLib.find_program_in_path('niro-snip') ? null : 'Niro Snip is not installed',
        run: async () => { run([GLib.find_program_in_path('niro-snip')]).catch(e => notify('Niro Snip', e.message)); return 'Snip'; }});
    const snip = (args) => { const bin = GLib.find_program_in_path('niro-snip'); run([bin, ...args]).catch(e => notify('Niro Snip', e.message)); };
    const haveSnip = () => GLib.find_program_in_path('niro-snip') ? null : 'Niro Snip is not installed';
    r.register({id: 'system.snip.delay', title: 'Snip in 5 seconds', description: 'Waits five seconds, so a menu or tooltip can be opened first, then takes the shot and opens it to edit', category: 'System', keywords: ['snipping', 'screenshot', 'timer', 'delay', 'later'], permission: 'none',
        available: haveSnip, run: async () => { snip(['--delay', '5']); return 'Snip in 5 seconds'; }});
    r.register({id: 'system.snip.full', title: 'Snip the whole screen', description: 'Takes the whole screen at once, then opens it to edit', category: 'System', keywords: ['snipping', 'screenshot', 'full screen', 'desktop'], permission: 'none',
        available: haveSnip, run: async () => { snip(['--full']); return 'Snip'; }});
    r.register({id: 'system.screenshot', title: 'Take a screenshot', description: 'Opens the screenshot tool', category: 'System', keywords: ['capture', 'screen', 'snip', 'record'], permission: 'none',
        available: () => Main.screenshotUI ? null : 'The screenshot tool is not available',
        run: async () => { Main.screenshotUI.open(); return 'Screenshot'; }});
    r.register({id: 'system.suspend', title: 'Suspend', description: 'Puts the computer to sleep', category: 'System', keywords: ['sleep'], permission: 'none',
        run: async () => { await run(['systemctl', 'suspend']); return 'Suspended'; }});
    r.register({id: 'system.logout', title: 'Log out', description: 'Ends this session and closes its applications', category: 'System', keywords: ['sign out', 'exit'], permission: 'confirm',
        confirm: 'Log out? Applications will close.', run: async () => { await run(['gnome-session-quit', '--logout', '--no-prompt']); }});
    r.register({id: 'system.restart', title: 'Restart', description: 'Restarts the computer', category: 'System', keywords: ['reboot'], permission: 'confirm',
        confirm: 'Restart the computer? Unsaved work in open applications is lost.', run: async () => { await run(['systemctl', 'reboot']); }});
    r.register({id: 'system.shutdown', title: 'Shut down', description: 'Turns the computer off', category: 'System', keywords: ['power off', 'turn off'], permission: 'confirm',
        confirm: 'Shut down the computer? Unsaved work in open applications is lost.', run: async () => { await run(['systemctl', 'poweroff']); }});
    registerSharedActions(r, {
        shellMajor: () => parseInt(PACKAGE_VERSION, 10),
        extensions: () => {
            const m = Main.extensionManager;
            return m.getUuids().map(uuid => {
                const e = m.lookup(uuid);
                return {uuid, enabled: e?.state === 1, shellVersions: e?.metadata?.['shell-version'] ?? []};
            });
        },
    });
    return r;
}
