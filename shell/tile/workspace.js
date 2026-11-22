// SPDX-License-Identifier: GPL-3.0-or-later
// The workspace features of Tile, as plain logic: window groups, session snapshots and monitor recovery. Nothing here imports GNOME: the
// shell is reached through `host` and the pure cores (shell/shared/windowGroups.js, snapshot.js, monitorManager.js) are passed in as `core`,
// so the whole of it runs under node with a fake host (tests/island/tileWorkspace.test.js) and under the real shell (extension.js).
//
// host: {
//   liveWindows()                -> [{id, appId, title, workspace (1-based, 0 = on all), monitor (index), rect:{x,y,width,height}}]
//   monitors()                   -> [{index, connector, vendor, product, serial, width, height (logical), scale, x, y, primary}]
//   nWorkspaces(), activeWorkspace() (1-based), focusedId()
//   moveWindow(id, {workspace, monitor, rect}) -> bool    (workspace 1-based or null, monitor an index or null, rect global or null)
//   focusWindows(ids), switchWorkspace(n)
//   launch(appId) -> {ok, reason}
//   load(name) -> object|null, save(name, object)
//   now() -> ms, recoveryEnabled() -> bool
// }
// Every call answers {api, ok, ...}; a failure is {ok:false, error}. Windows and apps that are gone are reported in the answer, never an error.

export const API = 1;
export const GROUPS_FILE = 'tile-groups.json';
export const SNAPSHOTS_FILE = 'tile-snapshots.json';
export const GROUP_OPS = ['list', 'create', 'add', 'remove', 'rename', 'delete', 'remember', 'activate', 'restore'];
export const SNAPSHOT_OPS = ['take', 'list', 'delete', 'pin', 'diff', 'plan', 'restore', 'launch', 'retain'];
const MAX_REMEMBERED = 200;
const SNAPSHOT_NOTE = 'Only each window\'s workspace and monitor are put back. What is open inside an app is not saved or restored, and nothing is closed.';

