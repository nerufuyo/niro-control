// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// What the Controls page sets, each behind a small object the page only reads and tells: the screen's brightness, Bluetooth, the
// Wi-Fi networks, the power profile and the airplane mode. They use what GNOME itself uses (the settings daemon, GnomeBluetooth,
// NetworkManager through nmcli, power-profiles-daemon), so the island and the Quick Settings always agree.
//
// Each has `available` (does this computer have it at all), a `changed` signal, and `destroy()`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const SETTINGS_DAEMON = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';

function dbusGet(name, path, iface, property) {
    return new Promise(resolve => {
        Gio.DBus.session.call(name, path, 'org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', [iface, property]), null,
            Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                try {
                    resolve(bus.call_finish(result).deep_unpack()[0].deep_unpack());
                } catch (_e) {
                    resolve(null);
                }
            });
    });
}

function dbusSet(name, path, iface, property, variant) {
    Gio.DBus.session.call(name, path, 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', [iface, property, variant]), null,
        Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                console.warn(`Island: could not set ${property}: ${e.message}`);
            }
        });
}

/** The screen's brightness, 0..1 (never fully dark). GNOME 48 and later have a scale of their own in the shell; older ones ask the
 * settings daemon. `available` is false on a desktop with no backlight. */
export class Brightness extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this._value = 0;
        this._scale = Main.brightnessManager?.globalScale ?? null;
        if (this._scale) {
            this.available = true;
            this._value = this._scale.value;
            this._scaleId = this._scale.connect('notify::value', () => {
                this._value = this._scale.value;
                this.emit('changed');
            });
            return;
        }
        this._ids = [];
        this._watch();
    }

    async _watch() {
        const percent = await dbusGet(SETTINGS_DAEMON, POWER_PATH, 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness');
        if (this._destroyed || percent === null || percent < 0)
            return;
        this.available = true;
        this._value = percent / 100;
        this._signalId = Gio.DBus.session.signal_subscribe(SETTINGS_DAEMON, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            POWER_PATH, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [iface, changed] = params.deep_unpack();
                if (iface === 'org.gnome.SettingsDaemon.Power.Screen' && 'Brightness' in changed) {
                    this._value = changed.Brightness.deep_unpack() / 100;
                    this.emit('changed');
                }
            });
        this.emit('changed');
    }

    get value() {
        return this._value;
    }

    set value(fraction) {
        const clamped = Math.max(0.01, Math.min(1, fraction));
        this._value = clamped;
        if (this._scale)
            this._scale.value = clamped;
        else
            dbusSet(SETTINGS_DAEMON, POWER_PATH, 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness', new GLib.Variant('i', Math.round(clamped * 100)));
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        if (this._scale && this._scaleId)
            this._scale.disconnect(this._scaleId);
        if (this._signalId)
            Gio.DBus.session.signal_unsubscribe(this._signalId);
    }
}

/** Power profiles (power-profiles-daemon): the profiles the computer offers and the one in use, cycled in order. */
export class PowerProfiles extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this.active = '';
        this.profiles = [];
        this._name = 'net.hadess.PowerProfiles';
        this._path = '/net/hadess/PowerProfiles';
        this._proxy = null;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, this._name, this._path, this._name, null, (_o, result) => {
            try {
                this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
            } catch (_e) {
                return;
            }
            if (this._destroyed || !this._proxy.get_name_owner())
                return;
            this._changedId = this._proxy.connect('g-properties-changed', () => this._read());
            this._read();
        });
    }

    _read() {
        const active = this._proxy.get_cached_property('ActiveProfile')?.deep_unpack() ?? '';
        const list = this._proxy.get_cached_property('Profiles')?.deep_unpack() ?? [];
        this.profiles = list.map(entry => entry.Profile?.deep_unpack?.() ?? entry.Profile).filter(Boolean);
        this.active = active;
        this.available = this.profiles.length > 1;
        this.emit('changed');
    }

    /** The profile after the one in use. */
    next() {
        const at = this.profiles.indexOf(this.active);
        const target = this.profiles[(at + 1) % this.profiles.length];
        this._proxy?.get_connection().call(this._name, this._path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [this._name, 'ActiveProfile', new GLib.Variant('s', target)]), null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        if (this._proxy && this._changedId)
            this._proxy.disconnect(this._changedId);
    }
}

