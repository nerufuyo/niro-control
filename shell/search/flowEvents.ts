// @ts-nocheck: the shell's objects are passed in, so this file imports nothing from GNOME and node can test it with fakes
// Niro Flow's event emitter (opt-in, `flow-events`): real Shell signals -> org.niro.Flow1.Notify(kind, payload) on the island daemon.
// Only five kinds leave the shell, each with the smallest payload: workspace {index}, monitor {count, added}, profile {name}, app-launched {appId},
// app-focus {appId}. Never a window title or any text. Nothing is connected until start(), and stop() disconnects everything and drops what waits.
// The call is fire and forget (the caller gives `send`, which must not block), a missing daemon is ignored, and bursts are debounced and capped here;
// the daemon has its own limit (10 a second per kind) as well.

const DEBOUNCED = new Set(['workspace', 'monitor', 'app-focus']);   // a burst (Alt+Tab through windows, a key held on a workspace shortcut) is one event
const DEBOUNCE_MS = 300;
const MAX_PER_WINDOW = 20;       // events sent in any WINDOW_MS; more are dropped
const WINDOW_MS = 10000;
const REPEAT_MS = 1000;          // the same launch or profile twice inside this is one
const FAILURES_BEFORE_PAUSE = 3; // a daemon that is not there: stop trying for a while
const PAUSE_MS = 60000;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PROFILE_ID = /^[\w][\w .-]{0,63}$/;

const whole = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;

/** The payload a kind may carry, rebuilt field by field from `raw`, or null. Nothing else ever gets through. */
export function cleanPayload(kind, raw) {
    if (!raw || typeof raw !== 'object') return null;
    switch (kind) {
    case 'workspace': return whole(raw.index, 1000) ? {index: raw.index} : null;
    case 'monitor': return whole(raw.count, 64) && typeof raw.added === 'boolean' ? {count: raw.count, added: raw.added} : null;
    case 'profile': return typeof raw.name === 'string' && PROFILE_ID.test(raw.name) ? {name: raw.name} : null;
    case 'app-launched':
    case 'app-focus': return typeof raw.appId === 'string' && APP_ID.test(raw.appId) ? {appId: raw.appId} : null;
    default: return null;
    }
}

/**
 * `send(kind, payloadJson)` returns a promise that resolves true when the daemon answered and false/rejects when it did not (and must not block).
 * `after(ms, fn)` returns a handle, `cancel(handle)` drops it, `now()` is milliseconds.
 */
export function createFlowEmitter({send, after, cancel, now}) {
    const waiting = new Map();   // kind -> {handle, payload}
    const last = new Map();      // kind -> {json, at}
    let sent = [];
    let failures = 0, pausedUntil = 0, stopped = false;
    let delivered = 0, dropped = 0, attempted = 0;

    const flush = (kind, payload) => {
        if (stopped) return;
        const t = now();
        const json = JSON.stringify(payload);
        const before = last.get(kind);
        if (before && before.json === json && (kind === 'app-focus' || t - before.at < REPEAT_MS)) { dropped++; return; }
        sent = sent.filter(s => t - s < WINDOW_MS);
        if (t < pausedUntil || sent.length >= MAX_PER_WINDOW) { dropped++; return; }
        sent.push(t);
        attempted++;
        last.set(kind, {json, at: t});
        let call;
        try { call = Promise.resolve(send(kind, json)); } catch (_e) { call = Promise.resolve(false); }
        const failed = () => { if (++failures >= FAILURES_BEFORE_PAUSE) { pausedUntil = now() + PAUSE_MS; failures = 0; } };
        // `false` is the daemon saying no (Flow off, over its own limit): not a missing daemon, so not counted
        call.then(ok => { if (ok === undefined) failed(); else { delivered++; failures = 0; } }, failed);
    };

    return {
        emit(kind, raw) {
            if (stopped) return;
            const payload = cleanPayload(kind, raw);
            if (!payload) { dropped++; return; }
            if (!DEBOUNCED.has(kind)) return flush(kind, payload);
            const w = waiting.get(kind);
            if (w) cancel(w.handle);
            waiting.set(kind, {payload, handle: after(DEBOUNCE_MS, () => { waiting.delete(kind); flush(kind, payload); })});
        },
        stop() {
            stopped = true;
            for (const w of waiting.values()) cancel(w.handle);
            waiting.clear();
        },
        stats: () => ({attempted, delivered, dropped, waiting: waiting.size, paused: now() < pausedUntil}),
    };
}

/**
 * Connects the Shell signals to the emitter. `host` gives the objects (so a test can pass fakes):
 *   workspaceManager {connect, disconnect, get_active_workspace_index}, layoutManager {connect, disconnect, monitors}, appSystem {connect, disconnect, get_running},
 *   tracker {connect, disconnect, focus_app}, runningState / stoppedState (Shell.AppState), watchProfile(cb) -> stop fn (cb gets the active profile id or null).
 * Returns {stop(), connected()}: `connected()` is how many listeners are live (0 after stop()).
 */
export function connectFlowSources(host, emitter) {
    const ids = [];
    const on = (obj, signal, fn) => { ids.push([obj, obj.connect(signal, fn)]); };
    let unwatch = null;
    const running = new Set((host.appSystem.get_running?.() ?? []).map(a => a.get_id?.()).filter(Boolean));
    let monitors = host.layoutManager.monitors?.length ?? 0;
    let profile = host.readProfile?.() ?? null;
    let focus = host.tracker.focus_app?.get_id?.() ?? null;

    on(host.workspaceManager, 'workspace-switched', () => emitter.emit('workspace', {index: host.workspaceManager.get_active_workspace_index()}));
    on(host.layoutManager, 'monitors-changed', () => {
        const count = host.layoutManager.monitors?.length ?? 0;
        if (count === monitors) return;
        const added = count > monitors;
        monitors = count;
        emitter.emit('monitor', {count, added});
    });
    on(host.appSystem, 'app-state-changed', (_s, app) => {
        const id = app?.get_id?.();
        if (!id) return;
        if (app.state === host.runningState) {
            if (!running.has(id)) { running.add(id); emitter.emit('app-launched', {appId: id}); }
        } else if (app.state === host.stoppedState) running.delete(id);
    });
    on(host.tracker, 'notify::focus-app', () => {
        const id = host.tracker.focus_app?.get_id?.() ?? null;
        if (id && id !== focus) emitter.emit('app-focus', {appId: id});
        focus = id;
    });
    try {
        unwatch = host.watchProfile?.(active => {
            if (active && active !== profile) emitter.emit('profile', {name: active});
            profile = active;
        }) ?? null;
    } catch (_e) { unwatch = null; }   // no file monitor: the other four still work

    return {
        stop() {
            for (const [obj, id] of ids.splice(0)) { try { obj.disconnect(id); } catch (_e) { /* gone */ } }
            try { unwatch?.(); } catch (_e) { /* gone */ }
            unwatch = null;
        },
        connected: () => ids.length + (unwatch ? 1 : 0),
    };
}
