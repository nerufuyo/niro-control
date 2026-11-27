// @ts-nocheck: GLib / Gio are untyped here
// The tiling's backend: what the command line (`niro-tile`) and the panel's Tiling pages both use. It reads the tiling's settings and, when
// the shell extension is running, asks it (org.niro.Tile on the session bus) for the live state and to apply layouts. A change that writes
// several settings is checked first, saved as a backup, written, read back, and put back if anything failed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {uniqueId} from './profileLogic.js';
import {Stores} from './store.js';
import {checkLayoutMap, checkRules} from './tile/config.js';
import {LAYOUT_IDS, LAYOUTS} from './tile/layouts.js';
import {checkRules as checkAdvanced, evaluate, findConflicts, parseRules as parseAdvanced} from './tile/windowRules.js';

export const PROFILE_VERSION = 1;
/** The settings a profile (and a reset) carries: how the tiles are laid out and sized, never the shortcuts or whether tiling is on. */
export const MANAGED = ['layout', 'gap-inner', 'gap-outer', 'master-factor', 'column-width', 'animate', 'layout-map', 'window-rules', 'floating-apps', 'rules-engine', 'advanced-rules'];
/** Actions the advanced rules accept but this system does not carry out: none now (opacity is applied by the extension). */
export const UNSUPPORTED_ACTIONS: string[] = [];
const BUS = 'org.niro.Tile', PATH = '/org/niro/Tile';
/** The version of the groups / snapshots D-Bus methods this backend speaks (shell/tile/workspace.js API). */
export const WORKSPACE_API = 1;

export const profileDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'niro', 'tile-profiles']);
export const backupDir = () => GLib.build_filenamev([GLib.get_user_state_dir(), 'niro', 'tile-backups']);

const read = file => { try { return new TextDecoder().decode(Gio.File.new_for_path(file).load_contents(null)[1]); } catch (_e) { return null; } };
function write(file, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(file), 0o755);
    Gio.File.new_for_path(file).replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
const safe = name => name.trim().replace(/[^\w .-]/g, '_').slice(0, 60);

export class TileBackend {
    constructor(stores = new Stores()) {
        this.settings = stores.by.tile ?? null;
    }

    get available() {
        return Boolean(this.settings);
    }

    // ---- The live shell

