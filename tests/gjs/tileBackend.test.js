// The tiling's backend against real schemas (a throw-away settings backend) and throw-away folders: checks, profiles, backups, undo,
// reset, and the way a failed write puts everything back.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const tmp = GLib.dir_make_tmp('niro-tile-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);
// (run.sh starts this with no session bus to talk to: the real session's extension, if it runs, must not answer)

const {TileBackend, MANAGED, profileDir} = await import('../../control/build/tileBackend.js');
const {Stores} = await import('../../control/build/store.js');

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const throws = (fn, re, what) => { try { fn(); } catch (e) { if (re.test(e.message)) return; fail(`${what}: wrong error: ${e.message}`); } fail(`${what}: did not throw`); };

const stores = new Stores();
if (!stores.has('tile')) fail('schema for tile not found (NIRO_SCHEMA_DIR)');
const b = new TileBackend(stores);
const defaults = b.current();
eq(MANAGED.every(k => k in defaults), true, 'every managed setting is read');

// validation says what is wrong, in words
eq(b.validate(defaults), [], 'defaults are valid');
eq(b.validate({layout: 'zig', 'gap-inner': 99, 'master-factor': 2, animate: 'yes', 'floating-apps': [1], nonsense: 1}).length, 6, 'six problems');
eq(b.validate({'layout-map': '{"workspaces":{"a":"grid"}}'}).length, 1, 'a bad layout map');
eq(b.validate({'window-rules': '[{"match":"x"}]'}).length, 1, 'a rule that does nothing');

// a change is checked, written, read back, and backed up
const changed = b.change({layout: 'grid', 'gap-inner': 14}, 'test');
eq(changed.sort(), ['gap-inner', 'layout'], 'what changed');
eq(b.current().layout, 'grid', 'layout written');
eq(b.backups().length, 1, 'a backup was made');
eq(b.change({layout: 'grid'}), [], 'nothing to change is nothing done');
eq(b.backups().length, 1, 'and no backup for it');

// a bad change leaves everything as it was
throws(() => b.change({layout: 'zig', 'gap-inner': 3}), /not a layout/, 'bad layout');
eq(b.current()['gap-inner'], 14, 'a refused change wrote nothing');

// a write that fails halfway is put back
const put = b._put.bind(b);
let burned = false;
b._put = values => { if (burned) return put(values); burned = true; put({'gap-inner': 1}); throw new Error('disk on fire'); };
throws(() => b.change({layout: 'monocle', 'gap-inner': 2}), /Nothing changed: disk on fire/, 'failed write');
eq(b.current().layout, 'grid', 'the layout is back');
b._put = put;
eq(b.current()['gap-inner'], 14, 'the gap is back');

// undo puts back what was before the newest change
b.change({layout: 'scrolling'}, 'to scrolling');
eq(b.undo(), 'to scrolling', 'undo names the change');
eq(b.current().layout, 'grid', 'undone');

// profiles: save, list, load, export, import, delete, and refusing bad files
b.change({'layout-map': '{"workspaces":{"2":"monocle"},"monitors":{}}', 'window-rules': '[{"match":"org.gnome.Calculator","action":"float"}]'}, 'rules');
eq(b.saveProfile('Work desk!'), 'Work desk_', 'a name is made safe');
eq(b.profiles().map(p => p.name), ['Work desk_'], 'listed');
b.change({layout: 'dwindle', 'layout-map': '{}', 'window-rules': '[]'}, 'plain');
const loaded = b.loadProfile('Work desk_');
eq(loaded.includes('layout-map') && loaded.includes('window-rules'), true, 'a profile brings its map and rules back');
eq(b.current().layout, 'grid', 'and its layout');
const out = `${tmp}/exported.json`;
b.exportProfile('Work desk_', out);
b.deleteProfile('Work desk_');
eq(b.profiles(), [], 'deleted');
eq(b.importProfile(out), 'Work desk_', 'imported by the name inside');
eq(b.importProfile(out), 'Work desk_-2', 'a second import does not overwrite');
eq(b.profiles().map(p => p.name), ['Work desk_-2', 'Work desk_'], 'both are there, each under its own name');
b.deleteProfile('Work desk_-2');
const badFile = `${tmp}/bad.json`;
Gio.File.new_for_path(badFile).replace_contents(new TextEncoder().encode('{"version":1,"name":"bad","settings":{"layout":"zig"}}'), null, false, 0, null);
throws(() => b.importProfile(badFile), /not a layout/, 'a bad profile is refused');
Gio.File.new_for_path(badFile).replace_contents(new TextEncoder().encode('{"version":7,"settings":{}}'), null, false, 0, null);
throws(() => b.readProfile(badFile), /version 7/, 'a profile of another version is refused');
Gio.File.new_for_path(badFile).replace_contents(new TextEncoder().encode('not json'), null, false, 0, null);
throws(() => b.readProfile(badFile), /not JSON/, 'not JSON');
throws(() => b.loadProfile('nope'), /Cannot read/, 'a missing profile');
eq(GLib.file_test(profileDir(), GLib.FileTest.IS_DIR), true, 'profiles are in the config folder');

