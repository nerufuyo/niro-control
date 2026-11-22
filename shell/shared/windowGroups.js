// Window groups and workspace memory core (vNext 7.4 and 7.5). Pure plain data: every function returns a new value and a PLAN of what
// the shell could do; nothing here touches a window. Windows are matched by app id plus title, with safe fallbacks, and a window or a
// monitor that is gone is reported in the plan (skipped / redirected), never an error. Bounded: group, member and layout counts are capped.

export const MAX_GROUPS = 50;
export const MAX_MEMBERS = 50;
export const MAX_LAYOUT = 200;
export const MAX_NAME = 60;

const clean = v => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
const nameOf = v => clean(v).slice(0, MAX_NAME);
const int = (v, d = 0) => (Number.isInteger(v) && v >= 0 ? v : d);
const lc = v => clean(v).toLowerCase();

/** A member remembers how to find a window again: app id, title and a live id that may have gone stale. */
export function makeMember(w) {
    return {appId: lc(w.appId), title: clean(w.title), windowId: w.id ?? w.windowId ?? null};
}

/**
 * Find the live window a remembered entry means. Order: same live id and same app (a reused id for another app is rejected), then
 * app + exact title, then app + title containing/contained, then the only window of that app. Ambiguity returns null (safe: do nothing).
 * `taken` is a Set of live ids already claimed, so two entries cannot grab the same window.
 */
export function matchWindow(entry, live, taken = new Set()) {
    const free = live.filter(w => !taken.has(w.id));
    const app = lc(entry.appId);
    const sameApp = free.filter(w => lc(w.appId) === app);
    if (entry.windowId !== null && entry.windowId !== undefined) {
        const byId = sameApp.find(w => w.id === entry.windowId);
        if (byId) return byId;
    }
    if (!app) return null;
    const title = clean(entry.title).toLowerCase();
    const exact = sameApp.filter(w => clean(w.title).toLowerCase() === title);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    if (title) {
        const part = sameApp.filter(w => {
            const t = clean(w.title).toLowerCase();
            return t && (t.includes(title) || title.includes(t));
        });
        if (part.length === 1) return part[0];
        if (part.length > 1) return null;
    }
    // Sole-window fallback counts every live window of the app, so a taken sibling cannot make a wrong window look unique.
    return sameApp.length === 1 && live.filter(w => lc(w.appId) === app).length === 1 ? sameApp[0] : null;
}

/** Groups store: a plain object {groups: []}. All mutators return a new store. */
export const emptyStore = () => ({version: 1, groups: []});

