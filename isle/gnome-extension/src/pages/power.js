// SPDX-License-Identifier: GPL-3.0-or-later
// Power page (local addition): lock, sleep, log out, restart and shut down, with the dark style and Night Light
// switches. Log out / restart / shut down go through gnome-session-quit, which asks GNOME's own confirmation.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {label, pillButton} from '../widgets.js';
import {Page} from './page.js';

// [text, command, asks for confirmation]
const ACTIONS = [
    ['Lock', 'loginctl lock-session', false],
    ['Sleep', 'systemctl suspend', false],
    ['Log out', 'gnome-session-quit --logout', true],
    ['Restart', 'gnome-session-quit --reboot', true],
    ['Shut down', 'gnome-session-quit --power-off', true],
];

// [text, schema, key, isOn(value), valueFor(on)]
const SWITCHES = [
    ['Dark style', 'org.gnome.desktop.interface', 'color-scheme', v => v === 'prefer-dark', on => (on ? 'prefer-dark' : 'default')],
    ['Night Light', 'org.gnome.settings-daemon.plugins.color', 'night-light-enabled', v => v === true, on => on],
];

/** Whether a radio of this rfkill type (bluetooth, wlan) is switched on; null when the PC has none. */
function radioOn(type) {
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

function settingsFor(schemaId) {
    const source = Gio.SettingsSchemaSource.get_default();
    return source?.lookup(schemaId, true) ? new Gio.Settings({schema_id: schemaId}) : null;
}

export const PowerPage = GObject.registerClass(
class PowerPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-power',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'power';
        this._switches = [];

        this.add_child(label('Power', 'isle-apps-heading'));
        const actions = new St.BoxLayout({style_class: 'isle-power-row', x_expand: true});
        for (const [text, command, danger] of ACTIONS) {
            const button = pillButton(text, `isle-pill-small isle-power-action${danger ? ' isle-power-danger' : ''}`,
                () => this._run(command));
            button.x_expand = true;
            actions.add_child(button);
        }
        this.add_child(actions);

        this.add_child(label('Switches', 'isle-apps-heading isle-power-heading'));
        const row = new St.BoxLayout({style_class: 'isle-power-row', x_expand: true});
        for (const [text, schemaId, key, isOn, valueFor] of SWITCHES) {
            const settings = settingsFor(schemaId);
            if (!settings)
                continue;
            const button = pillButton(text, 'isle-pill-small isle-power-switch', () => {
                const value = settings.get_value(key).deepUnpack();
                settings.set_value(key, new GLib.Variant(settings.get_value(key).get_type_string(), valueFor(!isOn(value))));
            });
            const sync = () => button.set_style_class_name(
                `isle-pill isle-pill-small isle-power-switch${isOn(settings.get_value(key).deepUnpack()) ? ' isle-power-on' : ''}`);
            const id = settings.connect(`changed::${key}`, sync);
            this.connect('destroy', () => settings.disconnect(id));
            sync();
            button.x_expand = true;
            row.add_child(button);
        }
        // Radios: only those this PC has (a desktop without Wi-Fi shows just Bluetooth).
        this._radios = [];
        for (const [text, type] of [['Wi-Fi', 'wlan'], ['Bluetooth', 'bluetooth']]) {
            if (radioOn(type) === null)
                continue;
            const button = pillButton(text, 'isle-pill-small isle-power-switch', () => {
                this._run(`rfkill ${radioOn(type) ? 'block' : 'unblock'} ${type}`, false);
                this.later(`radio-${type}`, 500, () => this._syncRadios());
            });
            button.x_expand = true;
            this._radios.push({type, button});
            row.add_child(button);
        }
        this._syncRadios();
        this.add_child(row);
    }

    onActivate() {
        this._syncRadios();
    }

    _syncRadios() {
        for (const {type, button} of this._radios) {
            button.set_style_class_name(
                `isle-pill isle-pill-small isle-power-switch${radioOn(type) ? ' isle-power-on' : ''}`);
        }
    }

    _run(command, close = true) {
        try {
            GLib.spawn_command_line_async(command);
        } catch (e) {
            console.error(`Isle power: ${command}: ${e.message}`);
        }
        if (close)
            this.emit('request-close');
    }
});
