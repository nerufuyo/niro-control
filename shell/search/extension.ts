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

import {askPermission, buildRegistry, clipboardHistory, autostartEntries, confirm, endPresentation, endSpotlight, profiles, windows} from './actions.js';
import {validateArgs} from './registry.js';
import {CAPABILITY_TEXT, createGate} from './capabilities.js';
import {registerRuntimeActions} from './runtime.js';
import {createSystemHub, SETTING_KEYS} from './systemHub.js';
import {NotificationWatch, ScreenShareWatch, shellServices} from './systemShell.js';
import {calculate} from './calc.js';
import {searchItems} from './logic.js';
import {hint, keyIntent, move, Once} from './nav.js';
import {arrange, bestScore} from './rank.js';
import {INDEX} from './settings-index.js';
import {convert, moneyQuery, moneyText} from './units.js';
import {zoneQuery} from './zones.js';
import {fileNeedle, findArgs, rankFiles} from './files.js';
import {toolQuery} from './tools.js';
import {habitQuery, habitStats, noteText, openTodos, recentNotes, todoQuery} from './notes.js';
import {describe as weatherLines, forecastUrl, geocodeUrl, parseCities, parsePlace, weatherQuery, worldQuery} from './weather.js';
import {entities, haQuery, validBase} from './homeAssistant.js';
import {layoutQuery} from './layouts.js';
import {agendaQuery, parseEvents, upcoming} from './agenda.js';
import {Switcher} from './switcher.js';
import {obstacle, placeSearch, SAFE_GAP} from './placement.js';
import {anchoredScroll, canActivateOnReturn, createSearchMachine, isLive, keepScrollValue, planUpdate, resultKey, rowReveal, SearchMotion} from './searchMotion.js';
import {buildEngine, evaluateNow, QUIET_MS} from './adaptive.js';
import {connectFlowSources, createFlowEmitter} from './flowEvents.js';
import {savedLayouts} from './actions.js';
import {contentNeedle, defineQuery, definitions, grepArgs, historyMatches, historyNeedle, killName, matchProcesses, qrText, translateQuery, translated} from './lookups.js';

const WIDTH = 680;
const ISLAND_ACTOR = 'islandIsland';       // the Niro Island's actor name; see _findIsland
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
  <method name="ListGrants"><arg type="s" direction="out" name="json"/></method>
  <method name="Grant"><arg type="s" direction="in" name="subject"/><arg type="s" direction="in" name="capability"/><arg type="s" direction="in" name="scope"/><arg type="s" direction="out" name="outcome_json"/></method>
  <method name="Revoke"><arg type="s" direction="in" name="subject"/><arg type="s" direction="in" name="capability"/><arg type="s" direction="out" name="outcome_json"/></method>
  <method name="PermissionHistory"><arg type="u" direction="in" name="limit"/><arg type="s" direction="out" name="json"/></method>
  <method name="ClearPermissionHistory"><arg type="s" direction="out" name="outcome_json"/></method>