const uid = (store, name) => {
    const base = nameOf(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
    let id = base, n = 2;
    while (store.groups.some(g => g.id === id)) id = `${base}-${n++}`;
    return id;
};

export function createGroup(store, name, windows = []) {
    if (!nameOf(name)) throw new Error('a group needs a name');
    if (store.groups.length >= MAX_GROUPS) throw new Error('too many groups');
    if (store.groups.some(g => g.name.toLowerCase() === nameOf(name).toLowerCase())) throw new Error('a group with that name exists');
    const group = {id: uid(store, name), name: nameOf(name), members: windows.slice(0, MAX_MEMBERS).map(makeMember), target: null};
    return {store: {...store, groups: [...store.groups, group]}, group};
}

const mapGroup = (store, id, fn) => {
    if (!store.groups.some(g => g.id === id)) throw new Error(`no group "${id}"`);
    return {...store, groups: store.groups.map(g => (g.id === id ? fn(g) : g))};
};

export function renameGroup(store, id, name) {
    const n = nameOf(name);
    if (!n) throw new Error('a group needs a name');
    if (store.groups.some(g => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) throw new Error('a group with that name exists');
    return mapGroup(store, id, g => ({...g, name: n}));
}

export function deleteGroup(store, id) {
    return {...store, groups: store.groups.filter(g => g.id !== id)};
}

export function addWindow(store, id, w) {
    return mapGroup(store, id, g => {
        const m = makeMember(w);
        if (g.members.some(x => x.windowId !== null && x.windowId === m.windowId)) return g;
        if (g.members.length >= MAX_MEMBERS) throw new Error('too many windows in a group');
        return {...g, members: [...g.members, m]};
    });
}

/** Remove by live id, or by app + title when the id is stale. */
export function removeWindow(store, id, w) {
    return mapGroup(store, id, g => ({
        ...g,
        members: g.members.filter(x => !((w.id != null && x.windowId === w.id) || (w.id == null && x.appId === lc(w.appId) && x.title === clean(w.title)))),
    }));
}

/** Remember where the group should live: {workspace?, monitor?} (monitor is an identity key from monitorManager, or an index). */
export function setTarget(store, id, target) {
    return mapGroup(store, id, g => ({...g, target: {workspace: Number.isInteger(target.workspace) ? target.workspace : null, monitor: target.monitor ?? null}}));
}

/**
 * Plan moving a group to a workspace and/or monitor. `live`: [{id, appId, title, workspace, monitor}]; `monitors`: connected monitor keys.
 * Returns {moves: [{windowId, workspace, monitor}], missing: [member], redirected: bool, notes: []}.
 * A target monitor that is not connected is dropped (the windows stay on their current monitor) and noted.
 */
export function planMove(group, target, live, monitors = []) {
    const taken = new Set(), moves = [], missing = [], notes = [];
    let monitor = target.monitor ?? null, redirected = false;
    if (monitor !== null && monitors.length && !monitors.includes(monitor)) {
        notes.push(`monitor ${monitor} is not connected; windows keep their monitor`);
        monitor = null;
        redirected = true;
    }
    for (const m of group.members) {
        const w = matchWindow(m, live, taken);
        if (!w) { missing.push(m); continue; }
        taken.add(w.id);
        const ws = Number.isInteger(target.workspace) ? target.workspace : null;
        if ((ws === null || w.workspace === ws) && (monitor === null || w.monitor === monitor)) continue;
        moves.push({windowId: w.id, workspace: ws, monitor});
    }
    return {moves, missing, redirected, notes};
}

/** Restore plan for a group: its stored target, applied to whatever of it is still open. Needs a stored target. */
export function restorePlan(group, live, monitors = []) {
    if (!group.target || (group.target.workspace === null && group.target.monitor === null))
        return {moves: [], missing: [], redirected: false, notes: ['no target stored for this group']};
    return planMove(group, group.target, live, monitors);
}

// ---- workspace memory ----

/** Capture a layout: one entry per window, remembering monitor, workspace and size. Capped. */
export function captureLayout(live, {name = 'layout', at = 0} = {}) {
    return {
        name: nameOf(name) || 'layout',
        at,
        entries: live.slice(0, MAX_LAYOUT).map(w => ({
            appId: lc(w.appId), title: clean(w.title), windowId: w.id ?? null,
            workspace: int(w.workspace), monitor: w.monitor ?? null,
            rect: w.rect ? {x: int(w.rect.x), y: int(w.rect.y), width: int(w.rect.width, 1), height: int(w.rect.height, 1)} : null,
        })),
    };
}

const clamp = (rect, area) => {
    if (!rect || !area) return rect;
    const width = Math.min(rect.width, area.width), height = Math.min(rect.height, area.height);
    const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
    return {x, y, width, height};
};

/**
 * Plan restoring a layout. `monitors`: [{key, workArea:{x,y,width,height}, primary?}] currently connected; `workspaces`: count.
 * A vanished monitor falls back to the primary (or the first one); a workspace past the end is clamped to the last. The rect is clamped
 * into the work area so a window cannot be placed off screen. Windows no longer open are listed as `missing`, not launched.
 */
export function planRestore(layout, live, monitors = [], {workspaces = 1} = {}) {
    const taken = new Set(), actions = [], missing = [], notes = [];
    const fallback = monitors.find(m => m.primary) ?? monitors[0] ?? null;
    for (const e of layout.entries) {
        const w = matchWindow(e, live, taken);
        if (!w) { missing.push({appId: e.appId, title: e.title}); continue; }
        taken.add(w.id);
        let mon = monitors.find(m => m.key === e.monitor) ?? null, fellBack = false;
        if (!mon && fallback) { mon = fallback; fellBack = true; }
        const ws = Math.min(e.workspace, Math.max(0, workspaces - 1));
        const rect = e.rect ? clamp(e.rect, mon?.workArea) : null;
        if (fellBack) notes.push(`${e.appId}: monitor gone, placed on ${mon.key}`);
        if (ws !== e.workspace) notes.push(`${e.appId}: workspace ${e.workspace + 1} gone, placed on ${ws + 1}`);
        actions.push({windowId: w.id, workspace: ws, monitor: mon ? mon.key : null, rect, fellBack});
    }
    return {actions, missing, notes};
}

/** Layouts kept by name, newest first, capped. */
export function saveLayout(layouts, layout, max = 10) {
    return [layout, ...layouts.filter(l => l.name !== layout.name)].slice(0, max);
}
