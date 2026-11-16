// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// Controls page: the settings of the computer one reaches for, in the island: volume and the microphone, the screen's brightness,
// Bluetooth (power, and its paired devices to connect), Wi-Fi (power, and the networks), the sound outputs and inputs, the power
// profile, Do Not Disturb, Night Light, dark style and airplane mode. Four views under a row of small tabs: Quick (the sliders and
// the switches), Bluetooth, Wi-Fi and Sound. What the computer does not have (no backlight on a desktop, no Wi-Fi) is not shown.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {Bluetooth, Brightness, PowerProfiles, WifiNetworks, airplaneOn} from '../systemControls.js';
import {Slider, iconButton, label, pillButton, setButtonIcon} from '../widgets.js';
import {Page} from './page.js';
import {radioOn} from './power.js';

const VIEWS = [['quick', 'Quick'], ['bluetooth', 'Bluetooth'], ['wifi', 'Wi-Fi'], ['sound', 'Sound']];
const PROFILE_NAMES = {'power-saver': 'Power Saver', 'balanced': 'Balanced', 'performance': 'Performance'};

function settingsFor(schemaId) {
    const source = Gio.SettingsSchemaSource.get_default();
    return source?.lookup(schemaId, true) ? new Gio.Settings({schema_id: schemaId}) : null;
}

function run(command) {
    try {
        GLib.spawn_command_line_async(command);
    } catch (e) {
        console.error(`Island controls: ${command}: ${e.message}`);
    }
}

/** A small switch pill, lit while on. */
function switchPill(text, onClick) {
    const button = pillButton(text, 'island-pill-small island-power-switch', onClick);
    button.x_expand = true;
    button.set = on => button.set_style_class_name(`island-pill island-pill-small island-power-switch${on ? ' island-power-on' : ''}`);
    return button;
}