// reset: the managed settings at their defaults, and undoable
b.change({layout: 'monocle', 'gap-outer': 30}, 'before reset');
const reset = b.reset();
eq(reset.includes('layout') && reset.includes('gap-outer'), true, 'reset changed them');
eq(b.current(), defaults, 'back at the defaults');
b.undo();
eq(b.current().layout, 'monocle', 'a reset can be undone');

// an old backup is dropped past twenty
for (let i = 0; i < 25; i++) b.change({'gap-inner': i % 2 ? 5 : 6}, `n${i}`);
eq(b.backups().length <= 20, true, 'at most twenty backups');

// the diagnostics say what they see
const checks = b.doctor();
eq(checks.find(c => c.name === 'settings schema found').ok, true, 'doctor: schema');
eq(checks.find(c => c.name === 'settings are valid').ok, true, 'doctor: valid');
eq(checks.find(c => c.name.startsWith('shell answers')).ok, false, 'doctor: no shell in a test');


// ---- the advanced rules: carried by the managed settings, checked, dry-run, and old profiles still load
eq(MANAGED.includes('rules-engine') && MANAGED.includes('advanced-rules'), true, 'the engine settings are managed');
eq(defaults['rules-engine'], false, 'the engine is off by default');
eq(defaults['advanced-rules'], '[]', 'no advanced rules by default');
eq(b.validate({'rules-engine': 'yes'}).length, 1, 'engine switch must be a boolean');
eq(b.validate({'advanced-rules': '[{"id":"x"}]'}).length > 0, true, 'a rule with no condition or action is refused');
eq(b.validate({'advanced-rules': '{"a":1}'}).length, 1, 'rules must be a list');
eq(b.validate({'advanced-rules': 'not json'}).length, 1, 'rules must be JSON');
const calc = {id: 'calc', conditions: {appId: 'org.gnome.Calculator'}, actions: {tile: 'float', opacity: 0.8}, priority: 5};
const wide = {id: 'any-gnome', conditions: {appId: 'org.gnome.Calculator'}, actions: {tile: 'tile', workspace: 2}, priority: 1};
throws(() => b.saveAdvancedRules([{id: 'bad', conditions: {}, actions: {tile: 'float'}}]), /no condition/, 'a bad rule is refused');
eq(b.current()['advanced-rules'], '[]', 'a refused rule wrote nothing');
eq(b.saveAdvancedRules([calc, wide]), ['advanced-rules'], 'rules saved');
eq(b.advancedRules().map(r => r.id), ['calc', 'any-gnome'], 'rules read back');
const report = b.rulesReport();
eq(report.problems, [], 'the stored rules are valid');
eq(report.conflicts.some(c => c.kind === 'override' && c.key === 'tile' && c.a === 'calc'), true, 'the conflict is found');
// the dry run reports and applies nothing
const dry = b.dryRun({appId: 'org.gnome.Calculator', title: 'Calculator', workspace: 1, monitor: 0});
eq(dry.actions.tile, 'float', 'higher priority wins the key');
eq(dry.actions.workspace, 2, 'a lower rule still sets what is free');
eq(dry.from.tile, 'calc', 'where the action came from');
eq(dry.unsupported, [], 'every rule action is applied now, including opacity');
eq(dry.engineOn, false, 'the dry run says the engine is off');
eq(dry.trace.map(t => t.matched), [true, true], 'the trace lists every rule');
eq(b.dryRun({appId: 'firefox'}).actions, {}, 'no rule, no action');
eq(b.current()['rules-engine'], false, 'a dry run changes no setting');
// the engine switch is a checked change with a backup, and a profile carries both keys
eq(b.change({'rules-engine': true}, 'engine'), ['rules-engine'], 'engine on');
eq(b.dryRun({appId: 'firefox'}).engineOn, true, 'the dry run sees the switch');
b.saveProfile('Rules');
const saved = JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([profileDir(), 'Rules.json'])).load_contents(null)[1]));
eq(saved.settings['rules-engine'], true, 'profile carries the switch');
eq(JSON.parse(saved.settings['advanced-rules']).length, 2, 'profile carries the rules');
b.change({'rules-engine': false, 'advanced-rules': '[]'}, 'clear');
b.loadProfile('Rules');
eq(b.current()['rules-engine'], true, 'loading the profile restores the switch');
eq(b.advancedRules().length, 2, 'and the rules');
// a v1.5 profile (no engine keys) still loads and leaves the engine alone
const old = {version: 1, name: 'Old', saved: '2025-01-01T00:00:00Z', settings: {layout: 'grid', 'gap-inner': 3}};
const oldFile = GLib.build_filenamev([tmp, 'old.json']);
Gio.File.new_for_path(oldFile).replace_contents(new TextEncoder().encode(JSON.stringify(old)), null, false, Gio.FileCreateFlags.NONE, null);
eq(b.importProfile(oldFile), 'Old', 'a v1.5 profile imports');
b.loadProfile('Old');
eq(b.current()['rules-engine'], true, 'the engine switch is untouched by an old profile');
eq(b.advancedRules().length, 2, 'the rules are untouched by an old profile');
// an undo brings the rules back; a reset takes them to the defaults
b.reset();
eq([b.current()['rules-engine'], b.current()['advanced-rules']], [false, '[]'], 'reset puts the engine back');
b.undo();
eq(b.advancedRules().length, 2, 'undo brings the rules back');


