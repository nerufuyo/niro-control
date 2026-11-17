// @ts-nocheck: converted from JavaScript; types are added file by file
// SPDX-License-Identifier: GPL-3.0-or-later
// Power page: the battery of a laptop (its level, what it is doing, how long it lasts, its health), the power mode, and the session's
// actions: lock, sleep, log out, restart and shut down. Log out / restart / shut down go through gnome-session-quit, which asks
// GNOME's own confirmation. The switches (dark style, Night Light, the radios) are on the Controls page.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {PROFILE_NAMES, batteryFacts, batteryStatus, batteryTone} from '../powerRules.js';
import {Battery, PowerProfiles} from '../systemControls.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** The page's own height, in CSS pixels. */
export const POWER_HEIGHT = 196;

// [text, icon, command, asks for confirmation]
/** What each power mode means, for the tiles shown when the computer has no battery to share the page with. */
const MODE_NOTES = {
    'power-saver': ['island-battery-symbolic', 'Quieter, uses less power'],
    'balanced': ['island-gauge', 'The everyday default'],
    'performance': ['island-bolt', 'Full speed, more heat and noise'],
};

const ACTIONS = [
    ['Lock', 'island-lock-symbolic', 'loginctl lock-session', false],
    ['Sleep', 'island-moon', 'systemctl suspend', false],
    ['Log out', 'island-open-symbolic', 'gnome-session-quit --logout', true],
    ['Restart', 'island-reset', 'gnome-session-quit --reboot', true],
    ['Shut down', 'island-power', 'gnome-session-quit --power-off', true],
];

/** Whether a radio of this rfkill type (bluetooth, wlan) is switched on; null when the PC has none. */
export function radioOn(type) {
    let found = false;
    for (let i = 0; i < 16; i++) {
        const dir = `/sys/class/rfkill/rfkill${i}`;
        try {
            const [ok, kind] = GLib.file_get_contents(`${dir}/type`);
            if (!ok || new TextDecoder().decode(kind).trim() !== type)
                continue;
            found = true;
            const [, soft] = GLib.file_get_contents(`${dir}/soft`);
            if (new TextDecoder().decode(soft).trim() === '0')
                return true;
        } catch (_e) { /* no such rfkill */ }
    }
    return found ? false : null;
}

function allocateAt(actor, x, y, width, height) {
    actor.allocate(Clutter.ActorBox.new(x, y, x + width, y + height));
}

