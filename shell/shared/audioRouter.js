// Smart Audio Router core (vNext initiative 21). Pure: parses `pactl -f json list ...` and `wpctl status` output into streams and
// devices, and plans per-app volume, routing presets and app -> sink rules as DATA (argv arrays). It never runs anything, never
// touches a timer or listener, and keeps its state bounded. The default device is never changed unless the caller passes
// `allowDefaultChange: true`. A loop guard stops a rule from moving the same stream back and forth.
// Formats learned from `pactl -f json list sinks` and `wpctl status` on PipeWire 1.6 (read-only listing).

export const MAX_STREAMS = 256;
export const MAX_DEVICES = 64;
export const MAX_VOLUME = 1.5;                       // 150 %, the usual boost limit
const NAME = /^[\w.:+@-]{1,200}$/;                   // a sink or source node name (also guards argv values)

const json = input => {
    if (typeof input !== 'string')
        return Array.isArray(input) ? input : [];
    try {
        const v = JSON.parse(input);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
};
const clamp = (v, hi = 1) => Math.min(hi, Math.max(0, Number.isFinite(v) ? v : 0));
const fraction = vol => {
    // {"front-left": {"value": 65536, "value_percent": "100%"}, ...}: the loudest channel stands for the stream.
    const values = Object.values(vol ?? {}).map(c => Number(c?.value)).filter(Number.isFinite);
    return values.length ? Math.round(Math.max(...values) / 65.536) / 1000 : 0;
};

/** `pactl -f json list sinks|sources` -> devices `{kind, index, name, description, muted, volume, available, monitor}`. Monitors are flagged. */
export function parsePactlDevices(input, kind = 'sink') {
    return json(input).slice(0, MAX_DEVICES).filter(d => typeof d?.name === 'string' && NAME.test(d.name)).map(d => {
        const port = (d.ports ?? []).find(p => p.name === d.active_port);
        return {
            kind,
            index: Number(d.index),
            name: d.name,
            description: String(d.description ?? d.name),
            muted: d.mute === true,
            volume: fraction(d.volume),
            // The port's availability string is localised ("tersedia"); only a port that says "no"/"not available" in English is
            // trusted as unavailable, so a localised string never wrongly hides a working device.
            available: !(port && /^(no|not available)$/i.test(String(port.availability ?? ''))),
            monitor: kind === 'source' && (d.monitor_of_sink != null && d.monitor_of_sink !== 4294967295 || /\.monitor$/.test(d.name)),
        };
    });
}

/** `pactl -f json list sink-inputs` -> playback streams `{id, app, appId, media, sinkIndex, muted, volume, corked}`. */
export function parsePactlStreams(input) {
    return json(input).slice(0, MAX_STREAMS).filter(s => Number.isInteger(s?.index)).map(s => {
        const p = s.properties ?? {};
        const app = String(p['application.name'] ?? p['node.name'] ?? 'Unknown').slice(0, 80);
        return {
            id: s.index,
            app,
            appId: String(p['application.id'] ?? p['application.process.binary'] ?? app).slice(0, 120),
            media: String(p['media.name'] ?? '').slice(0, 120),
            sinkIndex: Number(s.sink),
            muted: s.mute === true,
            volume: fraction(s.volume),
            corked: s.corked === true,
        };
    });
}

/**
 * `wpctl status` text -> `{sinks, sources, streams}`. Each device is `{id, name, default, volume, muted}`; `id` is the PipeWire object id.
 * Streams carry `{id, app}` only (wpctl does not show their sink on one line); use pactl for routing. Unknown lines are skipped.
 */
export function parseWpctlStatus(text) {
    const out = {sinks: [], sources: [], streams: []};
    if (typeof text !== 'string')
        return out;
    let section = null, block = null;
    for (const raw of text.split('\n').slice(0, 2000)) {
        const line = raw.replace(/[│├└─]/g, ' ');
        const head = /^\s*(Sinks|Sources|Streams|Devices|Filters|Clients)\s*:/.exec(line);
        if (head) {
            section = head[1];
            continue;
        }
        if (/^\S/.test(raw)) {                                 // "Audio", "Video", "Settings": a new top-level block
            block = raw.trim();
            section = null;
        }
        if (block !== 'Audio')
            continue;
        const m = /^\s*(\*)?\s*(\d+)\.\s+(.+?)\s*(?:\[vol:\s*([\d.]+)(\s+MUTED)?\])?\s*$/.exec(line);
        if (!m || !section || /[<>]/.test(m[3]))               // port lines contain "<" or ">"
            continue;
        const entry = {id: Number(m[2]), name: m[3].trim(), default: m[1] === '*', volume: m[4] === undefined ? null : Number(m[4]), muted: Boolean(m[5])};
        if (section === 'Sinks' && out.sinks.length < MAX_DEVICES)
            out.sinks.push(entry);
        else if (section === 'Sources' && out.sources.length < MAX_DEVICES)
            out.sources.push(entry);
        else if (section === 'Streams' && out.streams.length < MAX_STREAMS)
            out.streams.push({id: entry.id, app: entry.name});
    }
    return out;
}

// ---- per-app volume

/**
 * Plan for one stream: `{volume (0..1), delta, mute (true/false/'toggle')}`. Returns `{ok, commands, stream}`; commands are argv arrays
 * for pactl. Volume is capped at 1.0 unless `allowBoost` (then 1.5).
 */
export function planStreamVolume(stream, change, {allowBoost = false} = {}) {
    if (!stream || !Number.isInteger(stream.id))
        return {ok: false, reason: 'unknown stream', commands: []};
    const hi = allowBoost ? MAX_VOLUME : 1;
    const commands = [];
    let volume = stream.volume;
    if (Number.isFinite(change?.volume))
        volume = clamp(change.volume, hi);
    else if (Number.isFinite(change?.delta))
        volume = clamp(stream.volume + change.delta, hi);
    if (volume !== stream.volume || Number.isFinite(change?.volume))
        commands.push(['pactl', 'set-sink-input-volume', String(stream.id), `${Math.round(volume * 100)}%`]);
    if (change?.mute === true || change?.mute === false || change?.mute === 'toggle')
        commands.push(['pactl', 'set-sink-input-mute', String(stream.id), change.mute === 'toggle' ? 'toggle' : change.mute ? '1' : '0']);
    return {ok: true, commands, stream: {...stream, volume, muted: change?.mute === 'toggle' ? !stream.muted : (typeof change?.mute === 'boolean' ? change.mute : stream.muted)}};
}

// ---- routing

const sameApp = (stream, rule) => {
    const want = String(rule.app ?? '').toLowerCase();
    return want !== '' && (stream.app.toLowerCase() === want || stream.appId.toLowerCase() === want);
};
const usable = d => d && d.available !== false && NAME.test(d.name ?? '');

/** Loop guard: a stream (by app id) may be moved at most `max` times per `windowMs`; `now` is passed in, nothing is scheduled. */
export function createLoopGuard({max = 2, windowMs = 60000} = {}) {
    const seen = new Map();   // key -> [timestamps]
    return {
        allow(key, now) {
            const recent = (seen.get(key) ?? []).filter(t => now - t < windowMs);
            if (recent.length >= max) {
                seen.set(key, recent);
                return false;
            }
            return true;
        },
        record(key, now) {
            const recent = (seen.get(key) ?? []).filter(t => now - t < windowMs);
            recent.push(now);
            seen.set(key, recent);
            if (seen.size > 256)
                seen.delete(seen.keys().next().value);      // bounded: drop the oldest key
        },
        reset() { seen.clear(); },
    };
}

/**
 * Rules `[{app, sink, enabled?}]` -> plan `{moves, skipped, commands}`. A move is `{stream, app, from, to}`; a skip carries a `reason`
 * (target missing, unavailable, already there, blocked by the loop guard, rule conflict). Two enabled rules for one app that disagree:
 * the first wins and the later one is reported as a conflict. Never emits `set-default-*`.
 * `devices`: sinks (see parsePactlDevices). `guard`/`now` enable the loop guard; the caller calls `guard.record` after really moving.
 */
export function planRules(streams, devices, rules, {guard = null, now = 0} = {}) {
    const plan = {moves: [], skipped: [], commands: []};
    const sinks = new Map(devices.filter(d => d.kind === 'sink').map(d => [d.name, d]));
    const byIndex = new Map(devices.filter(d => d.kind === 'sink').map(d => [d.index, d]));
    const active = [];
    for (const r of rules ?? []) {
        if (r?.enabled === false)
            continue;
        const prior = active.find(a => a.app.toLowerCase() === String(r.app).toLowerCase());
        if (prior && prior.sink !== r.sink) {
            plan.skipped.push({app: r.app, reason: 'conflict', detail: `already routed to ${prior.sink}`});
            continue;
        }
        if (!prior)
            active.push(r);
    }
    for (const s of streams ?? []) {
        const rule = active.find(r => sameApp(s, r));
        if (!rule)
            continue;
        const target = sinks.get(rule.sink);
        if (!target)
            plan.skipped.push({stream: s.id, app: s.app, reason: 'target-missing'});
        else if (!usable(target))
            plan.skipped.push({stream: s.id, app: s.app, reason: 'target-unavailable'});
        else if (target.index === s.sinkIndex)
            plan.skipped.push({stream: s.id, app: s.app, reason: 'already-there'});
        else if (guard && !guard.allow(s.appId, now))
            plan.skipped.push({stream: s.id, app: s.app, reason: 'loop-guard'});
        else {
            plan.moves.push({stream: s.id, app: s.app, appId: s.appId, from: byIndex.get(s.sinkIndex)?.name ?? null, to: target.name});
            plan.commands.push(['pactl', 'move-sink-input', String(s.id), target.name]);
        }
    }
    return plan;
}

/** Marks a plan's moves as done in the guard (call only after the commands really ran). */
export function recordMoves(guard, plan, now) {
    for (const m of plan.moves)
        guard.record(m.appId, now);
}

/** A preset `{id, name, rules, volumes?: {app: 0..1}}` -> the rule plan plus volume commands for matching streams. */
export function planPreset(preset, streams, devices, opts = {}) {
    const plan = planRules(streams, devices, preset?.rules ?? [], opts);
    plan.volumeCommands = [];
    for (const [app, vol] of Object.entries(preset?.volumes ?? {})) {
        for (const s of streams.filter(x => sameApp(x, {app}))) {
            const p = planStreamVolume(s, {volume: vol}, opts);
            if (p.ok)
                plan.volumeCommands.push(...p.commands);
        }
    }
    return plan;
}

// ---- disconnect fallback

/**
 * A sink vanished or became unavailable. Streams that were on it (`sinkIndex === removed.index`) are moved to `preferred` when given and
 * usable, else to the current default, else to the first usable sink. PipeWire usually reroutes by itself; this is the explicit plan for
 * the cases it does not. The default device is only changed when `allowDefaultChange` is true and `defaultSink` is itself gone.
 */
export function planDisconnectFallback(streams, devices, removed, {preferred = null, defaultSink = null, allowDefaultChange = false} = {}) {
    const sinks = devices.filter(d => d.kind === 'sink' && d.index !== removed.index && usable(d) && !d.monitor);
    const pick = sinks.find(d => d.name === preferred) ?? sinks.find(d => d.name === defaultSink) ?? sinks[0] ?? null;
    const plan = {target: pick?.name ?? null, moves: [], commands: [], defaultChange: null};
    if (!pick)
        return {...plan, reason: 'no-sink-left'};
    for (const s of streams.filter(x => x.sinkIndex === removed.index)) {
        plan.moves.push({stream: s.id, app: s.app, from: removed.name, to: pick.name});
        plan.commands.push(['pactl', 'move-sink-input', String(s.id), pick.name]);
    }
    if (allowDefaultChange && (defaultSink === removed.name || defaultSink === null)) {
        plan.defaultChange = pick.name;
        plan.commands.push(['pactl', 'set-default-sink', pick.name]);
    }
    return plan;
}
