// Desktop widget core (vNext initiative 5). Pure: manifests, a shared data hub, grid and overlap math, a versioned layout schema.
// No timers and no listeners: the hub is a schedule the caller polls with `due(now)`; nothing here draws or touches a window.

import {CAPABILITIES} from './permissions.js';

export const MIN_REFRESH_MS = 1000;
export const MAX_WIDGETS = 40;
export const LAYOUT_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const POLICIES = ['interval', 'manual', 'event'];

const isSize = s => s && Number.isInteger(s.w) && Number.isInteger(s.h) && s.w >= 1 && s.h >= 1 && s.w <= 64 && s.h <= 64;

/** {ok, errors[]}. Sizes are in grid cells. A provider id is required so polling can be shared. */
export function validateWidgetManifest(m) {
    const errors = [];
    if (m === null || typeof m !== 'object' || Array.isArray(m))
        return {ok: false, errors: ['manifest must be an object']};
    if (typeof m.id !== 'string' || !ID_RE.test(m.id) || m.id.length > 60)
        errors.push('invalid id');
    if (typeof m.title !== 'string' || m.title.trim() === '' || m.title.length > 60)
        errors.push('title must be 1 to 60 characters');
    const sz = m.size;
    if (!sz || !isSize(sz.min) || !isSize(sz.max) || !isSize(sz.default))
        errors.push('size needs min, max and default as whole cells');
    else if (sz.min.w > sz.max.w || sz.min.h > sz.max.h || sz.default.w < sz.min.w || sz.default.w > sz.max.w || sz.default.h < sz.min.h || sz.default.h > sz.max.h)
        errors.push('size must satisfy min <= default <= max');
    const r = m.refresh;
    if (!r || !POLICIES.includes(r.policy))
        errors.push(`refresh.policy must be one of ${POLICIES.join(', ')}`);
    else if (r.policy === 'interval' && !(Number.isFinite(r.intervalMs) && r.intervalMs >= MIN_REFRESH_MS && r.intervalMs <= 86400000))
        errors.push(`refresh.intervalMs must be at least ${MIN_REFRESH_MS}`);
    if (typeof m.provider !== 'string' || !ID_RE.test(m.provider))
        errors.push('provider id is required');
    if (!Array.isArray(m.permissions) || m.permissions.some(p => !CAPABILITIES.includes(p)))
        errors.push('permissions must be a list of known capabilities');
    return {ok: errors.length === 0, errors};
}

// ---- shared data hub -----------------------------------------------------------------------------------------------------

/** One schedule per provider, however many widgets use it. A provider is due when it has at least one visible, non-errored
 * subscriber and its shortest interval has passed since the last refresh. Manual and event widgets never make a provider due. */
export function createHub() {
    const subs = new Map();       // widgetId -> {provider, intervalMs, visible, errored}
    const last = new Map();       // provider -> time of the last refresh
    const live = s => s.visible && !s.errored;
    return {
        subscribe(widgetId, manifest, {visible = true} = {}) {
            if (!validateWidgetManifest(manifest).ok)
                return false;
            if (!subs.has(widgetId) && subs.size >= MAX_WIDGETS)
                return false;
            subs.set(widgetId, {provider: manifest.provider, intervalMs: manifest.refresh.policy === 'interval' ? manifest.refresh.intervalMs : null, visible, errored: false});
            return true;
        },
        unsubscribe(widgetId) {
            const s = subs.get(widgetId);
            subs.delete(widgetId);
            if (s && ![...subs.values()].some(x => x.provider === s.provider))
                last.delete(s.provider);
        },
        setVisible(widgetId, visible) { const s = subs.get(widgetId); if (s) s.visible = !!visible; },
        /** A failing widget is marked errored and skipped; the others keep refreshing. */
        reportError(widgetId) { const s = subs.get(widgetId); if (s) s.errored = true; },
        clearError(widgetId) { const s = subs.get(widgetId); if (s) s.errored = false; },
        isErrored: widgetId => subs.get(widgetId)?.errored === true,
        /** Providers to refresh at `now`. Empty when every subscriber is hidden or errored. */
        due(now) {
            const intervals = new Map();
            for (const s of subs.values())
                if (live(s) && s.intervalMs !== null)
                    intervals.set(s.provider, Math.min(intervals.get(s.provider) ?? Infinity, s.intervalMs));
            return [...intervals].filter(([p, iv]) => !last.has(p) || now - last.get(p) >= iv).map(([p]) => p);
        },
        markRefreshed(provider, now) { last.set(provider, now); },
        /** Ms until the next provider is due, or null when nothing needs scheduling (so the caller may stop its timer). */
        nextDelay(now) {
            const d = this.due(now);
            if (d.length)
                return 0;
            let best = null;
            const intervals = new Map();
            for (const s of subs.values())
                if (live(s) && s.intervalMs !== null)
                    intervals.set(s.provider, Math.min(intervals.get(s.provider) ?? Infinity, s.intervalMs));
            for (const [p, iv] of intervals) {
                const wait = Math.max(0, iv - (now - (last.get(p) ?? -Infinity)));
                best = best === null ? wait : Math.min(best, wait);
            }
            return best;
        },
        /** Widgets that read a provider, for delivering one fetch to all of them (errored and hidden ones excluded). */
        subscribers: provider => [...subs].filter(([, s]) => s.provider === provider && live(s)).map(([id]) => id),
        count: () => subs.size,
    };
}

