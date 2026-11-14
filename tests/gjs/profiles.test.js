// The profile engine against real schemas (a throw-away settings backend) and a throw-away config folder.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CATALOG} from '../../control/build/catalog.js';
import {ProfileEngine} from '../../control/build/profiles.js';
import {Stores} from '../../control/build/store.js';

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const tmp = GLib.dir_make_tmp('niro-profiles-XXXXXX');
const builtinDir = GLib.path_get_dirname(import.meta.url.replace('file://', '')) + '/../../control/profiles';
const stores = new Stores();
const engine = new ProfileEngine(stores, {root: tmp, builtinDir});
const value = id => engine.readItem(CATALOG.find(i => i.id === id));

// capture covers every registered setting that has an owner, and the ones Look owns are covered by Look
const captured = engine.capture();
eq(Object.keys(captured).length, CATALOG.filter(i => !i.managed).length, 'captured settings');
for (const m of CATALOG.filter(i => i.managed)) if (!(m.managed in captured)) fail(`${m.id} is not covered by ${m.managed}`);
eq(CATALOG.length, 132, 'registered settings');

// built-in profiles are listed first, protected, and resolve through extends
const names = engine.list().map(p => p.name);
eq(names.slice(0, 4), ['Everyday', 'Deep Work', 'Creative', 'Gaming'], 'built-ins');
for (const verb of [() => engine.rename('gaming', 'x'), () => engine.remove('gaming'), () => engine.updateFromCurrent('gaming')])
    try { verb(); fail('a built-in profile was changed'); } catch (e) { if (!/built-in/.test(e.message)) throw e; }
const dw = engine.get('deep-work');
eq(engine.settingsOf(dw)['niro.accent'], '#E8472B', 'inherited from Everyday');
eq(engine.settingsOf(dw)['niro.opacity'], 92, 'own value wins');

// preview, apply, active, modifications
const before = engine.capture();
const planned = engine.preview(engine.settingsOf(dw));
if (!planned.length || planned.some(c => c.from === undefined)) fail('preview should list real changes');
const r = engine.apply('deep-work');
if (!r.ok) fail(`apply failed: ${JSON.stringify(r)}`);
eq(value('niro.opacity'), 92, 'applied opacity');
eq(value('dock.auto-hide'), true, 'applied dock auto-hide');
eq(value('island.auto-hide'), 'windows', 'applied island auto-hide');
eq(engine.active(), 'deep-work', 'active profile');
eq(engine.modifications().length, 0, 'nothing modified right after applying');
eq(engine.apply('deep-work').changed.length, 0, 'applying twice changes nothing');
stores.by.niro.set_int('opacity', 50);
eq(engine.modifications().map(c => c.id), ['niro.opacity'], 'a manual change is seen');

// unrelated settings are untouched
const after = engine.capture();
const touched = Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
for (const id of touched) if (!(id in engine.settingsOf(dw)) && id !== 'niro.opacity') fail(`${id} changed but the profile does not name it`);
const gnome = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
void gnome;

// automatic backup before applying, and restore (undo)
const backups = engine.backups();
if (!backups.length || !/Before applying Deep Work/.test(backups[0].label)) fail('no backup was made before applying');
eq(backups[0].count, Object.keys(before).length, 'backup holds every setting');
const restored = engine.restore(backups[0].file);
if (!restored.ok) fail('restore failed');
eq(engine.capture(), before, 'restoring the backup brings back every setting');
eq(engine.active(), null, 'a restore clears the active profile');

