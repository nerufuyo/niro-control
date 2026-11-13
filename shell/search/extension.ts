// Search: a centered panel that finds the installed applications as you type (Super+Space).
// Its look follows org.niro.control (tone, opacity) live.
// @ts-nocheck: GNOME Shell's modules are untyped here
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_RESULTS = 8;
const WIDTH = 640;

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** The applications matching `query` (the most used ones when it is empty), as Shell.App. */
function find(query: string) {
    const system = Shell.AppSystem.get_default();
    const shown = (app) => app && app.get_app_info()?.should_show();
    const text = query.trim();
    if (!text)
        return Shell.AppUsage.get_default().get_most_used().filter(shown).slice(0, MAX_RESULTS);
    const apps = [];
    const seen = new Set<string>();
    for (const group of Gio.DesktopAppInfo.search(text)) {
        for (const id of group) {
            if (seen.has(id))
                continue;
            seen.add(id);
            const app = system.lookup_app(id);
            if (shown(app))
                apps.push(app);
        }
    }
    return apps.slice(0, MAX_RESULTS);
}

export default class NiroSearch extends Extension {
    enable() {
        this._look = new Gio.Settings({schema_id: 'org.niro.control'});
        this._grab = null;
        this._rows = [];
        this._selected = 0;

        this._box = new St.BoxLayout({style_class: 'niro-search', vertical: true, reactive: true, visible: false, width: WIDTH});
        this._entry = new St.Entry({style_class: 'niro-search-entry', hint_text: 'Search applications', can_focus: true, x_expand: true});
        this._list = new St.BoxLayout({style_class: 'niro-search-list', vertical: true});
        this._box.add_child(this._entry);
        this._box.add_child(this._list);
        Main.layoutManager.uiGroup.add_child(this._box);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._refresh());
        text.connect('key-press-event', (_actor, event) => this._onKey(event));

        Main.wm.addKeybinding('search-shortcut', this._look, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding('search-shortcut');
        this._close();
        this._box?.destroy();
        this._box = this._entry = this._list = null;
        this._look = null;
    }

    _toggle() {
        if (this._box.visible)
            this._close();
        else
            this._open();
    }

    _open() {
        this._grab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab) {
            return;
        }
        this._applyLook();
        const monitor = Main.layoutManager.currentMonitor;
        this._box.set_position(Math.round(monitor.x + (monitor.width - WIDTH) / 2), Math.round(monitor.y + monitor.height * 0.2));
        this._entry.set_text('');
        this._box.show();
        this._refresh();
        this._entry.grab_key_focus();
        // A click outside the panel closes it.
        this._outside = global.stage.connect('button-press-event', (_stage, event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh)
                this._close();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _close() {
        if (this._outside) {
            global.stage.disconnect(this._outside);
            this._outside = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._box?.hide();
    }

    /** The tone and opacity the control panel sets. */
    _applyLook() {
        const [tr, tg, tb] = rgb(this._look.get_string('tint'));
        const opacity = this._look.get_int('opacity') / 100;
        this._box.set_style(`background-color: rgba(${tr}, ${tg}, ${tb}, ${opacity});`);
        this._accent = rgb(this._look.get_string('accent'));
    }

    _refresh() {
        this._list.destroy_all_children();
        this._rows = [];
        const apps = find(this._entry.get_text());
        apps.forEach((app, index) => {
            const row = new St.Button({style_class: 'niro-search-row', reactive: true, can_focus: false, x_expand: true});
            const content = new St.BoxLayout({x_expand: true});
            content.add_child(new St.Icon({gicon: app.get_icon(), icon_size: 32, style_class: 'niro-search-icon'}));
            const labels = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
            labels.add_child(new St.Label({text: app.get_name(), style_class: 'niro-search-name'}));
            const description = app.get_description();
            if (description)
                labels.add_child(new St.Label({text: description.split('\n')[0], style_class: 'niro-search-description'}));
            content.add_child(labels);
            row.set_child(content);
            row.connect('clicked', () => this._launch(app));
            row.connect('notify::hover', () => row.hover && this._select(index));
            this._list.add_child(row);
            this._rows.push({row, app});
        });
        this._select(0);
    }

    _select(index: number) {
        if (!this._rows.length)
            return;
        this._selected = (index + this._rows.length) % this._rows.length;
        const [r, g, b] = this._accent ?? [232, 71, 43];
        this._rows.forEach(({row}, i) =>
            row.set_style(i === this._selected ? `background-color: rgba(${r}, ${g}, ${b}, 0.28);` : ''));
    }

    _launch(app) {
        this._close();
        app.activate();
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this._close();
        } else if (key === Clutter.KEY_Down || key === Clutter.KEY_Tab) {
            this._select(this._selected + 1);
        } else if (key === Clutter.KEY_Up || key === Clutter.KEY_ISO_Left_Tab) {
            this._select(this._selected - 1);
        } else if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const target = this._rows[this._selected];
            if (target)
                this._launch(target.app);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }
}