// ---- grid and geometry -----------------------------------------------------------------------------------------------------

/** Rects are {x, y, w, h}. Widget rects are in cells; window rects in pixels (use cellRect to convert). */
export function snapToGrid(rect, grid) {
    const {cols, rows} = grid;
    const w = Math.min(Math.max(1, Math.round(rect.w)), cols);
    const h = Math.min(Math.max(1, Math.round(rect.h)), rows);
    return {x: Math.min(Math.max(0, Math.round(rect.x)), cols - w), y: Math.min(Math.max(0, Math.round(rect.y)), rows - h), w, h};
}

/** Pixel position -> cell rect: `px` = {x, y, w, h}; cell = {w, h, gap}. */
export function pixelsToCells(px, cell) {
    const sx = cell.w + (cell.gap ?? 0);
    const sy = cell.h + (cell.gap ?? 0);
    return {x: px.x / sx, y: px.y / sy, w: (px.w + (cell.gap ?? 0)) / sx, h: (px.h + (cell.gap ?? 0)) / sy};
}

export function cellRect(r, cell, origin = {x: 0, y: 0}) {
    const gap = cell.gap ?? 0;
    return {x: origin.x + r.x * (cell.w + gap), y: origin.y + r.y * (cell.h + gap), w: r.w * cell.w + (r.w - 1) * gap, h: r.h * cell.h + (r.h - 1) * gap};
}

/** Clamps a requested size to the manifest's min and max, and to what is left of the grid at (x, y). */
export function clampSize(size, manifest, grid = null, at = null) {
    let w = Math.min(Math.max(Math.round(size.w), manifest.size.min.w), manifest.size.max.w);
    let h = Math.min(Math.max(Math.round(size.h), manifest.size.min.h), manifest.size.max.h);
    if (grid && at) {
        w = Math.max(Math.min(w, grid.cols - at.x), Math.min(manifest.size.min.w, grid.cols));
        h = Math.max(Math.min(h, grid.rows - at.y), Math.min(manifest.size.min.h, grid.rows));
    }
    return {w, h};
}

export function intersects(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Windows a widget (in pixels) would cover. Returns [{index, area, fraction}], largest first; empty means no overlap. Widgets
 * must not cover windows unexpectedly, so the caller shows or avoids these instead of hiding them. */
export function overlaps(widgetPx, windowRects) {
    const out = [];
    (windowRects ?? []).forEach((w, index) => {
        if (!intersects(widgetPx, w))
            return;
        const ix = Math.min(widgetPx.x + widgetPx.w, w.x + w.w) - Math.max(widgetPx.x, w.x);
        const iy = Math.min(widgetPx.y + widgetPx.h, w.y + w.h) - Math.max(widgetPx.y, w.y);
        const area = ix * iy;
        out.push({index, area, fraction: w.w * w.h > 0 ? area / (w.w * w.h) : 0});
    });
    return out.sort((a, b) => b.area - a.area);
}

// ---- persistence -------------------------------------------------------------------------------------------------------

/** {version, grid, widgets: [{id, widget, x, y, w, h}]}; `id` is the instance, `widget` the manifest id. */
export function serializeLayout(grid, placed) {
    return JSON.stringify({version: LAYOUT_VERSION, grid: {cols: grid.cols, rows: grid.rows},
        widgets: placed.slice(0, MAX_WIDGETS).map(p => ({id: p.id, widget: p.widget, x: p.x, y: p.y, w: p.w, h: p.h}))});
}

/** Untrusted input: bad JSON or a newer version gives an empty layout, invalid or duplicate entries are skipped and counted.
 * `manifests` (optional, by id) clamps sizes and drops widgets that are no longer installed. */
export function loadLayout(text, manifests = null) {
    const empty = {grid: {cols: 12, rows: 8}, widgets: [], skipped: 0};
    let d;
    try { d = JSON.parse(text); } catch (_e) { return {...empty, error: 'not valid JSON'}; }
    if (!d || d.version !== LAYOUT_VERSION)
        return {...empty, error: 'unsupported layout version'};
    const cols = Number.isInteger(d.grid?.cols) && d.grid.cols >= 1 && d.grid.cols <= 64 ? d.grid.cols : null;
    const rows = Number.isInteger(d.grid?.rows) && d.grid.rows >= 1 && d.grid.rows <= 64 ? d.grid.rows : null;
    if (!cols || !rows)
        return {...empty, error: 'invalid grid'};
    const grid = {cols, rows};
    const widgets = [];
    const seen = new Set();
    let skipped = 0;
    for (const w of Array.isArray(d.widgets) ? d.widgets : []) {
        const ok = w && typeof w.id === 'string' && ID_RE.test(w.id) && typeof w.widget === 'string' && ID_RE.test(w.widget) && !seen.has(w.id) &&
            [w.x, w.y, w.w, w.h].every(Number.isInteger) && w.w >= 1 && w.h >= 1 && widgets.length < MAX_WIDGETS;
        const m = manifests?.[w?.widget];
        if (!ok || (manifests && !m)) {
            skipped++;
            continue;
        }
        seen.add(w.id);
        let rect = {x: w.x, y: w.y, ...(m ? clampSize(w, m) : {w: w.w, h: w.h})};
        rect = snapToGrid(rect, grid);
        widgets.push({id: w.id, widget: w.widget, ...rect});
    }
    return {grid, widgets, skipped};
}
