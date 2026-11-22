// A stand-in for the running Tile extension for the GJS tests: the real workspace service (shell/tile/workspace.js and the shared cores) behind
// the backend's D-Bus calls, with a fake list of windows and monitors. It replaces TileBackend's transport only; everything above it is real.
import GLib from 'gi://GLib';

import {createWorkspaceService} from '../../shell/tile/workspace.js';
import * as groups from '../../shell/shared/windowGroups.js';
import * as snapshot from '../../shell/shared/snapshot.js';
import * as monitors from '../../shell/shared/monitorManager.js';

export function installFakeShell(TileBackend, {windows, version = 1} = {}) {
    const mon = (index, x) => ({index, connector: `C${index}`, vendor: 'V', product: 'P', serial: `S${index}`, width: 1000, height: 800, scale: 1, x, y: 0, primary: index === 0});
    const shell = {on: true, files: {}, moved: [], launched: [], version, nws: 3, focus: 0,
        wins: windows ?? [], engine: true, ruleCalls: [], mons: [mon(0, 0), mon(1, 1000)], now: 1_700_000_000_000};
    const host = {
        liveWindows: () => shell.wins.map(w => ({...w, rect: {x: 10, y: 10, width: 300, height: 200}})),
        monitors: () => shell.mons, nWorkspaces: () => shell.nws, activeWorkspace: () => 1, focusedId: () => shell.focus,
        moveWindow: (id, to) => { const w = shell.wins.find(x => x.id === id); if (!w) return false; shell.moved.push({id, ...to}); if (to.workspace !== null) w.workspace = to.workspace; if (to.monitor !== null) w.monitor = to.monitor; return true; },
        focusWindows: () => {}, switchWorkspace: () => {},
        launch: appId => { shell.launched.push(appId); return {ok: true}; },
        load: name => (shell.files[name] ? JSON.parse(shell.files[name]) : null), save: (name, v) => { shell.files[name] = JSON.stringify(v); },
        now: () => shell.now, recoveryEnabled: () => false,
    };
    const svc = createWorkspaceService({core: {groups, snapshot, monitors}, host});
    const reply = r => [JSON.stringify(shell.version === 1 ? r : {...r, api: shell.version})];
    Object.defineProperty(TileBackend.prototype, 'live', {configurable: true, get: () => shell.on});
    TileBackend.prototype._call = function (method, params) {
        if (!shell.on) return null;
        const [op, args] = params ? params.deepUnpack() : [];
        switch (method) {
        case 'GetState':
            return [JSON.stringify({version: 1, enabled: true, layout: 'dwindle', layoutMap: {workspaces: {}, monitors: {}}, rules: [], gapInner: 8, gapOuter: 8, masterFactor: 0.55, columnWidth: 0.5, animate: true,
                session: {type: 'wayland', shell: '51'}, workspaces: [{index: 1, name: '', active: true, layout: 'dwindle', windows: 1}],
                monitors: shell.mons.map(m => ({index: m.index, x: m.x, y: m.y, width: m.width, height: m.height, scale: 1, primary: m.primary, layout: 'dwindle', tiled: 0})),
                windows: shell.wins.map(w => ({id: w.id, title: w.title, class: w.appId, workspace: w.workspace, monitor: w.monitor, tiled: true, floating: false, fullscreen: false, maximized: false, minimized: false, rect: {x: 0, y: 0, width: 1, height: 1}}))})];
        case 'GetWorkspaceApi': return reply(svc.api());
        case 'GroupsCall': return reply(svc.groups(op, args));
        case 'SnapshotsCall': return reply(svc.snapshots(op, args));
        case 'MonitorStatus': return reply(svc.monitorStatus());
        case 'ApplyRules':
        case 'ApplyRulesPreview': {
            const dry = method === 'ApplyRulesPreview';
            shell.ruleCalls.push(method);
            if (!shell.engine) return reply({api: 1, ok: false, error: 'the rules engine is off: switch on "Use the advanced rules" first (nothing was changed)'});
            const applied = shell.wins.filter(w => w.workspace !== 2).map(w => ({windowId: w.id, appId: w.appId, title: w.title, actions: {workspace: 2, fullscreen: true}, from: {workspace: 'r1', fullscreen: 'r1'}}));
            if (!dry) for (const w of shell.wins) w.workspace = 2;
            return reply({api: 1, ok: true, dryRun: dry, applied, skipped: [{windowId: 99, appId: 'x', key: 'monitor', reason: 'there is no monitor 5'}], notes: ['fake']});
        }
        default: return [true];
        }
    };
    return shell;
}
