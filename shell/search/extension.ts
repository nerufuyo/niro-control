// @ts-nocheck: GNOME Shell's modules are untyped here
// Niro Search: a command palette (Super+Space). Applications, a calculator, unit conversion, open windows, every Niro
// setting, profiles, system actions and the island's clipboard history, all through one action registry. Its look follows
// org.niro.control; the registry is also offered over D-Bus (org.niro.Search) for shortcuts and the assistant.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {buildRegistry, clipboardHistory, confirm, profiles, windows} from './actions.js';
import {calculate} from './calc.js';
import {searchItems} from './logic.js';
import {INDEX} from './settings-index.js';
import {convert} from './units.js';

const WIDTH = 680;
const LIMITS = {Applications: 5, Windows: 4, Settings: 5, Profiles: 4, Actions: 4, Clipboard: 6};
const RECENT_MAX = 8;
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const PAGE_OF = {Look: 'look', Island: 'island', Dock: 'dock', Windows: 'windows', Search: 'search'};
const ICON = {Calculator: 'accessories-calculator-symbolic', Conversion: 'edit-find-replace-symbolic', Settings: 'preferences-system-symbolic',
    Profiles: 'user-bookmarks-symbolic', Actions: 'system-run-symbolic', Clipboard: 'edit-paste-symbolic', Windows: 'focus-windows-symbolic'};

const DBUS_XML = `<node><interface name="org.niro.Search">
  <method name="ListActions"><arg type="s" direction="out" name="json"/></method>
  <method name="RunAction"><arg type="s" direction="in" name="id"/><arg type="s" direction="in" name="args_json"/><arg type="s" direction="out" name="outcome_json"/></method>
</interface></node>`;

export default class NiroSearch extends Extension {
    enable() {
        this._look = new Gio.Settings({schema_id: 'org.niro.control'});
        this._registry = buildRegistry();
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._busy = false;

        this._box = new St.BoxLayout({style_class: 'niro-search', vertical: true, reactive: true, visible: false, width: WIDTH});
        this._entry = new St.Entry({style_class: 'niro-search-entry', hint_text: 'Search apps, settings, windows, or type a calculation…', can_focus: true, x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'niro-search-scroll', hscrollbar_policy: St.PolicyType.NEVER, overlay_scrollbars: true});
        this._list = new St.BoxLayout({style_class: 'niro-search-list', vertical: true});
        this._scroll.set_child(this._list);
        this._status = new St.Label({style_class: 'niro-search-status', visible: false});
        this._box.add_child(this._entry); this._box.add_child(this._status); this._box.add_child(this._scroll);
        Main.layoutManager.uiGroup.add_child(this._box);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._refresh());
        text.connect('key-press-event', (_a, event) => this._onKey(event));

        Main.wm.addKeybinding('search-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
        this._export();
    }

    disable() {
        Main.wm.removeKeybinding('search-shortcut');
        this._unexport();
        this._close();
        this._box?.destroy();
        this._box = this._entry = this._list = this._scroll = this._status = null;
        this._registry = this._look = null;
    }