/** Wi-Fi: the radio and the networks in range (through nmcli: no network library to carry, the same service as GNOME's). */
export class WifiNetworks extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this.enabled = false;
        this.networks = [];
        this.refresh();
    }

    _run(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    try {
                        resolve(p.get_successful() ? p.communicate_utf8_finish(result)[1] : null);
                    } catch (_e) {
                        resolve(null);
                    }
                });
            } catch (_e) {
                resolve(null);
            }
        });
    }

    /** Reads the radio and the list again. */
    async refresh() {
        const hasWifi = await this._run(['nmcli', '-t', '-f', 'TYPE', 'device']);
        if (this._destroyed)
            return;
        this.available = Boolean(hasWifi?.split('\n').includes('wifi'));
        if (!this.available) {
            this.emit('changed');
            return;
        }
        this.enabled = (await this._run(['nmcli', 'radio', 'wifi']))?.trim() === 'enabled';
        const list = this.enabled ? await this._run(['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']) : '';
        if (this._destroyed)
            return;
        const seen = new Map();
        for (const line of (list ?? '').split('\n')) {
            // nmcli escapes ':' inside a field as '\:'.
            const fields = line.split(/(?<!\\):/).map(field => field.replace(/\\:/g, ':'));
            const [inUse, ssid, signal, security] = fields;
            if (!ssid)
                continue;
            const entry = {ssid, signal: Number(signal) || 0, secure: Boolean(security && security !== '--'), active: inUse === '*'};
            const known = seen.get(ssid);
            if (!known || entry.active || entry.signal > known.signal)
                seen.set(ssid, entry);
        }
        this.networks = [...seen.values()].sort((a, b) => b.active - a.active || b.signal - a.signal);
        this.emit('changed');
    }

    setEnabled(on) {
        this.enabled = on;
        this.emit('changed');
        this._run(['nmcli', 'radio', 'wifi', on ? 'on' : 'off']).then(() => this.refresh());
    }

    /** Joins a network NetworkManager already knows (or an open one); a new secured one needs its password: GNOME's own settings. */
    connect(network) {
        if (network.secure) {
            this._run(['nmcli', '-t', '-f', 'NAME', 'connection', 'show']).then(names => {
                if (names?.split('\n').includes(network.ssid))
                    this._run(['nmcli', 'connection', 'up', network.ssid]).then(() => this.refresh());
                else
                    GLib.spawn_command_line_async('gnome-control-center wifi');
            });
            return;
        }
        this._run(['nmcli', 'device', 'wifi', 'connect', network.ssid]).then(() => this.refresh());
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
    }
}

/** Bluetooth: the adapter's power and the paired devices, to connect and disconnect (GnomeBluetooth, as GNOME's own menu). */
export class Bluetooth extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this._client = null;
        import('gi://GnomeBluetooth?version=3.0').then(module => {
            if (this._destroyed)
                return;
            this._module = module.default;
            this._client = new this._module.Client();
            this._ids = [this._client.connect('notify::default-adapter-powered', () => this._sync()),
                this._client.connect('notify::default-adapter', () => this._sync()),
                this._client.connect('notify::default-adapter-state', () => this._sync())];
            this._devices = this._client.get_devices();
            this._listIds = [this._devices.connect('items-changed', () => this._sync())];
            this._sync();
        }).catch(error => console.warn(`Island: Bluetooth is not available: ${error.message}`));
        this.powered = false;
        this.devices = [];
    }

    _sync() {
        if (!this._client)
            return;
        this.available = Boolean(this._client.default_adapter);
        this.powered = Boolean(this._client.default_adapter_powered);
        const devices = [];
        for (let i = 0; i < this._devices.get_n_items(); i++) {
            const device = this._devices.get_item(i);
            // Watched for a change of its own (connected, battery), once.
            if (!device._islandWatched) {
                device._islandWatched = true;
                device.connect('notify::connected', () => this._sync());
                device.connect('notify::battery-percentage', () => this._sync());
            }
            if (device.paired || device.connected) {
                devices.push({
                    path: device.get_object_path(),
                    name: device.alias || device.name || device.address,
                    icon: device.icon,
                    connected: device.connected,
                    battery: device.battery_percentage > 0 ? device.battery_percentage : null,
                    busy: Boolean(device._islandBusy),
                    device,
                });
            }
        }
        this.devices = devices.sort((a, b) => b.connected - a.connected || a.name.localeCompare(b.name));
        this.emit('changed');
    }

    setPowered(on) {
        if (this._client)
            this._client.default_adapter_powered = on;
    }

    /** Connects or disconnects `entry`'s device. */
    toggle(entry) {
        const {device} = entry;
        if (!this._client || device._islandBusy)
            return;
        device._islandBusy = true;
        this._sync();
        this._client.connect_service(entry.path, !device.connected, null, (client, result) => {
            device._islandBusy = false;
            try {
                client.connect_service_finish(result);
            } catch (e) {
                console.warn(`Island: Bluetooth: ${e.message}`);
            }
            this._sync();
        });
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        if (this._client) {
            this._ids.forEach(id => this._client.disconnect(id));
            this._listIds.forEach(id => this._devices.disconnect(id));
        }
    }
}

/** Airplane mode: every radio blocked (rfkill), as the Quick Settings' own switch does. */
export function airplaneOn(radioOn) {
    const wlan = radioOn('wlan');
    const bluetooth = radioOn('bluetooth');
    if (wlan === null && bluetooth === null)
        return null;
    return !wlan && !bluetooth;
}
