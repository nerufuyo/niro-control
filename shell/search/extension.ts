// @ts-nocheck: GNOME Shell's modules are untyped here
// Niro Search: a command palette (Super+Space). Applications, a calculator, unit conversion, open windows, every Niro
// setting, profiles, system actions and the island's clipboard history, all through one action registry. Its look follows
// org.niro.control; the registry is also offered over D-Bus (org.niro.Search) for shortcuts and the assistant.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {buildRegistry, clipboardHistory, confirm, endPresentation, profiles, windows} from './actions.js';
import {calculate} from './calc.js';
import {searchItems} from './logic.js';
import {hint, keyIntent, move, Once} from './nav.js';
import {arrange, bestScore} from './rank.js';
import {INDEX} from './settings-index.js';
import {convert, moneyQuery, moneyText} from './units.js';
import {zoneQuery} from './zones.js';
import {fileNeedle, findArgs, rankFiles} from './files.js';
import {toolQuery} from './tools.js';

const WIDTH = 680;
/** JSON with the keys in order, so the same arguments written in another order are the same request. */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const LIMITS = {Applications: 5, Windows: 4, Settings: 5, Profiles: 4, Actions: 4, Clipboard: 6, Files: 8};
const RECENT_MAX = 8;
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
// St.BoxLayout: `vertical` up to GNOME 50, `orientation` from 48 (GNOME 51 dropped `vertical`).
const VERTICAL = parseInt(PACKAGE_VERSION, 10) >= 48 ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};

const PAGE_OF = {Look: 'look', Island: 'island', Dock: 'dock', Windows: 'windows', Search: 'search'};
const RATE_TTL_MS = 6 * 3600 * 1000;
const ICON = {Calculator: 'accessories-calculator-symbolic', Conversion: 'edit-find-replace-symbolic', Settings: 'preferences-system-symbolic',
    Profiles: 'user-bookmarks-symbolic', Actions: 'system-run-symbolic', Clipboard: 'edit-paste-symbolic', Files: 'folder-documents-symbolic', Tools: 'applications-utilities-symbolic', Windows: 'focus-windows-symbolic'};

const DBUS_XML = `<node><interface name="org.niro.Search">
  <method name="ListActions"><arg type="s" direction="out" name="json"/></method>
  <method name="Availability"><arg type="s" direction="in" name="id"/><arg type="s" direction="out" name="json"/></method>
  <method name="RunAction"><arg type="s" direction="in" name="id"/><arg type="s" direction="in" name="args_json"/><arg type="s" direction="out" name="outcome_json"/></method>
  <method name="History"><arg type="u" direction="in" name="limit"/><arg type="s" direction="out" name="json_lines"/></method>
</interface></node>`;

export default class NiroSearch extends Extension {
    enable() {
        this._look = new Gio.Settings({schema_id: 'org.niro.control'});
        this._registry = buildRegistry();
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._once = new Once();
        this._rates = new Map();
        this._files = new Map();
        this._vars = {};
        this._soup = new Soup.Session({timeout: 6});

        this._box = new St.BoxLayout({style_class: 'niro-search', ...VERTICAL, reactive: true, visible: false, width: WIDTH});
        this._entry = new St.Entry({style_class: 'niro-search-entry', hint_text: 'Search apps, settings, windows, or type a calculation…', can_focus: true, x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'niro-search-scroll', hscrollbar_policy: St.PolicyType.NEVER, overlay_scrollbars: true});
        this._list = new St.BoxLayout({style_class: 'niro-search-list', ...VERTICAL});
        this._scroll.set_child(this._list);
        this._status = new St.Label({style_class: 'niro-search-status', visible: false});
        this._hint = new St.Label({style_class: 'niro-search-hint', text: hint(undefined)});
        this._box.add_child(this._entry); this._box.add_child(this._status); this._box.add_child(this._scroll); this._box.add_child(this._hint);
        Main.layoutManager.uiGroup.add_child(this._box);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._refresh());
        text.connect('key-press-event', (_a, event) => this._onKey(event));

