// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// Remembers the applications that are open and opens them again at the next login (a reboot, a logout), each back on its
// workspace, monitor and place. GNOME has no such thing of its own. Settings: `restore-session` (on), `restore-positions`,
// `restore-session-exclude` (desktop file ids left out).
//
// Saving: the open applications and where their windows are go to ~/.local/state/niro/session.json, a few seconds after the
// last change (so a flurry of changes is one write). The delay is also what keeps a logout from emptying the file: as the
// session ends the applications close one by one, which is a flurry that never settles before the shell is gone, so the
// last settled state stays.
//
// Restoring: once per login (a marker file that names the shell process, written when it is done, so a restore the screen
// locking cut short carries on after the unlock), a few seconds after the session is up, applications not running are
// started a little apart. Saving waits until that is over, so a half-restored desktop is not taken for the desktop one wanted.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {maximize} from './compat.js';

/** How long after the last change the state is written, in ms. */
const SAVE_DELAY_MS = 5000;
/** Between one application started and the next, in ms: many at once would crawl. */
const LAUNCH_GAP_MS = 900;
/** How long a started application has to show its window before it is no longer waited for, in ms. */
const WINDOW_WAIT_MS = 25000;
/** After the last one is started, saving stays off this long, in ms. */
const SETTLE_MS = 15000;

/** Started by this shell process: it outlives the screen locking, so a restore cut short does not start these twice (some stay
 * "stopped" until their window shows). */
const launched = new Set();

function stateFile() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'niro', 'session.json']);
}

/** The file that says a login restored already. It holds the shell process it was made for: the runtime directory outlives a logout when
 * the user's manager stays up, so the file alone cannot tell this login from the one before. `NIRO_RESTORE_MARKER` lets a test choose it. */
function markerFile() {
    return GLib.getenv('NIRO_RESTORE_MARKER') ?? GLib.build_filenamev([GLib.get_user_runtime_dir(), 'niro-session-restored']);
}

/** Names this shell process: its pid and start time. On Wayland the shell is the session, so a new login is a new shell, and the
 * extension starting again inside the same shell (or the screen unlocking) is not. (The session id of logind cannot say: the
 * shell does not get it here, and the audit session id is the user manager's, which outlives a logout.) */
function shellId() {
    try {
        const stat = new TextDecoder().decode(Gio.File.new_for_path('/proc/self/stat').load_contents(null)[1]);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return `${stat.slice(0, stat.indexOf(' '))}-${fields[19]}`;
    } catch (_e) {
        return 'unknown';
    }
}

export class SessionRestore {
    constructor(settings) {
        this._settings = settings;
        this._saveId = 0;
        this._launchId = 0;
        this._restoring = false;
        this._pending = new Map();
        this._signals = [];
        this._settingIds = ['restore-session', 'restore-positions', 'restore-session-exclude'].map(key =>
            settings.connect(`changed::${key}`, () => this._sync()));
        this._started = false;
        this._sync();
    }

    get enabled() {
        return this._settings.get_boolean('restore-session');
    }

    _sync() {
        if (this.enabled && !this._started) {
            this._started = true;
            this._watch();
            this._beginRestore();
        } else if (!this.enabled && this._started) {
            this._started = false;
            this._unwatch();
            this._stopRestoring();
        }
    }

    // ---- Saving

    _watch() {
        const wm = global.window_manager;
        const display = global.display;
        const changed = () => this._scheduleSave();
        for (const signal of ['map', 'destroy', 'minimize', 'unminimize', 'size-changed', 'switch-workspace'])
            this._signals.push([wm, wm.connect(signal, changed)]);
        for (const signal of ['window-created', 'window-entered-monitor', 'window-left-monitor'])
            this._signals.push([display, display.connect(signal, changed)]);
        const apps = Shell.AppSystem.get_default();
        this._signals.push([apps, apps.connect('app-state-changed', changed)]);
    }

    _unwatch() {
        for (const [source, id] of this._signals)
            source.disconnect(id);
        this._signals = [];
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
    }

    _scheduleSave() {
        if (this._restoring || this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this.save();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The open applications as they are now (windows of normal applications that have a desktop file). */
    snapshot() {
        const exclude = new Set(this._settings.get_strv('restore-session-exclude'));
        const tracker = Shell.WindowTracker.get_default();
        const apps = new Map();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.skip_taskbar || win.window_type !== Meta.WindowType.NORMAL)
                continue;
            const app = tracker.get_window_app(win);
            const id = app?.get_id();
            if (!id || !app.get_app_info() || exclude.has(id))
                continue;
            const rect = win.get_frame_rect();
            const maximized = win.is_maximized?.() ?? (win.maximized_horizontally && win.maximized_vertically);
            const entry = apps.get(id) ?? {id, windows: []};
            entry.windows.push({
                workspace: win.is_on_all_workspaces() ? -1 : win.get_workspace()?.index() ?? 0,
                monitor: win.get_monitor(),
                maximized: Boolean(maximized),
                fullscreen: win.is_fullscreen?.() ?? Boolean(win.fullscreen),
                minimized: win.minimized,
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            });
            apps.set(id, entry);
        }
        return {version: 1, saved: Math.round(Date.now() / 1000), apps: [...apps.values()]};
    }

