// The Flow event emitter with fake Shell objects: opt-in (nothing connected until start), only the five kinds with their small payloads, debounced
// and capped, a missing daemon ignored, and every listener gone after stop().
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cleanPayload, connectFlowSources, createFlowEmitter} from '../../shell/search/build/flowEvents.js';

class Obj {
    constructor(props = {}) { Object.assign(this, props); this.handlers = new Map(); this.next = 1; }
    connect(signal, fn) { const id = this.next++; this.handlers.set(id, [signal, fn]); return id; }
    disconnect(id) { this.handlers.delete(id); }
    fire(signal, ...a) { for (const [s, fn] of [...this.handlers.values()]) if (s === signal) fn(this, ...a); }
    get live() { return this.handlers.size; }
}

function rig({sendResult = true} = {}) {
    let t = 1000;
    const timers = new Map();
    let nextTimer = 1;
    const sent = [];
    const emitter = createFlowEmitter({
        send: (kind, json) => { sent.push([kind, JSON.parse(json)]); return sendResult === 'throw' ? Promise.reject(new Error('no daemon')) : Promise.resolve(sendResult); },
        after: (ms, fn) => { const h = nextTimer++; timers.set(h, {at: t + ms, fn}); return h; },
        cancel: h => timers.delete(h),
        now: () => t,
    });
    const advance = async ms => {
        t += ms;
        for (const [h, x] of [...timers]) if (x.at <= t) { timers.delete(h); x.fn(); }
        await Promise.resolve(); await Promise.resolve();
    };
    return {emitter, sent, advance, timers, clock: () => t, tick: ms => { t += ms; }};
}

function shell() {
    const app = (id, state = 0) => ({get_id: () => id, state});
    const h = {
        workspaceManager: Object.assign(new Obj(), {idx: 0, get_active_workspace_index() { return this.idx; }}),
        layoutManager: new Obj({monitors: [{}]}),
        appSystem: Object.assign(new Obj(), {running: [app('already.desktop', 2)], get_running() { return this.running; }}),
        tracker: new Obj({focus_app: null}),
        runningState: 2, stoppedState: 0,
        profile: 'balanced', cbs: new Set(), readProfile() { return this.profile; },
        watchProfile(cb) { this.cbs.add(cb); return () => this.cbs.delete(cb); },
    };
    return {h, app};
}

test('payloads are rebuilt field by field: unknown kinds, extra fields, titles and bad values never pass', () => {
    assert.deepEqual(cleanPayload('workspace', {index: 2, title: 'secret'}), {index: 2});
    assert.deepEqual(cleanPayload('monitor', {count: 2, added: true, name: 'x'}), {count: 2, added: true});
    assert.deepEqual(cleanPayload('profile', {name: 'deep-work'}), {name: 'deep-work'});
    assert.deepEqual(cleanPayload('app-launched', {appId: 'org.gnome.Nautilus.desktop', title: 'My Documents'}), {appId: 'org.gnome.Nautilus.desktop'});
    for (const bad of [['workspace', {index: -1}], ['workspace', {index: 1.5}], ['monitor', {count: 2}], ['profile', {name: 'a\nb'}], ['profile', {name: ''}],
        ['app-focus', {appId: 'has space'}], ['app-focus', {appId: 'x'.repeat(200)}], ['clipboard', {text: 'x'}], ['workspace', null], ['app-focus', 'str']])
        assert.equal(cleanPayload(bad[0], bad[1]), null, JSON.stringify(bad));
});

test('workspace, monitor, app launch, focus and profile signals each send one small event', async () => {
    const {emitter, sent, advance} = rig();
    const {h, app} = shell();
    const src = connectFlowSources(h, emitter);
    h.workspaceManager.idx = 2; h.workspaceManager.fire('workspace-switched', 0, 2, 0);
    h.layoutManager.monitors = [{}, {}]; h.layoutManager.fire('monitors-changed');
    h.appSystem.fire('app-state-changed', app('code.desktop', 2));
    h.tracker.focus_app = app('code.desktop'); h.tracker.fire('notify::focus-app');
    for (const cb of h.cbs) cb('gaming');
    await advance(400);
    assert.deepEqual(sent.map(s => s[0]).sort(), ['app-focus', 'app-launched', 'monitor', 'profile', 'workspace']);
    const by = Object.fromEntries(sent);
    assert.deepEqual(by.workspace, {index: 2});
    assert.deepEqual(by.monitor, {count: 2, added: true});
    assert.deepEqual(by['app-launched'], {appId: 'code.desktop'});
    assert.deepEqual(by['app-focus'], {appId: 'code.desktop'});
    assert.deepEqual(by.profile, {name: 'gaming'});
    h.layoutManager.monitors = [{}]; h.layoutManager.fire('monitors-changed');
    await advance(400);
    assert.deepEqual(sent.at(-1), ['monitor', {count: 1, added: false}]);
    src.stop();
});

