// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// Controls page: the settings of the computer one reaches for, in the island. Four views under a row of tabs:
//   Quick      the sound, microphone and screen as thick sliders (easy to hit, always showing the level), and six switch tiles:
//              Wi-Fi and Bluetooth (each with an arrow into its list), Airplane, Do Not Disturb, Night Light and Dark style.
//   Wi-Fi      the networks, joined with a click; a new secured one asks its password right there.
//   Bluetooth  the paired devices, with their batteries, to connect and disconnect.
//   Sound      the outputs and inputs, each with its own level.
// What the computer does not have (no backlight on a desktop, no Wi-Fi) is not shown. The power mode and the battery are on the Power page.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {signalBars} from '../powerRules.js';
import {Bluetooth, Brightness, WifiNetworks, airplaneOn} from '../systemControls.js';
import {Slider, icon, iconButton, label, pillButton, setButtonIcon} from '../widgets.js';
import {Page} from './page.js';
import {radioOn} from './power.js';

/** The page's own height, in CSS pixels: more than the usual 150, which would crush its sliders and lists. */
export const CONTROLS_HEIGHT = 214;

const VIEWS = [['quick', 'Quick'], ['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['sound', 'Sound']];
/** How plain a network's signal shows: the Wi-Fi icon's opacity by bars (0..3). */
const SIGNAL_OPACITY = [90, 130, 190, 255];

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

/** A switch tile: an icon, a title and a line of detail, lit while on. A click switches it; `onMore` (Wi-Fi, Bluetooth) adds an
 * arrow in its corner, a button of its own, that opens the list. Returns the actor with `set(on, detail)` and `button`. */
function tile(iconName, title, onClick, onMore = null) {
    const root = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
    const button = new St.Button({style_class: 'island-pill island-pill-small island-ctl-tile', can_focus: true, x_expand: true,
        y_expand: true, accessible_name: title});
    const box = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
    const glyph = new St.Icon({gicon: icon(iconName), icon_size: 18, x_align: Clutter.ActorAlign.START});
    const name = label(title, 'island-ctl-tile-title', {x_align: Clutter.ActorAlign.START});
    const detail = label('', 'island-ctl-tile-detail', {x_align: Clutter.ActorAlign.START});
    detail.clutter_text.ellipsize = 3;
    box.add_child(glyph);
    box.add_child(new St.Widget({y_expand: true}));
    box.add_child(name);
    box.add_child(detail);
    button.set_child(box);
    button.connect('clicked', () => onClick());
    root.add_child(button);
    if (onMore) {
        const more = iconButton('island-chevron-right-symbolic', 'island-ctl-more', onMore, {size: 12, accessibleName: `${title} list`});
        more.set({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START});
        root.add_child(more);
    }
    root.button = button;
    root.glyph = glyph;
    root.detail = detail;
    root.set = (on, text = '') => {
        button.set_style_class_name(`island-pill island-pill-small island-ctl-tile${on ? ' island-power-on' : ''}`);
        detail.text = text;
        detail.visible = Boolean(text);
    };
    return root;
}

export const ControlsPage = GObject.registerClass(
class ControlsPage extends Page {
    _init(daemon, audio, {height}) {
        super._init(daemon, {
            style_class: 'island-page island-controls',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height: Math.max(height, CONTROLS_HEIGHT),
        });
        this.name = 'controls';
        this._audio = audio;
        this._brightness = new Brightness();
        this._bluetooth = new Bluetooth();
        this._wifi = new WifiNetworks();
        this._view = 'quick';
        this._views = new Map();
        this._tabs = new Map();
        this._promptNetwork = null;

        const tabs = new St.BoxLayout({style_class: 'island-ctl-tabs'});
        for (const [name, text] of VIEWS) {
            const tab = pillButton(text, 'island-pill-small island-ctl-tab', () => this._show(name));
            this._tabs.set(name, tab);
            tabs.add_child(tab);
        }
        this.add_child(tabs);

        this._body = new St.Bin({x_expand: true, y_expand: true});
        this.add_child(this._body);
        this._views.set('quick', this._buildQuick());
        this._views.set('wifi', this._buildWifi());
        this._views.set('bluetooth', this._buildBluetooth());
        this._views.set('sound', this._buildSound());
        this._show('quick');

        const redraw = () => this._sync();
        const watched = [[audio, audio.connect('changed', redraw)], [this._brightness, this._brightness.connect('changed', redraw)],
            [this._bluetooth, this._bluetooth.connect('changed', redraw)], [this._wifi, this._wifi.connect('changed', redraw)]];
        this.connect('destroy', () => {
            // The mixer may be gone (and its signals with it) before the page: the island ends its parts in its own order.
            for (const [source, id] of watched) {
                try {
                    source.disconnect(id);
                } catch (_e) { /* already disconnected */ }
            }
            for (const service of [this._brightness, this._bluetooth, this._wifi])
                service.destroy();
            this._settingIds?.forEach(([settings, id]) => settings.disconnect(id));
        });
        this._sync();
    }

    get minHeight() {
        return CONTROLS_HEIGHT;
    }

    onActivate() {
        this._wifi.refresh();
        this._sync();
    }

    onDeactivate() {
        this._cancelPrompt();
    }

    _show(name) {
        if (name !== this._view)
            this._cancelPrompt();
        this._view = name;
        this._body.set_child(this._views.get(name));
        for (const [view, tab] of this._tabs)
            tab.set_style_class_name(`island-pill island-pill-small island-ctl-tab${view === name ? ' island-power-on' : ''}`);
        if (name === 'wifi')
            // A scan on an adapter that is joined stalls its traffic for a moment: look afresh only when not joined (Rescan is there to ask).
            this._wifi.refresh({rescan: !this._wifi.networks.some(network => network.active)});
        this._sync();
    }

    // ---- Quick: sliders and tiles

    /** A level card: an optional line naming the device (a button into Sound), then a button (mutes), a thick slider and the
     * percentage. Returns {card, button, slider, text, name}. */
    _sliderCard(iconName, onButton, onValue, {withDevice = false} = {}) {
        const card = new St.BoxLayout({style_class: 'island-ctl-card', ...VERTICAL, x_expand: true, y_expand: true});
        let name = null;
        if (withDevice) {
            name = new St.Button({style_class: 'island-ctl-device', can_focus: true, x_align: Clutter.ActorAlign.START,
                child: label('', 'island-ctl-device-text')});
            name.connect('clicked', () => this._show('sound'));
            card.add_child(name);
        }
        const row = new St.BoxLayout({style_class: 'island-ctl-slider-row', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const button = iconButton(iconName, 'island-ctl-round', onButton, {size: 16});
        const slider = new Slider({scrollStep: 0.05, thick: true});
        slider.connect('value-changed', (_slider, value) => onValue(value));
        const text = label('', 'island-ctl-percent');
        row.add_child(button);
        row.add_child(slider);
        row.add_child(text);
        card.add_child(row);
        return {card, button, slider, text, name};
    }

    _buildQuick() {
        const box = new St.BoxLayout({style_class: 'island-ctl-quick', x_expand: true, y_expand: true});

        const sliders = new St.BoxLayout({...VERTICAL, style_class: 'island-ctl-sliders', x_expand: true});
        this._volume = this._sliderCard('island-speaker-2-symbolic', () => this._audio.toggleMuted(),
            value => (this._audio.volume = value), {withDevice: true});
        this._mic = this._sliderCard('island-mic-symbolic', () => this._audio.toggleMicMuted(),
            value => (this._audio.micVolume = value), {withDevice: true});
        this._screen = this._sliderCard('island-sun-symbolic', () => {}, value => (this._brightness.value = value));
        for (const {card} of [this._volume, this._mic, this._screen])
            sliders.add_child(card);
        box.add_child(sliders);

        this._tiles = new Map();
        // Equal tiles: a grid whose rows and columns share the room, three to a row.
        const layout = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true, column_spacing: 8, row_spacing: 8});
        const grid = new St.Widget({style_class: 'island-ctl-grid', layout_manager: layout, y_expand: true});
        const columns = [0, 0];
        const add = (index, key, iconName, text, onClick, onMore) => {
            const item = tile(iconName, text, onClick, onMore);
            this._tiles.set(key, item);
            layout.attach(item, columns[index]++, index, 1, 1);
        };
        add(0, 'wifi', 'island-wifi-symbolic', 'Wi-Fi', () => this._wifi.setEnabled(!this._wifi.enabled), () => this._show('wifi'));
        add(0, 'bluetooth', 'island-bluetooth-symbolic', 'Bluetooth', () => this._bluetooth.setPowered(!this._bluetooth.powered),
            () => this._show('bluetooth'));
        add(0, 'airplane', 'island-airplane-symbolic', 'Airplane', () => {
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
            add(1, 'dnd', 'island-bell', 'Do Not Disturb', () => notifications.set_boolean('show-banners', !notifications.get_boolean('show-banners')));
            watch(notifications, 'show-banners');
        }
        if (night) {
            add(1, 'night', 'island-sunset-symbolic', 'Night Light', () => night.set_boolean('night-light-enabled', !night.get_boolean('night-light-enabled')));
            watch(night, 'night-light-enabled');
        }
        if (interfaceSettings) {
            add(1, 'dark', 'island-moon', 'Dark style', () => interfaceSettings.set_string('color-scheme',
                interfaceSettings.get_string('color-scheme') === 'prefer-dark' ? 'default' : 'prefer-dark'));
            watch(interfaceSettings, 'color-scheme');
        }
        this._settingsFor = {notifications, night, interfaceSettings};
        box.add_child(grid);
        return box;
    }

    // ---- Lists

    /** A list that scrolls, one button per row. */
    _list() {
        const scroll = new St.ScrollView({style_class: 'island-ctl-list', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, x_expand: true, y_expand: true});
        const box = new St.BoxLayout({...VERTICAL, x_expand: true});
        scroll.set_child(box);
        scroll.box = box;
        return scroll;
    }

    /** Fills `scroll` with `rows` ({text, detail, tone, active, glyph, glyphOpacity, right, onClick}), or `empty` when there are none.
     * `right` is an actor (a button, an icon) on the row's far side. */
    _rows(scroll, rows, empty, emptyIcon = null) {
        scroll.box.destroy_all_children();
        if (!rows.length) {
            const none = new St.BoxLayout({...VERTICAL, style_class: 'island-ctl-none', x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            if (emptyIcon)
                none.add_child(new St.Icon({gicon: icon(emptyIcon), icon_size: 22, x_align: Clutter.ActorAlign.CENTER, style_class: 'island-ctl-none-icon'}));
            none.add_child(label(empty, 'island-ctl-empty', {x_align: Clutter.ActorAlign.CENTER}));
            scroll.box.add_child(none);
            return;
        }
        for (const {text, detail, tone, active, glyph, glyphOpacity, right, onClick} of rows) {
            const row = new St.BoxLayout({style_class: `island-ctl-row${active ? ' island-ctl-row-active' : ''}`, x_expand: true});
            const body = new St.Button({style_class: 'island-ctl-row-body', can_focus: Boolean(onClick), reactive: Boolean(onClick), x_expand: true});
            const line = new St.BoxLayout({x_expand: true, style_class: 'island-ctl-row-line'});
            if (glyph) {
                const image = new St.Icon({gicon: icon(glyph), icon_size: 14, y_align: Clutter.ActorAlign.CENTER, opacity: glyphOpacity ?? 255});
                line.add_child(image);
            }
            const names = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const title = label(text, 'island-ctl-row-text', {x_align: Clutter.ActorAlign.START});
            title.clutter_text.ellipsize = 3;
            names.add_child(title);
            if (detail)
                names.add_child(label(detail, `island-ctl-row-detail${tone === 'bad' ? ' island-ctl-bad' : ''}`, {x_align: Clutter.ActorAlign.START}));
            line.add_child(names);
            // The one in use is lit softly and ticked (a switch is the accent's; a choice from a list is not).
            if (active && !right)
                line.add_child(new St.Icon({gicon: icon('island-check-symbolic'), icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            body.set_child(line);
            if (onClick)
                body.connect('clicked', () => onClick());
            row.add_child(body);
            if (right)
                row.add_child(right);
            scroll.box.add_child(row);
        }
    }

    // ---- Wi-Fi

    _buildWifi() {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-ctl-view'});
        const head = new St.BoxLayout({style_class: 'island-ctl-head', x_expand: true});
        this._wifiPower = pillButton('Wi-Fi', 'island-pill-small island-ctl-switch', () => this._wifi.setEnabled(!this._wifi.enabled));
        this._wifiPower.set = on => this._wifiPower.set_style_class_name(`island-pill island-pill-small island-ctl-switch${on ? ' island-power-on' : ''}`);
        head.add_child(this._wifiPower);
        head.add_child(new St.Widget({x_expand: true}));
        const rescan = pillButton('Rescan', 'island-pill-small', () => this._wifi.refresh({rescan: true}));
        head.add_child(rescan);
        const settings = pillButton('Settings…', 'island-pill-small', () => {
            run('gnome-control-center wifi');
            this.emit('request-close');
        });
        head.add_child(settings);
        box.add_child(head);

        // The password bar: shown between the buttons and the list while a new secured network asks for its password.
        this._prompt = new St.BoxLayout({...VERTICAL, style_class: 'island-ctl-prompt', x_expand: true, visible: false});
        const field = new St.BoxLayout({style_class: 'island-ctl-prompt-row', x_expand: true});
        this._promptEntry = new St.PasswordEntry({style_class: 'island-ctl-entry', hint_text: 'Password', can_focus: true, x_expand: true});
        const text = this._promptEntry.clutter_text;
        text.connect('activate', () => this._submitPassword());
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._cancelPrompt();
            return Clutter.EVENT_STOP;
        });
        this._promptJoin = pillButton('Join', 'island-pill-small island-pill-accent', () => this._submitPassword());
        const cancel = iconButton('island-close-symbolic', 'island-ctl-round', () => this._cancelPrompt(), {size: 12, accessibleName: 'Cancel'});
        field.add_child(this._promptEntry);
        field.add_child(this._promptJoin);
        field.add_child(cancel);
        this._promptError = label('', 'island-ctl-prompt-error', {x_align: Clutter.ActorAlign.START, visible: false});
        this._prompt.add_child(field);
        this._prompt.add_child(this._promptError);
        box.add_child(this._prompt);

        this._wifiList = this._list();
        box.add_child(this._wifiList);
        return box;
    }

    /** Joins `network`: at once when it is open or saved, with a password bar when it is new and secured. */
    async _join(network) {
        if (network.active || this._wifi.connecting)
            return;
        this._cancelPrompt();
        const result = await this._wifi.join(network);
        if (result === 'needs-password')
            this._askPassword(network);
    }

    _askPassword(network) {
        this._promptNetwork = network;
        this._promptEntry.hint_text = `Password for ${network.ssid}`;
        this._promptEntry.text = '';
        this._promptError.visible = false;
        this._prompt.visible = true;
        this.emit('request-keyboard', true);
        this._promptEntry.grab_key_focus();
    }

    async _submitPassword() {
        const network = this._promptNetwork;
        const password = this._promptEntry.text;
        if (!network || !password || this._wifi.connecting)
            return;
        this._promptJoin.label = 'Joining…';
        const result = await this._wifi.join(network, password);
        this._promptJoin.label = 'Join';
        if (this._promptNetwork !== network)
            return;
        if (result === 'connected') {
            this._cancelPrompt();
            return;
        }
        // Not joined (the password was wrong, or the network did not answer): the bar stays, with why.
        this._promptError.text = this._wifi.error?.message ?? 'Could not connect';
        this._promptError.visible = true;
        this._promptEntry.clutter_text.set_selection(0, -1);
        this._promptEntry.grab_key_focus();
    }

    _cancelPrompt() {
        if (!this._prompt)
            return;
        const had = this._promptNetwork !== null;
        this._promptNetwork = null;
        this._prompt.visible = false;
        this._promptEntry.text = '';
        if (this._promptEntry.clutter_text.has_key_focus())
            global.stage.set_key_focus(null);
        if (had)
            this.emit('request-keyboard', false);
    }

    _syncWifi() {
        const wifi = this._wifi;
        this._wifiPower.set(wifi.enabled);
        this._wifiPower.get_parent().visible = wifi.available;
        const rows = wifi.networks.map(network => {
            const saved = wifi.known.has(network.ssid);
            const failed = wifi.error?.ssid === network.ssid ? wifi.error : null;
            let detail;
            if (wifi.connecting === network.ssid)
                detail = 'Connecting…';
            else if (failed)
                detail = failed.message;
            else if (network.active)
                detail = 'Connected';
            else
                detail = saved ? 'Saved' : network.secure ? 'Secured' : 'Open';
            let right = null;
            if (network.active) {
                right = pillButton('Disconnect', 'island-pill-small island-ctl-row-action', () => wifi.leave());
            } else if (failed && saved) {
                right = pillButton('Forget', 'island-pill-small island-ctl-row-action', () => wifi.forget(network.ssid));
            } else {
                const bars = signalBars(network.signal);
                right = new St.BoxLayout({style_class: 'island-ctl-row-meta', y_align: Clutter.ActorAlign.CENTER});
                if (network.secure && !saved)
                    right.add_child(new St.Icon({gicon: icon('island-lock-symbolic'), icon_size: 12, style_class: 'island-ctl-lock'}));
                right.add_child(label(`${network.signal}%`, 'island-ctl-row-detail island-ctl-signal'));
                right.opacity = SIGNAL_OPACITY[bars];
            }
            return {text: network.ssid, detail, tone: failed ? 'bad' : '', active: network.active, glyph: 'island-wifi-symbolic',
                glyphOpacity: SIGNAL_OPACITY[signalBars(network.signal)], right, onClick: () => this._join(network)};
        });
        this._rows(this._wifiList, rows, wifi.available ? (wifi.enabled ? 'No networks in range' : 'Wi-Fi is off') : 'This computer has no Wi-Fi',
            'island-wifi-off-symbolic');
    }

    // ---- Bluetooth

    _buildBluetooth() {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-ctl-view'});
        const head = new St.BoxLayout({style_class: 'island-ctl-head', x_expand: true});
        this._btPower = pillButton('Bluetooth', 'island-pill-small island-ctl-switch', () => this._bluetooth.setPowered(!this._bluetooth.powered));
        this._btPower.set = on => this._btPower.set_style_class_name(`island-pill island-pill-small island-ctl-switch${on ? ' island-power-on' : ''}`);
        head.add_child(this._btPower);
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(pillButton('Pair a device…', 'island-pill-small', () => {
            run('gnome-control-center bluetooth');
            this.emit('request-close');
        }));
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
            detail: entry.busy ? 'Working…' : entry.connected ? 'Connected · click to disconnect' : 'Paired · click to connect',
            active: entry.connected,
            glyph: 'island-bluetooth-symbolic',
            right: entry.battery ? label(`${entry.battery}%`, 'island-ctl-row-detail island-ctl-signal', {y_align: Clutter.ActorAlign.CENTER}) : null,
            onClick: () => bluetooth.toggle(entry),
        }));
        this._rows(this._btList, bluetooth.powered ? rows : [], bluetooth.available
            ? (bluetooth.powered ? 'No paired devices: pair one in Settings' : 'Bluetooth is off')
            : 'This computer has no Bluetooth', 'island-bluetooth-off-symbolic');
    }

    // ---- Sound

    _buildSound() {
        const box = new St.BoxLayout({x_expand: true, style_class: 'island-ctl-view island-ctl-sound'});
        const make = (title, key, iconName, onButton, onValue) => {
            const column = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'island-ctl-column'});
            column.add_child(label(title, 'island-ctl-heading'));
            this[`_${key}Level`] = this._sliderCard(iconName, onButton, onValue);
            column.add_child(this[`_${key}Level`].card);
            const list = this._list();
            column.add_child(list);
            box.add_child(column);
            return list;
        };
        this._outputList = make('Output', 'output', 'island-speaker-2-symbolic', () => this._audio.toggleMuted(), value => (this._audio.volume = value));
        this._inputList = make('Input', 'input', 'island-mic-symbolic', () => this._audio.toggleMicMuted(), value => (this._audio.micVolume = value));
        return box;
    }

    _syncSound() {
        const audio = this._audio;
        this._rows(this._outputList, audio.outputs.map(output => ({text: output.name, detail: output.detail, active: output.active,
            onClick: () => audio.activate(output.id)})), 'No sound output', 'island-speaker-off-symbolic');
        this._rows(this._inputList, audio.inputs.map(input => ({text: input.name, detail: input.detail, active: input.active,
            onClick: () => audio.activateInput(input.id)})), 'No microphone', 'island-mic-off-symbolic');
        this._outputLevel.card.visible = audio.hasOutput;
        this._level(this._outputLevel, audio.volume, audio.muted, audio.iconName);
        this._inputLevel.card.visible = audio.hasInput;
        this._level(this._inputLevel, audio.micVolume, audio.micMuted, audio.micMuted ? 'island-mic-off-symbolic' : 'island-mic-symbolic');
    }

    // ---- State

    /** Shows `value` (0..1) and its text on a level card, "Muted" while muted. */
    _level(card, value, muted, iconName) {
        setButtonIcon(card.button, iconName);
        card.slider.value = muted ? 0 : value;
        card.text.text = muted ? 'Muted' : `${Math.round(value * 100)}%`;
    }

    _sync() {
        if (!this._volume)
            return;
        const audio = this._audio;
        const micIcon = audio.micMuted ? 'island-mic-off-symbolic' : 'island-mic-symbolic';
        this._level(this._volume, audio.volume, audio.muted, audio.iconName);
        this._volume.card.visible = audio.hasOutput;
        this._volume.name.child.text = audio.outputs.find(output => output.active)?.name ?? 'Output';
        this._level(this._mic, audio.micVolume, audio.micMuted, micIcon);
        this._mic.card.visible = audio.hasInput;
        this._mic.name.child.text = audio.inputs.find(input => input.active)?.name ?? 'Input';
        this._screen.card.visible = this._brightness.available;
        this._level(this._screen, this._brightness.value, false, 'island-sun-symbolic');

        const wifi = this._wifi;
        const joined = wifi.networks.find(network => network.active);
        this._tile('wifi', wifi.enabled, wifi.available, wifi.enabled ? (wifi.connecting ? 'Connecting…' : joined?.ssid ?? 'Not connected') : 'Off');
        const connected = this._bluetooth.devices.filter(device => device.connected);
        this._tile('bluetooth', this._bluetooth.powered, this._bluetooth.available,
            this._bluetooth.powered ? (connected.length ? connected.map(device => device.name).join(', ') : 'No device') : 'Off');
        const airplane = airplaneOn(radioOn);
        this._tile('airplane', airplane === true, airplane !== null, airplane ? 'On' : 'Off');
        const {notifications, night, interfaceSettings} = this._settingsFor;
        const dnd = notifications ? !notifications.get_boolean('show-banners') : false;
        this._tile('dnd', dnd, true, dnd ? 'On' : 'Off');
        const nightOn = night ? night.get_boolean('night-light-enabled') : false;
        this._tile('night', nightOn, true, nightOn ? 'On' : 'Off');
        const dark = interfaceSettings ? interfaceSettings.get_string('color-scheme') === 'prefer-dark' : false;
        this._tile('dark', dark, true, dark ? 'On' : 'Off');

        if (this._view === 'wifi')
            this._syncWifi();
        else if (this._view === 'bluetooth')
            this._syncBluetooth();
        else if (this._view === 'sound')
            this._syncSound();
    }

    _tile(key, on, visible, detail) {
        const item = this._tiles.get(key);
        if (!item)
            return;
        item.visible = visible;
        item.set(on, detail);
    }
});