export const ControlsPage = GObject.registerClass(
class ControlsPage extends Page {
    _init(daemon, audio, {height}) {
        super._init(daemon, {
            style_class: 'island-page island-controls',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'controls';
        this._audio = audio;
        this._brightness = new Brightness();
        this._bluetooth = new Bluetooth();
        this._wifi = new WifiNetworks();
        this._profiles = new PowerProfiles();
        this._view = 'quick';
        this._views = new Map();
        this._tabs = new Map();

        const tabs = new St.BoxLayout({style_class: 'island-controls-tabs'});
        for (const [name, text] of VIEWS) {
            const tab = pillButton(text, 'island-pill-small island-controls-tab', () => this._show(name));
            this._tabs.set(name, tab);
            tabs.add_child(tab);
        }
        this.add_child(tabs);

        this._body = new St.Bin({x_expand: true, y_expand: true});
        this.add_child(this._body);
        this._views.set('quick', this._buildQuick());
        this._views.set('bluetooth', this._buildBluetooth());
        this._views.set('wifi', this._buildWifi());
        this._views.set('sound', this._buildSound());
        this._show('quick');

        const redraw = () => this._sync();
        const watched = [[audio, audio.connect('changed', redraw)], [this._brightness, this._brightness.connect('changed', redraw)],
            [this._bluetooth, this._bluetooth.connect('changed', redraw)], [this._wifi, this._wifi.connect('changed', redraw)],
            [this._profiles, this._profiles.connect('changed', redraw)]];
        this.connect('destroy', () => {
            // The mixer may be gone (and its signals with it) before the page: the island ends its parts in its own order.
            for (const [source, id] of watched) {
                try {
                    source.disconnect(id);
                } catch (_e) { /* already disconnected */ }
            }
            for (const service of [this._brightness, this._bluetooth, this._wifi, this._profiles])
                service.destroy();
            this._settingIds?.forEach(([settings, id]) => settings.disconnect(id));
        });
        this._sync();
    }

    onActivate() {
        this._wifi.refresh();
        this._sync();
    }

    _show(name) {
        this._view = name;
        this._body.set_child(this._views.get(name));
        for (const [view, tab] of this._tabs)
            tab.set_style_class_name(`island-pill island-pill-small island-controls-tab${view === name ? ' island-power-on' : ''}`);
        if (name === 'wifi')
            this._wifi.refresh();
        this._sync();
    }

    // ---- Quick: sliders and switches

    /** A volume-like row: a button (mutes), a slider and its percentage. */
    _sliderRow(iconName, onButton, onValue) {
        const row = new St.BoxLayout({style_class: 'island-controls-slider-row', x_expand: true});
        const button = iconButton(iconName, 'island-controls-icon', onButton, {size: 16});
        const slider = new Slider({scrollStep: 0.05});
        slider.connect('value-changed', (_slider, value) => onValue(value));
        const text = label('', 'island-volume-text');
        row.add_child(button);
        row.add_child(slider);
        row.add_child(text);
        return {row, button, slider, text};
    }

    _buildQuick() {
        const box = new St.BoxLayout({style_class: 'island-controls-quick', ...VERTICAL, x_expand: true});
        this._volume = this._sliderRow('island-speaker-2-symbolic', () => this._audio.toggleMuted(), value => (this._audio.volume = value));
        this._mic = this._sliderRow('island-mic-symbolic', () => this._audio.toggleMicMuted(), value => (this._audio.micVolume = value));
        this._screen = this._sliderRow('island-sun-symbolic', () => {}, value => (this._brightness.value = value));
        const sliders = new St.BoxLayout({style_class: 'island-controls-sliders', x_expand: true});
        const left = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-controls-column'});
        const right = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-controls-column'});
        left.add_child(this._volume.row);
        left.add_child(this._mic.row);
        right.add_child(this._screen.row);
        sliders.add_child(left);
        sliders.add_child(right);
        box.add_child(sliders);

        const pills = new St.BoxLayout({style_class: 'island-power-row island-controls-pills', x_expand: true});
        this._pills = new Map();
        const add = (key, text, onClick) => {
            const pill = switchPill(text, onClick);
            this._pills.set(key, pill);
            pills.add_child(pill);
        };
        add('wifi', 'Wi-Fi', () => this._wifi.setEnabled(!this._wifi.enabled));
        add('bluetooth', 'Bluetooth', () => this._bluetooth.setPowered(!this._bluetooth.powered));
        add('airplane', 'Airplane', () => {
            run(`rfkill ${airplaneOn(radioOn) ? 'unblock' : 'block'} all`);
            this.later('airplane', 600, () => this._sync());
        });
        const notifications = settingsFor('org.gnome.desktop.notifications');
        const night = settingsFor('org.gnome.settings-daemon.plugins.color');
        const interfaceSettings = settingsFor('org.gnome.desktop.interface');
        this._settingIds = [];
        const watch = (settings, key) => {
            if (settings)
                this._settingIds.push([settings, settings.connect(`changed::${key}`, () => this._sync())]);
        };
        if (notifications) {
            add('dnd', 'Do Not Disturb', () => notifications.set_boolean('show-banners', !notifications.get_boolean('show-banners')));
            watch(notifications, 'show-banners');
        }
        if (night) {
            add('night', 'Night Light', () => night.set_boolean('night-light-enabled', !night.get_boolean('night-light-enabled')));
            watch(night, 'night-light-enabled');
        }
        if (interfaceSettings) {
            add('dark', 'Dark style', () => interfaceSettings.set_string('color-scheme',
                interfaceSettings.get_string('color-scheme') === 'prefer-dark' ? 'default' : 'prefer-dark'));
            watch(interfaceSettings, 'color-scheme');
        }
        add('profile', 'Power mode', () => this._profiles.next());
        this._settingsFor = {notifications, night, interfaceSettings};
        box.add_child(pills);
        return box;
    }

    // ---- Bluetooth

    /** A list that scrolls, a button per row. */
    _list() {
        const scroll = new St.ScrollView({style_class: 'island-controls-list', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, x_expand: true, y_expand: true});
        const box = new St.BoxLayout({...VERTICAL, x_expand: true});
        scroll.set_child(box);
        scroll.box = box;
        return scroll;
    }

    _rows(scroll, rows, empty) {
        scroll.box.destroy_all_children();
        if (!rows.length) {
            scroll.box.add_child(label(empty, 'island-controls-empty'));
            return;
        }
        for (const {text, detail, active, onClick} of rows) {
            const button = new St.Button({style_class: `island-controls-row${active ? ' island-power-on' : ''}`, can_focus: true, x_expand: true});
            const line = new St.BoxLayout({x_expand: true});
            line.add_child(label(text, 'island-controls-row-text', {x_expand: true, x_align: Clutter.ActorAlign.START}));
            if (detail)
                line.add_child(label(detail, 'island-controls-row-detail'));
            button.set_child(line);
            button.connect('clicked', () => onClick());
            scroll.box.add_child(button);
        }
    }

    _buildBluetooth() {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-controls-view'});
        const head = new St.BoxLayout({style_class: 'island-power-row', x_expand: true});
        this._btPower = switchPill('Bluetooth', () => this._bluetooth.setPowered(!this._bluetooth.powered));
        head.add_child(this._btPower);
        const settings = pillButton('Pair a device…', 'island-pill-small', () => {
            run('gnome-control-center bluetooth');
            this.emit('request-close');
        });
        settings.x_expand = true;
        head.add_child(settings);
        box.add_child(head);
        this._btList = this._list();
        box.add_child(this._btList);
        return box;
    }

    _syncBluetooth() {
        const bluetooth = this._bluetooth;
        this._btPower.set(bluetooth.powered);
        // Nothing to switch or pair on a computer with no Bluetooth.
        this._btPower.get_parent().visible = bluetooth.available;
        const rows = bluetooth.devices.map(entry => ({
            text: entry.name,
            detail: entry.busy ? '…' : [entry.battery ? `${entry.battery}%` : '', entry.connected ? 'Connected · click to disconnect' : 'Click to connect'].filter(Boolean).join('  '),
            active: entry.connected,
            onClick: () => bluetooth.toggle(entry),
        }));
        this._rows(this._btList, bluetooth.powered ? rows : [], bluetooth.available
            ? (bluetooth.powered ? 'No paired devices: pair one in Settings' : 'Bluetooth is off')
            : 'This computer has no Bluetooth');
    }

    // ---- Wi-Fi

    _buildWifi() {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-controls-view'});
        const head = new St.BoxLayout({style_class: 'island-power-row', x_expand: true});
        this._wifiPower = switchPill('Wi-Fi', () => this._wifi.setEnabled(!this._wifi.enabled));
        head.add_child(this._wifiPower);
        const refresh = pillButton('Refresh', 'island-pill-small', () => this._wifi.refresh());
        refresh.x_expand = true;
        head.add_child(refresh);
        box.add_child(head);
        this._wifiList = this._list();
        box.add_child(this._wifiList);
        return box;
    }

    _syncWifi() {
        const wifi = this._wifi;
        this._wifiPower.set(wifi.enabled);
        this._wifiPower.get_parent().visible = wifi.available;
        const rows = wifi.networks.map(network => ({
            text: network.ssid,
            detail: `${network.active ? 'Connected  ' : ''}${network.secure ? '🔒 ' : ''}${network.signal}%`,
            active: network.active,
            onClick: () => wifi.connect(network),
        }));
        this._rows(this._wifiList, rows, wifi.available ? (wifi.enabled ? 'No networks in range' : 'Wi-Fi is off') : 'This computer has no Wi-Fi');
    }

    // ---- Sound

    _buildSound() {
        const box = new St.BoxLayout({x_expand: true, style_class: 'island-controls-view island-controls-sound'});
        const make = title => {
            const column = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-controls-column'});
            column.add_child(label(title, 'island-apps-heading'));
            const list = this._list();
            column.add_child(list);
            box.add_child(column);
            return list;
        };
        this._outputList = make('Output');
        this._inputList = make('Input');
        return box;
    }

    _syncSound() {
        const audio = this._audio;
        this._rows(this._outputList, audio.outputs.map(output => ({text: output.name, detail: output.detail, active: output.active,
            onClick: () => audio.activate(output.id)})), 'No sound output');
        this._rows(this._inputList, audio.inputs.map(input => ({text: input.name, detail: input.detail, active: input.active,
            onClick: () => audio.activateInput(input.id)})), 'No microphone');
    }

    // ---- State

    _sync() {
        if (!this._volume)
            return;
        const audio = this._audio;
        setButtonIcon(this._volume.button, audio.iconName);
        this._volume.slider.value = audio.muted ? 0 : audio.volume;
        this._volume.text.text = audio.muted ? 'Muted' : `${Math.round(audio.volume * 100)}%`;
        this._volume.row.visible = audio.hasOutput;

        setButtonIcon(this._mic.button, audio.micMuted ? 'island-mic-off-symbolic' : 'island-mic-symbolic');
        this._mic.slider.value = audio.micMuted ? 0 : audio.micVolume;
        this._mic.text.text = audio.micMuted ? 'Muted' : `${Math.round(audio.micVolume * 100)}%`;
        this._mic.row.visible = audio.hasInput;

        this._screen.row.visible = this._brightness.available;
        this._screen.slider.value = this._brightness.value;
        this._screen.text.text = `${Math.round(this._brightness.value * 100)}%`;

        const pill = (key, on, visible = true) => {
            const button = this._pills.get(key);
            if (!button)
                return;
            button.visible = visible;
            button.set(on);
        };
        pill('wifi', this._wifi.enabled, this._wifi.available);
        pill('bluetooth', this._bluetooth.powered, this._bluetooth.available);
        const airplane = airplaneOn(radioOn);
        pill('airplane', airplane === true, airplane !== null);
        pill('dnd', this._settingsFor.notifications ? !this._settingsFor.notifications.get_boolean('show-banners') : false);
        pill('night', this._settingsFor.night ? this._settingsFor.night.get_boolean('night-light-enabled') : false);
        pill('dark', this._settingsFor.interfaceSettings ? this._settingsFor.interfaceSettings.get_string('color-scheme') === 'prefer-dark' : false);
        const profile = this._pills.get('profile');
        profile.visible = this._profiles.available;
        profile.label = PROFILE_NAMES[this._profiles.active] ?? 'Power mode';
        profile.set(this._profiles.active === 'performance');

        if (this._view === 'bluetooth')
            this._syncBluetooth();
        else if (this._view === 'wifi')
            this._syncWifi();
        else if (this._view === 'sound')
            this._syncSound();
    }
});
