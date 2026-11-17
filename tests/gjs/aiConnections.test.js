// The Connections on the Island's AI Usage page: opencode's Go plan is signed in only with an API key for it in opencode's auth.json.
// The DeepSeek key on the Island's AI Usage page: refused when it is not a key, saved as a private file (mode 600) when it is, never put into the settings,
// forgotten on request; saving it turns the card on.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const tmp = GLib.dir_make_tmp('niro-ai-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${tmp}/config`, true);
GLib.setenv('DEEPSEEK_API_KEY', '', true);

if (!Gtk.init_check()) { print('aiConnections: no display, skipped'); imports.system.exit(0); }
Adw.init();

const {aiConnectionsGroup, checkKey, deepseekKeyFile, keyStatus, opencodeGoSignedIn, removeKey, saveKey} = await import('../../control/build/aiConnections.js');
const {Stores} = await import('../../control/build/store.js');

const stores = new Stores();
const island = stores.by.island ?? fail('no island schema (NIRO_SCHEMA_DIR)');
const toasts = [];
const group = aiConnectionsGroup({stores}, {toast: m => toasts.push(m)});

const all = (w, test, out = []) => { if (test(w)) out.push(w); for (let c = w.get_first_child(); c; c = c.get_next_sibling()) all(c, test, out); return out; };
const entry = all(group, w => w instanceof Adw.PasswordEntryRow)[0] ?? fail('no key field');

// not a key
for (const bad of ['', '   ', 'short', 'two words here that are long enough to pass the length']) {
    try { checkKey(bad); fail(`"${bad}" was accepted`); } catch (e) { if (!/does not look like an API key/.test(e.message)) throw e; }
}
entry.set_text('too short');
entry.emit('apply');
if (!toasts.some(t => /does not look like an API key/.test(t))) fail(`no sentence for a bad key (${toasts})`);
if (GLib.file_test(deepseekKeyFile(), GLib.FileTest.EXISTS)) fail('a bad key was saved');

// a key: saved privately, the card is turned on, the field is cleared, the settings do not hold it
island.set_boolean('usage-deepseek', false);
island.set_boolean('usage-enabled', false);
const KEY = 'sk-0123456789abcdef0123456789abcdef';
entry.set_text(KEY);
entry.emit('apply');
const info = Gio.File.new_for_path(deepseekKeyFile()).query_info('unix::mode', 0, null);
if ((info.get_attribute_uint32('unix::mode') & 0o777) !== 0o600) fail(`the key file has mode ${(info.get_attribute_uint32('unix::mode') & 0o777).toString(8)}, wanted 600`);
const dirInfo = Gio.File.new_for_path(GLib.path_get_dirname(deepseekKeyFile())).query_info('unix::mode', 0, null);
if ((dirInfo.get_attribute_uint32('unix::mode') & 0o077) !== 0) fail('the folder of the key is open to others');
if (new TextDecoder().decode(Gio.File.new_for_path(deepseekKeyFile()).load_contents(null)[1]).trim() !== KEY) fail('the key was not written as given');
if (entry.get_text() !== '') fail('the field still shows the key');
if (!island.get_boolean('usage-deepseek') || !island.get_boolean('usage-enabled')) fail('saving a key did not turn the card on');
if (keyStatus().tail !== KEY.slice(-4) || keyStatus().source !== 'file') fail(`status: ${JSON.stringify(keyStatus())}`);
// nothing the settings hold contains the key
for (const k of island.settings_schema.list_keys())
    if (String(island.get_value(k).print(false)).includes(KEY)) fail(`the key is in the setting ${k}`);
if (!all(group, w => w instanceof Adw.ActionRow && /ends in …cdef/.test(w.subtitle ?? '')).length) fail('the page does not say a key is saved');

// forgotten
all(group, w => w instanceof Gtk.Button && w.label === 'Forget the key')[0].emit('clicked');
if (GLib.file_test(deepseekKeyFile(), GLib.FileTest.EXISTS)) fail('the key file is still there');
if (keyStatus().saved) fail('the key is still reported');
removeKey();   // forgetting again is not an error

// opencode's Go plan: a "opencode-go" API key in opencode's own auth.json, and nothing else, counts
const opencodeAuth = (name, content) => {
    const dir = `${tmp}/${name}`;
    GLib.mkdir_with_parents(`${dir}/opencode`, 0o700);
    if (content !== null)
        GLib.file_set_contents(`${dir}/opencode/auth.json`, JSON.stringify(content));
    return dir;
};
if (!opencodeGoSignedIn(opencodeAuth('oc-go', {'opencode-go': {type: 'api', key: 'sk-go-123'}}))) fail('a Go key was not seen');
for (const [name, content] of [['oc-none', null], ['oc-empty', {}], ['oc-zen', {opencode: {type: 'api', key: 'sk-zen'}}],
    ['oc-oauth', {'opencode-go': {type: 'oauth', access: 'x'}}], ['oc-blank', {'opencode-go': {type: 'api', key: '  '}}]]) {
    if (opencodeGoSignedIn(opencodeAuth(name, content))) fail(`${name} counted as the Go plan`);
}
if (!all(group, w => w instanceof Adw.ActionRow && w.get_title() === 'opencode (Go plan)').length) fail('no opencode row in Connections');

print('aiConnections: ok');