    _proxy() {
        try {
            const p = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
                null, BUS, PATH, BUS, null);
            return p.get_name_owner() ? p : null;
        } catch (_e) {
            return null;
        }
    }

    /** Whether the extension is running and answering. */
    get live() {
        return this._proxy() !== null;
    }

    _call(method, params = null) {
        const p = this._proxy();
        if (!p)
            return null;
        return p.call_sync(method, params, Gio.DBusCallFlags.NONE, 3000, null).deepUnpack();
    }

    /** The live state (monitors, workspaces, windows) from the extension, or null when it is not running. */
    state() {
        const r = this._call('GetState');
        return r ? JSON.parse(r[0]) : null;
    }

    /** What the settings alone say, for when the shell has nothing to tell. */
    settingsState() {
        const s = this.settings;
        return {
            enabled: s.get_boolean('enabled'), layout: s.get_string('layout'), layoutMap: JSON.parse(s.get_string('layout-map') || '{}'),
            rules: JSON.parse(s.get_string('window-rules') || '[]'), gapInner: s.get_int('gap-inner'), gapOuter: s.get_int('gap-outer'),
            masterFactor: s.get_double('master-factor'), columnWidth: s.get_double('column-width'), animate: s.get_boolean('animate'),
        };
    }

    layouts() {
        return LAYOUTS.map(([id, title, description]) => ({id, title, description}));
    }

    // ---- Groups, snapshots and monitor recovery (the shell does the work; these are its D-Bus methods, version WORKSPACE_API)

    /** One call to GroupsCall / SnapshotsCall / MonitorStatus. Throws a sentence when the shell cannot answer or refuses. */
    _workspace(method, params = null) {
        let r;
        try {
            r = this._call(method, params);
        } catch (e) {
            if (/UnknownMethod|No such method|not implemented/i.test(e.message))
                throw new Error('the running Tile is older than this panel: log out and in (or run: gnome-extensions disable tile@niro.local; gnome-extensions enable tile@niro.local)');
            throw e;
        }
        if (!r)
            throw new Error('the tiling extension is not running, so this is not available (groups, snapshots and applying rules need the shell)');
        const answer = JSON.parse(r[0]);
        if (answer.api !== WORKSPACE_API)
            throw new Error(`the shell speaks workspace API ${answer.api}, this panel ${WORKSPACE_API}: update both to the same version`);
        if (!answer.ok)
            throw new Error(answer.error || 'the shell refused');
        return answer;
    }

    /** The versions and operations the running Tile offers, or null when it is not running. Throws when it has no workspace features. */
    workspaceApi() {
        return this.live ? this._workspace('GetWorkspaceApi') : null;
    }

    _groups(op, args = {}) {
        return this._workspace('GroupsCall', new GLib.Variant('(ss)', [op, JSON.stringify(args)]));
    }

    _snapshots(op, args = {}) {
        return this._workspace('SnapshotsCall', new GLib.Variant('(ss)', [op, JSON.stringify(args)]));
    }

    /** The groups. Without the shell the stored file is read as it is (no open/closed information). */
    groups() {
        if (this.live)
            return this._groups('list').groups;
        const text = read(GLib.build_filenamev([GLib.get_user_config_dir(), 'niro', 'tile-groups.json']));
        try {
            return (JSON.parse(text ?? '{}').groups ?? []).map(g => ({id: g.id, name: g.name, members: g.members.map(m => ({...m, open: false, windowId: null})), open: 0, closed: g.members.length, target: g.target ?? null, offline: true}));
        } catch (_e) {
            return [];
        }
    }

    /** `windowIds` null: the focused window of the shell; a list (even empty) is used as given. */
    createGroup(name, windowIds = null) { return this._groups('create', {name, windowIds}); }
    addToGroup(id, windowId = 0) { return this._groups('add', {id, windowId}); }
    removeFromGroup(id, windowId) { return this._groups('remove', {id, windowId}); }
    renameGroup(id, name) { return this._groups('rename', {id, name}); }
    deleteGroup(id) { return this._groups('delete', {id}); }
    rememberGroup(id) { return this._groups('remember', {id}); }
    activateGroup(id, preview = false) { return this._groups('activate', {id, preview}); }
    restoreGroup(id, preview = false) { return this._groups('restore', {id, preview}); }

    snapshots() { return this._snapshots('list'); }
    takeSnapshot(name = '', pinned = false) { return this._snapshots('take', {name, pinned}); }
    deleteSnapshot(id) { return this._snapshots('delete', {id}); }
    pinSnapshot(id, pinned = true) { return this._snapshots('pin', {id, pinned}); }
    diffSnapshots(a, b = null) { return this._snapshots('diff', b ? {a, b} : {a}); }
    planSnapshot(id) { return this._snapshots('plan', {id}); }
    /** The preview unless `confirm`; with it only the windows that run are moved (workspace and monitor), nothing is closed or launched. */
    restoreSnapshot(id, confirm = false) { return this._snapshots('restore', {id, confirm}); }
    launchFromSnapshot(id, appId) { return this._snapshots('launch', {id, appId}); }
    retainSnapshots(max = 20, days = 30) { return this._snapshots('retain', {max, days}); }

    monitorStatus() { return this._workspace('MonitorStatus'); }
    get monitorRecovery() { return this.settings.get_boolean('monitor-recovery'); }
    setMonitorRecovery(on) { this.settings.set_boolean('monitor-recovery', on); }

    // ---- Applying

    /** Gives the general layout, a workspace (from 1) or a monitor (from 0) a layout. Throws a sentence when it cannot. */
    apply(layout, {workspace = null, monitor = null} = {}) {
        if (!LAYOUT_IDS.includes(layout))
            throw new Error(`"${layout}" is not a layout. Layouts: ${LAYOUT_IDS.join(', ')}`);
        const live = this._call('ApplyLayout', new GLib.Variant('(sii)', [layout, workspace ?? 0, monitor ?? -1]));
        if (live)
            return live[0] === true;
        // the extension is not running: the settings take it, and it is read when the extension starts
        const s = this.settings;
        if (workspace === null && monitor === null) {
            s.set_string('layout', layout);
        } else {
            const map = JSON.parse(s.get_string('layout-map') || '{}');
            map.workspaces ??= {}; map.monitors ??= {};
            if (workspace !== null) map.workspaces[String(workspace)] = layout;
            else map.monitors[String(monitor)] = layout;
            s.set_string('layout-map', JSON.stringify(map));
        }
        return true;
    }

    clear({workspace = null, monitor = null} = {}) {
        const live = this._call('ClearLayout', new GLib.Variant('(ii)', [workspace ?? 0, monitor ?? -1]));
        if (live !== null)
            return;
        const map = JSON.parse(this.settings.get_string('layout-map') || '{}');
        if (workspace !== null) delete map.workspaces?.[String(workspace)];
        if (monitor !== null) delete map.monitors?.[String(monitor)];
        this.settings.set_string('layout-map', JSON.stringify(map));
    }

    setEnabled(on) {
        this.settings.set_boolean('enabled', on);
    }

    // ---- Checking

    /** What is wrong with a set of managed settings (an object of key: value), one sentence each. */
    validate(values) {
        const problems = [];
        const range = (key, lo, hi) => {
            if (key in values && !(typeof values[key] === 'number' && values[key] >= lo && values[key] <= hi))
                problems.push(`${key} must be a number from ${lo} to ${hi}`);
        };
        if ('layout' in values && !LAYOUT_IDS.includes(values.layout))
            problems.push(`layout "${values.layout}" is not a layout`);
        range('gap-inner', 0, 40);
        range('gap-outer', 0, 60);
        range('master-factor', 0.1, 0.9);
        range('column-width', 0.2, 1);
        if ('animate' in values && typeof values.animate !== 'boolean')
            problems.push('animate must be true or false');
        if ('layout-map' in values)
            problems.push(...checkLayoutMap(typeof values['layout-map'] === 'string' ? values['layout-map'] : JSON.stringify(values['layout-map'])));
        if ('window-rules' in values)
            problems.push(...checkRules(typeof values['window-rules'] === 'string' ? values['window-rules'] : JSON.stringify(values['window-rules'])));
        if ('rules-engine' in values && typeof values['rules-engine'] !== 'boolean')
            problems.push('rules-engine must be true or false');
        if ('advanced-rules' in values)
            problems.push(...checkAdvanced(typeof values['advanced-rules'] === 'string' ? values['advanced-rules'] : JSON.stringify(values['advanced-rules'])).map(p => `advanced-rules: ${p}`));
        if ('floating-apps' in values && !(Array.isArray(values['floating-apps']) && values['floating-apps'].every(x => typeof x === 'string')))
            problems.push('floating-apps must be a list of names');
        for (const key of Object.keys(values))
            if (!MANAGED.includes(key))
                problems.push(`"${key}" is not a setting a profile carries`);
        return problems;
    }

    /** The managed settings now, as plain values. */
    current() {
        const s = this.settings;
        return {
            layout: s.get_string('layout'), 'gap-inner': s.get_int('gap-inner'), 'gap-outer': s.get_int('gap-outer'),
            'master-factor': Math.round(s.get_double('master-factor') * 100) / 100, 'column-width': Math.round(s.get_double('column-width') * 100) / 100,
            animate: s.get_boolean('animate'), 'layout-map': s.get_string('layout-map'), 'window-rules': s.get_string('window-rules'), 'floating-apps': s.get_strv('floating-apps'),
            'rules-engine': s.get_boolean('rules-engine'), 'advanced-rules': s.get_string('advanced-rules'),
        };
    }

    _put(values) {
        const s = this.settings;
        for (const [key, v] of Object.entries(values)) {
            if (key === 'layout' || key === 'layout-map' || key === 'window-rules' || key === 'advanced-rules') s.set_string(key, typeof v === 'string' ? v : JSON.stringify(v));
            else if (key === 'gap-inner' || key === 'gap-outer') s.set_int(key, v);
            else if (key === 'master-factor' || key === 'column-width') s.set_double(key, v);
            else if (key === 'animate' || key === 'rules-engine') s.set_boolean(key, v);
            else if (key === 'floating-apps') s.set_strv(key, v);
        }
        Gio.Settings.sync();
    }

    /**
     * Writes `values` as one change: checked first, the settings as they are saved as a backup, written, read back, and put back as they were
     * if the read-back differs or anything throws. Returns what changed; throws a sentence on failure.
     */
    change(values, label = 'change') {
        const problems = this.validate(values);
        if (problems.length)
            throw new Error(problems.join('; '));
        const before = this.current();
        const changed = Object.keys(values).filter(k => JSON.stringify(this.current()[k]) !== JSON.stringify(typeof values[k] === 'object' && !Array.isArray(values[k]) ? JSON.stringify(values[k]) : values[k]));
        if (!changed.length)
            return [];
        this.backup(label, before);
        try {
            this._put(values);
            const after = this.current();
            for (const k of Object.keys(values)) {
                const want = typeof values[k] === 'object' && !Array.isArray(values[k]) ? JSON.stringify(values[k]) : values[k];
                const got = after[k];
                if (JSON.stringify(got) !== JSON.stringify(want) && !(typeof want === 'number' && Math.abs(got - want) < 0.011))
                    throw new Error(`${k} did not take (wanted ${JSON.stringify(want)}, found ${JSON.stringify(got)})`);
            }
        } catch (e) {
            try {
                this._put(before);
            } catch (e2) {
                throw new Error(`${e.message}; and putting the settings back failed too: ${e2.message}. Run: niro-tile undo`);
            }
            throw new Error(`Nothing changed: ${e.message}`);
        }
        return changed;
    }

    // ---- Advanced window rules (read here, applied only by the shell extension; nothing below touches a window)

    /** The advanced rules as stored: the raw list the editor changes. Throws a sentence when the stored text is not a list. */
    advancedRules() {
        const data = JSON.parse(this.settings.get_string('advanced-rules') || '[]');
        if (!Array.isArray(data))
            throw new Error('advanced-rules is not a list');
        return data;
    }

    /** Writes the advanced rules as one checked change (backup first). Returns what changed. */
    saveAdvancedRules(list) {
        return this.change({'advanced-rules': JSON.stringify(list)}, 'advanced rules');
    }

    /**
     * The advanced rules over the windows already open, through the running shell. Without `confirm` it is a preview (nothing is changed);
     * with it the pending actions are applied once. Answer: `{ok, dryRun, applied: [{windowId, appId, title, actions, from}], skipped: [...], notes}`.
     * Throws a sentence when the shell is not running, is too old, or the rules engine is off.
     */
    applyRules(confirm = false) {
        return this._workspace(confirm ? 'ApplyRules' : 'ApplyRulesPreview');
    }

    /** What is wrong with the stored (or given) rule text, the rules that would run, and where they disagree. */
    rulesReport(text = this.settings.get_string('advanced-rules')) {
        const problems = checkAdvanced(text);
        const rules = parseAdvanced(text);
        return {problems, rules, conflicts: findConflicts(rules), unsupported: UNSUPPORTED_ACTIONS};
    }

    /**
     * What the rules would do to a window described by `win` ({appId, title, workspace, monitor, type}), with the per-rule trace. Applies nothing.
     * `text` defaults to the stored rules; the engine switch is reported, not required, so a person can try rules before turning them on.
     */
    dryRun(win, text = this.settings.get_string('advanced-rules'), now = new Date()) {
        const rules = parseAdvanced(text);
        const result = evaluate(rules, {
            appIds: win.appId ? [win.appId] : [], title: win.title ?? '', workspace: win.workspace ?? undefined, monitor: win.monitor ?? undefined, type: win.type || 'normal',
        }, {now});
        const unsupported = Object.keys(result.actions).filter(k => UNSUPPORTED_ACTIONS.includes(k));
        return {...result, unsupported, engineOn: this.settings.get_boolean('rules-engine'), ruleCount: rules.length};
    }

    // ---- Backups (made before every change; keeps the newest 20) and the undo

    backup(label, values = this.current()) {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S-%f').slice(0, 22);
        write(GLib.build_filenamev([backupDir(), `${stamp}.json`]), JSON.stringify({version: PROFILE_VERSION, label, saved: GLib.DateTime.new_now_utc().format_iso8601(), settings: values}, null, 1));
        const names = this._names(backupDir()).sort().reverse();
        for (const old of names.slice(20))
            try { Gio.File.new_for_path(GLib.build_filenamev([backupDir(), old])).delete(null); } catch (_e) { /* gone */ }
    }

    backups() {
        return this._names(backupDir()).sort().reverse().map(f => ({file: f, ...JSON.parse(read(GLib.build_filenamev([backupDir(), f])) ?? '{}')}));
    }

    /** Puts back the settings as they were before the newest change. */
    undo() {
        const newest = this.backups()[0];
        if (!newest)
            throw new Error('There is nothing to undo yet.');
        const values = newest.settings;
        const problems = this.validate(values);
        if (problems.length)
            throw new Error(`The backup is not usable: ${problems.join('; ')}`);
        this._put(values);
        Gio.File.new_for_path(GLib.build_filenamev([backupDir(), newest.file])).delete(null);
        return newest.label;
    }

    /** The managed settings back at their defaults. */
    reset() {
        const defaults = {};
        for (const key of MANAGED)
            defaults[key] = this._default(key);
        return this.change(defaults, 'reset');
    }

    _default(key) {
        const v = this.settings.settings_schema.get_key(key).get_default_value();
        return v.get_type_string() === 'as' ? v.deepUnpack() : v.unpack();
    }

    // ---- Profiles (JSON files in ~/.config/niro/tile-profiles)

    _names(dir) {
        const out = [];
        try {
            const e = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
            for (let i = e.next_file(null); i; i = e.next_file(null))
                if (i.get_name().endsWith('.json')) out.push(i.get_name());
        } catch (_e) { /* none yet */ }
        return out;
    }

    profiles() {
        return this._names(profileDir()).sort().map(f => {
            const data = JSON.parse(read(GLib.build_filenamev([profileDir(), f])) ?? '{}');
            return {name: data.name ?? f.replace(/\.json$/, ''), file: f, saved: data.saved ?? '', layout: data.settings?.layout ?? ''};
        });
    }

    saveProfile(name) {
        const clean = safe(name);
        if (!clean)
            throw new Error('A profile needs a name.');
        write(GLib.build_filenamev([profileDir(), `${clean}.json`]), JSON.stringify({version: PROFILE_VERSION, name: clean, saved: GLib.DateTime.new_now_utc().format_iso8601(), settings: this.current()}, null, 1));
        return clean;
    }

    /** Reads a profile file and says what is wrong with it, without applying it. Returns `{name, settings}`; throws a sentence. */
    readProfile(file) {
        const text = read(file);
        if (text === null)
            throw new Error(`Cannot read ${file}`);
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`${file} is not JSON: ${e.message}`); }
        if (data.version !== PROFILE_VERSION)
            throw new Error(`${file} is version ${data.version}; this reads version ${PROFILE_VERSION}`);
        if (!data.settings || typeof data.settings !== 'object')
            throw new Error(`${file} has no settings`);
        const problems = this.validate(data.settings);
        if (problems.length)
            throw new Error(`${file}: ${problems.join('; ')}`);
        return data;
    }

    loadProfile(name) {
        const file = GLib.build_filenamev([profileDir(), `${safe(name)}.json`]);
        return this.change(this.readProfile(file).settings, `load profile ${name}`);
    }

    deleteProfile(name) {
        Gio.File.new_for_path(GLib.build_filenamev([profileDir(), `${safe(name)}.json`])).delete(null);
    }

    exportProfile(name, destination) {
        const text = read(GLib.build_filenamev([profileDir(), `${safe(name)}.json`]));
        if (text === null)
            throw new Error(`There is no profile "${name}".`);
        write(destination, text);
    }

    importProfile(file) {
        const data = this.readProfile(file);
        const wanted = safe(data.name ?? GLib.path_get_basename(file).replace(/\.json$/, ''));
        // never over one that is there: a suffix, as for settings profiles (the base is cut so safe() keeps the suffix)
        const taken = this._names(profileDir()).map(f => f.replace(/\.json$/, ''));
        const name = taken.includes(wanted) ? uniqueId(wanted.slice(0, 56).trim(), taken) : wanted;
        write(GLib.build_filenamev([profileDir(), `${name}.json`]), JSON.stringify({...data, name}, null, 1));
        return name;
    }

    // ---- Diagnostics

    /** Every check: `{name, ok, detail}`. The panel's Advanced page and `niro-tile doctor` print these. */
    doctor() {
        const out = [];
        const add = (name, ok, detail = '') => out.push({name, ok, detail});
        add('settings schema found', this.available, this.available ? '' : 'org.gnome.shell.extensions.tile is not installed');
        if (!this.available)
            return out;
        const extension = GLib.find_program_in_path('gnome-extensions') !== null
            ? new TextDecoder().decode(GLib.spawn_command_line_sync('gnome-extensions info tile@niro.local')[1]) : '';
        add('extension active', /ACTIVE|Aktif|Kondisi: ACTIVE/i.test(extension) || this.live, /ACTIVE/i.test(extension) ? 'tile@niro.local' : 'not reported active');
        add('shell answers on D-Bus (org.niro.Tile)', this.live, this.live ? '' : 'log out and in, or: gnome-extensions enable tile@niro.local');
        const problems = this.validate(this.current());
        add('settings are valid', problems.length === 0, problems.join('; '));
        const state = this.state();
        if (state) {
            add('compositor is Wayland', state.session.type === 'wayland', `${state.session.type}, GNOME Shell ${state.session.shell}`);
            add('monitors seen', state.monitors.length > 0, `${state.monitors.length} monitor(s)`);
            let features = '';
            try { features = this.workspaceApi() ? '' : 'no answer'; } catch (e) { features = e.message; }
            add('groups and snapshots available', features === '', features || `API ${WORKSPACE_API}`);
        }
        return out;
    }
}
