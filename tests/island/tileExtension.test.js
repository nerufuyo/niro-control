// Tile's extension.js with GNOME faked: windows open at enable() are not "new" (the lock screen re-enables Tile), and only a missing file is empty.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const NOT_FOUND = 1;
let loadError = null;
const layoutManager = {_startingUp: false, connect: () => 1};
globalThis.__fake = {
    Meta: {GrabOp: {}, WindowType: {NORMAL: 0}, KeyBindingFlags: {}},
    Shell: {ActionMode: {}},
    GLib: {PRIORITY_DEFAULT: 0, timeout_add: () => 1, build_filenamev: p => p.join('/'), get_user_config_dir: () => '/fake'},
    Gio: {IOErrorEnum: {NOT_FOUND}, File: {new_for_path: () => ({load_contents() { throw loadError; }})}},
    main: {layoutManager, wm: {addKeybinding() {}}},
};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    if (spec.endsWith('/ui/main.js')) return fake('export const {layoutManager, wm} = globalThis.__fake.main;');
    if (spec.endsWith('/extensions/extension.js')) return fake('export class Extension {}');
    if (spec.endsWith('/misc/config.js')) return fake("export const PACKAGE_VERSION = '50';");
    if (spec === './switcher.js') return fake('export class LayoutSwitcher {}');
    return next(spec, ctx);
}});

const moved = [];
const win = name => ({window_type: 0, get_compositor_private: () => ({}), get_wm_class: () => 'app', get_wm_class_instance: () => name,
    change_workspace_by_index: () => moved.push(name), connect: () => 1});
let windows = [];
globalThis.global = Object.assign(globalThis, {
    get_window_actors: () => windows.map(meta_window => ({meta_window})),
    window_manager: {connect: () => 1}, display: {connect: () => 1}, workspace_manager: {get_n_workspaces: () => 4},
});
const settings = {get_string: k => (k === 'window-rules' ? 'rule' : ''), get_boolean: () => false, connect: () => 1};

const {default: Tile} = await import('../../shell/tile/extension.js');

function enabled() {
    const tile = new Tile();
    Object.assign(tile, {getSettings: () => settings, _exportDBus() {}, _loadEngine: () => []});
    tile.enable();
    tile._rules = [{match: 'app', workspace: 2}];
    return tile;
}

test('window rules skip the windows already open at enable, but not at login', () => {
    windows = [win('old')];
    const tile = enabled();
    windows.push(win('new'));
    tile._sync();
    assert.deepEqual(moved, ['new']);

    moved.length = 0;
    layoutManager._startingUp = true;
    enabled()._sync();
    assert.deepEqual(moved, ['old', 'new']);
});

test('loading a stored file: only "not found" is empty', () => {
    const {load} = Tile.prototype._workspaceHost.call({});
    loadError = {matches: (_domain, code) => code === NOT_FOUND};
    assert.equal(load('tile-groups.json'), null);
    loadError = Object.assign(new Error('permission denied'), {matches: () => false});
    assert.throws(() => load('tile-groups.json'), /permission denied/);
});