// create (all, partial), rename, duplicate, delete
stores.by.niro.set_int('opacity', 61);
const mine = engine.create('My look');
eq(mine.id, 'my-look', 'new id');
eq(Object.keys(mine.settings).length, Object.keys(before).length, 'a full profile holds every setting');
const partial = engine.create('Only dock', {menus: ['Dock']});
if (!Object.keys(partial.settings).every(id => id.startsWith('dock.'))) fail('a partial profile holds only its menu');
eq(engine.create('My look').id, 'my-look-2', 'ids stay unique');
engine.rename('my-look', 'Renamed');
eq(engine.get('my-look').name, 'Renamed', 'rename');
const copy = engine.duplicate('my-look');
eq(copy.name, 'Renamed copy', 'duplicate');
stores.by.niro.set_int('opacity', 33);
engine.updateFromCurrent('my-look');
eq(engine.get('my-look').settings['niro.opacity'], 33, 'update from current');
engine.apply('only-dock');
eq(engine.active(), 'only-dock', 'a partial profile can be applied');
engine.remove('only-dock');
eq(engine.active(), null, 'deleting the active profile clears it');
if (engine.get('only-dock')) fail('profile was not deleted');

// export and import, round trip, and refusals
const out = `${tmp}/export.json`;
engine.exportTo('deep-work', out);
const imported = engine.importFrom(out);
eq(imported.profile.id, 'deep-work-2', 'import never replaces a built-in');
eq(imported.profile.builtin, undefined, 'an imported profile is not built-in');
eq(engine.settingsOf(engine.get(imported.profile.id)), engine.settingsOf(dw), 'a round trip keeps every setting');
GLib.file_set_contents(`${tmp}/bad.json`, JSON.stringify({format: 'niro-profile', version: 1, name: 'Bad', settings: {'niro.opacity': 999}}));
try { engine.importFrom(`${tmp}/bad.json`); fail('an invalid profile was imported'); } catch (e) { if (!/at most 100/.test(e.message)) throw e; }
GLib.file_set_contents(`${tmp}/junk.json`, 'not json');
try { engine.importFrom(`${tmp}/junk.json`); fail('junk was imported'); } catch (e) { if (!/Can't read/.test(e.message)) throw e; }
GLib.file_set_contents(`${tmp}/future.json`, JSON.stringify({format: 'niro-profile', version: 99, name: 'F', settings: {}}));
try { engine.importFrom(`${tmp}/future.json`); fail('a newer profile was imported'); } catch (e) { if (!/newer/.test(e.message)) throw e; }

// a failed write rolls everything back
const start = engine.capture();
const target = {'niro.opacity': 10, 'dock.icon-size': 100, 'island.auto-hide': 'always', 'dock.auto-hide': false};
const real = engine.writeItem.bind(engine);
let writes = 0;
engine.writeItem = (item, v) => { if (++writes === 3) throw new Error('disk full'); real(item, v); };
const bad = engine.applySettings(target);
engine.writeItem = real;
eq(bad.ok, false, 'a failed write is reported');
eq(bad.failed.error, 'disk full', 'the failure is named');
eq(bad.rolledBack, true, 'the earlier writes were put back');
eq(engine.capture(), start, 'nothing changed after the rollback');

// backups are capped
for (let i = 0; i < 14; i++) { GLib.usleep(2000); engine.backup(`n${i}`); }
eq(engine.backups().length, 10, 'only the last ten backups are kept');
print('profiles: ok');

// ---- Reliability: explicit values versus defaults, an interrupted change, a rollback that cannot finish, import limits
const userSet = (source, key) => stores.by[source].get_user_value(key) !== null;
for (const [source, key] of [['island', 'system-alerts'], ['island', 'chimes'], ['dock', 'bounce-on-launch'], ['niro', 'opacity']]) stores.by[source].reset(key);
if (userSet('island', 'system-alerts') || userSet('niro', 'opacity')) fail('the starting point should have unset keys');
engine.backup('start');
const startBackup = engine.backups()[0];
if (!startBackup) fail('no backup to restore');
const tgt = {'island.system-alerts': false, 'island.chimes': false, 'niro.opacity': 40, 'dock.bounce-on-launch': false};
if (!engine.applySettings(tgt).ok) fail('apply failed');
if (!userSet('island', 'system-alerts') || !userSet('niro', 'opacity')) fail('applying should store values');
const back = engine.restore(startBackup.file);
if (!back.ok) fail('restore failed');
for (const [source, key] of [['island', 'system-alerts'], ['island', 'chimes'], ['dock', 'bounce-on-launch'], ['niro', 'opacity']])
    if (userSet(source, key)) fail(`${source}.${key} was written back as a chosen value instead of being unset`);
if (!(back.reset >= 4)) fail(`restore reported ${back.reset} unset keys`);
eq(value('niro.opacity'), 80, 'unset opacity is its default again');

// a key that was explicitly set before stays explicit after a round trip (even when it equals the default)
stores.by.niro.set_int('opacity', 80);
engine.backup('explicit');
const explicit = engine.backups()[0];
engine.applySettings({'niro.opacity': 30});
engine.restore(explicit.file);
if (!userSet('niro', 'opacity')) fail('an explicitly stored value should stay stored');
stores.by.niro.reset('opacity');

// a rollback restores unset keys as unset too
const w0 = engine.writeItem.bind(engine);
let n0 = 0;
engine.writeItem = (item, v) => { if (++n0 === 3) throw new Error('boom'); w0(item, v); };
const failed = engine.applySettings({'island.system-alerts': false, 'island.chimes': false, 'dock.bounce-on-launch': false, 'niro.opacity': 10});
engine.writeItem = w0;
eq(failed.rolledBack, true, 'rolled back');
if (userSet('island', 'system-alerts') || userSet('island', 'chimes') || userSet('niro', 'opacity')) fail('a rollback left stored values where there were none');
eq(engine.interrupted(), null, 'a clean rollback leaves no journal');

// a rollback that cannot finish keeps the journal, and the backup it names puts things right
let n1 = 0, undoing = false;
engine.writeItem = (item, v) => {
    n1++;
    if (n1 === 3) { undoing = true; throw new Error('first failure'); }
    if (undoing) throw new Error('cannot put it back');
    w0(item, v);
};
const stuck = engine.applySettings({'island.system-alerts': false, 'island.chimes': false, 'dock.bounce-on-launch': false}, 'Before the stuck change');
engine.writeItem = w0;
eq(stuck.ok, false, 'failed');
eq(stuck.rolledBack, false, 'the rollback could not finish');
if (!stuck.rollbackErrors.length) fail('the errors of the rollback are reported');
const pending = new ProfileEngine(stores, {root: tmp, builtinDir}).interrupted();
if (!pending || !pending.backup) fail('an unfinished change is remembered, with its backup');
const fixed = new ProfileEngine(stores, {root: tmp, builtinDir}).recover();
if (!fixed.ok) fail('recovery failed');
eq(engine.interrupted(), null, 'recovery clears the note');
if (userSet('island', 'system-alerts') || userSet('island', 'chimes')) fail('recovery should have put the keys back as they were');

// import limits and messages
GLib.file_set_contents(`${tmp}/huge.json`, JSON.stringify({format: 'niro-profile', version: 1, name: 'Huge', settings: {}, pad: 'x'.repeat(300 * 1024)}));
try { engine.importFrom(`${tmp}/huge.json`); fail('a huge file was imported'); } catch (e) { if (!/too big/.test(e.message)) throw e; }
GLib.file_set_contents(`${tmp}/broken.json`, '{\n  "format": "niro-profile",\n  "name": \n}');
try { engine.importFrom(`${tmp}/broken.json`); fail('broken JSON was imported'); } catch (e) { if (!/line \d+,? column \d+/.test(e.message)) throw new Error(`no position in: ${e.message}`); }
GLib.file_set_contents(`${tmp}/many.json`, JSON.stringify({format: 'niro-profile', version: 1, name: 'Many', settings: {'niro.opacity': 500, 'dock.icon-size': 5, 'island.auto-hide': 'x'}}));
try { engine.importFrom(`${tmp}/many.json`); fail('invalid values were imported'); } catch (e) {
    if (!/at most 100/.test(e.message) || !/at least 16/.test(e.message) || !/one of/.test(e.message)) throw new Error(`not every error is listed: ${e.message}`);
}
// the notes of an apply name what has no effect
const noted = engine.applySettings({'island.hover-delay': 300, 'island.open-on': 'click'});
if (!noted.notes.length || !/no effect/.test(noted.notes[0].text)) fail('an inactive setting should be noted');
print('profiles reliability: ok');