/** A level as a bar: a track and a fill to `value` (0..1), laid out by hand so it never takes more than the room it is given. */
const LevelBar = GObject.registerClass(
class LevelBar extends St.Widget {
    _init() {
        super._init({style_class: 'island-level', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'island-level-track'});
        this._fill = new St.Widget({style_class: 'island-level-fill'});
        this.add_child(this._track);
        this.add_child(this._fill);
        this._value = 0;
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    set value(value) {
        value = Math.min(1, Math.max(0, value || 0));
        if (value === this._value)
            return;
        this._value = value;
        this.queue_relayout();
    }

    /** 'low', 'charging' or 'normal': the fill's colour. */
    set tone(tone) {
        this._fill.set_style_class_name(`island-level-fill island-level-${tone}`);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = [box.get_width(), box.get_height()];
        allocateAt(this._track, 0, 0, width, height);
        // A sliver at least, so a nearly flat battery still shows its red.
        allocateAt(this._fill, 0, 0, this._value > 0 ? Math.max(Math.round(width * this._value), Math.min(width, px(6))) : 0, height);
    }
});

export const PowerPage = GObject.registerClass(
class PowerPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'island-page island-power',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height: Math.max(height, POWER_HEIGHT),
        });
        this.name = 'power';
        this._battery = new Battery();
        this._profiles = new PowerProfiles();
        this._modeButtons = new Map();

        const top = new St.BoxLayout({style_class: 'island-power-top', x_expand: true, y_expand: true});
        top.add_child(this._buildBattery());
        top.add_child(this._buildModes());
        this.add_child(top);
        this.add_child(this._buildActions());

        const redraw = () => this._sync();
        const ids = [[this._battery, this._battery.connect('changed', redraw)], [this._profiles, this._profiles.connect('changed', redraw)]];
        this.connect('destroy', () => {
            for (const [source, id] of ids)
                source.disconnect(id);
            this._battery.destroy();
            this._profiles.destroy();
        });
        this._sync();
    }

    get minHeight() {
        return POWER_HEIGHT;
    }

    onActivate() {
        this._battery.readHealth();
        this._sync();
    }

    // ---- Battery

    _buildBattery() {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'island-power-card island-power-battery', x_expand: true, y_expand: true});
        const head = new St.BoxLayout({style_class: 'island-power-head', x_expand: true});
        this._percent = label('', 'island-power-percent');
        const names = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._statusTitle = label('', 'island-power-title', {x_align: Clutter.ActorAlign.START});
        this._statusDetail = label('', 'island-power-detail', {x_align: Clutter.ActorAlign.START});
        names.add_child(this._statusTitle);
        names.add_child(this._statusDetail);
        this._bolt = new St.Icon({gicon: icon('island-bolt'), icon_size: 18, y_align: Clutter.ActorAlign.CENTER, visible: false});
        head.add_child(this._percent);
        head.add_child(names);
        head.add_child(this._bolt);
        this._level = new LevelBar();
        this._facts = label('', 'island-power-facts', {x_align: Clutter.ActorAlign.START});
        card.add_child(label('Battery', 'island-power-label', {x_align: Clutter.ActorAlign.START}));
        card.add_child(head);
        card.add_child(this._level);
        card.add_child(this._facts);
        this._batteryCard = card;
        return card;
    }

    // ---- Power mode

    _buildModes() {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'island-power-card island-power-modes', y_expand: true});
        card.add_child(label('Power mode', 'island-power-label', {x_align: Clutter.ActorAlign.START}));
        // Beside the battery: three buttons one above the other. Alone (no battery): one row of three.
        this._modes = new St.BoxLayout({...VERTICAL, style_class: 'island-power-segments'});
        this._modesRow = new St.BoxLayout({style_class: 'island-power-segments island-power-segments-row', x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        card.add_child(this._modes);
        card.add_child(this._modesRow);
        this._modeCard = card;
        return card;
    }

    /** One button per profile the computer offers, the one in use lit, in both layouts (see `_buildModes`). Rebuilt only when
     * the list changes. */
    _syncModes() {
        const profiles = this._profiles;
        this._modeCard.visible = profiles.available;
        const alone = !this._battery.available;
        this._modes.visible = !alone;
        this._modesRow.visible = alone;
        const key = profiles.profiles.join(',');
        if (key !== this._modeKey) {
            this._modeKey = key;
            this._modeButtons.clear();
            for (const box of [this._modes, this._modesRow]) {
                box.destroy_all_children();
                const tiles = box === this._modesRow;
                for (const name of profiles.profiles) {
                    let button;
                    if (tiles) {
                        // A tile: an icon, the name and what it means.
                        const [iconName, note] = MODE_NOTES[name] ?? ['island-gauge', ''];
                        button = new St.Button({style_class: 'island-power-tile', can_focus: true, x_expand: true, y_expand: true,
                            accessible_name: PROFILE_NAMES[name] ?? name});
                        const inside = new St.BoxLayout({...VERTICAL, x_expand: true});
                        inside.add_child(new St.Icon({gicon: icon(iconName), icon_size: 18, x_align: Clutter.ActorAlign.START}));
                        inside.add_child(new St.Widget({y_expand: true}));
                        inside.add_child(label(PROFILE_NAMES[name] ?? name, 'island-power-tile-title', {x_align: Clutter.ActorAlign.START}));
                        inside.add_child(label(note, 'island-power-tile-note', {x_align: Clutter.ActorAlign.START}));
                        button.set_child(inside);
                    } else {
                        button = new St.Button({style_class: 'island-power-segment', can_focus: true, x_expand: true, label: PROFILE_NAMES[name] ?? name});
                    }
                    button.connect('clicked', () => profiles.set(name));
                    this._modeButtons.set(`${tiles ? 'row' : 'column'}:${name}`, [name, button, tiles]);
                    box.add_child(button);
                }
            }
        }
        for (const [name, button, tile] of this._modeButtons.values()) {
            const on = name === profiles.active;
            const base = tile ? 'island-power-tile' : 'island-power-segment';
            button.set_style_class_name(`${base}${on ? ` ${base}-on` : ''}`);
            button.checked = on;
        }
    }

    // ---- Actions

    _buildActions() {
        const row = new St.BoxLayout({style_class: 'island-power-actions', x_expand: true});
        for (const [text, iconName, command, danger] of ACTIONS) {
            const button = new St.Button({style_class: `island-pill island-pill-small island-power-action${danger ? ' island-power-danger' : ''}`,
                can_focus: true, x_expand: true, accessible_name: text});
            const box = new St.BoxLayout({...VERTICAL, x_expand: true});
            box.add_child(new St.Icon({gicon: icon(iconName), icon_size: 16, x_align: Clutter.ActorAlign.CENTER}));
            box.add_child(label(text, 'island-power-action-text', {x_align: Clutter.ActorAlign.CENTER}));
            button.set_child(box);
            button.connect('clicked', () => this._run(command));
            row.add_child(button);
        }
        return row;
    }

    // ---- State

    _sync() {
        const battery = this._battery;
        this._batteryCard.visible = battery.available;
        if (battery.available) {
            const {title, detail} = batteryStatus(battery);
            this._percent.text = `${battery.percent}%`;
            this._statusTitle.text = title;
            this._statusDetail.text = detail;
            this._statusDetail.visible = Boolean(detail);
            const tone = batteryTone(battery.percent, battery.state);
            this._level.value = battery.percent / 100;
            this._level.tone = tone;
            this._percent.set_style_class_name(`island-power-percent${tone === 'low' ? ' island-power-low' : ''}`);
            this._bolt.visible = battery.state === 'charging';
            const facts = batteryFacts(battery);
            this._facts.text = facts;
            this._facts.visible = Boolean(facts);
        }
        this._syncModes();
        // With no battery the mode card has the page to itself.
        this._modeCard.x_expand = !battery.available;
    }

    _run(command) {
        try {
            GLib.spawn_command_line_async(command);
        } catch (e) {
            console.error(`Island power: ${command}: ${e.message}`);
        }
        this.emit('request-close');
    }
});
