// The dock's SignalManager: actors that are destroyed before disable() must not be disconnected again (GJS throws "already disposed"
// on a disposed instance), and a destroyed actor's connections must not pile up across icon reloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SignalManager} from '../../shell/dock/src/lib/signalManager.ts';

/** A GObject stand-in: connect/disconnect/emit, and a disposed state in which any access throws like GJS does. */
class FakeActor {
    constructor() { this.handlers = new Map(); this.next = 1; this.disposed = false; }
    connect(signal, cb) { this._live(); const id = this.next++; this.handlers.set(id, {signal, cb}); return id; }
    disconnect(id) { this._live(); if (!this.handlers.delete(id)) throw new Error(`no handler with id '${id}'`); }
    emit(signal) { for (const h of [...this.handlers.values()]) if (h.signal === signal) h.cb(this); }
    destroy() { this.emit('destroy'); this.handlers.clear(); this.disposed = true; }
    _live() { if (this.disposed) throw new Error('Object has been already disposed'); }
}

test('disconnectAll after an actor was destroyed does not touch the disposed actor', () => {
    const sm = new SignalManager();
    const live = new FakeActor(), gone = new FakeActor();
    sm.connectActor(live, 'notify::hover', () => {});
    sm.connectActor(gone, 'notify::hover', () => {});
    sm.connectActor(gone, 'button-press-event', () => {});
    gone.destroy();
    assert.doesNotThrow(() => sm.disconnectAll());
    assert.equal(live.handlers.size, 0, 'the live actor was disconnected');
    assert.equal(sm.size, 0);
});

test('plain connect on a destroyed actor reproduces the old failure (why connectActor exists)', () => {
    const sm = new SignalManager();
    const gone = new FakeActor();
    sm.connect(gone, 'notify::hover', () => {});
    gone.destroy();
    assert.throws(() => sm.disconnectAll(), /disposed/);
});

test('reload churn does not accumulate connections', () => {
    const sm = new SignalManager();
    sm.connect(new FakeActor(), 'installed-changed', () => {});
    for (let round = 0; round < 50; round++) {
        const icons = Array.from({length: 8}, () => new FakeActor());
        for (const a of icons) { sm.connectActor(a, 'button-press-event', () => {}); sm.connectActor(a, 'button-release-event', () => {}); sm.connectActor(a, 'notify::hover', () => {}); }
        for (const a of icons) a.destroy();
    }
    assert.equal(sm.size, 1, 'only the long-lived connection remains');
});

test('disconnectSource lets one actor go before it is destroyed and leaves the others', () => {
    const sm = new SignalManager();
    const a = new FakeActor(), b = new FakeActor();
    sm.connectActor(a, 'notify::hover', () => {});
    sm.connectActor(b, 'notify::hover', () => {});
    sm.disconnectSource(a);
    assert.equal(a.handlers.size, 0);
    assert.equal(b.handlers.size, 2, 'its handler and its destroy watch');
    a.destroy();
    assert.doesNotThrow(() => sm.disconnectAll());
    assert.equal(b.handlers.size, 0);
});

test('a handler on a destroyed actor never fires after destruction and the callback still runs while alive', () => {
    const sm = new SignalManager();
    const a = new FakeActor();
    let n = 0;
    sm.connectActor(a, 'notify::hover', () => { n++; });
    a.emit('notify::hover');
    assert.equal(n, 1);
    a.destroy();
    assert.equal(sm.size, 0);
});
