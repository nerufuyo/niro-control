// Backup & Restore: the page against a FAKE settings backend and fake pickers (no real settings, no dialogs), the real Gio backend
// against throw-away schemas (memory GSettings backend) and temp files, the plugin checker's command line against temp folders, and the
// page's place in the window. Widgets are found by name and text: nothing here was seen on a screen.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const tmp = GLib.dir_make_tmp('niro-backup-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${tmp}/state`, true);
if (!Gtk.init_check()) { print('backupPage: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {backupPage} = await import('../../control/build/backupPage.js');
const {GioSettingsIO, GioFiles, sha256} = await import('../../control/build/backupBackend.js');
const {exportSettings, parseBackup, planImport, applyPlan} = await import('../../control/build/backupLogic.js');
const {runPluginCli, manifestPath} = await import('../../control/build/pluginCli.js');
const {Model} = await import('../../control/build/pages.js');

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const named = (root, name) => all(root, w => w.get_name?.() === name)[0] ?? null;
const need = (root, name) => named(root, name) ?? fail(`no widget named ${name}`);
const texts = root => all(root, w => w instanceof Gtk.Label).map(l => l.get_label() ?? '').concat(all(root, w => w instanceof Adw.PreferencesRow || w instanceof Adw.ActionRow || w instanceof Adw.Banner || w instanceof Adw.StatusPage).flatMap(r => [r.get_title?.() ?? '', r.get_subtitle?.() ?? '', r.get_description?.() ?? '']));
const has = (root, re) => texts(root).some(t => re.test(t));
const tick = (ms = 20) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(10); };
const ctx = {toast: () => {}, openLook: () => {}, go: () => {}, inhibitShortcuts: () => {}, takenShortcuts: () => [], window: null};

// ---- a fake settings backend (same contract as GioSettingsIO)
const TYPES = {niro: {opacity: 'i', accent: 's', 'ai-api-key': 's', open: 'b'}};
function fakeEnv(initial, {failWrite = null, sources = ['niro']} = {}) {
    const store = JSON.parse(JSON.stringify(initial));
    return {
        store,
        env: {
            hash: sha256, appVersion: 'test', now: () => '2026-01-01T00:00:00Z',
            settings: {
                sources: () => { if (sources === 'throw') throw new Error('no settings'); return sources; },
                keys: s => ({...TYPES[s]}),
                read: (s, k) => store[s][k],
                canon: (s, k, t) => { if (TYPES[s][k] === 'i' && !/^\d+$/.test(t)) throw new Error('not a number'); return t; },
                writable: () => true,
                write: (s, k, t) => { if (`${s}.${k}` === failWrite) throw new Error('refused'); store[s][k] = t; },
            },
        },
    };
}
const fakeFiles = (init = {}) => ({store: {...init}, read(p) { if (!(p in this.store)) throw new Error('No such file'); return this.store[p]; }, write(p, t) { this.store[p] = t; }});
const initial = () => ({niro: {opacity: '80', accent: "'#E8472B'", 'ai-api-key': "'sk-AAAAAAAAAAAAAAAAAAAA'", open: 'true'}});
const dialogs = (savePath = null, openPath = null) => ({save: async () => savePath, open: async () => openPath});
const make = async (e, files, d, load = true) => {
    const page = backupPage(new Model(ctx), ctx, e.env, files, d);
    if (load) { await page.ensure(); await settle(); }
    return {page, root: page.widget};
};
const shown = p => p.stack.get_visible_child_name();

// ---- loading, then ready; nothing written yet
{
    const e = fakeEnv(initial()), files = fakeFiles();
    const {page, root} = await make(e, files, dialogs(), false);
    page.ensure(); await tick(0);
    await settle();
    if (shown(page) !== 'main') fail('not ready');
    need(root, 'backup-export'); need(root, 'backup-choose');
    if (!has(root, /Never included/) || !has(root, /token/)) fail('the exclusion list is not shown');
    if (Object.keys(files.store).length) fail('something was written without a request');
    page.dispose();
}
// ---- empty and error
{
    const {page, root} = await make(fakeEnv(initial(), {sources: []}), fakeFiles(), dialogs());
    if (shown(page) !== 'status' || !has(root, /Nothing to back up/)) fail('no empty screen');
    page.dispose();
    const e2 = await make(fakeEnv(initial(), {sources: 'throw'}), fakeFiles(), dialogs());
    if (shown(e2.page) !== 'status' || !has(e2.root, /could not be read/) || !has(e2.root, /no settings/)) fail('no error screen');
    need(e2.root, 'backup-retry');
    e2.page.dispose();
}
// ---- export: cancelled dialog does nothing; chosen path writes without the secret, and shows success
{
    const e = fakeEnv(initial()), files = fakeFiles();
    let pick = null;
    const {page, root} = await make(e, files, {save: async () => pick, open: async () => null});
    need(root, 'backup-export').emit('clicked'); await settle();
    if (Object.keys(files.store).length) fail('cancelled export wrote a file');
    pick = '/tmp/x/niro.json';
    need(root, 'backup-export').emit('clicked'); await settle();
    const out = files.store['/tmp/x/niro.json'] ?? fail('no file written');
    if (out.includes('sk-AAAA')) fail('a secret was exported');
    need(root, 'backup-success');
    if (!has(root, /Exported 3 settings/)) fail('no success text');
    if (!has(root, /Left out of the last export/) || !has(root, /ai-api-key/)) fail('the left-out secret is not named');
    page.dispose();
}
// ---- restore: preview with a per-key diff, Cancel, then Apply -> success -> Undo
{
    const a = fakeEnv(initial()), text = exportSettings(a.env).text;
    const start = {niro: {...initial().niro, opacity: '30', accent: "'#000000'"}};
    const e = fakeEnv(start), files = fakeFiles({'/b.json': text});
    const {page, root} = await make(e, files, dialogs(null, '/b.json'));
    need(root, 'backup-choose').emit('clicked'); await settle();
    need(root, 'backup-preview'); need(root, 'backup-change:niro.opacity'); need(root, 'backup-change:niro.accent');
    if (!has(root, /30\s+→\s+80/)) fail('no before/after text');
    if (!need(root, 'backup-apply').get_sensitive()) fail('Apply not usable on a good plan');
    if (e.store.niro.opacity !== '30') fail('the preview wrote');
    need(root, 'backup-cancel').emit('clicked'); await settle();
    if (named(root, 'backup-preview')) fail('preview stays after Cancel');
    need(root, 'backup-choose').emit('clicked'); await settle();
    need(root, 'backup-apply').emit('clicked'); await settle();
    if (e.store.niro.opacity !== '80') fail('Apply did not write');
    need(root, 'backup-success');
    if (!has(root, /Imported: 2 settings changed/)) fail('no import success text');
    need(root, 'backup-undo').emit('clicked'); await settle();
    if (e.store.niro.opacity !== '30') fail('Undo did not put it back');
    page.dispose();
}
// ---- applying state (gate), rollback, refused file, unreadable file
{
    const a = fakeEnv(initial()), text = exportSettings(a.env).text;
    const start = {niro: {...initial().niro, opacity: '30'}};
    const e = fakeEnv(start, {failWrite: 'niro.opacity'}), files = fakeFiles({'/b.json': text});
    const {page, root} = await make(e, files, dialogs(null, '/b.json'));
    need(root, 'backup-choose').emit('clicked'); await settle();
    need(root, 'backup-apply').emit('clicked'); await tick(0);
    if (!named(root, 'backup-applying') && !named(root, 'backup-rollback')) fail('neither applying nor rollback shown');
    await settle();
    need(root, 'backup-rollback');
    if (!has(root, /put back/)) fail('no rollback text');
    if (JSON.stringify(e.store) !== JSON.stringify(start)) fail('the settings changed after a failed import');
    // refused (damaged) file
    files.store['/b.json'] = text.replace('"80', '"81');
    need(root, 'backup-choose').emit('clicked'); await settle();
    need(root, 'backup-error'); if (!has(root, /damaged/)) fail('no damaged text');
    // missing file
    page.dispose();
    const m = await make(e, files, dialogs(null, '/nope.json'));
    need(m.root, 'backup-choose').emit('clicked'); await settle();
    if (!has(m.root, /No such file/)) fail('no missing-file text');
    m.page.dispose();
}
// ---- a backup with an unknown key is refused: problem rows, Apply disabled
{
    const a = fakeEnv(initial()), doc = JSON.parse(exportSettings(a.env).text);
    doc.files[0].content = JSON.stringify({nope: {type: 'b', value: 'true'}}); doc.files[0].hash = sha256(doc.files[0].content);
    const e = fakeEnv(initial()), files = fakeFiles({'/b.json': JSON.stringify(doc)});
    const {page, root} = await make(e, files, dialogs(null, '/b.json'));
    need(root, 'backup-choose').emit('clicked'); await settle();
    need(root, 'backup-problem');
    if (need(root, 'backup-apply').get_sensitive()) fail('Apply usable on a refused plan');
    page.dispose();
}

// ---- the real Gio backend on the throw-away schemas: export, change, preview, import, read-back; file size cap and mode
{
    const io = new GioSettingsIO();
    const env = {settings: io, hash: sha256, appVersion: 'test'};
    if (!io.sources().includes('niro')) fail('the niro schema is not available to the backend');
    const keys = io.keys('niro');
    if (Object.keys(keys).length < 10) fail('too few keys read from the schema');
    const r = exportSettings(env);
    if (!r.ok || r.keys < 10) fail(`real export failed: ${r.error}`);
    // change a boolean and a string, then restore from the backup
    const boolKey = Object.keys(keys).find(k => keys[k] === 'b' && !/token|password|secret|passphrase|key/i.test(k));
    const settings = new Gio.Settings({schema_id: 'org.niro.control'});
    const was = settings.get_boolean(boolKey);
    settings.set_boolean(boolKey, !was);
    const p = parseBackup(r.text, env);
    if (!p.ok) fail(`real parse failed: ${p.error}`);
    const plan = planImport(p.entries, env);
    if (!plan.ok) fail(`real plan refused: ${plan.problems.slice(0, 3)}`);
    if (!plan.changes.some(c => c.id === `niro.${boolKey}`)) fail('the changed key is not in the diff');
    const a = applyPlan(plan, env);
    if (!a.ok) fail(`real apply failed: ${a.error}`);
    if (settings.get_boolean(boolKey) !== was) fail('the value was not restored');
    // a wrong type is refused against the real schema
    const bad = {niro: {[boolKey]: {type: 's', value: "'x'"}}};
    if (planImport(bad, env).ok) fail('a wrong type was accepted by the real schema');
    // a value outside the schema's range or type text is refused
    const intKey = Object.keys(keys).find(k => keys[k] === 'i');
    if (planImport({niro: {[intKey]: {type: 'i', value: 'banana'}}}, env).ok) fail('a bad value was accepted');
    // files
    const files = new GioFiles();
    const path = `${tmp}/out/backup.json`; GLib.mkdir_with_parents(`${tmp}/out`, 0o755);
    files.write(path, r.text);
    const mode = Gio.File.new_for_path(path).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777;
    if (mode !== 0o600) fail(`backup file mode is ${mode.toString(8)}, not 600`);
    if (files.read(path) !== r.text) fail('file round trip differs');
    const big = `${tmp}/out/big.json`; GLib.file_set_contents(big, 'x'.repeat(1024 * 1024 + 5));
    let refused = false; try { files.read(big); } catch (e) { refused = /larger than 1 MB/.test(e.message); }
    if (!refused) fail('an oversize file was read');
}

// ---- niro-plugin check (validation only), against temp folders
{
    const dir = `${tmp}/plug`; GLib.mkdir_with_parents(dir, 0o755);
    const good = {id: 'com.example.hello', name: 'Hello', version: '1.0.0', apiVersion: '1.0', capabilities: ['notifications'], entryPoint: 'main.js'};
    GLib.file_set_contents(`${dir}/manifest.json`, JSON.stringify(good));
    // the entry point is never opened: it does not even exist here
    if (manifestPath(dir) !== `${dir}/manifest.json`) fail('a folder does not resolve to its manifest.json');
    if (runPluginCli(['check', dir]) !== 0) fail('a valid manifest was not accepted (folder)');
    if (runPluginCli(['check', `${dir}/manifest.json`, '--json']) !== 0) fail('a valid manifest was not accepted (file)');
    GLib.file_set_contents(`${dir}/manifest.json`, JSON.stringify({...good, capabilities: ['network'], entryPoint: '../x.js'}));
    if (runPluginCli(['check', dir]) !== 1) fail('an invalid manifest was accepted');
    GLib.file_set_contents(`${dir}/manifest.json`, 'x'.repeat(70 * 1024));
    if (runPluginCli(['check', dir]) !== 1) fail('an oversize manifest was read');
    if (runPluginCli(['check', `${tmp}/missing`]) !== 1) fail('a missing path was accepted');
    if (runPluginCli(['check']) !== 2) fail('check without a target did not say usage');
    if (runPluginCli(['install', dir]) !== 2) fail('an install command exists');
    if (runPluginCli(['help']) !== 0) fail('help failed');
}

// ---- the window: the page is in System, before About, and no Ctrl+N number moved (it is past the ninth)
{
    const {buildWindow} = await import('../../control/build/window.js');
    const app = new Adw.Application({application_id: 'org.niro.ControlBackupTest'});
    app.register(null);
    const {window, shared} = buildWindow(app);
    const row = all(window, w => w instanceof Gtk.ListBoxRow && w.get_name() === 'backup')[0] ?? fail('Backup & Restore is not in the sidebar');
    const rows = all(row.get_parent(), w => w instanceof Gtk.ListBoxRow && w.get_parent() === row.get_parent()).map(r => r.get_name());
    if (rows.indexOf('backup') < rows.indexOf('notifications') || rows.indexOf('backup') > rows.indexOf('about')) fail(`not in System: ${rows}`);
    if (rows.indexOf('backup') < 9) fail('the page moved into the first nine (Ctrl+N would shift)');
    if (!shared.backup?.flow) fail('the window has no backup page');
    window.close();
}
GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
print('backupPage: ok');
