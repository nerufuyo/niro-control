// SPDX-License-Identifier: GPL-3.0-or-later
// What the tiling is told, in plain data: which layout a workspace or monitor has, and the rules for applications. Pure (no shell), so
// the extension, the panel and the command line all read and check it the same way, and it is tested without a shell.
//
// `layout-map` (a setting, JSON): {"workspaces": {"2": "grid"}, "monitors": {"1": "master-left"}}. Workspaces count from 1. A workspace's
// own layout wins over its monitor's, which wins over the general `layout` setting.
// `window-rules` (a setting, JSON): [{"match": "org.gnome.Calculator", "action": "float"}, {"match": "firefox", "workspace": 2}].
// `action` is "float" (never tiled) or "tile" (tiled even where it would not be); `workspace` (from 1) sends the window there when it opens.

import {LAYOUT_IDS} from './layouts.js';

export const ACTIONS = ['float', 'tile'];

const isIndex = key => /^[1-9]\d{0,3}$/.test(key) || key === '0';

/** The map as an object, or `{workspaces: {}, monitors: {}}` for anything that is not one. Unknown layouts and keys are dropped. */
export function parseLayoutMap(text) {
    const out = {workspaces: {}, monitors: {}};
    let data;
    try {
        data = typeof text === 'string' ? JSON.parse(text || '{}') : text;
    } catch (_e) {
        return out;
    }
    if (!data || typeof data !== 'object')
        return out;
    for (const part of ['workspaces', 'monitors']) {
        for (const [key, layout] of Object.entries(data[part] ?? {})) {
            if (isIndex(key) && LAYOUT_IDS.includes(layout))
                out[part][key] = layout;
        }
    }
    return out;
}

/** Why a map is not good, one sentence for each thing wrong: the command line and the panel say them. Empty when it is fine. */
export function checkLayoutMap(text) {
    const problems = [];
    let data;
    try {
        data = JSON.parse(text || '{}');
    } catch (e) {
        return [`not JSON: ${e.message}`];
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return ['not an object'];
    for (const part of ['workspaces', 'monitors']) {
        for (const [key, layout] of Object.entries(data[part] ?? {})) {
            if (!isIndex(key))
                problems.push(`${part}: "${key}" is not a number`);
            if (!LAYOUT_IDS.includes(layout))
                problems.push(`${part}.${key}: "${layout}" is not a layout`);
        }
    }
    return problems;
}

/** The layout for a workspace (counted from 0, as GNOME does) on a monitor: the workspace's own, else the monitor's, else `fallback`. */
export function resolveLayout(map, workspace, monitor, fallback) {
    return map.workspaces[String(workspace + 1)] ?? map.monitors[String(monitor)] ?? fallback;
}

/** `map` with `layout` set for what is given: a workspace (from 0), a monitor, or neither, which is `null` here (the general layout). */
export function withLayout(map, layout, {workspace = null, monitor = null} = {}) {
    const next = {workspaces: {...map.workspaces}, monitors: {...map.monitors}};
    if (workspace !== null && workspace >= 0)
        next.workspaces[String(workspace + 1)] = layout;
    else if (monitor !== null && monitor >= 0)
        next.monitors[String(monitor)] = layout;
    return next;
}

/** `map` without the layout of a workspace or a monitor. */
export function withoutLayout(map, {workspace = null, monitor = null} = {}) {
    const next = {workspaces: {...map.workspaces}, monitors: {...map.monitors}};
    if (workspace !== null && workspace >= 0)
        delete next.workspaces[String(workspace + 1)];
    if (monitor !== null && monitor >= 0)
        delete next.monitors[String(monitor)];
    return next;
}

/** The rules as an array of `{match, action?, workspace?}`; what is not a rule is dropped. */
export function parseRules(text) {
    let data;
    try {
        data = typeof text === 'string' ? JSON.parse(text || '[]') : text;
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(data))
        return [];
    return data.filter(r => r && typeof r.match === 'string' && r.match.trim() !== '' && (r.action === undefined || ACTIONS.includes(r.action))
        && (r.workspace === undefined || (Number.isInteger(r.workspace) && r.workspace >= 1 && r.workspace <= 36)))
        .map(r => ({match: r.match.trim(), ...(r.action ? {action: r.action} : {}), ...(r.workspace ? {workspace: r.workspace} : {})}));
}

export function checkRules(text) {
    const problems = [];
    let data;
    try {
        data = JSON.parse(text || '[]');
    } catch (e) {
        return [`not JSON: ${e.message}`];
    }
    if (!Array.isArray(data))
        return ['not a list'];
    data.forEach((r, i) => {
        if (!r || typeof r.match !== 'string' || r.match.trim() === '')
            problems.push(`rule ${i + 1}: "match" is missing`);
        if (r?.action !== undefined && !ACTIONS.includes(r.action))
            problems.push(`rule ${i + 1}: action "${r.action}" is not float or tile`);
        if (r?.workspace !== undefined && !(Number.isInteger(r.workspace) && r.workspace >= 1 && r.workspace <= 36))
            problems.push(`rule ${i + 1}: workspace must be a number from 1 to 36`);
        if (r && r.action === undefined && r.workspace === undefined)
            problems.push(`rule ${i + 1}: it does nothing (no action, no workspace)`);
    });
    return problems;
}

/** The first rule that names one of the window's classes (case does not matter), or null. */
export function matchRule(rules, classes) {
    const names = classes.filter(Boolean).map(c => c.toLowerCase());
    return rules.find(r => names.includes(r.match.toLowerCase())) ?? null;
}

/**
 * The window nearest to `from` in `direction` ('left', 'right', 'up', 'down'): its centre lies that way, and the closer along the
 * direction and the more it faces the window, the better. `rects` are `{x, y, width, height}`; the result is an index, or -1.
 */
export function neighbor(rects, from, direction) {
    const c = r => [r.x + r.width / 2, r.y + r.height / 2];
    const [fx, fy] = c(rects[from]);
    let best = -1, bestScore = Infinity;
    rects.forEach((r, i) => {
        if (i === from)
            return;
        const [x, y] = c(r);
        const along = {left: fx - x, right: x - fx, up: fy - y, down: y - fy}[direction];
        if (along <= 0)
            return;
        const across = direction === 'left' || direction === 'right' ? Math.abs(y - fy) : Math.abs(x - fx);
        const score = along + across * 2;   // a window straight across beats one that is nearer but off to the side
        if (score < bestScore) {
            best = i;
            bestScore = score;
        }
    });
    return best;
}
