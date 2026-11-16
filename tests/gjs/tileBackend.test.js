// The tiling's backend against real schemas (a throw-away settings backend) and throw-away folders: checks, profiles, backups, undo,
// reset, and the way a failed write puts everything back.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const tmp = GLib.dir_make_tmp('niro-tile-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);

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

print('tileBackend: ok');
