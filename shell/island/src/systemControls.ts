// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// What the Controls and Power pages set and show, each behind a small object the page only reads and tells: the screen's brightness,
// Bluetooth, the Wi-Fi networks, the power profile, the battery and the airplane mode. They use what GNOME itself uses (the settings daemon, GnomeBluetooth,
// NetworkManager through nmcli, power-profiles-daemon), so the island and the Quick Settings always agree.
//
// Each has `available` (does this computer have it at all), a `changed` signal, and `destroy()`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {batteryState, orderedProfiles, parseWifiList, wifiFailure} from './powerRules.js';

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
        this.profiles = orderedProfiles(list.map(entry => entry.Profile?.deep_unpack?.() ?? entry.Profile).filter(Boolean));
        this.active = active;
        this.available = this.profiles.length > 1;
        this.emit('changed');
    }

    /** The profile after the one in use. */
    next() {
        const at = this.profiles.indexOf(this.active);
        this.set(this.profiles[(at + 1) % this.profiles.length]);
    }

    /** Switches to `name` (one of `profiles`). */
    set(name) {
        if (!this.profiles.includes(name))
            return;
        this.active = name;
        this.emit('changed');
        this._proxy?.get_connection().call(this._name, this._path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [this._name, 'ActiveProfile', new GLib.Variant('s', name)]), null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        if (this._proxy && this._changedId)
            this._proxy.disconnect(this._changedId);
    }
}

/** The laptop's battery, from UPower's display device (the one GNOME's own menu reads): the level, what it is doing, how long it
 * lasts or takes to fill, and its health. `available` is false on a computer with no battery. Emits `changed` only when
 * something it shows did. */
export class Battery extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this.percent = 0;
        this.state = 'unknown';
        this.timeToFull = 0;
        this.timeToEmpty = 0;
        this.rate = 0;
        /** The battery's capacity against what it was built for, in percent; 0 when UPower does not say. */
        this.health = 0;
        this._proxy = null;
        this._seen = '';
        const name = 'org.freedesktop.UPower';
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, name, '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', null, (_o, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (_e) {
                    return;
                }
                if (this._destroyed || !this._proxy.get_name_owner())
                    return;
                this._changedId = this._proxy.connect('g-properties-changed', () => this._read());
                this._read();
                this.readHealth();
            });
    }

    _prop(name, fallback) {
        return this._proxy?.get_cached_property(name)?.deepUnpack() ?? fallback;
    }

    _read() {
        const present = this._prop('IsPresent', false);
        const percent = this._prop('Percentage', 0);
        const state = batteryState(this._prop('State', 0));
        const timeToFull = Number(this._prop('TimeToFull', 0));
        const timeToEmpty = Number(this._prop('TimeToEmpty', 0));
        const rate = this._prop('EnergyRate', 0);
        // The power draw wobbles with every read: a tenth of a watt is all the card shows.
        const seen = JSON.stringify([present, Math.round(percent), state, Math.round(timeToFull / 60), Math.round(timeToEmpty / 60), Math.round(rate * 10), this.health]);
        if (seen === this._seen)
            return;
        this._seen = seen;
        Object.assign(this, {available: Boolean(present), percent: Math.round(percent), state, timeToFull, timeToEmpty, rate});
        this.emit('changed');
    }

    /** Reads the health of the first battery UPower lists (its `Capacity`: what it holds now of what it was built to hold). */
    readHealth() {
        Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', 'EnumerateDevices', null,
            new GLib.VariantType('(ao)'), Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                let path;
                try {
                    [path] = bus.call_finish(result).deepUnpack()[0].filter(entry => /battery_/.test(entry));
                } catch (_e) {
                    return;
                }
                if (!path || this._destroyed)
                    return;
                bus.call('org.freedesktop.UPower', path, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', ['org.freedesktop.UPower.Device', 'Capacity']), null, Gio.DBusCallFlags.NONE, -1, null, (b, res) => {
                        try {
                            const capacity = b.call_finish(res).deepUnpack()[0].deepUnpack();
                            if (!this._destroyed && capacity > 0 && Math.round(capacity) !== this.health) {
                                this.health = Math.round(capacity);
                                this._seen = '';
                                this._read();
                            }
                        } catch (_e) { /* no capacity to show */ }
                    });
            });
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
        if (this._proxy && this._changedId)
            this._proxy.disconnect(this._changedId);
    }
}

/** Wi-Fi: the radio and the networks in range, and joining one (through nmcli: no network library to carry, the same service as
 * GNOME's). Its methods are `join` and `leave`, never `connect` and `disconnect`: those are the EventEmitter's, for the signals, and the page
 * calls them with a signal's name and id (naming a method after them once joined a network called "changed" and left Wi-Fi when the page ended).
 * `connecting` names the network being joined; `error` is {ssid, message, wrongPassword} for the last that failed. */
export class WifiNetworks extends Signals.EventEmitter {
    constructor() {
        super();
        this.available = false;
        this.enabled = false;
        this.networks = [];
        /** The saved connections: network name -> the name of its saved connection (not always the same: another tool may have named it
         * "Home 1"), joined with no password asked. */
        this.known = new Map();
        this.connecting = '';
        this.error = null;
        this._device = '';
        this.refresh();
    }

