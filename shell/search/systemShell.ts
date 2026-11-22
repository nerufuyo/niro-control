// @ts-nocheck: GNOME Shell's modules are untyped here
// The shell side of System Experience (systemHub.ts): what only GNOME Shell can see. Two watchers that listen only between start() and stop(),
// and the services the hub is given. Nothing here keeps a notification's text or title.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {run} from './actions.js';

const DAEMON = ['org.niro.island.Daemon', '/org/niro/island/Daemon'];
const URGENCY = {[MessageTray.Urgency.LOW]: 'low', [MessageTray.Urgency.NORMAL]: 'normal', [MessageTray.Urgency.HIGH]: 'high', [MessageTray.Urgency.CRITICAL]: 'critical'};

/** Calls a method on the island daemon; resolves with the unpacked reply, rejects after `timeout` ms. */
export function daemonCall(iface, method, params, replyType, timeout = 1500) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(DAEMON[0], DAEMON[1], iface, method, params, replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, timeout, null, (conn, res) => {
            try { resolve(conn.call_finish(res).deepUnpack()); } catch (e) { reject(e); }
        });
    });
}

const daemonProperty = async (iface, name) => {
    const [v] = await daemonCall('org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', [iface, name]), '(v)');
    return v.deepUnpack();
};

/** The services the hub needs, bound to this shell. `ext` is the Search extension (its settings and config files). */
export function shellServices(ext, watchers) {
    return {
        pref: (key, fallback) => ext._pref(key, fallback),
        now: () => Date.now(),
        setTimer: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; }),
        clearTimer: id => GLib.source_remove(id),
        sleep: ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; })),
        readConfig: name => ext._readConfig(name),
        writeConfig: (name, text) => ext._writeConfig(name, text),
        readProc: async path => {
            try { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); } catch (_e) { return null; }
        },
        // the daemon already watches the battery and the camera: Search asks it, it does not poll them again
        systemState: async () => {
            try { return JSON.parse(await daemonProperty('org.niro.island.System1', 'State')); } catch (_e) { return null; }
        },
        clipboard: {
            items: async () => JSON.parse(await daemonProperty('org.niro.island.Clipboard1', 'Items') || '[]'),
            text: async id => (await daemonCall('org.niro.island.Clipboard1', 'GetText', new GLib.Variant('(t)', [id]), '(s)'))[0],
            remove: id => daemonCall('org.niro.island.Clipboard1', 'Remove', new GLib.Variant('(t)', [id]), '()'),
        },
        pactl: args => run(['pactl', ...args]),
        osd: (icon, label, level) => {
            try { Main.osdWindowManager.show(-1, Gio.ThemedIcon.new(icon), label || null, level, 1); } catch (e) { throw new Error(`the on-screen display is not available (${e.message})`); }
        },
        privacyLive: async () => ({
            wayland: Meta.is_wayland_compositor?.() ?? true,
            screenShares: watchers.screen.count(),
            recorder: typeof Main.screenshotUI?.screencast_in_progress === 'boolean' ? Main.screenshotUI.screencast_in_progress : null,
        }),
        watchNotifications: on => (on ? watchers.notifications.start() : watchers.notifications.stop()),
        watchScreen: on => (on ? watchers.screen.start() : watchers.screen.stop()),
        version: '',
        shellVersion: '',
    };
}

/** Each notification as it arrives: application and urgency only, handed to `decide(meta)`, whose answer ({verdict, apply}) is applied here. */
export class NotificationWatch {
    constructor(decide) {
        this._decide = decide;
        this._sources = null;
        this._trayIds = null;
        this._idle = new Set();
    }

    get active() { return this._sources !== null; }

    start() {
        if (this._sources) return;
        this._sources = new Map();
        const tray = Main.messageTray;
        this._trayIds = [tray.connect('source-added', (_t, source) => this._watch(source)), tray.connect('source-removed', (_t, source) => this._unwatch(source))];
        for (const source of tray.getSources()) this._watch(source);
    }

    stop() {
        if (!this._sources) return;
        const tray = Main.messageTray;
        for (const id of this._trayIds) tray.disconnect(id);
        this._trayIds = null;
        for (const source of [...this._sources.keys()]) this._unwatch(source);
        this._sources = null;
        for (const id of this._idle) GLib.source_remove(id);
        this._idle.clear();
    }

    _watch(source) {
        if (!this._sources || this._sources.has(source)) return;
        this._sources.set(source, source.connect('notification-added', (_s, n) => this._seen(source, n)));
    }

    _unwatch(source) {
        const id = this._sources?.get(source);
        if (id === undefined) return;
        try { source.disconnect(id); } catch (_e) { /* the source is already gone */ }
        this._sources.delete(source);
    }

    static appId(source) {
        const policy = source.policy?.id;                       // 'generic' for a source that is not an application
        const raw = source.app?.get_id?.() ?? (policy && policy !== 'generic' ? policy : null) ?? source.title ?? 'unknown';
        return String(raw).replace(/\.desktop$/, '').slice(0, 80);
    }

    _seen(source, n) {
        let out = null;
        try { out = this._decide({appId: NotificationWatch.appId(source), urgency: URGENCY[n.urgency] ?? 'normal'}); } catch (_e) { return; }
        if (!out?.apply || out.verdict === 'show') return;
        // silent / snoozed: kept in the list, no banner (marked seen). hide: the same at once, then removed from the list.
        n.acknowledged = true;
        if (out.verdict !== 'hide') return;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle.delete(id);
            try { n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED); } catch (_e) { /* already gone */ }
            return GLib.SOURCE_REMOVE;
        });
        this._idle.add(id);
    }
}

/** How many screen shares are running (Wayland: the compositor's remote-access handles). Counts nothing while stopped. */
export class ScreenShareWatch {
    constructor() {
        this._remote = null;
        this._remoteId = 0;
        this._handles = new Map();
    }

    start() {
        if (this._remote || !(Meta.is_wayland_compositor?.() ?? true)) return;
        this._remote = global.backend.get_remote_access_controller?.() ?? null;
        if (!this._remote) return;
        this._remoteId = this._remote.connect('new-handle', (_c, handle) => this._add(handle));
        // shares that began before this started are known to GNOME's own indicator (a private field, so read defensively)
        const seeded = Main.panel.statusArea.screenSharing?._handles;
        if (seeded instanceof Set) seeded.forEach(h => this._add(h));
    }

    stop() {
        if (this._remote && this._remoteId) this._remote.disconnect(this._remoteId);
        for (const [handle, id] of this._handles) { try { handle.disconnect(id); } catch (_e) { /* gone */ } }
        this._handles.clear();
        this._remote = null;
        this._remoteId = 0;
    }

    count() { return this._handles.size; }

    _add(handle) {
        if (handle.is_recording || this._handles.has(handle)) return;       // recordings are the screen recorder's own state
        this._handles.set(handle, handle.connect('stopped', () => {
            try { handle.disconnect(this._handles.get(handle)); } catch (_e) { /* gone */ }
            this._handles.delete(handle);
        }));
    }
}