</interface></node>`;

export default class NiroSearch extends Extension {
    enable() {
        this._look = new Gio.Settings({schema_id: 'org.niro.control'});
        this._registry = buildRegistry();
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._once = new Once();
        this._sm = createSearchMachine();
        this._keys = [];                   // identity of each result row, so a late update keeps the selection on the same result
        this._rowByKey = new Map();
        this._animRow = [];
        this._lastQuery = null;
        this._frames = null;
        this._motion = new SearchMotion({
            onWake: () => this._wakeFrames(),
            onFrame: () => this._drawMotion(),
            onOpened: () => this._sm?.send('settled', {count: this._results.length}),
            onClosed: () => { this._sm?.send('settled'); this._box?.hide(); },
            off: () => !St.Settings.get().enable_animations,
        });
        this._rates = new Map();
        this._files = new Map();
        this._vars = {};
        this._net = new Map();       // answers from the web for this moment's query (translations, definitions): not kept once the palette closes
        this._procs = new Map();
        this._adaptive = null;             // the suggestion Search shows now (profile, reason, rule)
        this._pending = null;              // adaptive-live: a suggestion found while Search was closed
        this._lastSuggestion = null;       // the one dismiss answers
        this._liveIds = null;
        this._liveTimer = 0;
        this._flow = null;                 // flow-events (opt-in): the emitter and its listeners
        this._gate = createGate({
            read: () => this._readConfig('permissions.json'),
            write: text => this._writeConfig('permissions.json', text),
            ask: (subject, cap) => askPermission(subject, CAPABILITY_TEXT[cap] ?? cap),
        });
        this._ad = buildEngine(this._readConfig('adaptive-rules.json'));
        registerRuntimeActions(this._registry, {
            runStep: (id, args, ctx) => this._dispatch(id, args, ctx?.source ?? 'ui', ctx?.caller ?? 'search', 'plan'),
            readMacros: () => this._readConfig('macros.json'),
            writeMacros: text => this._writeConfig('macros.json', text),
            sleep: ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; })),
            adaptive: {dismiss: () => this._adaptiveDismiss(), history: () => this._adaptiveHistory(), lock: on => this._adaptiveLock(on)},
        });
        // System Experience: opt-in clipboard clean-up, notification rules, performance history, audio, HUD, privacy, shelf collections
        const watchers = {notifications: new NotificationWatch(n => this._hub?.onNotification(n)), screen: new ScreenShareWatch()};
        this._watchers = watchers;
        const services = shellServices(this, watchers);
        services.version = String(this.metadata?.version ?? 'unknown');
        services.shellVersion = PACKAGE_VERSION;
        this._hub = createSystemHub(services);
        this._hub.register(this._registry);
        this._hubIds = SETTING_KEYS.map(k => this._look.connect(`changed::${k}`, () => this._hub?.sync()));
        this._hub.sync();
        this._contents = new Map();
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

        this._box.set_pivot_point(0.5, 0);
        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._refresh());
        text.connect('key-press-event', (_a, event) => this._onKey(event));
        // GNOME 51: ClutterText takes Return and KP_Enter for its own 'activate' signal and emits no key-press-event for them (measured in an isolated
        // 51.1 session: Down and Tab reach _onKey, Return does not), so Enter never started a result. The signal is the Return path now; where
        // key-press-event still carries Return it STOPs the event, the entry emits no 'activate', and `_activate` runs once either way.
        text.connect('activate', () => { if (canActivateOnReturn(this._sm?.state)) this._activate(this._results[this._selected]); });

        Main.wm.addKeybinding('search-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
        this._switcher = new Switcher();
        Main.wm.addKeybinding('switcher-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._switcher.isOpen ? this._switcher.close() : this._switcher.open());
        Main.wm.addKeybinding('snip-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._snip());
        this._lookIds = ['changed::adaptive-suggestions', 'changed::adaptive-live'].map(k => this._look.connect(k, () => this._syncLive()));
        this._lookIds.push(this._look.connect('changed::flow-events', () => this._syncFlow()));
        this._syncLive();
        this._syncFlow();
        this._export();
    }

    disable() {
        Main.wm.removeKeybinding('search-shortcut');
        Main.wm.removeKeybinding('snip-shortcut');
        Main.wm.removeKeybinding('switcher-shortcut');
        this._switcher?.destroy();
        this._switcher = null;
        this._unexport();
        this._stopLive();
        this._stopFlow();
        for (const id of this._lookIds ?? []) this._look?.disconnect(id);
        this._lookIds = null;
        for (const id of this._hubIds ?? []) this._look?.disconnect(id);
        this._hubIds = null;
        this._hub?.stop();
        this._watchers?.notifications.stop();
        this._watchers?.screen.stop();
        this._hub = this._watchers = null;
        endPresentation();
        endSpotlight();
        this._soup?.abort();
        this._soup = null;
        this._release();
        this._motion?.cancel();
        this._stopFrames();
        this._motion = this._sm = null;
        this._box?.destroy();
        this._box = this._entry = this._list = this._scroll = this._status = this._hint = null;
        this._registry = this._look = this._gate = this._ad = null;
        this._pending = this._adaptive = this._lastSuggestion = null;
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
            ListGrants: () => JSON.stringify({enforced: this._pref('permissions-enforced', false), grants: this._gate.list()}),
            GrantAsync: (params, invocation) => {
                const [subject, capability, scope] = params;
                const reply = outcome => invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(outcome)]));
                this._grant(subject, capability, scope).then(reply);
            },
            Revoke: (subject, capability) => {
                try { this._gate.revoke(subject, capability || null); this._audit({at: new Date().toISOString(), source: 'external', id: 'permission.revoke', subject, capability: capability || null, ok: true}); return JSON.stringify({ok: true}); }
                catch (e) { return JSON.stringify({ok: false, error: e.message}); }
            },
            PermissionHistory: limit => JSON.stringify(this._gate.history(Math.min(Math.max(limit, 1), 200))),
            ClearPermissionHistory: () => { this._gate.clearHistory(); return JSON.stringify({ok: true}); },
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
        const outcome = await this._dispatch(id, args, source, caller);
        if (source === 'external') this._inflight.set(key, GLib.get_monotonic_time());
        if (!outcome.ok && outcome.code !== 'declined') Main.notify('Niro Search', outcome.error);
        else if (outcome.ok && source === 'external') Main.notify('Niro Search', outcome.message);
        return outcome;
    }

    /** One action through the whole gate: the permission service (outside callers, when it is on), the registry's own checks and confirmation, the audit. */
    async _dispatch(id, args, source, caller, via = null) {
        if (!this._registry) return {ok: false, code: 'unavailable', error: 'Search is off'};
        const started = GLib.get_monotonic_time();
        let outcome = await this._permit(id, args, source, caller);
        outcome ??= await this._registry.run(id, args, {source, caller}, source, (action, a) => confirm(action.title, action.ask ? action.ask(a) : action.confirm, action.title));
        // A profile chosen by hand silences the suggestions for an hour; one accepted from the suggestion does not
        if (outcome.ok && id === 'profile.apply' && !this._viaAdaptive && typeof args.id === 'string') this._ad?.engine.setOverride(args.id);
        this._audit({at: new Date().toISOString(), source, caller, id, args: this._shorten(args), ok: outcome.ok, code: outcome.code ?? null, ...(via ? {via} : {}),
            ms: Math.round((GLib.get_monotonic_time() - started) / 1000)});
        return outcome;
    }

    /** null: go on. Otherwise the refusal. Only outside callers are checked, and only when "Ask before other programs use Search actions" is on. */
    async _permit(id, args, source, caller) {
        if (source !== 'external' || !this._pref('permissions-enforced', false)) return null;
        const action = this._registry.get(id);
        if (!action || validateArgs(action.params, args)) return null;           // the registry says what is wrong with it
        const verdict = await this._gate.check(caller, id);
        return verdict.allowed ? null : {ok: false, code: 'denied', error: verdict.reason};
    }

    /** D-Bus Grant: only a program-side `deny` is taken as it comes; letting a program do more needs you to say yes on screen. */
    async _grant(subject, capability, scope) {
        try {
            this._gate.validate(subject, capability, scope);
            if (scope !== 'deny') {
                const yes = await confirm('Let a program do more?', `Allow "${subject}" to ${CAPABILITY_TEXT[capability] ?? capability} (${scope})? No answer in a minute counts as no.`, 'Allow', 60);
                if (!yes) return {ok: false, code: 'declined', error: 'cancelled'};
            }
            this._gate.grant(subject, capability, scope);
            this._audit({at: new Date().toISOString(), source: 'external', id: 'permission.grant', subject, capability, scope, ok: true});
            return {ok: true};
        } catch (e) { return {ok: false, code: 'invalid', error: e.message}; }
    }

    _configPath(name) { return `${GLib.get_user_config_dir()}/niro-control/${name}`; }

    _readConfig(name) {
        try { return new TextDecoder().decode(GLib.file_get_contents(this._configPath(name))[1]); } catch (_e) { return null; }
    }

    _writeConfig(name, text) {
        const path = this._configPath(name);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
    }

    _shorten(args) {
        const out = {};
        // The audit says what was asked, not what was typed: text, secrets and clipboard content are recorded by length only.
        const private_ = /text|content|clip|secret|token|pass|key|value|body|message|input/i;
        for (const [k, v] of Object.entries(args))
            out[k] = typeof v === 'string' && private_.test(k) ? `(hidden, ${v.length} chars)` : typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
        return out;
    }

    async _activate(result) {
        if (!result || !this._once.begin()) return;
        this._sm.send('execute');          // the selected row stays lit while the panel fades; the action starts now, never after the fade
        this._close();
        let outcome;
        this._viaAdaptive = Boolean(result.adaptiveRule);
        try { outcome = await this._run(result.action, result.args, 'ui'); } finally { this._once.end(); this._viaAdaptive = false; }
        if (outcome.ok && result.adaptiveRule) { try { this._ad?.engine.recordOutcome(result.adaptiveRule, 'accepted'); this._lastSuggestion = null; } catch (_e) { /* history only */ } }
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
        if (['Calculator', 'Conversion', 'Clipboard', 'Windows', 'Tools', 'Files', 'Processes', 'History'].includes(result.section)) return;       // not kept: they are about the moment
        const entry = {section: result.section, title: result.title, subtitle: result.subtitle, action: result.action, args: result.args, icon: result.iconName};
        const list = [entry, ...this._recent().filter(r => !(r.action === entry.action && JSON.stringify(r.args) === JSON.stringify(entry.args)))].slice(0, RECENT_MAX);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._recentPath), 0o700);
            GLib.file_set_contents(this._recentPath, JSON.stringify(list));
        } catch (_e) { /* not kept */ }
    }

    /** Niro Snip: the desktop's own picker, then an editor for the shot. */
    _snip() {
        if (this._live()) this._close();
        this._run('system.snip', {}, 'ui');
    }

    // ---- Showing
    /** True from the first frame of opening until the user dismisses it; not while the panel is only fading out. */
    _live() { return Boolean(this._sm) && (isLive(this._sm.state) || this._sm.state === 'Executing'); }

    _toggle() { this._live() ? this._close() : this._open(); }

    _open() {
        if (this._live()) return;
        this._adaptive = this._adaptiveSuggestion();       // before the palette takes the focus: it is about the window that had it
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab) return;
        this._applyLook();
        const monitor = Main.layoutManager.currentMonitor;
        this._monitor = monitor;
        this._defaultY = Math.round(monitor.y + monitor.height * 0.16);
        this._box.set_position(Math.round(monitor.x + (monitor.width - WIDTH) / 2), this._defaultY);
        this._scrollMax = Math.round(monitor.height * 0.5);
        this._scroll.style = `max-height: ${this._scrollMax}px;`;
        this._windows = windows();
        this._sm.send('open');
        this._entry.set_text('');
        this._lastQuery = null;
        this._motion.dropHighlights();
        const wasHidden = !this._box.visible;
        this._box.show();
        this._refresh();
        this._watchIsland();
        this._placeNow(wasHidden);                         // clear of the island from the first frame; a panel still fading out moves smoothly instead
        this._entry.grab_key_focus();                      // keys work from the first frame: the animation never gates typing
        this._motion.open();
        this._drawMotion();
        this._outside = global.stage.connect('button-press-event', (_s, event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh) this._close();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /** Hands the keyboard back and forgets the moment's data at once; what is left of the panel is only a fade. */
    _release() {
        this._unwatchIsland();
        this._fit = null;
        if (this._outside) { global.stage.disconnect(this._outside); this._outside = 0; }
        if (this._grab) { Main.popModal(this._grab); this._grab = null; }
        this._files?.clear();
        this._net?.clear(); this._procs?.clear(); this._contents?.clear();
        this._adaptive = null;                                   // file names are not kept once the palette is closed
    }

    _close() {
        this._release();
        if (!this._sm || this._sm.state === 'Closed') return;
        this._sm.send('close');
        this._motion.close();                                    // fades out; onClosed hides the actor
    }

    // ---- Keeping clear of the Niro Island
    // The island is another extension. Search does not import it or ask it anything: it finds the island's actor in the shell's chrome by its
    // NAME, 'islandIsland' (set in shell/island/src/island.ts and not to be renamed), and reads what GNOME itself reports about that actor
    // (its stage rectangle, visibility), the same way any shell code can see any actor. FALLBACK: if no actor has that name (island not
    // enabled, renamed, or destroyed) or it is hidden/unmapped/on another monitor, nothing is an obstacle and Search sits at its normal anchor.
    // The actor is looked up once per open and the signals are connected only while Search is open (no polling, no per-frame queries).
    _findIsland() {
        const walk = (actor, depth) => {
            if (actor.get_name?.() === ISLAND_ACTOR) return actor;
            if (depth > 3) return null;
            for (const child of actor.get_children?.() ?? []) { const hit = walk(child, depth + 1); if (hit) return hit; }
            return null;
        };
        return walk(Main.layoutManager.uiGroup, 0);
    }

    _watchIsland() {
        this._unwatchIsland();
        const island = this._findIsland();
        if (!island) {
            // Not there yet (enabled while Search is open): look again when the shell's chrome gains a child; until then no obstacle.
            this._groupId = Main.layoutManager.uiGroup.connect('child-added', (_g, actor) => {
                if (actor.get_name?.() !== ISLAND_ACTOR) return;
                this._watchIsland();
                this._queuePlace();
            });
            return;
        }
        this._island = island;
        this._islandIds = ['x', 'y', 'width', 'height', 'visible', 'mapped', 'opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y']
            .map(prop => island.connect(`notify::${prop}`, () => { this._follow(); this._queuePlace(); }));
        this._islandIds.push(island.connect('destroy', () => { this._island = null; this._islandIds = null; this._queuePlace(); }));
    }

    _unwatchIsland() {
        if (this._groupId) { try { Main.layoutManager.uiGroup.disconnect(this._groupId); } catch (_e) { /* gone */ } this._groupId = 0; }
        if (this._island && this._islandIds) for (const id of this._islandIds) { try { this._island.disconnect(id); } catch (_e) { /* destroyed */ } }
        this._island = null; this._islandIds = null;
        if (this._placeLater) { global.compositor.get_laters().remove(this._placeLater); this._placeLater = 0; }
    }

    /**
     * The island moves in its own frame step, which can land after this frame's `BEFORE_REDRAW` evaluation: acting only there leaves Search one frame
     * behind a growing island (measured: up to 7 px of overlap on 4 of 75 frames). So a notification also does the cheap part at once: if the island's
     * edge now reaches the panel, push it down (cached measurements, one rectangle read, no layout queries). The full evaluation stays one per frame.
     */
    _follow() {
        if (!this._box || !this._motion || !this._fit || !this._live()) return;
        const rect = this._islandRect();
        if (!rect) return;
        const plan = placeSearch({...this._fit, island: rect, panelX: this._box.x, defaultY: this._defaultY, gap: SAFE_GAP});
        if (plan.offset <= this._motion.dodge.value) return;
        this._motion.place(plan.offset, false);
        this._box.translation_y = this._motion.pose().dy + this._motion.dodge.value;
    }

    /** One evaluation per frame however many island notifications arrive (a morph changes x, y, width and height every frame). */
    _queuePlace() {
        if (this._placeLater || !this._box || !this._live()) return;
        this._placeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLater = 0;
            this._placeNow(false);
            return false;
        });
    }

    /** The island's visible rectangle in stage pixels, if it is an obstacle on Search's monitor. */
    _islandRect() {
        const a = this._island;
        if (!a) return null;
        const visible = a.visible && a.mapped && a.get_paint_opacity() > 0;
        if (!visible) return null;
        const rect = a.get_transformed_extents();
        return obstacle({x: rect.get_x(), y: rect.get_y(), width: rect.get_width(), height: rect.get_height()}, visible, this._monitor);
    }

    /** Moves the panel clear of the island (or back), and keeps its results list inside the work area. `instant`: no spring. */
    _placeNow(instant) {
        if (!this._box || !this._motion || !this._monitor) return;
        const m = this._monitor;
        // Heights are outer boxes: the scroll view's own padding is inside `max-height`'s outside, so it is taken off when the cap is written.
        const pad = this._scroll.get_theme_node().get_vertical_padding();
        const total = this._box.get_preferred_height(WIDTH)[1];
        const fixed = total - this._scroll.get_preferred_height(WIDTH)[1];
        const normalCap = Math.round(m.height * 0.5);
        const wanted = Math.min(this._list.get_preferred_height(WIDTH)[1], normalCap) + pad;
        this._fit = {work: Main.layoutManager.getWorkAreaForMonitor(m.index), panelWidth: WIDTH, fixedHeight: fixed, wantedResults: wanted};
        const plan = placeSearch({...this._fit, panelX: this._box.x, defaultY: this._defaultY, island: this._islandRect(), gap: SAFE_GAP});
        const cap = plan.maxResults < wanted ? Math.max(0, plan.maxResults - pad) : normalCap;
        if (cap !== this._scrollMax) { this._scrollMax = cap; this._scroll.style = `max-height: ${cap}px;`; }
        this._motion.place(plan.offset, instant);
        this._drawMotion();
    }

    // ---- Motion: the frame loop exists only while a spring is moving
    /** One step per real frame: a Clutter timeline on the box runs in the stage's frame clock, so every step lands before a paint (a GLib timeout beats against it). */
    _wakeFrames() {
        if (this._frames || !this._box) return;
        const frames = new Clutter.Timeline({actor: this._box, duration: 3_600_000});
        frames.connect('new-frame', (_t, ms: number) => {
            this._motion?.tick(ms);
            if (!this._motion?.animator.active) this._stopFrames();        // a spring woken during the last step keeps the loop going
        });
        this._frames = frames;
        frames.start();
    }

    _stopFrames() {
        const frames = this._frames;
        this._frames = null;
        frames?.stop();
    }

    _drawMotion() {
        if (!this._box || !this._motion) return;
        const pose = this._motion.pose();
        this._box.opacity = pose.opacity;
        this._box.set_scale(pose.scale, pose.scale);
        this._box.translation_y = pose.dy + this._motion.dodge.value;
        const reveal = this._motion.reveal.value;
        this._rows.forEach((row, i) => {
            const r = this._animRow[i] ? rowReveal(reveal, i) : {opacity: 255, dy: 0};
            row.opacity = r.opacity; row.translation_y = r.dy;
        });
        for (const [key, spring] of this._motion.highlight) this._paintRow(this._rowByKey.get(key), spring.value);
    }

    _paintRow(row, alpha: number) {
        if (!row) return;
        const [r, g, b] = this._accent ?? [232, 71, 43];
        row.set_style(alpha > 0.01 ? `background-color: rgba(${r}, ${g}, ${b}, ${(0.28 * alpha).toFixed(3)});` : '');
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
        if (tool) add('Tools', {title: tool.title, subtitle: tool.subtitle, score: this._pref('tools-above-apps', true) ? 100 : 30, action: 'clipboard.copy', args: {text: tool.copy}, iconName: ICON.Tools, toast: true});
        const conv = convert(q);
        if (conv) add('Conversion', {title: conv.text, subtitle: `${q}  ·  Enter copies`, score: 100, action: 'clipboard.copy', args: {text: conv.text}, iconName: ICON.Conversion, toast: true});

        const zone = zoneQuery(q, Date.now(), undefined, this._lang());
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
        // looked up on the web, only when asked for: the words typed go to the named service, nothing else
        const tr = translateQuery(q);
        if (tr) {
            const got = this._remote(`tr:${tr.to}:${tr.text}`, tr.url, translated);
            if (got.value) add('Tools', {title: got.value, subtitle: `Translated to ${tr.to}  ·  the text was sent to MyMemory  ·  Enter copies`, score: 100, action: 'clipboard.copy', args: {text: got.value}, iconName: ICON.Tools, toast: true});
        }
        const def = defineQuery(q);
        if (def) {
            const got = this._remote(`def:${def.word}`, def.url, j => { const d = definitions(j); return d.length ? d.join('\n') : null; });
            if (got.value) got.value.split('\n').forEach((line, i) => add('Tools', {title: line.length > 140 ? `${line.slice(0, 140)}…` : line, subtitle: i ? '' : `${def.word}  ·  the word was sent to dictionaryapi.dev  ·  Enter copies`, score: 100 - i, action: 'clipboard.copy', args: {text: line}, iconName: ICON.Tools, toast: true}));
        }
        const qr = qrText(q);
        if (qr) add('Tools', {title: 'Make a QR code', subtitle: `${qr.slice(0, 80)}  ·  Enter opens it in Niro Snip`, score: 100, action: 'qr.make', args: {text: qr}, iconName: ICON.Tools, toast: false, recent: false});
        const kill = killName(q);
        if (kill) {
            this._listProcesses(kill);
            for (const p of this._procs.get(kill) ?? []) add('Processes', {title: `Stop ${p.name}`, subtitle: `Process ${p.pid}  ·  asks first`, score: 90, action: 'process.kill', args: {pid: p.pid, name: p.name}, iconName: ICON.Actions, toast: true, recent: false});
        }
        const auto = /^(?:autostart|startup|login items?)\s*(.*)$/i.exec(q);
        if (auto) autostartEntries().filter(e => !auto[1] || norm(e.name).includes(norm(auto[1]))).slice(0, 8)
            .forEach(e => add('Actions', {title: `${e.off ? 'Turn on' : 'Turn off'}: ${e.name}`, subtitle: `${e.off ? 'Does not start' : 'Starts'} when you log in  ·  Enter switches it`, iconName: ICON.Actions, action: 'autostart.toggle', args: {id: e.id}, toast: true, recent: false, score: 90}));
        // notes, to-dos, habits: plain files in Documents/Niro
        const note = noteText(q);
        if (note) add('Tools', {title: `Save note: ${note.slice(0, 80)}`, subtitle: 'Adds a line to Documents/Niro/notes.md  ·  Enter saves', score: 100, action: 'note.add', args: {text: note}, iconName: ICON.Tools, toast: true, recent: false});
        if (/^(?:notes?|catatan)$/i.test(q)) recentNotes(this._niroFile('notes.md')).forEach(n => add('Tools', {title: n, subtitle: 'A saved note  ·  Enter copies it', score: 90, action: 'clipboard.copy', args: {text: n}, iconName: ICON.Tools, toast: true, recent: false}));
        const todo = todoQuery(q);
        if (todo && 'add' in todo) add('Tools', {title: `Add to-do: ${todo.add.slice(0, 80)}`, subtitle: 'Adds an open item to Documents/Niro/todo.md  ·  Enter adds it', score: 100, action: 'todo.add', args: {text: todo.add}, iconName: ICON.Tools, toast: true, recent: false});
        if (todo && 'list' in todo) openTodos(this._niroFile('todo.md')).forEach(t => add('Tools', {title: t, subtitle: 'Open to-do  ·  Enter ticks it off', score: 90, action: 'todo.done', args: {text: t}, iconName: ICON.Tools, toast: true, recent: false}));
        const habit = habitQuery(q);
        if (habit && 'log' in habit) add('Tools', {title: `Done today: ${habit.log}`, subtitle: 'Ticks it in Documents/Niro/habits.tsv  ·  Enter logs it', score: 100, action: 'habit.log', args: {name: habit.log}, iconName: ICON.Tools, toast: true, recent: false});
        if (habit && 'list' in habit) habitStats(this._niroFile('habits.tsv'), GLib.DateTime.new_now_local().format('%Y-%m-%d')).forEach(h =>
            add('Tools', {title: `${h.doneToday ? '●' : '○'} ${h.name}`, subtitle: `${h.streak} day streak  ·  ${h.total} days in all  ·  ${h.doneToday ? 'done today' : 'Enter logs today'}`, score: 90, action: 'habit.log', args: {name: h.name}, iconName: ICON.Tools, toast: true, recent: false}));
        // clocks and weather
        if (worldQuery(q)) parseCities(this._pref('world-clock-cities', '')).forEach(c => { const z = zoneQuery(`time in ${c}`, Date.now(), undefined, this._lang()); if (z) add('Tools', {title: z.title, subtitle: 'World clock  ·  Enter copies the time', score: 90, action: 'clipboard.copy', args: {text: z.copy}, iconName: ICON.Tools, toast: true, recent: false}); });
        const city = weatherQuery(q);
        if (city) {
            const place = this._remote(`geo:${city.toLowerCase()}`, geocodeUrl(city), j => { const p = parsePlace(j); return p ? JSON.stringify(p) : null; });
            if (place.value) {
                const p = JSON.parse(place.value);
                const days = this._pref('weather-days', 3), lang = this._lang();
                const fc = this._remote(`wx:${p.lat},${p.lon}:${days}:${lang}`, forecastUrl(p, days), j => { const l = weatherLines(j, p, lang); return l.length ? l.join('\n') : null; });
                if (fc.value) fc.value.split('\n').forEach((line, i) => add('Tools', {title: line, subtitle: i ? '' : 'Only the city name was sent, to Open-Meteo  ·  Enter copies', score: 100 - i, action: 'clipboard.copy', args: {text: line}, iconName: ICON.Tools, toast: true, recent: false}));
            }
        }
        // the next events of Island's calendar
        if (agendaQuery(q)) {
            const now = GLib.DateTime.new_now_local();
            const coming = upcoming(this._agendaEvents(), now.format('%Y-%m-%d'), now.get_hour() * 60 + now.get_minute());
            if (!coming.length) this._say('Nothing coming up in Island\'s calendar.');
            coming.forEach(e => add('Tools', {title: e.title, subtitle: `${e.text}  ·  Enter copies the title`, score: 95 - e.inMinutes / 100000, action: 'clipboard.copy', args: {text: e.title}, iconName: ICON.Tools, toast: true, recent: false}));
        }
        // layouts of windows
        const lay = layoutQuery(q);
        if (lay && 'save' in lay) add('Actions', {title: `Save layout "${lay.save}"`, subtitle: 'Remembers where the open windows are  ·  Enter saves', score: 100, action: 'layout.save', args: {name: lay.save}, iconName: ICON.Actions, toast: true, recent: false});
        if (lay && 'restore' in lay) add('Actions', {title: `Restore layout "${lay.restore}"`, subtitle: 'Puts open windows back where it had them  ·  Enter restores', score: 100, action: 'layout.restore', args: {name: lay.restore}, iconName: ICON.Actions, toast: true, recent: false});
        if (lay && 'list' in lay) Object.keys(savedLayouts()).forEach(n => add('Actions', {title: `Layout: ${n}`, subtitle: 'Enter puts the open windows back', score: 90, action: 'layout.restore', args: {name: n}, iconName: ICON.Actions, toast: true, recent: false}));
        // Home Assistant, the person's own server
        const ha = haQuery(q);
        if (ha !== null) {
            const base = validBase(this._niroSettings()?.get_string('ha-url') ?? '');
            const token = this._niroFile('niro-control/ha-token', true).trim();
            if (!base || !token) this._say('Set the Home Assistant address (Niro Control › Search) and put its token in ~/.config/niro-control/ha-token');
            else {
                const got = this._remote(`ha:${base}`, `${base}/api/states`, j => (Array.isArray(j) ? JSON.stringify(j) : null), {Authorization: `Bearer ${token}`}, 20);
                if (got.value) entities(JSON.parse(got.value), ha).forEach(e => add('Actions', {title: `${e.name}: ${e.state}`, subtitle: `${e.id}  ·  Enter switches it (asks first)`, score: 90, action: 'ha.call', args: {id: e.id}, iconName: ICON.Actions, toast: true, recent: false}));
            }
        }
        const snips = /^(?:snips?|screenshots?)\s*$/i.test(q);
        if (snips) this._keptSnips().forEach(f => add('Tools', {title: f.name, subtitle: `Kept snip  ·  ${f.when}  ·  Enter opens it in Niro Snip`, iconName: ICON.Tools, action: 'snip.open', args: {path: f.path}, toast: false, recent: false, score: 90}));
        const hist = historyNeedle(q);
        if (hist) for (const cmd of this._terminalHistory(hist))
            add('History', {title: cmd, subtitle: 'From your terminal history  ·  Enter copies it', score: 85, action: 'clipboard.copy', args: {text: cmd}, iconName: ICON.Clipboard, toast: true, recent: false});
        const content = contentNeedle(q);
        if (content) {
            this._searchContents(content);
            for (const f of this._contents.get(content.toLowerCase()) ?? [])
                add('Files', {title: f.name, subtitle: `${f.folder}  ·  contains "${content}"  ·  Enter opens it`, iconName: ICON.Files, action: 'file.open', args: {path: f.path}, toast: true, score: 85});
        }
        // files: only when asked for ("f invoice"), names only, searched on this computer
        const fn = fileNeedle(q);
        if (fn) for (const f of this._files.get(fn.toLowerCase()) ?? [])
            add('Files', {title: f.name, subtitle: `${f.folder}  ·  Enter opens it`, iconName: ICON.Files, action: 'file.open', args: {path: f.path}, toast: true, score: 85});
        return arrange(out);
    }

    /** An answer from the web: the cached value, or null while it is being fetched (the list is drawn again when it arrives). */
    _remote(key, url, parse, headers = null, ttlSeconds = 0) {
        const have = this._net.get(key);
        if (have) return have;
        const entry = {value: null, busy: true};
        this._net.set(key, entry);
        if (!this._soup) return entry;
        const msg = Soup.Message.new('GET', url);
        if (headers) for (const [k, v] of Object.entries(headers)) msg.get_request_headers().append(k, v);
        const query = this._entry.get_text();
        this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            entry.busy = false;
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${msg.get_status()}`);
                entry.value = parse(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                if (!entry.value) throw new Error('nothing found');
                if (this._live() && this._entry.get_text() === query) this._refresh();
            } catch (e) {
                if (this._live() && this._entry.get_text() === query) this._say(`Lookup failed: ${e.message}`);
            }
        });
        return entry;
    }

    /** The person's own processes whose name contains `needle` (one `ps`, once per name). */
    _listProcesses(needle) {
        if (this._procs.has(needle)) return;
        this._procs.set(needle, []);
        try {
            const proc = Gio.Subprocess.new(['ps', '-u', GLib.get_user_name(), '-o', 'pid=,comm='], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    this._procs?.set(needle, matchProcesses(out ?? '', needle, Number(new TextDecoder().decode(GLib.file_get_contents('/proc/self/stat')[1]).split(' ')[0]), 6, String(this._pref('kill-protected', '')).split(',')));
                    if (this._live()) this._refresh();
                } catch (_e) { /* no list */ }
            });
        } catch (_e) { /* no ps */ }
    }

    /** Island's own calendar events, read from the daemon (nothing when it is not running). */
    _agendaEvents() {
        try {
            const reply = Gio.DBus.session.call_sync('org.niro.island.Daemon', '/org/niro/island/Daemon', 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.niro.island.Calendar1', 'Events']), null, Gio.DBusCallFlags.NONE, 800, null);
            return parseEvents(reply.deepUnpack()[0].deepUnpack());
        } catch (_e) { return []; }
    }

    /** A file of Documents/Niro (or, with `config`, one under ~/.config) as text; '' when it is not there. */
    _niroFile(name, config = false) {
        const root = config ? GLib.get_user_config_dir() : `${GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir()}/Niro`;
        try { return new TextDecoder().decode(GLib.file_get_contents(`${root}/${name}`)[1]); } catch (_e) { return ''; }
    }

    /** One of Niro Control's settings, or `fallback` when the package's schema (or that key of it) is not there. */
    _pref(key, fallback) {
        try {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.niro.control', true);
            if (!schema?.has_key(key)) return fallback;
            const settings = new Gio.Settings({schema_id: 'org.niro.control'});
            const type = schema.get_key(key).get_value_type().dup_string();
            return type === 'b' ? settings.get_boolean(key) : type === 'i' ? settings.get_int(key) : settings.get_string(key);
        } catch (_e) { return fallback; }
    }

    _lang() { return this._pref('search-language', 'english') === 'indonesian' ? 'id' : 'en'; }

    _niroSettings() {
        try {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.niro.control', true);
            return schema?.has_key('ha-url') ? new Gio.Settings({schema_id: 'org.niro.control'}) : null;
        } catch (_e) { return null; }
    }

    /** The snips Niro Snip kept (only when its history is switched on), newest first. */
    _keptSnips() {
        const dir = `${GLib.get_user_data_dir()}/niro-snip/history`;
        const out = [];
        try {
            const it = Gio.File.new_for_path(dir).enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            for (let i = it.next_file(null); i; i = it.next_file(null)) {
                if (!i.get_name().endsWith('.png')) continue;
                const at = i.get_modification_date_time();
                out.push({name: i.get_name(), path: `${dir}/${i.get_name()}`, at: at.to_unix(), when: at.to_local().format('%d %b, %H:%M')});
            }
            it.close(null);
        } catch (_e) { return []; }
        return out.sort((a, b) => b.at - a.at).slice(0, 8);
    }

    /** Matching lines of bash and zsh history (the tail of each file: history can be large). */
    _terminalHistory(needle) {
        let text = '';
        for (const name of ['.bash_history', '.zsh_history']) {
            try {
                const file = Gio.File.new_for_path(`${GLib.get_home_dir()}/${name}`);
                const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
                const stream = file.read(null);
                if (size > 2e6) stream.skip(size - 2e6, null);
                text += `${new TextDecoder().decode(stream.read_bytes(2e6, null).toArray())}\n`;
                stream.close(null);
            } catch (_e) { /* not there */ }
        }
        return historyMatches(text, needle);
    }

    /** `grep` over Documents and the Desktop, at most four seconds. */
    _searchContents(needle) {
        const key = needle.toLowerCase();
        if (this._contents.has(key)) return;
        this._contents.set(key, []);
        const dirs = [GLib.UserDirectory.DIRECTORY_DOCUMENTS, GLib.UserDirectory.DIRECTORY_DESKTOP].map(d => GLib.get_user_special_dir(d)).filter(Boolean);
        if (!dirs.length) return;
        let proc;
        try { proc = Gio.Subprocess.new(['grep', ...grepArgs(needle, dirs)], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE); } catch (_e) { return; }
        const stop = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => { proc.force_exit(); return GLib.SOURCE_REMOVE; });
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.source_remove(stop);
            let out = '';
            try { [, out] = p.communicate_utf8_finish(res); } catch (_e) { out = ''; }
            if (!this._contents) return;
            this._contents.set(key, rankFiles((out ?? '').split('\n'), needle, GLib.get_home_dir()));
            if (this._live()) this._refresh();
        });
    }

    /** What the tools need from the system: the clock, a UUID, random bytes from the kernel, hashes and base64. */
    _toolEnv() {
        const sum = {md5: GLib.ChecksumType.MD5, sha1: GLib.ChecksumType.SHA1, sha256: GLib.ChecksumType.SHA256};
        return {
            now: Date.now(),
            lang: this._lang(),
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
            if (this._live() && fileNeedle(this._entry.get_text())?.toLowerCase() === needle.toLowerCase()) this._refresh();
        });
    }

    /** What the engine may look at: the window in front, the time, the monitors, the workspace and the power. Read only when asked (Search opens, or a live event). */
    _signals() {
        const win = global.display.focus_window;
        const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
        const id = `${app?.get_id() ?? ''} ${win?.get_wm_class() ?? ''}`.trim().toLowerCase();
        const now = GLib.DateTime.new_now_local();
        const power = this._power();
        return {app: id || null, minute: now.get_hour() * 60 + now.get_minute(), monitors: Main.layoutManager.monitors.length,
            workspace: global.workspace_manager.get_active_workspace_index(), battery: power.battery, onAc: power.onAc};
    }

    /** Battery level and mains from /sys/class/power_supply; nulls on a desktop. */
    _power() {
        const out = {battery: null, onAc: null};
        try {
            const base = '/sys/class/power_supply';
            const it = Gio.File.new_for_path(base).enumerate_children('standard::name', 0, null);
            for (let i = it.next_file(null); i; i = it.next_file(null)) {
                const read = f => { try { return new TextDecoder().decode(GLib.file_get_contents(`${base}/${i.get_name()}/${f}`)[1]).trim(); } catch (_e) { return null; } };
                const type = read('type');
                if (type === 'Battery' && out.battery === null) { const c = Number(read('capacity')); if (Number.isFinite(c)) out.battery = c; }
                else if (type === 'Mains') out.onAc = read('online') === '1';
            }
        } catch (_e) { /* no power supplies listed */ }
        return out;
    }

    /** One profile suggestion for the application in front, or null (off by default; each rule is then quiet for 30 minutes). With "watch while you work" the
     * suggestion found earlier may be waiting. */
    _adaptiveSuggestion() {
        if (!this._pref('adaptive-suggestions', false) || !this._ad) return null;
        try {
            const list = profiles();
            const active = list.find(p => p.active)?.id ?? null;
            const known = id => list.some(p => p.id === id);
            let found = this._pending && this._pending.profile !== active && known(this._pending.profile) ? this._pending : null;
            this._pending = null;
            found ??= evaluateNow(this._ad.engine, this._signals(), active, known);
            if (!found) return null;
            this._lastSuggestion = found;
            return {profile: list.find(p => p.id === found.profile), reason: found.reason, rule: found.ruleId};
        } catch (_e) { return null; }
    }

    _adaptiveDismiss() {
        const s = this._lastSuggestion;
        if (!s) return 'There is no suggestion to dismiss';
        this._ad.engine.recordOutcome(s.ruleId, 'dismissed');
        this._lastSuggestion = this._pending = null;
        return 'Dismissed; it stays quiet for a while';
    }

    _adaptiveHistory() {
        const h = this._ad.engine.history().slice(-20).reverse();
        const lines = h.map(e => `${new Date(e.at).toLocaleString()}  ${e.outcome}  ${e.ruleId ?? 'by hand'}  ${e.profile}`);
        const problems = this._ad.problems.length ? `\nIgnored rules: ${this._ad.problems.join(' | ')}` : '';
        return (lines.length ? lines.join('\n') : 'No suggestions yet') + problems + (this._ad.engine.isLocked() ? '\nSuggestions are locked' : '');
    }

    _adaptiveLock(on) {
        on ? this._ad.engine.lock() : this._ad.engine.unlock();
        return on ? 'Suggestions locked: none until you unlock' : 'Suggestions unlocked';
    }

    // ---- adaptive-live (opt-in): look when the focused window or the monitors change, not only when Search opens. Nothing listens while it is off.
    _syncLive() {
        const want = this._pref('adaptive-suggestions', false) && this._pref('adaptive-live', false);
        if (want && !this._liveIds) {
            this._liveIds = [
                [global.display, global.display.connect('notify::focus-window', () => this._liveEvent())],
                [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._liveEvent())],
            ];
        } else if (!want) this._stopLive();
    }

    _stopLive() {
        for (const [obj, id] of this._liveIds ?? []) obj.disconnect(id);
        this._liveIds = null;
        if (this._liveTimer) GLib.source_remove(this._liveTimer);
        this._liveTimer = 0;
        this._pending = null;
    }

    /** A burst of focus changes (Alt+Tab through windows) is one look, after the focus has rested for a moment. */
    _liveEvent() {
        if (this._liveTimer) GLib.source_remove(this._liveTimer);
        this._liveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._liveTimer = 0;
            try {
                if (this._live() || !this._ad) return GLib.SOURCE_REMOVE;
                const list = profiles();
                const active = list.find(p => p.active)?.id ?? null;
                const found = evaluateNow(this._ad.engine, this._signals(), active, id => list.some(p => p.id === id));
                if (found) this._pending = found;
            } catch (_e) { /* a look that fails is just no suggestion */ }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Niro Flow events (opt-in, `flow-events`): nothing is connected while it is off. Real Shell signals only; see flowEvents.ts for what leaves and how often.
    _syncFlow() {
        const want = this._pref('flow-events', false);
        if (want && !this._flow) {
            const emitter = createFlowEmitter({
                send: (kind, payload) => new Promise((resolve, reject) => {
                    // NO_AUTO_START: a daemon that is not running is not started for an event; the answer comes later and is only looked at for failures
                    Gio.DBus.session.call('org.niro.island.Daemon', '/org/niro/island/Daemon', 'org.niro.Flow1', 'Notify', new GLib.Variant('(ss)', [kind, payload]),
                        new GLib.VariantType('(b)'), Gio.DBusCallFlags.NO_AUTO_START, 1000, null, (conn, res) => {
                            try { resolve(conn.call_finish(res).deepUnpack()[0]); } catch (e) { reject(e); }
                        });
                }),
                after: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; }),
                cancel: handle => { try { GLib.source_remove(handle); } catch (_e) { /* already ran */ } },
                now: () => GLib.get_monotonic_time() / 1000,
            });
            const activeProfile = () => {
                try { return JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(`${GLib.get_user_config_dir()}/niro-control/state.json`).load_contents(null)[1])).active ?? null; } catch (_e) { return null; }
            };
            const sources = connectFlowSources({
                workspaceManager: global.workspace_manager, layoutManager: Main.layoutManager, appSystem: Shell.AppSystem.get_default(), tracker: Shell.WindowTracker.get_default(),
                runningState: Shell.AppState.RUNNING, stoppedState: Shell.AppState.STOPPED, readProfile: activeProfile,
                watchProfile: cb => {
                    const monitor = Gio.File.new_for_path(`${GLib.get_user_config_dir()}/niro-control/state.json`).monitor_file(Gio.FileMonitorFlags.NONE, null);
                    const id = monitor.connect('changed', () => cb(activeProfile()));
                    return () => { monitor.disconnect(id); monitor.cancel(); };
                },
            }, emitter);
            this._flow = {emitter, sources};
        } else if (!want) this._stopFlow();
    }

    _stopFlow() {
        this._flow?.sources.stop();
        this._flow?.emitter.stop();
        this._flow = null;
    }

    _suggestions() {
        const out = [];
        if (this._adaptive) out.push({section: 'Suggested', title: `Switch to ${this._adaptive.profile.name}?`, subtitle: `${this._adaptive.reason}  ·  Enter applies it  ·  not asked again for 30 minutes`,
            iconName: ICON.Profiles, action: 'profile.apply', args: {id: this._adaptive.profile.id}, toast: true, recent: false, adaptiveRule: this._adaptive.rule});
        if (this._adaptive) out.push({section: 'Suggested', title: 'Not now', subtitle: 'Dismiss this suggestion  ·  "suggestion history" shows what you answered', iconName: ICON.Profiles, action: 'adaptive.dismiss', args: {}, recent: false});
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
        // A late answer for the same text (rates, files, the web) keeps the selection on the same result and the scroll where it was.
        const queryChanged = query !== this._lastQuery;
        this._lastQuery = query;
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.().adjustment;
        const selRow = this._rows[this._selected];
        // where the selected row sits in the viewport now (its allocation is current: nothing was rebuilt yet)
        const anchor = adj && selRow ? selRow.get_allocation_box().y1 - adj.value : null;
        const before = {keys: this._keys, selected: this._selected};
        this._results = results;
        this._list.destroy_all_children();
        this._rows = [];
        this._rowByKey.clear();
        this._motion?.dropHighlights();
        this._status.visible = false;
        if (failure) {
            this._say(`Search failed: ${failure}`);
        } else if (!results.length) {
            this._say(this._rateBusy && moneyQuery(query) ? 'Looking up the exchange rate…' : query.trim() ? `Nothing matches "${query.trim()}". Try an app name, a setting, "profile", or a sum like 2 + 2.` : 'Start typing to search.');
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
        this._keys = results.map(resultKey);
        const plan = planUpdate(before, this._keys, queryChanged);
        this._animRow = plan.animate;
        this._keys.forEach((k, i) => this._rowByKey.set(k, this._rows[i]));
        this._select(plan.selected, {instant: true, scroll: queryChanged});
        if (plan.keepScroll && adj) this._keepScroll(adj, plan.selected, anchor);
        if (plan.animate.some(Boolean)) { this._motion?.revealList(); }
        this._drawMotion();
        this._queuePlace();                                // the list's height changed: it may now reach the island, or fit again
    }

    /**
     * The list was rebuilt, so adj.upper and every row position are those of the previous layout until the next frame. Allocate now (the same box,
     * synchronously) so they are current, then put the selected row back where it was in the viewport. Rows that arrived above it push the offset
     * down by their height, rows that arrived below leave it alone, and the offset can never pass the new end.
     */
    _keepScroll(adj, selected: number, anchor: number | null) {
        this._list.queue_relayout();
        this._scroll.allocate(this._scroll.get_allocation_box());
        const row = this._rows[selected];
        adj.value = row && anchor !== null ? anchoredScroll(row.get_allocation_box().y1, anchor, adj.upper, adj.page_size) : keepScrollValue(adj.value, adj.upper, adj.page_size);
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
                if (this._live() && this._entry.get_text() === query) this._refresh();
            } catch (e) {
                if (this._live() && this._entry.get_text() === query) this._say(`Could not get the exchange rate: ${e.message}`);
            }
        });
    }

    _say(text) {
        this._status.text = text;
        this._status.visible = true;
    }

    _select(index, {instant = false, scroll = true} = {}) {
        this._hint.text = hint(undefined);
        if (!this._rows.length || index < 0) { this._selected = 0; return; }
        const from = this._keys[this._selected] ?? null;
        this._selected = index;
        const sel = this._results[index];
        this._hint.text = hint(sel && {title: sel.title, permission: this._registry.get(sel.action)?.permission});
        // The old row fades out while the new one fades in (springs, no layout change); a rebuilt list lights its row at once.
        this._motion.select(instant ? null : from, this._keys[index] ?? null, instant);
        this._drawMotion();
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.().adjustment;
        const row = this._rows[this._selected];
        if (scroll && adj && row) {
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
