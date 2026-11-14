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

export const PAGES = ['look', 'island', 'dock', 'windows', 'search', 'profiles', 'about'];
const NIRO = () => GLib.find_program_in_path('niro-control');
const CONFIG = `${GLib.get_user_config_dir()}/niro-control`;
const BUILTIN = '/usr/share/niro-control/profiles';

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

// ---- Asking before something that ends the session
export function confirm(title: string, question: string, verb: string): Promise<boolean> {
    return new Promise(resolve => {
        const dialog = new ModalDialog({styleClass: 'niro-confirm', destroyOnClose: true});
        dialog.contentLayout.add_child(new St.Label({text: title, style_class: 'niro-confirm-title'}));
        dialog.contentLayout.add_child(new St.Label({text: question, style_class: 'niro-confirm-body'}));
        dialog.setButtons([
            {label: 'Cancel', action: () => { dialog.close(); resolve(false); }, key: 0xff1b},
            {label: verb, action: () => { dialog.close(); resolve(true); }, default: true},
        ]);
        dialog.open();
    });
}

// ---- The registry
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
    r.register({id: 'system.suspend', title: 'Suspend', description: 'Puts the computer to sleep', category: 'System', keywords: ['sleep'], permission: 'none',
        run: async () => { await run(['systemctl', 'suspend']); return 'Suspended'; }});
    r.register({id: 'system.logout', title: 'Log out', description: 'Ends this session and closes its applications', category: 'System', keywords: ['sign out', 'exit'], permission: 'confirm',
        confirm: 'Log out? Applications will close.', run: async () => { await run(['gnome-session-quit', '--logout', '--no-prompt']); }});
    r.register({id: 'system.restart', title: 'Restart', description: 'Restarts the computer', category: 'System', keywords: ['reboot'], permission: 'confirm',
        confirm: 'Restart the computer? Unsaved work in open applications is lost.', run: async () => { await run(['systemctl', 'reboot']); }});
    r.register({id: 'system.shutdown', title: 'Shut down', description: 'Turns the computer off', category: 'System', keywords: ['power off', 'turn off'], permission: 'confirm',
        confirm: 'Shut down the computer? Unsaved work in open applications is lost.', run: async () => { await run(['systemctl', 'poweroff']); }});
    return r;
}