    // ---- D-Bus: the registry for shortcuts and the assistant. Anything that is not harmless is asked about on screen.
    _export() {
        const impl = {
            ListActions: () => JSON.stringify(this._registry.manifest()),
            RunActionAsync: (params, invocation) => {
                const [id, argsJson] = params;
                let args = {};
                try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (_e) {
                    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ok: false, code: 'invalid', error: 'arguments are not JSON'})]));
                    return;
                }
                if (typeof args !== 'object' || Array.isArray(args) || args === null)
                    args = {__bad: true};
                this._run(id, args, 'external').then(outcome =>
                    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(outcome)])));
            },
        };
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, impl);
        this._dbus.export(Gio.DBus.session, '/org/niro/Search');
        this._owner = Gio.DBus.own_name(Gio.BusType.SESSION, 'org.niro.Search', Gio.BusNameOwnerFlags.NONE, null, null, null);
    }

    _unexport() {
        if (this._owner) Gio.DBus.unown_name(this._owner);
        this._dbus?.unexport();
        this._owner = 0; this._dbus = null;
    }

    // ---- Running
    async _run(id, args, source) {
        const outcome = await this._registry.run(id, args, {}, source, (action) =>
            confirm(action.title, action.confirm, action.title));
        if (!outcome.ok && outcome.code !== 'declined') Main.notify('Niro Search', outcome.error);
        else if (outcome.ok && source === 'external') Main.notify('Niro Search', outcome.message);
        return outcome;
    }

    async _activate(result) {
        if (!result || this._busy) return;
        this._busy = true;
        this._close();
        const outcome = await this._run(result.action, result.args, 'ui');
        this._busy = false;
        if (outcome.ok) {
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
        if (['Calculator', 'Conversion', 'Clipboard', 'Windows'].includes(result.section)) return;       // not kept: they are about the moment
        const entry = {section: result.section, title: result.title, subtitle: result.subtitle, action: result.action, args: result.args, icon: result.iconName};
        const list = [entry, ...this._recent().filter(r => !(r.action === entry.action && JSON.stringify(r.args) === JSON.stringify(entry.args)))].slice(0, RECENT_MAX);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._recentPath), 0o700);
            GLib.file_set_contents(this._recentPath, JSON.stringify(list));
        } catch (_e) { /* not kept */ }
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
        const add = (section, r) => out.push({section, ...r});
        if (!q) return this._suggestions();
        const calc = calculate(q);
        if (calc) add('Calculator', {title: calc.text, subtitle: `${q} =  ·  Enter copies`, action: 'clipboard.copy', args: {text: calc.text.replace(/,/g, '')}, iconName: ICON.Calculator, toast: true});
        const conv = convert(q);
        if (conv) add('Conversion', {title: conv.text, subtitle: `${q}  ·  Enter copies`, action: 'clipboard.copy', args: {text: conv.text}, iconName: ICON.Conversion, toast: true});

        const nq = norm(q);
        // applications
        let apps = 0;
        for (const group of Gio.DesktopAppInfo.search(q)) for (const id of group) {
            if (apps >= LIMITS.Applications) break;
            const app = Shell.AppSystem.get_default().lookup_app(id);
            if (!app || !app.get_app_info()?.should_show() || out.some(o => o.args?.id === id)) continue;
            add('Applications', {title: app.get_name(), subtitle: (app.get_description() ?? '').split('\n')[0], icon: app.get_icon(), action: 'app.launch', args: {id}});
            apps++;
        }
        // windows
        (this._windows ?? []).filter(w => norm(`${w.title} ${w.app}`).includes(nq)).slice(0, LIMITS.Windows)
            .forEach(w => add('Windows', {title: w.title || w.app, subtitle: `${w.app}  ·  Switch to this window`, icon: w.icon, iconName: ICON.Windows, action: 'window.activate', args: {id: w.id}}));
        // settings
        searchItems(INDEX, q).filter(i => !i.managed).slice(0, LIMITS.Settings)
            .forEach(i => add('Settings', {title: i.title, subtitle: `${i.menu} › ${i.group}${i.help ? '  ·  ' + i.help : ''}`, iconName: ICON.Settings,
                action: 'settings.open', args: {page: PAGE_OF[i.menu], query: i.title}}));
        // profiles
        const all = profiles();
        const wantsProfiles = /^(profiles?|mode|preset)s?\b/.test(nq);
        const rest = nq.replace(/^(profiles?|mode|preset)s?\s*/, '');
        all.filter(p => wantsProfiles ? (!rest || norm(p.name).includes(rest)) : norm(p.name).includes(nq)).slice(0, LIMITS.Profiles)
            .forEach(p => add('Profiles', {title: p.name, subtitle: `${p.active ? 'Active profile  ·  ' : 'Apply profile  ·  '}${p.description}`, iconName: ICON.Profiles, action: 'profile.apply', args: {id: p.id}, toast: true}));
        // actions (the ones that need nothing more from the person)
        this._registry.find(q, {}, 8).filter(a => !(a.params ?? []).some(p => p.required) && !a.id.startsWith('settings.')).slice(0, LIMITS.Actions)
            .forEach(a => add('Actions', {title: a.title, subtitle: a.permission === 'none' ? a.description : `${a.description}  ·  asks first`, iconName: ICON.Actions, action: a.id, args: {}, toast: true}));
        // clipboard: only when asked for, so that what was copied never turns up in an ordinary search
        const m = /^(?:clip(?:board)?|copied|paste)\b\s*(.*)$/i.exec(q);
        if (m) {
            const needle = norm(m[1]);
            clipboardHistory().filter(c => !needle || norm(c.text).includes(needle)).slice(0, LIMITS.Clipboard)
                .forEach(c => add('Clipboard', {title: c.text.replace(/\s+/g, ' ').slice(0, 90), subtitle: `Copied ${GLib.DateTime.new_from_unix_local(Math.floor(c.at / 1000)).format('%d %b, %H:%M')}  ·  Enter copies it again`,
                    iconName: ICON.Clipboard, action: 'clipboard.copy', args: {text: c.text.slice(0, 10000)}, toast: true}));
        }
        return out;
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
            const labels = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            labels.add_child(new St.Label({text: r.title, style_class: 'niro-search-name'}));
            if (r.subtitle) labels.add_child(new St.Label({text: r.subtitle, style_class: 'niro-search-description'}));
            content.add_child(labels);
            row.set_child(content);
            row.connect('clicked', () => this._activate(r));
            row.connect('notify::hover', () => row.hover && this._select(i));
            this._list.add_child(row);
            this._rows.push(row);
        });
        this._select(0);
    }

    _say(text) {
        this._status.text = text;
        this._status.visible = true;
    }

    _select(index) {
        if (!this._rows.length) return;
        this._selected = (index + this._rows.length) % this._rows.length;
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
        const key = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (key === Clutter.KEY_Escape) {
            if (this._entry.get_text()) this._entry.set_text(''); else this._close();
        } else if (key === Clutter.KEY_Down || (ctrl && key === Clutter.KEY_n) || key === Clutter.KEY_Tab) {
            this._select(this._selected + 1);
        } else if (key === Clutter.KEY_Up || (ctrl && key === Clutter.KEY_p) || key === Clutter.KEY_ISO_Left_Tab) {
            this._select(this._selected - 1);
        } else if (key >= Clutter.KEY_1 && key <= Clutter.KEY_9 && ctrl) {
            const r = this._results[key - Clutter.KEY_1];
            if (r) this._activate(r);
        } else if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._activate(this._results[this._selected]);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }
}
