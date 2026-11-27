// A media player found at startup must be removed when it leaves, and one still being reached must not outlive that or stop(). GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const queue = [];                                       // proxies being made, finished by the test
let nameOwnerChanged, listNames;
const bus = {
    signal_subscribe: (...a) => { nameOwnerChanged = (...v) => a[6](null, null, null, null, null, {deepUnpack: () => v}); return 1; },
    signal_unsubscribe() {},
    call: (...a) => { listNames = names => a[9](null, names); },
    call_finish: names => ({deepUnpack: () => [names]}),
};
const proxy = () => ({get_cached_property: p => p === 'PlaybackStatus' ? {deepUnpack: () => 'Playing'} : null, connect: () => 1, disconnect() {}});
globalThis.__fake = {
    Gio: {
        DBus: {session: bus}, DBusSignalFlags: {}, DBusCallFlags: {}, DBusProxyFlags: {},
        Cancellable: class { cancel() { this.done = true; } is_cancelled() { return !!this.done; } },
        DBusProxy: {new: (...a) => queue.push(a[7]), new_finish: () => proxy()},   // no new_sync: nothing may block
    },
    GLib: {VariantType: class {}},
    Shell: {AppSystem: {get_default: () => ({lookup_app: id => id})}},
};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    return next(spec, ctx);
}});
const finish = () => { while (queue.length) queue.shift()(null, {}); };
const name = 'org.mpris.MediaPlayer2.vlc';

test('dock media players are removed by the name they were added under, and not added after leaving or stop', async () => {
    const {MediaManager} = await import('../../shell/dock/dist/lib/mediaManager.js');
    const m = new MediaManager(), seen = [];
    m.setOnStateChanged(app => seen.push(app));
    m.start();

    listNames([name]);
    finish();
    assert.equal(m.getActiveApp(), 'vlc.desktop');
    nameOwnerChanged(name, ':1.5', '');
    assert.deepEqual(seen, ['vlc.desktop', null]);
    assert.equal(m.isPlaying(), false);

    nameOwnerChanged(name, '', ':1.6');
    nameOwnerChanged(name, ':1.6', '');                 // leaves while still being reached
    finish();
    assert.equal(m.getActiveApp(), null);

    nameOwnerChanged(name, '', ':1.7');
    m.stop();
    finish();
    assert.equal(m.getActiveApp(), null);
    assert.equal(seen.length, 2);
});
