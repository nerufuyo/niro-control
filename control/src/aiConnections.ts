// @ts-nocheck: GTK / libadwaita are untyped here
// "Connections" on the Island's AI Usage page: how each AI is reached (Claude, ChatGPT Plus or Pro, Grok through their command lines' sign-ins; opencode's Go plan
// through the key opencode keeps; DeepSeek with an API key) and, for DeepSeek, where to put the key. The key goes into a private file of the user's (~/.config/niro/deepseek-api-key, mode 600), never into the
// settings (dconf is not private); island-daemon reads it from there.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

export const deepseekKeyFile = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'niro', 'deepseek-api-key']);

const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
/** Whether opencode holds an API key for the OpenCode Go plan (`opencode auth login`), in its own auth.json: what island-daemon asks the limits with. */
export function opencodeGoSignedIn(dataDir = GLib.get_user_data_dir()) {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dataDir, 'opencode', 'auth.json']));
        const entry = JSON.parse(new TextDecoder().decode(bytes))?.['opencode-go'];
        return entry?.type === 'api' && String(entry.key ?? '').trim() !== '';
    } catch (_e) {
        return false;
    }
}

const homeDir = (variable, fallback) => GLib.getenv(variable) || GLib.build_filenamev([GLib.get_home_dir(), fallback]);

/** What is not a key at all: nothing, blanks, or a sentence. */
export function checkKey(text) {
    const key = String(text ?? '').trim();
    if (!/^\S{16,300}$/.test(key))
        throw new Error('That does not look like an API key: no spaces, and at least 16 characters');
    return key;
}

/** Saves the key as a private file (only the user can read it). Throws a sentence when it cannot. */
export function saveKey(text) {
    const key = checkKey(text);
    const file = deepseekKeyFile();
    GLib.mkdir_with_parents(GLib.path_get_dirname(file), 0o700);
    Gio.File.new_for_path(file).replace_contents(new TextEncoder().encode(`${key}\n`), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
    return key;
}

export function removeKey() {
    try {
        Gio.File.new_for_path(deepseekKeyFile()).delete(null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
}

/** `{saved, tail, source}`: whether a key is there (the file, else DEEPSEEK_API_KEY), and its last four characters to recognise it by. */
export function keyStatus() {
    try {
        const text = new TextDecoder().decode(Gio.File.new_for_path(deepseekKeyFile()).load_contents(null)[1]).trim();
        if (text)
            return {saved: true, tail: text.slice(-4), source: 'file'};
    } catch (_e) { /* none */ }
    const env = (GLib.getenv('DEEPSEEK_API_KEY') ?? '').trim();
    return env ? {saved: true, tail: env.slice(-4), source: 'environment'} : {saved: false, tail: '', source: null};
}

/** Tells island-daemon to read the usage again now (it also does by itself every ten minutes). */
function refreshDaemon() {
    try {
        Gio.DBus.session.call('org.niro.island.Daemon', '/org/niro/island/Daemon', 'org.niro.island.Usage1', 'Refresh', null, null,
            Gio.DBusCallFlags.NO_AUTO_START, 2000, null, null);
    } catch (_e) { /* the island is not running: it reads the key when it starts */ }
}

export function aiConnectionsGroup(model, ctx) {
    const group = new Adw.PreferencesGroup({title: 'Connections',
        description: 'How the island reaches each AI. Claude, ChatGPT and Grok use the sign-in of their command line, and opencode the key it keeps for its Go plan, so nothing is typed here; DeepSeek has no sign-in, only an API key.'});
    const island = model.stores.by.island;
    const row = (title, subtitle, ok) => {
        const r = new Adw.ActionRow({title, subtitle});
        r.add_prefix(new Gtk.Image({icon_name: ok ? 'emblem-ok-symbolic' : 'dialog-information-symbolic', css_classes: [ok ? 'success' : 'dim-label']}));
        r.set_subtitle_selectable?.(true);
        return r;
    };
    const claude = homeDir('CLAUDE_CONFIG_DIR', '.claude');
    const codex = homeDir('CODEX_HOME', '.codex');
    const grok = homeDir('GROK_HOME', '.grok');
    const rows = {
        claude: row('Claude', '', false), chatgpt: row('ChatGPT Plus or Pro', '', false), grok: row('Grok', '', false), opencode: row('opencode (Go plan)', '', false),
    };
    Object.values(rows).forEach(r => group.add(r));
    const deepseek = row('DeepSeek', '', false);
    group.add(deepseek);

    const entry = new Adw.PasswordEntryRow({title: 'DeepSeek API key'});
    entry.set_show_apply_button(true);
    entry.update_property([Gtk.AccessibleProperty.DESCRIPTION], ['Paste a key from platform.deepseek.com and press the check mark. It is kept in a private file.']);
    const forget = new Gtk.Button({label: 'Forget the key', valign: Gtk.Align.CENTER, css_classes: ['flat', 'destructive-action']});
    const forgetRow = new Adw.ActionRow({title: 'Saved key', subtitle: ''});
    forgetRow.add_suffix(forget);
    group.add(entry);
    group.add(forgetRow);

    const sync = () => {
        rows.claude.set_subtitle(exists(GLib.build_filenamev([claude, '.credentials.json'])) ? 'Signed in with Claude Code: the plan and its limits show' : 'Not signed in. Open Claude Code (`claude`) and sign in.');
        rows.chatgpt.set_subtitle(exists(GLib.build_filenamev([codex, 'auth.json'])) ? 'Signed in with Codex: the Plus or Pro limits (5 hours, week) show'
            : 'Not signed in. Install Codex, run `codex login` and choose "Sign in with ChatGPT". No API key.');
        rows.grok.set_subtitle(exists(GLib.build_filenamev([grok, 'auth.json'])) ? 'Signed in with Grok: its allowance shows' : 'Not signed in. Open the Grok command line and sign in.');
        rows.opencode.set_subtitle(opencodeGoSignedIn() ? 'Signed in to the Go plan with opencode: its 5-hour, weekly and monthly limits show'
            : 'Not signed in to the Go plan. Install opencode, run `opencode auth login` and choose OpenCode Go.');
        const status = keyStatus();
        deepseek.set_subtitle(status.saved
            ? `An API key is saved (ends in …${status.tail}${status.source === 'environment' ? ', from DEEPSEEK_API_KEY' : ''}); the balance shows when "Show DeepSeek's balance" is on`
            : 'No API key yet. Get one at platform.deepseek.com, then paste it below.');
        forgetRow.set_visible(status.saved && status.source === 'file');
        forgetRow.set_subtitle(status.saved ? `…${status.tail}` : '');
    };
    entry.connect('apply', () => {
        try {
            saveKey(entry.get_text());
            entry.set_text('');
            // Saving a key means wanting the card: usage and DeepSeek's switch go on
            island?.set_boolean('usage-enabled', true);
            island?.set_boolean('usage-deepseek', true);
            ctx.toast('DeepSeek API key saved. Its balance shows in the island\'s Usage page.');
            refreshDaemon();
        } catch (e) {
            ctx.toast(e.message);
        }
        sync();
    });
    forget.connect('clicked', () => {
        try { removeKey(); ctx.toast('DeepSeek API key removed'); refreshDaemon(); } catch (e) { ctx.toast(`Could not remove the key: ${e.message}`); }
        sync();
    });
    sync();
    group.refresh = sync;
    return group;
}