        Main.wm.addKeybinding('search-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
        Main.wm.addKeybinding('snip-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._snip());
        this._export();
    }

    disable() {
        Main.wm.removeKeybinding('search-shortcut');
        Main.wm.removeKeybinding('snip-shortcut');
        this._unexport();
        endPresentation();
        this._soup?.abort();
        this._soup = null;
        this._close();
        this._box?.destroy();
        this._box = this._entry = this._list = this._scroll = this._status = this._hint = null;
        this._registry = this._look = null;
        this._files = null;
    }

    // ---- D-Bus: the registry for shortcuts and the assistant. Anything that is not harmless is asked about on screen.
    _export() {
        const impl = {
            ListActions: () => JSON.stringify(this._registry.manifest({})),
            Availability: id => {
                const a = this._registry.get(id);
                const reason = a ? (a.available?.({}) ?? null) : 'no such action';
                return JSON.stringify({id, available: Boolean(a) && reason === null, reason});
            },
            History: limit => this._history(Math.min(Math.max(limit, 1), 200)),
            RunActionAsync: (params, invocation) => {
                const [id, argsJson] = params;
                const reply = outcome => invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(outcome)]));
                let args = {};
                try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (_e) {
                    reply({ok: false, code: 'invalid', error: 'arguments are not JSON'});
                    return;
                }
                if (typeof args !== 'object' || Array.isArray(args) || args === null)
                    args = {__bad: true};
                this._caller(invocation.get_sender()).then(caller => this._run(id, args, 'external', caller)).then(reply);
            },
        };
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, impl);
        this._dbus.export(Gio.DBus.session, '/org/niro/Search');
        this._owner = Gio.DBus.own_name(Gio.BusType.SESSION, 'org.niro.Search', Gio.BusNameOwnerFlags.NONE, null, null, null);
    }

    /** Which program is on the other end of a D-Bus call (its process name), for the audit. */
    _caller(sender) {
        return new Promise(resolve => {
            try {
                Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                    new GLib.Variant('(s)', [sender]), null, Gio.DBusCallFlags.NONE, 1000, null, (conn, res) => {
                        try {
                            const [pid] = conn.call_finish(res).deepUnpack();
                            const comm = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/comm`)[1]).trim();
                            resolve(comm || String(pid));
                        } catch (_e) { resolve('unknown'); }
                    });
            } catch (_e) { resolve('unknown'); }
        });
    }

    // ---- The audit: one line per request that reached the registry, whoever asked
    get _auditPath() { return `${GLib.get_user_data_dir()}/niro-control/audit.jsonl`; }

    _audit(entry) {
        try {
            const path = this._auditPath;
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            const file = Gio.File.new_for_path(path);
            try { if (file.query_info('standard::size', 0, null).get_size() > 512 * 1024) file.move(Gio.File.new_for_path(`${path}.old`), Gio.FileCopyFlags.OVERWRITE, null, null); } catch (_e) { /* not there yet */ }
            const out = file.append_to(Gio.FileCreateFlags.PRIVATE, null);
            out.write_all(new TextEncoder().encode(JSON.stringify(entry) + '\n'), null);
            out.close(null);
        } catch (_e) { /* the history is best effort: it never stops an action */ }
    }

    _history(limit) {
        try {
            const lines = new TextDecoder().decode(GLib.file_get_contents(this._auditPath)[1]).trim().split('\n').filter(Boolean);
            return lines.slice(-limit).join('\n');
        } catch (_e) { return ''; }
    }

    _unexport() {
        if (this._owner) Gio.DBus.unown_name(this._owner);
        this._dbus?.unexport();
        this._owner = 0; this._dbus = null;
    }

    // ---- Running: the one gate. Search, a shortcut over D-Bus and the assistant all come through here.
    async _run(id, args, source, caller = 'search') {
        const started = GLib.get_monotonic_time();
        const key = `${id}\u001f${canon(args)}`;
        // The same request while it is still running or just finished is not run twice (a loop, a double press, a retry)
        this._inflight ??= new Map();
        const now = GLib.get_monotonic_time();
        const last = this._inflight.get(key);
        if (source === 'external' && last !== undefined && (last === 0 || now - last < 1500000)) {
            const outcome = {ok: false, code: 'duplicate', error: 'the same request is already running or has just run'};
            this._audit({at: new Date().toISOString(), source, caller, id, args: this._shorten(args), ok: false, code: 'duplicate', ms: 0});
            return outcome;
        }
        if (source === 'external') this._inflight.set(key, 0);
        const outcome = await this._registry.run(id, args, {}, source, (action) => confirm(action.title, action.confirm, action.title));
        if (source === 'external') this._inflight.set(key, GLib.get_monotonic_time());
        this._audit({at: new Date().toISOString(), source, caller, id, args: this._shorten(args), ok: outcome.ok, code: outcome.code ?? null,
            ms: Math.round((GLib.get_monotonic_time() - started) / 1000)});
        if (!outcome.ok && outcome.code !== 'declined') Main.notify('Niro Search', outcome.error);
        else if (outcome.ok && source === 'external') Main.notify('Niro Search', outcome.message);
        return outcome;
    }

    _shorten(args) {
        const out = {};
        for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
        return out;
    }

    async _activate(result) {
        if (!result || !this._once.begin()) return;
        this._close();
        let outcome;
        try { outcome = await this._run(result.action, result.args, 'ui'); } finally { this._once.end(); }
        if (outcome.ok) {
            if (result.calc && this._vars) {                       // a sum was used: its result is `ans`, and a named one is kept for later sums
                this._vars.ans = result.calc.value;
                if (result.calc.assign) this._vars[result.calc.assign] = result.calc.value;
            }
            if (result.recent !== false) this._remember(result);
            if (result.toast) Main.notify('Niro Search', outcome.message);
        }
    }

    // ---- Recent
    get _recentPath() { return `${GLib.get_user_cache_dir()}/niro-search/recent.json`; }

    _recent() {
        try { return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(this._recentPath)[1])).filter(r => this._registry.get(r.action)); } catch (_e) { return []; }
    }

    _remember(result) {
        if (['Calculator', 'Conversion', 'Clipboard', 'Windows', 'Tools', 'Files'].includes(result.section)) return;       // not kept: they are about the moment
        const entry = {section: result.section, title: result.title, subtitle: result.subtitle, action: result.action, args: result.args, icon: result.iconName};
        const list = [entry, ...this._recent().filter(r => !(r.action === entry.action && JSON.stringify(r.args) === JSON.stringify(entry.args)))].slice(0, RECENT_MAX);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._recentPath), 0o700);
            GLib.file_set_contents(this._recentPath, JSON.stringify(list));
        } catch (_e) { /* not kept */ }
    }

    /** Niro Snip: the desktop's own picker, then an editor for the shot. */
    _snip() {
        if (this._box.visible) this._close();
        this._run('system.snip', {}, 'ui');
    }

    // ---- Showing
    _toggle() { this._box.visible ? this._close() : this._open(); }

    _open() {
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab) return;
        this._applyLook();
        const monitor = Main.layoutManager.currentMonitor;
        this._box.set_position(Math.round(monitor.x + (monitor.width - WIDTH) / 2), Math.round(monitor.y + monitor.height * 0.16));
        this._scroll.style = `max-height: ${Math.round(monitor.height * 0.5)}px;`;
        this._windows = windows();
        this._entry.set_text('');
        this._box.show();
        this._refresh();
        this._entry.grab_key_focus();
        this._outside = global.stage.connect('button-press-event', (_s, event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh) this._close();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _close() {
        if (this._outside) { global.stage.disconnect(this._outside); this._outside = 0; }
        if (this._grab) { Main.popModal(this._grab); this._grab = null; }
        this._box?.hide();
        this._files?.clear();                                   // file names are not kept once the palette is closed
    }

    _applyLook() {
        const [tr, tg, tb] = rgb(this._look.get_string('tint'));
        this._box.set_style(`background-color: rgba(${tr}, ${tg}, ${tb}, ${this._look.get_int('opacity') / 100});`);
        this._accent = rgb(this._look.get_string('accent'));
    }

    // ---- Finding
    _collect(query) {
        const q = query.trim();
        const out = [];
        // score: how well the title (or a keyword) matches, plus the kind's bonus (see rank.ts)
        const add = (section, r) => out.push({section, ...r, score: (r.score ?? bestScore(q, [r.title, ...(r.keywords ?? [])]))});
        if (!q) return this._suggestions();
        const calc = calculate(q, this._vars);
        if (calc) add('Calculator', {title: calc.assign ? `${calc.assign} = ${calc.text}` : calc.text, subtitle: calc.assign ? `Remembered until you log out: use ${calc.assign} in later sums  ·  Enter keeps it and copies`
            : `${q} =  ·  Enter copies  ·  ans is this result`, score: 100, action: 'clipboard.copy', args: {text: calc.text.replace(/,/g, '')}, iconName: ICON.Calculator, toast: true, calc: {assign: calc.assign, value: calc.value}});
        const tool = toolQuery(q, this._toolEnv());
        if (tool) add('Tools', {title: tool.title, subtitle: tool.subtitle, score: 100, action: 'clipboard.copy', args: {text: tool.copy}, iconName: ICON.Tools, toast: true});
        const conv = convert(q);
        if (conv) add('Conversion', {title: conv.text, subtitle: `${q}  ·  Enter copies`, score: 100, action: 'clipboard.copy', args: {text: conv.text}, iconName: ICON.Conversion, toast: true});

        const zone = zoneQuery(q, Date.now());
        if (zone) add('Conversion', {title: zone.title, subtitle: zone.subtitle, score: 100, action: 'clipboard.copy', args: {text: zone.copy}, iconName: ICON.Conversion, toast: true});

        const money = moneyQuery(q);
        const rate = money && this._rates.get(money.from)?.rates?.[money.to];
        if (money && rate) {
            const text = moneyText(money, rate);
            add('Conversion', {title: text, subtitle: `${q}  ·  1 ${money.from} = ${rate} ${money.to}  ·  Enter copies`, score: 100, action: 'clipboard.copy', args: {text}, iconName: ICON.Conversion, toast: true});
        }

        const nq = norm(q);
        // applications
        let apps = 0;
        for (const group of Gio.DesktopAppInfo.search(q)) for (const id of group) {
            if (apps >= LIMITS.Applications) break;
            const app = Shell.AppSystem.get_default().lookup_app(id);
            if (!app || !app.get_app_info()?.should_show() || out.some(o => o.args?.id === id)) continue;
            add('Applications', {title: app.get_name(), subtitle: (app.get_description() ?? '').split('\n')[0], icon: app.get_icon(), action: 'app.launch', args: {id}, score: Math.max(45 - apps * 3, bestScore(q, [app.get_name()]))});
            apps++;
        }
        // windows
        (this._windows ?? []).filter(w => norm(`${w.title} ${w.app}`).includes(nq)).slice(0, LIMITS.Windows)
            .forEach(w => add('Windows', {title: w.title || w.app, subtitle: `${w.app}  ·  Switch to this window`, icon: w.icon, iconName: ICON.Windows, action: 'window.activate', args: {id: w.id}, score: Math.max(30, bestScore(q, [w.title, w.app]))}));
        // settings
        searchItems(INDEX, q).filter(i => !i.managed).slice(0, LIMITS.Settings)
            .forEach(i => add('Settings', {title: i.title, subtitle: `${i.menu} › ${i.group}${i.help ? '  ·  ' + i.help : ''}`, iconName: ICON.Settings,
                action: 'settings.open', args: {page: PAGE_OF[i.menu], query: i.title}, score: Math.max(20, bestScore(q, [i.title]))}));
        // profiles
        const all = profiles();
        const wantsProfiles = /^(profiles?|mode|preset)s?\b/.test(nq);
        const rest = nq.replace(/^(profiles?|mode|preset)s?\s*/, '');
        all.filter(p => wantsProfiles ? (!rest || norm(p.name).includes(rest)) : norm(p.name).includes(nq)).slice(0, LIMITS.Profiles)
            .forEach(p => add('Profiles', {title: p.name, subtitle: `${p.active ? 'Active profile  ·  ' : 'Apply profile  ·  '}${p.description}`, iconName: ICON.Profiles, action: 'profile.apply', args: {id: p.id}, toast: true, score: Math.max(wantsProfiles ? 70 : 0, bestScore(q, [p.name]))}));
        // actions (the ones that need nothing more from the person)
        this._registry.find(q, {}, 8).filter(a => !(a.params ?? []).some(p => p.required) && !a.id.startsWith('settings.')).slice(0, LIMITS.Actions)
            .forEach(a => add('Actions', {title: a.title, subtitle: a.permission === 'none' ? a.description : `${a.description}  ·  asks first`, iconName: ICON.Actions, action: a.id, args: {}, toast: true, keywords: a.keywords}));
        // clipboard: only when asked for, so that what was copied never turns up in an ordinary search
        const m = /^(?:clip(?:board)?|copied|paste)\b\s*(.*)$/i.exec(q);
        if (m) {
            const needle = norm(m[1]);
            clipboardHistory().filter(c => !needle || norm(c.text).includes(needle)).slice(0, LIMITS.Clipboard)
                .forEach(c => add('Clipboard', {title: c.text.replace(/\s+/g, ' ').slice(0, 90), subtitle: `Copied ${GLib.DateTime.new_from_unix_local(Math.floor(c.at / 1000)).format('%d %b, %H:%M')}  ·  Enter copies it again`,
                    iconName: ICON.Clipboard, action: 'clipboard.copy', args: {text: c.text.slice(0, 10000)}, toast: true, score: 80}));
        }
        // files: only when asked for ("f invoice"), names only, searched on this computer
        const fn = fileNeedle(q);
        if (fn) for (const f of this._files.get(fn.toLowerCase()) ?? [])
            add('Files', {title: f.name, subtitle: `${f.folder}  ·  Enter opens it`, iconName: ICON.Files, action: 'file.open', args: {path: f.path}, toast: true, score: 85});
        return arrange(out);
    }

    /** What the tools need from the system: the clock, a UUID, random bytes from the kernel, hashes and base64. */
    _toolEnv() {
        const sum = {md5: GLib.ChecksumType.MD5, sha1: GLib.ChecksumType.SHA1, sha256: GLib.ChecksumType.SHA256};
        return {
            now: Date.now(),
            uuid: () => GLib.uuid_string_random(),
            randomBytes: n => {
                const stream = Gio.File.new_for_path('/dev/urandom').read(null);
                try { return stream.read_bytes(n, null).toArray(); } finally { stream.close(null); }
            },
            hash: (kind, text) => GLib.compute_checksum_for_string(sum[kind], text, -1),
            base64: (text, decode) => decode ? new TextDecoder('utf-8', {fatal: true}).decode(GLib.base64_decode(text.trim()))
                : GLib.base64_encode(new TextEncoder().encode(text)),
        };
    }

    /** `find` in the home folder, at most four seconds, and the list is drawn again when it answers. */
    _findFiles(query) {
        const needle = fileNeedle(query);
        if (!needle || this._files.has(needle.toLowerCase()) || this._fileBusy === needle) return;
        this._fileBusy = needle;
        const home = GLib.get_home_dir();
        let proc;
        try {
            proc = Gio.Subprocess.new(['find', ...findArgs(home, needle)], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) { this._fileBusy = null; this._say(`Could not search files: ${e.message}`); return; }
        const stop = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => { proc.force_exit(); return GLib.SOURCE_REMOVE; });
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.source_remove(stop);
            this._fileBusy = null;
            let out = '';
            try { [, out] = p.communicate_utf8_finish(res); } catch (e) { out = ''; }
            if (!this._files) return;
            this._files.set(needle.toLowerCase(), rankFiles((out ?? '').split('\n'), needle, home));
            if (this._box?.visible && fileNeedle(this._entry.get_text())?.toLowerCase() === needle.toLowerCase()) this._refresh();
        });
    }

    _suggestions() {
        const out = [];
        for (const r of this._recent()) out.push({section: 'Recent', title: r.title, subtitle: r.subtitle, iconName: r.icon, action: r.action, args: r.args, recent: false});
        const seen = new Set(out.map(o => o.action + JSON.stringify(o.args)));
        const push = (section, r) => { if (!seen.has(r.action + JSON.stringify(r.args))) out.push({section, ...r}); };
        for (const p of profiles().slice(0, 4)) push('Suggested', {title: `Apply ${p.name}`, subtitle: p.description, iconName: ICON.Profiles, action: 'profile.apply', args: {id: p.id}, toast: true});
        push('Suggested', {title: 'Lock screen', subtitle: 'Locks the session', iconName: ICON.Actions, action: 'system.lock', args: {}});
        push('Suggested', {title: 'Toggle Do Not Disturb', subtitle: 'Hides notification banners, or shows them again', iconName: ICON.Actions, action: 'system.dnd.toggle', args: {}, toast: true});
        return out;
    }

    _refresh() {
        const query = this._entry.get_text();
        let results = [];
        let failure = null;
        try { results = this._collect(query); } catch (e) { failure = e.message; }
        this._fetchRates(query);
        this._findFiles(query);
        this._results = results;
        this._list.destroy_all_children();
        this._rows = [];
        this._status.visible = false;
        if (failure) {
            this._say(`Search failed: ${failure}`);
        } else if (!results.length) {
            this._say(query.trim() ? `Nothing matches "${query.trim()}". Try an app name, a setting, "profile", or a sum like 2 + 2.` : 'Start typing to search.');
        }
        let section = null;
        results.forEach((r, i) => {
            if (r.section !== section) {
                section = r.section;
                this._list.add_child(new St.Label({text: section, style_class: 'niro-search-section'}));
            }
            const row = new St.Button({style_class: 'niro-search-row', reactive: true, can_focus: false, x_expand: true});
            const content = new St.BoxLayout({x_expand: true});
            const icon = r.icon ? new St.Icon({gicon: r.icon, icon_size: 28, style_class: 'niro-search-icon'})
                : new St.Icon({icon_name: r.iconName ?? 'application-x-executable-symbolic', icon_size: 24, style_class: 'niro-search-icon niro-search-icon-symbolic'});
            content.add_child(icon);
            const labels = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            labels.add_child(new St.Label({text: r.title, style_class: 'niro-search-name'}));
            if (r.subtitle) labels.add_child(new St.Label({text: r.subtitle, style_class: 'niro-search-description'}));
            content.add_child(labels);
            row.set_child(content);
            row.connect('clicked', () => this._activate(r));
            this._list.add_child(row);
            this._rows.push(row);
        });
        this._select(0);
    }

    /** A currency question needs the day's rate: fetched once, kept for six hours, and the list is drawn again when it arrives. */
    _fetchRates(query) {
        const money = moneyQuery(query);
        if (!money || !this._soup) return;
        const have = this._rates.get(money.from);
        if ((have && Date.now() - have.at < RATE_TTL_MS) || this._rateBusy === money.from) return;
        this._rateBusy = money.from;
        const msg = Soup.Message.new('GET', `https://api.frankfurter.dev/v1/latest?base=${money.from}`);
        this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            this._rateBusy = null;
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) throw new Error(`rates: HTTP ${msg.get_status()}`);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._rates?.set(money.from, {at: Date.now(), rates: data.rates ?? {}});
                if (this._box?.visible && this._entry.get_text() === query) this._refresh();
            } catch (e) {
                if (this._box?.visible && this._entry.get_text() === query) this._say(`Could not get the exchange rate: ${e.message}`);
            }
        });
    }

    _say(text) {
        this._status.text = text;
        this._status.visible = true;
    }

    _select(index) {
        this._hint.text = hint(undefined);
        if (!this._rows.length) return;
        this._selected = index;
        const sel = this._results[index];
        this._hint.text = hint(sel && {title: sel.title, permission: this._registry.get(sel.action)?.permission});
        const [r, g, b] = this._accent ?? [232, 71, 43];
        this._rows.forEach((row, i) => row.set_style(i === this._selected ? `background-color: rgba(${r}, ${g}, ${b}, 0.28);` : ''));
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.().adjustment;
        const row = this._rows[this._selected];
        if (adj && row) {
            const y = row.get_allocation_box().y1, h = row.get_height();
            if (y < adj.value) adj.value = y - 30; else if (y + h > adj.value + adj.page_size) adj.value = y + h - adj.page_size + 8;
        }
    }

    _onKey(event) {
        const intent = keyIntent(event.get_key_symbol(), (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0);
        if (!intent) return Clutter.EVENT_PROPAGATE;
        switch (intent.type) {
        case 'close': this._close(); break;
        case 'next': this._select(move(this._selected, 1, this._rows.length)); break;
        case 'previous': this._select(move(this._selected, -1, this._rows.length)); break;
        case 'quick': this._activate(this._results[intent.index]); break;
        case 'activate': this._activate(this._results[this._selected]); break;
        }
        return Clutter.EVENT_STOP;
    }
}
