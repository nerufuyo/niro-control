// Monitor manager core (vNext 12). Pure PLANNING only: identity, profiles, hotplug diff and move plans. Nothing here writes a display
// configuration (Mutter DisplayConfig is out of scope); the plans say what the shell would do with windows.
// A monitor's identity is connector + vendor + product + a hash of the serial. The raw serial is never kept or returned.

export const MAX_PROFILES = 20;

const clean = v => (typeof v === 'string' ? v.trim() : '');

/** Small deterministic string hash (FNV-1a, 32 bit) so tests and the shell agree without a crypto dependency. Not a security boundary. */
export function hashSerial(serial) {
    let h = 0x811c9dc5;
    for (const ch of clean(serial)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * raw: {connector, vendor, product, serial, width, height, scale, x, y, primary}. Returns the identity plus geometry:
 * `key` is stable across reboots for the same physical monitor on the same port; `logical` = physical / scale.
 */
export function monitorIdentity(raw) {
    const connector = clean(raw.connector), vendor = clean(raw.vendor), product = clean(raw.product);
    const serialHash = clean(raw.serial) ? hashSerial(raw.serial) : 'none';
    const scale = Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 1;
    const width = Number.isFinite(raw.width) ? raw.width : 0, height = Number.isFinite(raw.height) ? raw.height : 0;
    return {
        key: [connector, vendor, product, serialHash].join('|'),
        connector, vendor, product, serialHash,
        width, height, scale,
        logical: {width: Math.round(width / scale), height: Math.round(height / scale)},
        x: Number.isFinite(raw.x) ? raw.x : 0, y: Number.isFinite(raw.y) ? raw.y : 0,
        primary: Boolean(raw.primary),
    };
}

/** The same monitor on another port: connector differs but vendor, product and serial hash agree (only with a real serial). */
export const sameHardware = (a, b) => a.serialHash !== 'none' && a.serialHash === b.serialHash && a.vendor === b.vendor && a.product === b.product;

/** Key of a monitor set: sorted, so order of enumeration never matters. */
export const setKey = monitors => monitors.map(m => m.key).sort().join('+');

/** The primary monitor: flagged one, else the one at the origin, else the first. null when there are none. */
export function primaryOf(monitors) {
    return monitors.find(m => m.primary) ?? monitors.find(m => m.x === 0 && m.y === 0) ?? monitors[0] ?? null;
}

/** Hotplug diff between two enumerations. Matches by key first, then by hardware (moved to another port). */
export function diffMonitors(before, after) {
    const connected = [], disconnected = [], moved = [];
    const left = [...before];
    for (const m of after) {
        const i = left.findIndex(b => b.key === m.key);
        if (i >= 0) { left.splice(i, 1); continue; }
        const j = left.findIndex(b => sameHardware(b, m));
        if (j >= 0) { moved.push({from: left[j].key, to: m.key}); left.splice(j, 1); continue; }
        connected.push(m);
    }
    disconnected.push(...left);
    return {connected, disconnected, moved, changed: connected.length + disconnected.length + moved.length > 0};
}

/**
 * Fallback: windows on a monitor that vanished go to the primary of those that remain, clamped into its logical size, so none is
 * stranded off screen. Windows: [{id, monitor (key), x, y, width, height}]. Returns {moves, remaining, notes}; no monitors left = no moves.
 */
export function fallbackPlan(windows, remaining, gone) {
    const target = primaryOf(remaining);
    const goneKeys = new Set(gone.map(m => m.key));
    if (!target) return {moves: [], target: null, notes: ['no monitor left to move windows to']};
    const moves = [];
    for (const w of windows) {
        if (!goneKeys.has(w.monitor)) continue;
        const width = Math.min(w.width, target.logical.width), height = Math.min(w.height, target.logical.height);
        const x = Math.min(Math.max(0, w.x ?? 0), target.logical.width - width);
        const y = Math.min(Math.max(0, w.y ?? 0), target.logical.height - height);
        moves.push({windowId: w.id, from: w.monitor, to: target.key, rect: {x, y, width, height}});
    }
    return {moves, target: target.key, notes: moves.length ? [`${moves.length} window(s) moved to ${target.key}`] : []};
}

/**
 * Remember where windows were when a monitor left, so they can go back when it returns (`restorePlan`).
 * Bounded by the caller's window list; stored as {monitor key: [{windowId, rect}]}.
 */
export function rememberDisplaced(fallback, windows) {
    const mem = {};
    for (const m of fallback.moves) {
        const w = windows.find(x => x.id === m.windowId);
        if (!w) continue;
        (mem[m.from] ??= []).push({windowId: w.id, rect: {x: w.x ?? 0, y: w.y ?? 0, width: w.width, height: w.height}});
    }
    return mem;
}

/** A monitor returned: windows that were displaced from it go back (only those still open and still where the fallback put them). */
export function restorePlan(memory, returned, live) {
    const entries = memory[returned.key] ?? [];
    const moves = [], missing = [];
    for (const e of entries) {
        const w = live.find(x => x.id === e.windowId);
        if (!w) { missing.push(e.windowId); continue; }
        if (w.monitor === returned.key) continue;
        const width = Math.min(e.rect.width, returned.logical.width), height = Math.min(e.rect.height, returned.logical.height);
        moves.push({windowId: w.id, to: returned.key, rect: {
            x: Math.min(Math.max(0, e.rect.x), returned.logical.width - width),
            y: Math.min(Math.max(0, e.rect.y), returned.logical.height - height), width, height}});
    }
    return {moves, missing};
}

/** Monitor profiles: name + the monitor set they belong to + the settings to suggest (data only: layout order, primary key, per-monitor scale). */
export function saveProfile(profiles, name, monitors, settings = {}) {
    const key = setKey(monitors);
    const n = clean(name).slice(0, 60);
    if (!n || !key) throw new Error('a profile needs a name and at least one monitor');
    const entry = {name: n, setKey: key, primary: primaryOf(monitors)?.key ?? null,
        layout: monitors.map(m => ({key: m.key, x: m.x, y: m.y, scale: m.scale})), settings: {...settings}};
    return [entry, ...profiles.filter(p => p.setKey !== key)].slice(0, MAX_PROFILES);
}

/** The profile for the current monitor set: exact set first; otherwise none (a different set is a different situation). */
export const findProfile = (profiles, monitors) => profiles.find(p => p.setKey === setKey(monitors)) ?? null;

/** What changed in a profile versus the live monitors: scale or position drift, for a "restore this layout?" prompt (a plan, not a write). */
export function profileDrift(profile, monitors) {
    const d = [];
    for (const l of profile.layout) {
        const m = monitors.find(x => x.key === l.key);
        if (!m) continue;
        if (m.scale !== l.scale) d.push({key: l.key, field: 'scale', from: m.scale, to: l.scale});
        if (m.x !== l.x || m.y !== l.y) d.push({key: l.key, field: 'position', from: {x: m.x, y: m.y}, to: {x: l.x, y: l.y}});
    }
    return d;
}