test('what was already there is not an event: running apps, the same monitor count, the same profile', async () => {
    const {emitter, sent, advance} = rig();
    const {h, app} = shell();
    connectFlowSources(h, emitter);
    h.appSystem.fire('app-state-changed', app('already.desktop', 2));   // was running at start
    h.layoutManager.fire('monitors-changed');                           // a re-layout, same count
    for (const cb of h.cbs) cb('balanced');                             // same profile re-saved
    h.appSystem.fire('app-state-changed', app('already.desktop', 0));   // quits ...
    h.appSystem.fire('app-state-changed', app('already.desktop', 2));   // ... and starts again: a launch
    await advance(400);
    assert.deepEqual(sent, [['app-launched', {appId: 'already.desktop'}]]);
});

test('a burst is debounced to its last event, and a repeated launch inside a second is one', async () => {
    const {emitter, sent, advance, tick} = rig();
    for (let i = 0; i < 6; i++) { emitter.emit('workspace', {index: i}); await advance(50); }
    emitter.emit('app-focus', {appId: 'a'}); emitter.emit('app-focus', {appId: 'b'});
    await advance(400);
    assert.deepEqual(sent, [['workspace', {index: 5}], ['app-focus', {appId: 'b'}]]);
    sent.length = 0;
    emitter.emit('app-launched', {appId: 'x'}); emitter.emit('app-launched', {appId: 'x'});
    assert.equal(sent.length, 1);
    tick(1500);
    emitter.emit('app-launched', {appId: 'x'});
    assert.equal(sent.length, 2);
});

test('there is a cap per ten seconds', async () => {
    const {emitter, sent, tick} = rig();
    for (let i = 0; i < 60; i++) { emitter.emit('app-launched', {appId: `app${i}`}); tick(10); }
    assert.equal(sent.length, 20);
    assert.equal(emitter.stats().dropped, 40);
    tick(11000);
    emitter.emit('app-launched', {appId: 'later'});
    assert.equal(sent.length, 21);
});

test('a missing daemon is ignored: a rejected call never throws, and after repeated failures the shell stops trying for a minute', async () => {
    for (const result of ['throw']) {
        const {emitter, sent, tick, advance} = rig({sendResult: result});
        for (let i = 0; i < 6; i++) { emitter.emit('app-launched', {appId: `a${i}`}); await advance(5); }
        assert.equal(sent.length, 3, 'three tries, then paused');
        assert.equal(emitter.stats().paused, true);
        tick(61000);
        emitter.emit('app-launched', {appId: 'back'});
        assert.equal(sent.length, 4);
    }
});

test('a send that throws at once does not break the shell signal', () => {
    const emitter = createFlowEmitter({send: () => { throw new Error('boom'); }, after: () => 1, cancel() {}, now: () => 0});
    assert.doesNotThrow(() => emitter.emit('app-launched', {appId: 'x'}));
});

test('stop() disconnects every listener, drops what waits, and sends nothing afterwards', async () => {
    const {emitter, sent, advance, timers} = rig();
    const {h, app} = shell();
    const src = connectFlowSources(h, emitter);
    assert.equal(src.connected(), 5);
    h.workspaceManager.fire('workspace-switched');
    assert.equal(timers.size, 1);
    src.stop(); emitter.stop();
    assert.equal(src.connected(), 0);
    assert.equal(timers.size, 0);
    assert.equal(h.workspaceManager.live + h.layoutManager.live + h.appSystem.live + h.tracker.live + h.cbs.size, 0);
    h.appSystem.fire('app-state-changed', app('x.desktop', 2));
    emitter.emit('profile', {name: 'x'});
    await advance(1000);
    assert.deepEqual(sent, []);
});

test('a profile watch that cannot start leaves the other four working', () => {
    const {emitter} = rig();
    const {h} = shell();
    h.watchProfile = () => { throw new Error('no monitor'); };
    const src = connectFlowSources(h, emitter);
    assert.equal(src.connected(), 4);
    src.stop();
});

test('the extension is opt-in: nothing is created unless flow-events is on, the call never starts the daemon, and disable stops it', () => {
    const ext = readFileSync(new URL('../../shell/search/extension.ts', import.meta.url), 'utf8');
    assert.match(ext, /_pref\('flow-events', false\)/);
    assert.match(ext, /changed::flow-events/);
    assert.match(ext, /NO_AUTO_START/);
    assert.match(ext, /disable\(\) \{[\s\S]*this\._stopFlow\(\)/);
    const xml = readFileSync(new URL('../../control/org.niro.control.gschema.xml', import.meta.url), 'utf8');
    assert.match(xml, /<key name="flow-events" type="b">\s*<default>false<\/default>/);
});

test('the daemon answering false (Flow off, its own limit) is not a missing daemon: sending goes on', async () => {
    const {emitter, sent, advance} = rig({sendResult: false});
    for (let i = 0; i < 6; i++) { emitter.emit('app-launched', {appId: `a${i}`}); await advance(5); }
    assert.equal(sent.length, 6);
    assert.equal(emitter.stats().paused, false);
});
