// Privacy Dashboard core (vNext initiative 26). Pure model over what the platform can actually tell us. An indicator is 'supported' or
// 'unsupported' with a reason, and an unsupported one reports state 'unknown', never "not in use": the UI must not claim what GNOME
// cannot expose. History is OFF by default, bounded, holds only (kind, app, start, end) and is cleared when switched off.
// Based on shell/island/src/privacy.ts: mic via the PulseAudio/PipeWire mixer streams, camera via the daemon, screen share via the Mutter
// remote-access controller (Wayland only), recording via GNOME's own screen recorder.

export const INDICATOR_KINDS = ['mic', 'camera', 'screen-share', 'recording'];
export const LEVEL_METERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];
const HISTORY_MAX = 200;

/**
 * `caps`: {wayland, audioServer: true when the mixer is reachable, cameraProbe: the daemon reports camera use, recorderSignal: GNOME's
 * screen recorder state is readable}. Returns `{kind: {supported, explanation}}`.
 */
export function describeSupport(caps = {}) {
    return {
        mic: caps.audioServer
            ? {supported: true, explanation: 'Seen from the sound server\'s recording streams; apps that only show a level meter are ignored.'}
            : {supported: false, explanation: 'The sound server was not reachable, so microphone use cannot be seen.'},
        camera: caps.cameraProbe
            ? {supported: true, explanation: 'Seen as a process holding the camera device; apps using a camera through a portal may show only while streaming.'}
            : {supported: false, explanation: 'Camera use is not reported on this system (no device probe), so it is not shown.'},
        'screen-share': caps.wayland
            ? {supported: true, explanation: 'Seen from the compositor\'s remote-access sessions (Wayland).'}
            : {supported: false, explanation: 'On X11 any app can capture the screen without telling the desktop, so sharing cannot be detected.'},
        recording: caps.recorderSignal
            ? {supported: true, explanation: 'Only GNOME\'s own screen recorder is detected. Other recorders (OBS, browsers) appear as screen sharing when they use the portal.'}
            : {supported: false, explanation: 'The screen recorder state is not readable here.'},
    };
}

/**
 * `createPrivacy({caps, now})`. `observe(active, now)` takes the current list `[{kind, app?, since?}]` and returns the model:
 * `{indicators: {kind: {supported, explanation, state: 'active'|'inactive'|'unknown', apps}}, anyActive}`.
 */
export function createPrivacy({caps = {}} = {}) {
    let support = describeSupport(caps);
    let historyOn = false;
    let history = [];
    let open = new Map();       // `${kind}|${app}` -> history entry still running

    const record = (active, now) => {
        const keys = new Set();
        for (const a of active) {
            const k = `${a.kind}|${a.app}`;
            keys.add(k);
            if (!open.has(k)) {
                const entry = {kind: a.kind, app: a.app, start: now, end: null};
                open.set(k, entry);
                history.push(entry);
            }
        }
        for (const [k, e] of open)
            if (!keys.has(k)) {
                e.end = now;
                open.delete(k);
            }
        if (history.length > HISTORY_MAX) {
            history = history.slice(-HISTORY_MAX);
            for (const [k, e] of open)
                if (!history.includes(e))
                    open.delete(k);
        }
    };

    return {
        setCapabilities(next) { support = describeSupport(next); },
        observe(list, now) {
            const active = (list ?? [])
                .filter(a => INDICATOR_KINDS.includes(a?.kind) && support[a.kind].supported && !LEVEL_METERS.includes(a.app))
                .map(a => ({kind: a.kind, app: String(a.app ?? 'Unknown').slice(0, 80), since: a.since ?? null}));
            if (historyOn)
                record(active, now);
            const indicators = {};
            for (const kind of INDICATOR_KINDS) {
                const apps = active.filter(a => a.kind === kind).map(a => a.app);
                indicators[kind] = {...support[kind], state: !support[kind].supported ? 'unknown' : apps.length ? 'active' : 'inactive', apps};
            }
            return {indicators, anyActive: active.length > 0};
        },
        /** History is opt-in. Turning it off also clears it, so nothing lingers. */
        setHistory(on) {
            historyOn = on === true;
            if (!historyOn) {
                history = [];
                open = new Map();
            }
            return historyOn;
        },
        get historyEnabled() { return historyOn; },
        history() { return history.map(e => ({...e})); },
        clearHistory() { history = []; open = new Map(); },
    };
}

/**
 * Permission overview from a plain input `[{app, mic?, camera?, location?, screen?}]` where each value is 'granted' | 'denied' | 'ask' | undefined
 * (undefined -> 'unknown'). Returns rows sorted by how many permissions are granted, and counts. Reads nothing itself: the caller supplies
 * what the portal permission store (or anything else) reported.
 */
export function permissionOverview(entries) {
    const KEYS = ['mic', 'camera', 'location', 'screen'];
    const ok = v => (v === 'granted' || v === 'denied' || v === 'ask') ? v : 'unknown';
    const rows = (entries ?? []).filter(e => typeof e?.app === 'string' && e.app).slice(0, 500).map(e => {
        const row = {app: e.app.slice(0, 80)};
        for (const k of KEYS)
            row[k] = ok(e[k]);
        row.granted = KEYS.filter(k => row[k] === 'granted').length;
        return row;
    }).sort((a, b) => b.granted - a.granted || a.app.localeCompare(b.app));
    const counts = Object.fromEntries(KEYS.map(k => [k, {granted: rows.filter(r => r[k] === 'granted').length, denied: rows.filter(r => r[k] === 'denied').length, unknown: rows.filter(r => r[k] === 'unknown').length}]));
    return {rows, counts};
}