// ---- groups, snapshots and monitor recovery (the shell's side is the real workspace service behind a fake transport)
{
    const {installFakeShell} = await import('./tileFakeShell.js');
    // no shell at all: groups can still be read from their file; the rest says so in a sentence
    throws(() => b.snapshots(), /not running/, 'snapshots without a shell');
    throws(() => b.createGroup('x'), /not running/, 'a group without a shell');
    eq(b.groups(), [], 'no groups file, no groups');
    const dir = GLib.build_filenamev([tmp, 'config', 'niro']);
    GLib.mkdir_with_parents(dir, 0o755);
    Gio.File.new_for_path(GLib.build_filenamev([dir, 'tile-groups.json'])).replace_contents(new TextEncoder().encode(JSON.stringify({version: 1, groups: [{id: 'w', name: 'Work', members: [{appId: 'a.A', title: 't', windowId: 4}], target: {workspace: 2, monitor: null}}]})), null, false, Gio.FileCreateFlags.NONE, null);
    eq([b.groups()[0].name, b.groups()[0].offline, b.groups()[0].open], ['Work', true, 0], 'groups read from the file with no shell');
    eq(b.monitorRecovery, false, 'monitor recovery is off by default');
    b.setMonitorRecovery(true); eq(b.monitorRecovery, true, 'monitor recovery switches on'); b.setMonitorRecovery(false);
    eq(MANAGED.includes('monitor-recovery'), false, 'monitor recovery is not part of a profile');

    const shell = installFakeShell(TileBackend, {windows: [
        {id: 1, appId: 'org.a.Edit', title: 'one', workspace: 1, monitor: 0}, {id: 2, appId: 'org.b.Term', title: 'sh', workspace: 2, monitor: 1}]});
    eq(b.workspaceApi().api, 1, 'the API version is read');
    const made = b.createGroup('Work', [1]);
    eq(made.group.members.length, 1, 'a group is created');
    b.addToGroup('work', 2);
    eq(b.groups()[0].open, 2, 'two windows open');
    shell.wins.find(w => w.id === 1).workspace = 3;
    const prev = b.restoreGroup('work', true);
    eq([prev.preview, prev.planned, shell.moved.length], [true, 2, 0], 'a preview moves nothing');
    const done = b.activateGroup('work');
    eq([done.applied.length, done.failed.length, shell.moved.length], [2, 0, 2], 'activating moves the strays to the group place');
    shell.wins = shell.wins.filter(w => w.id !== 2);
    eq(b.activateGroup('work').closed.length, 1, 'a closed window is reported, not an error');
    throws(() => b.renameGroup('nope', 'x'), /no group/, 'an unknown group');
    b.deleteGroup('work'); eq(b.groups().length, 0, 'a group is deleted');

    const taken = b.takeSnapshot('Morning');
    eq(taken.windows, 1, 'a snapshot is taken');
    const id = b.snapshots().snapshots[0].id;
    shell.wins[0].workspace = 2;
    eq(b.diffSnapshots(id).diff.moved.length, 1, 'the diff sees the move');
    const pl = b.planSnapshot(id);
    eq(pl.counts, {place: 1}, 'one window to place');
    eq(b.restoreSnapshot(id).preview, true, 'restore without confirm is a preview');
    const n = shell.moved.length;
    eq(b.restoreSnapshot(id, true).applied.length, 1, 'confirmed restore moves the window');
    eq(shell.moved.length, n + 1, 'and only that');
    throws(() => b.launchFromSnapshot(id, 'org.a.Edit'), /not an app/, 'a running app is not relaunched');
    eq(b.pinSnapshot(id, true).pinned, true, 'a snapshot is pinned');
    b.deleteSnapshot(id); eq(b.snapshots().snapshots.length, 0, 'a snapshot is deleted');
    eq(b.monitorStatus().enabled, false, 'monitor status answers');
    eq(b.doctor().find(c => c.name === 'groups and snapshots available').ok, true, 'doctor sees the workspace API');

    // the advanced rules over the windows already open: a preview changes nothing, a confirmed call applies, an engine that is off refuses
    shell.wins.splice(0, shell.wins.length, {id: 1, appId: "org.a.Edit", title: "one", workspace: 1, monitor: 0}, {id: 2, appId: "org.b.Term", title: "sh", workspace: 2, monitor: 1});
    const pv = b.applyRules();
    eq([pv.dryRun, pv.applied.length], [true, 1], 'the preview lists what would change');
    const before = shell.wins.map(w => w.workspace);
    b.applyRules();
    eq(shell.wins.map(w => w.workspace), before, 'the preview moved nothing');
    const applied = b.applyRules(true);
    eq([applied.dryRun, applied.applied[0].actions, applied.skipped.length], [false, {workspace: 2, fullscreen: true}, 1], 'a confirmed call applies and reports');
    eq(shell.ruleCalls.slice(-1), ['ApplyRules'], 'the confirmed call is ApplyRules, the preview ApplyRulesPreview');
    eq(b.applyRules(true).applied.length, 0, 'a second call is a no-op');
    shell.engine = false;
    throws(() => b.applyRules(true), /engine is off/, 'engine off is refused in words');
    shell.engine = true;

    // a shell speaking another version, or an older Tile without the methods, is told apart in words
    shell.version = 2;
    throws(() => b.snapshots(), /workspace API 2/, 'a different API version');
    shell.version = 1;
    const call = TileBackend.prototype._call;
    TileBackend.prototype._call = function (m, p) { if (/Groups|Snapshots|WorkspaceApi/.test(m)) throw new Error('GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such method'); return call.call(this, m, p); };
    throws(() => b.snapshots(), /older than this panel/, 'an older Tile');
    TileBackend.prototype._call = call;
    shell.on = false;
    throws(() => b.snapshots(), /not running/, 'the shell went away');
}

print('tileBackend: ok');
