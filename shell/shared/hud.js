// Universal HUD / OverlayManager core (vNext initiative 22). Pure: no actors, no timers. The caller feeds `show()` events and a clock
// (`now` in ms), and asks `view(now)` what to draw; `nextExpiry()` tells it when to wake once. State is bounded (queue cap, text cap).
// HUDs are click-through by construction: `clickThrough` is always true and cannot be configured.

import {createMotion} from './tokens.js';

export const HUD_KINDS = ['volume', 'brightness', 'mic', 'media', 'battery', 'power-profile', 'bluetooth', 'network', 'custom'];
export const POSITIONS = ['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right', 'center'];
export const SIZES = ['small', 'medium', 'large'];
// Kinds GNOME Shell's own OSD also draws; only these can be "suppressed" (see `suppressNative`).
export const GNOME_OSD_KINDS = ['volume', 'brightness', 'mic'];
const QUEUE_MAX = 8;
const TEXT_MAX = 80;

export const DEFAULT_CONFIG = {
    position: 'bottom', size: 'medium', opacity: 0.92, duration: 1800, compact: false,
    monitor: 'focused',                 // 'primary' | 'focused' | a monitor index
    maxVisible: 3, dedupeMs: 600, suppressGnomeOsd: false,
    motion: {preset: 'smooth', reduced: false},
};

const num = (v, lo, hi, d) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;

/** Any input -> a valid config (unknown values fall back to the default; nothing throws). */
export function normalizeConfig(c = {}) {
    const d = DEFAULT_CONFIG;
    return {
        position: POSITIONS.includes(c.position) ? c.position : d.position,
        size: SIZES.includes(c.size) ? c.size : d.size,
        opacity: num(c.opacity, 0.3, 1, d.opacity),
        duration: Math.round(num(c.duration, 500, 10000, d.duration)),
        compact: c.compact === true,
        monitor: c.monitor === 'primary' || c.monitor === 'focused' ? c.monitor : Number.isInteger(c.monitor) && c.monitor >= 0 ? c.monitor : d.monitor,
        maxVisible: Math.round(num(c.maxVisible, 1, 5, d.maxVisible)),
        dedupeMs: Math.round(num(c.dedupeMs, 0, 5000, d.dedupeMs)),
        suppressGnomeOsd: c.suppressGnomeOsd === true,
        motion: {preset: typeof c.motion?.preset === 'string' ? c.motion.preset : d.motion.preset, reduced: c.motion?.reduced === true},
    };
}

/**
 * `createHud(config)`. Events: `show(kind, {value 0..1, label, icon, muted, key, urgent}, now)` -> `{action: 'created'|'updated'|'queued'|'dropped', id}`.
 * Same kind (same `key` for custom) already visible or ended within `dedupeMs` is updated and its expiry extended, never stacked.
 */
export function createHud(config = {}) {
    let cfg = normalizeConfig(config);
    let motion = createMotion(cfg.motion);
    let seq = 0;
    let visible = [];       // {id, kind, key, payload, shownAt, expiresAt}
    let queue = [];
    const recent = new Map();   // identity -> endedAt, for the dedupe window; bounded by HUD_KINDS size plus custom keys

    const ident = (kind, key) => kind === 'custom' ? `custom:${key ?? ''}` : kind;
    const clean = (kind, p = {}) => ({
        value: Number.isFinite(p.value) ? Math.min(1, Math.max(0, p.value)) : null,
        label: typeof p.label === 'string' ? p.label.slice(0, TEXT_MAX) : '',
        icon: typeof p.icon === 'string' ? p.icon.slice(0, 64) : '',
        muted: p.muted === true,
        urgent: p.urgent === true,
    });

    const expire = now => {
        for (const v of visible.filter(x => x.expiresAt <= now)) {
            recent.set(ident(v.kind, v.key), v.expiresAt);
            if (recent.size > 32)
                recent.delete(recent.keys().next().value);
        }
        visible = visible.filter(x => x.expiresAt > now);
        queue = queue.filter(q => now - q.shownAt < cfg.duration * 3);   // a queued HUD that waited too long is stale
        while (visible.length < cfg.maxVisible && queue.length) {
            const q = queue.shift();
            visible.push({...q, expiresAt: now + cfg.duration});
        }
    };

    return {
        get config() { return {...cfg, motion: {...cfg.motion}}; },
        /** Merge new settings; visible items stay (their expiry is not rewritten). */
        configure(next) { cfg = normalizeConfig({...cfg, ...next, motion: {...cfg.motion, ...next?.motion}}); motion = createMotion(cfg.motion); return this.config; },
        show(kind, payload, now) {
            if (!HUD_KINDS.includes(kind))
                return {action: 'dropped', reason: 'unknown-kind'};
            expire(now);
            const key = kind === 'custom' ? String(payload?.key ?? '').slice(0, 40) : null;
            const id = ident(kind, key);
            const p = clean(kind, payload);
            const live = visible.find(v => ident(v.kind, v.key) === id);
            const wasRecent = recent.has(id) && now - recent.get(id) < cfg.dedupeMs;
            if (live) {
                live.payload = p;
                live.expiresAt = now + cfg.duration;
                return {action: 'updated', id: live.id};
            }
            const queued = queue.find(q => ident(q.kind, q.key) === id);
            if (queued) {
                queued.payload = p;
                return {action: 'updated', id: queued.id, queued: true};
            }
            const item = {id: ++seq, kind, key, payload: p, shownAt: now, expiresAt: now + cfg.duration, replay: wasRecent};
            if (visible.length < cfg.maxVisible) {
                visible.push(item);
                return {action: 'created', id: item.id};
            }
            if (p.urgent) {                                     // urgent replaces the oldest non-urgent visible item
                const idx = visible.findIndex(v => !v.payload.urgent);
                if (idx >= 0) {
                    visible.splice(idx, 1, item);
                    return {action: 'created', id: item.id};
                }
            }
            if (queue.length >= QUEUE_MAX)
                return {action: 'dropped', reason: 'queue-full'};
            queue.push(item);
            return {action: 'queued', id: item.id};
        },
        /** What to draw at `now`: placement, sizing, and animation durations (all 0 under reduced motion). */
        view(now) {
            expire(now);
            return {
                position: cfg.position, size: cfg.compact ? 'small' : cfg.size, compact: cfg.compact, opacity: cfg.opacity, monitor: cfg.monitor,
                clickThrough: true,
                items: visible.map(v => ({id: v.id, kind: v.kind, ...v.payload, expiresAt: v.expiresAt, remaining: v.expiresAt - now})),
                queued: queue.length,
                animation: {in: motion.duration('fast', 'hud'), out: motion.duration('normal', 'hud'), animated: motion.duration('fast', 'hud') > 0},
            };
        },
        /** The earliest expiry (ms) so the caller arms one timer; null when nothing is shown. */
        nextExpiry() { return visible.length ? Math.min(...visible.map(v => v.expiresAt)) : null; },
        /** Whether the native GNOME OSD for `kind` should be hidden: only when the flag is on and GNOME draws that kind itself. */
        suppressNative(kind) { return cfg.suppressGnomeOsd && GNOME_OSD_KINDS.includes(kind); },
        dismiss(id) { visible = visible.filter(v => v.id !== id); queue = queue.filter(q => q.id !== id); },
        clear() { visible = []; queue = []; recent.clear(); },
    };
}