    /** Runs `argv`: {ok, out, err}. Never throws. */
    _exec(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    try {
                        const [, out, err] = p.communicate_utf8_finish(result);
                        resolve({ok: p.get_successful(), out: out ?? '', err: err ?? ''});
                    } catch (e) {
                        resolve({ok: false, out: '', err: e.message});
                    }
                });
            } catch (e) {
                resolve({ok: false, out: '', err: e.message});
            }
        });
    }

    async _run(argv) {
        const {ok, out} = await this._exec(argv);
        return ok ? out : null;
    }

    /** Reads the radio and the list again; `rescan` asks the adapter to look afresh first (the list is its last look). */
    async refresh({rescan = false} = {}) {
        // Reads started one after another may end out of turn: only the newest says what is there.
        const turn = (this._turn = (this._turn ?? 0) + 1);
        const devices = await this._run(['nmcli', '-t', '-f', 'DEVICE,TYPE', 'device']);
        if (this._destroyed || turn !== this._turn)
            return;
        const wifi = (devices ?? '').split('\n').map(line => line.split(':')).find(([, type]) => type === 'wifi');
        this.available = Boolean(wifi);
        this._device = wifi?.[0] ?? '';
        if (!this.available) {
            this.emit('changed');
            return;
        }
        this.enabled = (await this._run(['nmcli', 'radio', 'wifi']))?.trim() === 'enabled';
        if (this.enabled && rescan)
            await this._exec(['nmcli', 'device', 'wifi', 'rescan']);
        const list = this.enabled ? await this._run(['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']) : '';
        const saved = await this._run(['nmcli', '-t', '-f', 'NAME,UUID,TYPE', 'connection', 'show']);
        // A saved connection is the network it names inside (its SSID), not the name it was given.
        const profiles = (saved ?? '').split('\n').map(line => line.split(/(?<!\\):/).map(field => field.replace(/\\:/g, ':')))
            .filter(([, , type]) => type === '802-11-wireless');
        const known = new Map();
        await Promise.all(profiles.map(async ([name, uuid]) => {
            const ssid = (await this._run(['nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid]))?.trim() || name;
            if (!known.has(ssid))
                known.set(ssid, name);
        }));
        if (this._destroyed || turn !== this._turn)
            return;
        this.known = known;
        this.networks = parseWifiList(list);
        this.emit('changed');
    }

    setEnabled(on) {
        this.enabled = on;
        this.emit('changed');
        this._run(['nmcli', 'radio', 'wifi', on ? 'on' : 'off']).then(() => this.refresh());
    }

    /** Joins `network`. A saved one or an open one goes at once; a new secured one needs `password`, and with none given this
     * answers 'needs-password' so the page can ask. Resolves 'connected', 'failed' (see `error`), 'needs-password' or 'busy'. */
    async join(network, password = null) {
        if (this.connecting)
            return 'busy';
        const profile = this.known.get(network.ssid);
        if (network.secure && !profile && password === null)
            return 'needs-password';
        this.connecting = network.ssid;
        this.error = null;
        this.emit('changed');
        let result;
        if (profile) {
            // A password given for a saved network replaces the saved one, and is kept for the whole computer (not in one login's keyring),
            // so the network joins by itself at boot and after a drop.
            if (password !== null)
                await this._exec(['nmcli', 'connection', 'modify', 'id', profile, 'wifi-sec.psk', password, 'wifi-sec.psk-flags', '0']);
            result = await this._exec(['nmcli', '--wait', '25', 'connection', 'up', 'id', profile]);
        } else {
            const join = () => this._exec(['nmcli', '--wait', '25', 'device', 'wifi', 'connect', network.ssid, ...(network.secure ? ['password', password] : [])]);
            result = await join();
            // The adapter's list was out of date: look afresh, once, and try again.
            if (!result.ok && /no network with ssid/i.test(result.err)) {
                await this._exec(['nmcli', 'device', 'wifi', 'rescan']);
                result = await join();
            }
        }
        this.connecting = '';
        if (!result.ok) {
            const why = wifiFailure(result.err);
            if (profile && password === null && why.wrongPassword) {
                // The saved connection has no password this session can use (kept by another login's keyring, or changed since): ask for it.
                if (!this._destroyed)
                    await this.refresh();
                return 'needs-password';
            }
            this.error = {ssid: network.ssid, ...why};
            // A connection this try made and that never worked would only be tried again, with the same password.
            if (!profile)
                await this._exec(['nmcli', 'connection', 'delete', 'id', network.ssid]);
        }
        if (!this._destroyed)
            await this.refresh();
        if (result.ok) {
            // Joined by hand once: it is joined by itself from now on.
            const kept = this.known.get(network.ssid);
            if (kept)
                await this._exec(['nmcli', 'connection', 'modify', 'id', kept, 'connection.autoconnect', 'yes']);
        }
        return result.ok ? 'connected' : 'failed';
    }

    /** Leaves the network joined now (it stays saved, and is not joined again by itself until asked). */
    async leave() {
        if (this._device)
            await this._exec(['nmcli', 'device', 'disconnect', this._device]);
        if (!this._destroyed)
            await this.refresh();
    }

    /** Forgets a saved network: the next join asks for its password again. */
    async forget(ssid) {
        await this._exec(['nmcli', 'connection', 'delete', 'id', ssid]);
        this.error = null;
        if (!this._destroyed)
            await this.refresh();
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