export function createWorkspaceService({core, host}) {
    const {groups: G, snapshot: S, monitors: M} = core;
    let last = null;          // the monitors as they were when we last looked
    let noted = new Map();    // window id -> {monitor key, rect relative to that monitor}, taken while the monitors were steady
    let memory = {};          // monitor key -> windows displaced from it
    let lastEvent = null;

    const ok = extra => ({api: API, ok: true, ...extra});
    const fail = message => ({api: API, ok: false, error: message});

    // ---- the shell, seen through the cores

    const monitorList = () => host.monitors().map(m => ({...M.monitorIdentity({...m, width: Math.round(m.width * (m.scale || 1))}), index: m.index}));
    const keyOf = (mons, index) => mons.find(m => m.index === index)?.key ?? null;
    const indexOf = (mons, key) => mons.find(m => m.key === key)?.index ?? null;

    /** Live windows in the cores' shape: monitor as an identity key, workspace 1-based. */
    function live(mons = monitorList()) {
        return host.liveWindows().map(w => ({id: w.id, appId: w.appId ?? '', title: w.title ?? '', workspace: w.workspace, monitor: keyOf(mons, w.monitor), monitorIndex: w.monitor, rect: w.rect}));
    }

    const readStore = (file, empty) => {
        const v = host.load(file);
        return v && typeof v === 'object' ? v : empty;
    };
    const groupStore = () => {
        const s = readStore(GROUPS_FILE, G.emptyStore());
        return {version: 1, groups: Array.isArray(s.groups) ? s.groups.filter(g => g && typeof g.id === 'string' && Array.isArray(g.members)) : []};
    };

    // ---- groups

    function groupView(g, windows, mons) {
        const taken = new Set();
        const members = g.members.map(m => {
            const w = G.matchWindow(m, windows, taken);
            if (w) taken.add(w.id);
            return {appId: m.appId, title: m.title, open: Boolean(w), windowId: w ? w.id : null};
        });
        const t = g.target;
        return {
            id: g.id, name: g.name, members, open: members.filter(m => m.open).length, closed: members.filter(m => !m.open).length,
            target: t ? {workspace: t.workspace, monitor: t.monitor, monitorIndex: t.monitor === null ? null : indexOf(mons, t.monitor), monitorConnected: t.monitor === null ? null : indexOf(mons, t.monitor) !== null} : null,
        };
    }

    /** What moving the group's windows to its target needs; windows on all workspaces are never given a workspace move. */
    function groupPlan(group, windows, mons) {
        const target = group.target;
        const prepared = windows.map(w => (w.workspace === 0 && target?.workspace ? {...w, workspace: target.workspace} : w));
        const plan = G.restorePlan(group, prepared, mons.map(m => m.key));
        const nws = host.nWorkspaces();
        for (const m of plan.moves)
            if (m.workspace !== null && m.workspace > nws) m.workspace = nws;
        return plan;
    }

    function applyMoves(moves, mons) {
        const applied = [], failed = [];
        for (const m of moves) {
            let done = false, reason = 'the shell refused';
            try {
                done = host.moveWindow(m.windowId, {workspace: m.workspace ?? null, monitor: m.monitor === null || m.monitor === undefined ? null : indexOf(mons, m.monitor), rect: m.rect ?? null});
            } catch (e) {
                reason = e.message;
            }
            (done ? applied : failed).push(done ? {windowId: m.windowId} : {windowId: m.windowId, reason});
        }
        return {applied, failed};
    }

    const groupOp = {
        list() {
            const mons = monitorList(), windows = live(mons);
            return ok({groups: groupStore().groups.map(g => groupView(g, windows, mons))});
        },
        create({name, windowIds}) {
            const mons = monitorList(), windows = live(mons);
            // an explicit list (even an empty one) is used as given; none at all means the focused window
            const ids = Array.isArray(windowIds) ? windowIds : (host.focusedId() ? [host.focusedId()] : []);
            const chosen = ids.map(id => windows.find(w => w.id === id)).filter(Boolean);
            const {store, group} = G.createGroup(groupStore(), name, chosen);
            const first = chosen[0];
            const saved = first ? G.setTarget(store, group.id, {workspace: first.workspace || null, monitor: first.monitor}) : store;
            host.save(GROUPS_FILE, saved);
            return ok({group: groupView(saved.groups.find(g => g.id === group.id), windows, mons), skipped: ids.length - chosen.length});
        },
        add({id, windowId}) {
            const mons = monitorList(), windows = live(mons);
            const wid = windowId || host.focusedId();
            const w = windows.find(x => x.id === wid);
            if (!w) throw new Error('that window is not open (focus the window you want to add)');
            let store = G.addWindow(groupStore(), id, w);
            // the first window of a group that has no place yet gives it one
            if (!store.groups.find(g => g.id === id).target) store = G.setTarget(store, id, {workspace: w.workspace || null, monitor: w.monitor});
            host.save(GROUPS_FILE, store);
            return ok({group: groupView(store.groups.find(g => g.id === id), windows, mons)});
        },
        remove({id, windowId}) {
            const mons = monitorList(), windows = live(mons);
            const w = windows.find(x => x.id === windowId);
            const store = G.removeWindow(groupStore(), id, w ?? {id: windowId, appId: '', title: ''});
            host.save(GROUPS_FILE, store);
            return ok({group: groupView(store.groups.find(g => g.id === id), windows, mons)});
        },
        rename({id, name}) {
            const store = G.renameGroup(groupStore(), id, name);
            host.save(GROUPS_FILE, store);
            const mons = monitorList();
            return ok({group: groupView(store.groups.find(g => g.id === id), live(mons), mons)});
        },
        delete({id}) {
            const before = groupStore();
            if (!before.groups.some(g => g.id === id)) throw new Error(`no group "${id}"`);
            host.save(GROUPS_FILE, G.deleteGroup(before, id));
            return ok({deleted: id});
        },
        /** Keep where the group's open windows are now as the group's place (the first open member sets it). */
        remember({id}) {
            const mons = monitorList(), windows = live(mons);
            const store = groupStore(), g = store.groups.find(x => x.id === id);
            if (!g) throw new Error(`no group "${id}"`);
            const w = G.matchWindow(g.members[0] ?? {appId: '', title: ''}, windows) ?? g.members.map(m => G.matchWindow(m, windows)).find(Boolean);
            if (!w) throw new Error('none of its windows is open, so there is no place to remember');
            const saved = G.setTarget(store, id, {workspace: w.workspace || null, monitor: w.monitor});
            host.save(GROUPS_FILE, saved);
            return ok({group: groupView(saved.groups.find(x => x.id === id), windows, mons)});
        },
        activate: args => groupMove(args, true),
        restore: args => groupMove(args, false),
    };

    /** restore: windows to the group's place. activate: the same, then the workspace is shown and the windows raised. `preview` changes nothing. */
    function groupMove({id, preview = false}, focus) {
        const mons = monitorList(), windows = live(mons);
        const g = groupStore().groups.find(x => x.id === id);
        if (!g) throw new Error(`no group "${id}"`);
        const view = groupView(g, windows, mons);
        const plan = groupPlan(g, windows, mons);
        const out = {group: view, preview: Boolean(preview), planned: plan.moves.length, closed: view.members.filter(m => !m.open).map(m => ({appId: m.appId, title: m.title})), notes: plan.notes, applied: [], failed: [], focused: false};
        if (preview) return ok(out);
        const r = applyMoves(plan.moves, mons);
        out.applied = r.applied; out.failed = r.failed;
        if (focus) {
            const open = view.members.filter(m => m.open).map(m => m.windowId);
            if (open.length) {
                const ws = g.target?.workspace ?? windows.find(w => w.id === open[0])?.workspace;
                if (ws) host.switchWorkspace(Math.min(ws, host.nWorkspaces()));
                host.focusWindows([...open].reverse());   // the first member is raised last: it ends up focused
                out.focused = true;
            } else {
                out.notes = [...out.notes, 'none of the group\'s windows is open'];
            }
        }
        return ok(out);
    }

    // ---- snapshots

    const snapStore = () => {
        const s = readStore(SNAPSHOTS_FILE, {version: 1, snapshots: []});
        const snapshots = [];
        let invalid = 0;
        for (const x of Array.isArray(s.snapshots) ? s.snapshots : []) {
            try { snapshots.push({...S.migrateSnapshot(x), id: String(x.id), name: String(x.name ?? ''), at: Number(x.at) || 0, pinned: Boolean(x.pinned)}); } catch (_e) { invalid++; }
        }
        return {snapshots, invalid};
    };
    const saveSnaps = snapshots => host.save(SNAPSHOTS_FILE, {version: 1, snapshots});
    const summary = s => ({id: s.id, name: s.name, at: s.at, pinned: s.pinned, windows: s.windows.length, monitors: s.monitors ?? null});

    function liveSnapshot(mons = monitorList()) {
        const windows = live(mons).slice(0, 200).map(w => ({
            appId: w.appId.toLowerCase(), title: w.title.slice(0, 200), workspace: w.workspace, monitor: w.monitorIndex ?? 0,
            x: w.rect?.x ?? 0, y: w.rect?.y ?? 0, width: w.rect?.width ?? 0, height: w.rect?.height ?? 0,
        }));
        return {version: S.SNAPSHOT_VERSION, monitors: mons.length, windows};
    }

    function findSnap(store, id) {
        const s = store.snapshots.find(x => x.id === id);
        if (!s) throw new Error(`no snapshot "${id}"`);
        return s;
    }

    /** The restore plan of a snapshot against what runs now: each item says place, relaunch, unsupported or skip, with the reason. */
    function snapshotItems(snap, windows, mons) {
        const base = S.restorePlan(snap, windows.map(w => w.appId).filter(Boolean), mons.length);
        const taken = new Set(), nws = host.nWorkspaces();
        return base.map((b, i) => {
            const sw = snap.windows[i];
            const item = {appId: b.appId, title: sw.title ?? '', action: b.action};
            if (b.note) item.note = b.note;
            if (b.action === 'place') {
                const w = G.matchWindow({appId: sw.appId, title: sw.title, windowId: null}, windows, taken);
                if (!w) return {...item, action: 'skip', reason: 'the app is open but this window could not be told apart from its others'};
                taken.add(w.id);
                const workspace = sw.workspace === 0 ? null : Math.min(sw.workspace, nws);
                if (workspace !== null && workspace !== sw.workspace) item.note = `workspace ${sw.workspace} is gone, placed on ${workspace}`;
                Object.assign(item, {windowId: w.id, workspace, monitor: b.monitor});
                item.noop = (workspace === null || w.workspace === workspace) && w.monitorIndex === b.monitor;
            } else if (b.action === 'relaunch') {
                item.workspace = b.workspace; item.monitor = b.monitor;
            } else if (b.reason) {
                item.reason = b.reason;
            }
            return item;
        });
    }

    const snapOp = {
        take({name = '', pinned = false, max = 20, days = 30}) {
            const mons = monitorList(), at = host.now();
            const base = liveSnapshot(mons);
            const snap = {...base, id: `s${at}`, name: String(name).trim().slice(0, 60) || new Date(at).toISOString().slice(0, 16).replace('T', ' '), at, pinned: Boolean(pinned)};
            const store = snapStore();
            const all = [snap, ...store.snapshots.filter(s => s.id !== snap.id)];
            const kept = S.retain(all, at, {max, days});
            saveSnaps(kept);
            return ok({snapshot: summary(snap), dropped: all.length - kept.length, windows: snap.windows.length});
        },
        list() {
            const store = snapStore();
            return ok({snapshots: store.snapshots.sort((a, b) => b.at - a.at).map(summary), invalid: store.invalid});
        },
        delete({id}) {
            const store = snapStore();
            findSnap(store, id);
            saveSnaps(store.snapshots.filter(s => s.id !== id));
            return ok({deleted: id});
        },
        pin({id, pinned = true}) {
            const store = snapStore();
            findSnap(store, id);
            saveSnaps(store.snapshots.map(s => (s.id === id ? {...s, pinned: Boolean(pinned)} : s)));
            return ok({id, pinned: Boolean(pinned)});
        },
        /** Differences between two snapshots, or one and the windows open now (`b` left out). */
        diff({a, b}) {
            const store = snapStore();
            const left = findSnap(store, a);
            const right = b ? findSnap(store, b) : liveSnapshot();
            return ok({a: summary(left), b: b ? summary(findSnap(store, b)) : 'now', diff: S.diffSnapshots(left, right)});
        },
        plan({id}) {
            const mons = monitorList();
            const snap = findSnap(snapStore(), id);
            const items = snapshotItems(snap, live(mons), mons);
            return ok({snapshot: summary(snap), items, note: SNAPSHOT_NOTE, counts: count(items)});
        },
        /** Without `confirm` this is the preview (nothing changes). With it, only the 'place' items for windows that run are applied. */
        restore({id, confirm = false}) {
            const mons = monitorList();
            const snap = findSnap(snapStore(), id);
            const items = snapshotItems(snap, live(mons), mons);
            const out = {snapshot: summary(snap), items, counts: count(items), note: SNAPSHOT_NOTE, preview: !confirm, applied: [], failed: []};
            if (!confirm) return ok(out);
            const moves = items.filter(i => i.action === 'place' && !i.noop).map(i => ({windowId: i.windowId, workspace: i.workspace, monitor: mons.find(m => m.index === i.monitor)?.key ?? null}));
            const r = applyMoves(moves, mons);
            out.applied = r.applied; out.failed = r.failed;
            return ok(out);
        },
        /** Starts one app of the snapshot that is not running. Only a user's explicit request gets here; the id must be one the snapshot names. */
        launch({id, appId}) {
            const mons = monitorList();
            const snap = findSnap(snapStore(), id);
            const item = snapshotItems(snap, live(mons), mons).find(i => i.action === 'relaunch' && i.appId === String(appId).toLowerCase());
            if (!item) throw new Error(`"${appId}" is not an app this snapshot would relaunch (it may be running already)`);
            const r = host.launch(item.appId);
            return r.ok ? ok({launched: item.appId}) : fail(r.reason || `could not start ${item.appId}`);
        },
        retain({max = 20, days = 30}) {
            const store = snapStore(), kept = S.retain(store.snapshots, host.now(), {max, days});
            saveSnaps(kept);
            return ok({kept: kept.length, dropped: store.snapshots.length - kept.length});
        },
    };

    const count = items => items.reduce((c, i) => ({...c, [i.action]: (c[i.action] ?? 0) + 1}), {});

    // ---- monitor recovery (opt-in; windows only, no display configuration is written)

    /** Remembers where windows are while the monitors are steady, so a vanished monitor can be told from what mutter did to the windows. */
    function noteWindows() {
        try {
            const mons = monitorList();
            if (last && M.setKey(mons) !== M.setKey(last)) return;
            last = mons;
            noted = new Map();
            for (const w of live(mons)) {
                const m = mons.find(x => x.key === w.monitor);
                if (m && w.rect) noted.set(w.id, {monitor: m.key, x: w.rect.x - m.x, y: w.rect.y - m.y, width: w.rect.width, height: w.rect.height});
            }
        } catch (_e) { /* the shell is busy: the next look will do */ }
    }

    function monitorsChanged() {
        const now = monitorList();
        const before = last ?? now;
        if (!host.recoveryEnabled()) {
            last = now;
            return ok({skipped: 'monitor recovery is off'});
        }
        const diff = M.diffMonitors(before, now);
        last = now;
        if (!diff.changed) return ok({changed: false});
        const event = {at: host.now(), connected: diff.connected.map(m => m.key), disconnected: diff.disconnected.map(m => m.key), moved: [], restored: 0, relocated: 0, failed: 0, notes: []};
        const windows = live(now);
        const aliveIds = new Set(windows.map(w => w.id));
        for (const mv of diff.moved) if (memory[mv.from]) { memory[mv.to] = memory[mv.from]; delete memory[mv.from]; event.moved.push(mv); }
        if (diff.disconnected.length) {
            const wins = [...noted].filter(([id]) => aliveIds.has(id)).map(([id, n]) => ({id, monitor: n.monitor, x: n.x, y: n.y, width: n.width, height: n.height}));
            const fb = M.fallbackPlan(wins, now, diff.disconnected);
            event.notes.push(...fb.notes);
            const target = now.find(m => m.key === fb.target);
            const mem = M.rememberDisplaced(fb, wins);
            for (const [k, list] of Object.entries(mem)) memory[k] = [...(memory[k] ?? []).filter(e => !list.some(x => x.windowId === e.windowId)), ...list].slice(-MAX_REMEMBERED);
            const r = applyMoves(fb.moves.map(m => ({windowId: m.windowId, workspace: null, monitor: m.to, rect: {x: target.x + m.rect.x, y: target.y + m.rect.y, width: m.rect.width, height: m.rect.height}})), now);
            event.relocated = r.applied.length; event.failed += r.failed.length;
        }
        for (const m of diff.connected) {
            const plan = M.restorePlan(memory, m, windows);
            const r = applyMoves(plan.moves.map(x => ({windowId: x.windowId, workspace: null, monitor: x.to, rect: {x: m.x + x.rect.x, y: m.y + x.rect.y, width: x.rect.width, height: x.rect.height}})), now);
            event.restored += r.applied.length; event.failed += r.failed.length;
            if (plan.missing.length) event.notes.push(`${plan.missing.length} remembered window(s) were closed meanwhile`);
            delete memory[m.key];
        }
        lastEvent = event;
        return ok({changed: true, event});
    }

    // ---- the entry points the D-Bus methods call

    const run = (table, allowed, op, argsJson) => {
        try {
            if (!allowed.includes(op)) return fail(`unknown operation "${op}"; operations: ${allowed.join(', ')}`);
            let args = {};
            if (argsJson) {
                args = JSON.parse(argsJson);
                if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('the arguments must be a JSON object');
            }
            return table[op](args);
        } catch (e) {
            return fail(e.message);
        }
    };

    return {
        api: () => ok({version: API, groups: GROUP_OPS, snapshots: SNAPSHOT_OPS, monitorRecovery: host.recoveryEnabled()}),
        groups: (op, args) => run(groupOp, GROUP_OPS, op, args),
        snapshots: (op, args) => run(snapOp, SNAPSHOT_OPS, op, args),
        monitorStatus: () => ok({enabled: host.recoveryEnabled(), monitors: monitorList().map(m => ({index: m.index, key: m.key, primary: m.primary})), remembered: Object.fromEntries(Object.entries(memory).map(([k, v]) => [k, v.length])), last: lastEvent}),
        noteWindows,
        monitorsChanged: () => { try { return monitorsChanged(); } catch (e) { return fail(e.message); } },
    };
}