    save() {
        if (!this.enabled || this._restoring)
            return;
        try {
            const path = stateFile();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            const bytes = new TextEncoder().encode(JSON.stringify(this.snapshot(), null, 1));
            Gio.File.new_for_path(path).replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Island: could not save the session: ${e.message}`);
        }
    }

    // ---- Restoring

    /** The saved state, or null. */
    _read() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(stateFile()).load_contents(null);
            const state = ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
            return Array.isArray(state?.apps) ? state : null;
        } catch (_e) {
            return null;
        }
    }

    _beginRestore() {
        const marker = Gio.File.new_for_path(markerFile());
        const login = shellId();
        // Once per login: the marker names this login's session once a restore in it has finished.
        let marked = null;
        try {
            marked = new TextDecoder().decode(marker.load_contents(null)[1]).trim();
        } catch (_e) { /* none yet */ }
        if (marked === login) {
            this._scheduleSave();
            return;
        }
        const state = this._read();
        const running = id => {
            const app = Shell.AppSystem.get_default().lookup_app(id);
            return !app || app.state !== Shell.AppState.STOPPED;
        };
        const queue = (state?.apps ?? []).filter(entry => entry.windows?.length && !launched.has(entry.id) && !running(entry.id));
        // Cut short after the last start: it still has to settle before anything is saved.
        if (!queue.length && !launched.size) {
            this._markRestored();
            this._scheduleSave();
            return;
        }
        this._restoring = true;
        // Placing windows as they come up.
        this._windowSignal = global.display.connect('window-created', (_display, win) => this._place(win));
        // A moment after the session is up: what starts by itself is there by then and is not started twice.
        this._launchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, this._settings.get_int('restore-session-delay')) * 1000, () => {
            this._launchId = 0;
            this._launchNext(queue.filter(entry => !running(entry.id)));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Only once there is nothing left to restore: cut short (the screen locking), it carries on next time. */
    _markRestored() {
        try {
            Gio.File.new_for_path(markerFile()).replace_contents(new TextEncoder().encode(shellId()), null, false,
                Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.warn(`Island: could not mark the session as restored: ${e.message}`);
        }
    }

    _launchNext(queue) {
        const entry = queue.shift();
        if (!entry) {
            // Saving starts again once what was started has had time to settle.
            this._launchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                this._launchId = 0;
                this._markRestored();
                this._stopRestoring();
                this._scheduleSave();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        const app = Shell.AppSystem.get_default().lookup_app(entry.id);
        if (app && app.state === Shell.AppState.STOPPED) {
            this._pending.set(entry.id, {entry, until: GLib.get_monotonic_time() / 1000 + WINDOW_WAIT_MS});
            try {
                launched.add(entry.id);
                app.activate();
            } catch (e) {
                console.warn(`Island: could not restore ${entry.id}: ${e.message}`);
                this._pending.delete(entry.id);
            }
        }
        this._launchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNCH_GAP_MS, () => {
            this._launchId = 0;
            this._launchNext(queue);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Puts a restored application's first window where it was (workspace, monitor, size and place). */
    _place(win) {
        if (!this._settings.get_boolean('restore-positions') || win.window_type !== Meta.WindowType.NORMAL)
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const wanted = app ? this._pending.get(app.get_id()) : null;
        if (!wanted)
            return;
        this._pending.delete(app.get_id());
        const saved = wanted.entry.windows[0];
        // Once the window has its first frame: placed sooner, the application's own sizing would win.
        const actor = win.get_compositor_private();
        const apply = () => {
            try {
                if (saved.workspace >= 0 && saved.workspace < global.workspace_manager.get_n_workspaces())
                    win.change_workspace_by_index(saved.workspace, false);
                else if (saved.workspace < 0)
                    win.stick();
                if (saved.monitor >= 0 && saved.monitor < global.display.get_n_monitors() && saved.monitor !== win.get_monitor())
                    win.move_to_monitor(saved.monitor);
                if (saved.maximized)
                    maximize(win);
                else if (saved.width > 0 && saved.height > 0)
                    win.move_resize_frame(false, saved.x, saved.y, saved.width, saved.height);
                if (saved.minimized)
                    win.minimize();
            } catch (e) {
                console.warn(`Island: could not place a window: ${e.message}`);
            }
        };
        if (actor)
            actor.connect_after('first-frame', () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                apply();
                return GLib.SOURCE_REMOVE;
            }));
        else
            apply();
    }

    _stopRestoring() {
        this._restoring = false;
        this._pending.clear();
        if (this._launchId) {
            GLib.Source.remove(this._launchId);
            this._launchId = 0;
        }
        if (this._windowSignal) {
            global.display.disconnect(this._windowSignal);
            this._windowSignal = 0;
        }
    }

    destroy() {
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._unwatch();
        this._stopRestoring();
    }
}
