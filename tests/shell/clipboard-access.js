// Clipboard1.Items on a private bus: GNOME Shell (played here) reads it and hears its changes, nobody else does.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const DAEMON = 'org.niro.island.Daemon';
const PATH = '/org/niro/island/Daemon';
const connect = () => Gio.DBusConnection.new_for_address_sync(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'),
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
const call = (bus, name, path, iface, method, params) => new Promise((resolve, reject) =>
    bus.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 5000, null, (_bus, result) => {
        try {
            resolve(bus.call_finish(result).recursiveUnpack());
        } catch (e) {
            reject(e);
        }
    }));
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (resolve(), GLib.SOURCE_REMOVE)));
const props = (bus, method, ...args) =>
    call(bus, DAEMON, PATH, 'org.freedesktop.DBus.Properties', method, new GLib.Variant(`(${'s'.repeat(args.length)})`, args));

let failures = 0;
const check = (ok, what) => {
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    failures += ok ? 0 : 1;
};

const loop = GLib.MainLoop.new(null, false);
(async () => {
    const shell = connect();
    const other = connect();
    await call(shell, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
        new GLib.Variant('(su)', ['org.gnome.Shell', 0]));
    await call(shell, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'StartServiceByName',
        new GLib.Variant('(su)', [DAEMON, 0])).catch(() => {});
    for (let i = 0; i < 50; i++) {
        if (await props(shell, 'Get', 'org.niro.island.Clipboard1', 'Items').then(() => true, () => false))
            break;
        await sleep(100);
    }

    const heard = {shell: [], other: []};
    for (const [who, bus] of [['shell', shell], ['other', other]]) {
        bus.signal_subscribe(null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', PATH, 'org.niro.island.Clipboard1',
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => heard[who].push(JSON.stringify(params.recursiveUnpack())));
    }
    await call(other, DAEMON, PATH, 'org.niro.island.Clipboard1', 'AddText', new GLib.Variant('(ss)', ['private words', '']));
    await sleep(500);

    const [items] = await props(shell, 'Get', 'org.niro.island.Clipboard1', 'Items');
    check(JSON.stringify(items).includes('private words'), 'GNOME Shell reads Items');
    const [all] = await props(shell, 'GetAll', 'org.niro.island.Clipboard1');
    check('Items' in all, 'GNOME Shell gets Items from GetAll (what its proxy loads)');
    const refused = await props(other, 'Get', 'org.niro.island.Clipboard1', 'Items').then(() => '', e => e.message);
    check(refused.includes('AccessDenied'), 'another program may not Get Items');
    const [theirs] = await props(other, 'GetAll', 'org.niro.island.Clipboard1').catch(() => [{}]);
    check(!('Items' in theirs), 'another program gets no Items from GetAll');
    check(heard.shell.some(signal => signal.includes('private words')), 'GNOME Shell hears the change');
    check(heard.other.length === 0, 'another program hears no change');
    loop.quit();
})().catch(e => {
    check(false, e.message);
    loop.quit();
});
loop.run();
System.exit(failures ? 1 : 0);
