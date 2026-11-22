// Session snapshot core (vNext S9). Pure. A snapshot records which windows were where; restoring is honest about what it can do:
// 'relaunch' (the app is not running), 'place' (running, move the window), 'unsupported' (no app id: nothing safe to match).

export const SNAPSHOT_VERSION = 2;

/** v1 stored windows as {app, workspace, monitor}; v2 uses {appId, title, workspace, monitor, x, y, width, height}. */
export function migrateSnapshot(s) {
    if (!s || !Array.isArray(s.windows))
        throw new Error('not a snapshot');
    if (s.version === SNAPSHOT_VERSION)
        return s;
    if (s.version === 1)
        return {...s, version: SNAPSHOT_VERSION, windows: s.windows.map(w => ({appId: w.app ?? null, title: '', workspace: w.workspace ?? 1, monitor: w.monitor ?? 0}))};
    throw new Error(`cannot migrate snapshot version ${s.version}`);
}

const id = w => (w.appId ?? '').toLowerCase();

/** {added, removed, moved} between two snapshots, matching windows of one app in order. */
export function diffSnapshots(a, b) {
    const group = s => {
        const m = new Map();
        for (const w of s.windows)
            m.set(id(w), [...(m.get(id(w)) ?? []), w]);
        return m;
    };
    const ga = group(a), gb = group(b), out = {added: [], removed: [], moved: []};
    for (const k of new Set([...ga.keys(), ...gb.keys()])) {
        const x = ga.get(k) ?? [], y = gb.get(k) ?? [];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if (!x[i])
                out.added.push(y[i]);
            else if (!y[i])
                out.removed.push(x[i]);
            else if (x[i].workspace !== y[i].workspace || x[i].monitor !== y[i].monitor)
                out.moved.push({appId: k, from: {workspace: x[i].workspace, monitor: x[i].monitor}, to: {workspace: y[i].workspace, monitor: y[i].monitor}});
        }
    }
    return out;
}

/** What restoring would do given the apps running now, and the monitors that exist now. Nothing is closed. `only` limits it to chosen app ids. */
export function restorePlan(snapshot, runningAppIds, monitorCount, only = null) {
    const running = new Set(runningAppIds.map(a => a.toLowerCase()));
    return snapshot.windows.filter(w => !only || only.includes(w.appId)).map(w => {
        if (!w.appId)
            return {appId: null, action: 'unsupported', reason: 'no application id'};
        const monitor = w.monitor < monitorCount ? w.monitor : 0;
        return {appId: w.appId, action: running.has(id(w)) ? 'place' : 'relaunch', workspace: w.workspace, monitor,
            note: monitor !== w.monitor ? 'its monitor is not connected: placed on the first' : undefined};
    });
}

/** The snapshots to keep: the newest `max`, none older than `days`, and manual ones that are pinned always. */
export function retain(snapshots, nowMs, {max = 20, days = 30} = {}) {
    const fresh = snapshots.filter(s => s.pinned || nowMs - s.at <= days * 864e5).sort((a, b) => b.at - a.at);
    const pinned = fresh.filter(s => s.pinned), rest = fresh.filter(s => !s.pinned).slice(0, Math.max(0, max - pinned.length));
    return [...pinned, ...rest].sort((a, b) => b.at - a.at);
}
