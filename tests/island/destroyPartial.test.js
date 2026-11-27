// A build that fails part way must give GNOME its top bar back. The method runs with GNOME stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('a failed build destroys the bar hider and the session restore too', () => {
    const source = readFileSync(new URL('../../shell/island/src/controller.ts', import.meta.url), 'utf8');
    const method = source.match(/^ {4}_destroyPartial\(\) \{\n[\s\S]*?^ {4}\}$/m)[0];
    const nothing = () => {};
    const deps = {
        Alerts: {stopWatching: nothing}, stopPending: nothing, Format: {release: nothing}, Motion: {release: nothing},
        global: {backend: {get_core_idle_monitor: () => ({})}},
    };
    const Controller = new Function(...Object.keys(deps), `return class {\n${method}\n};`)(...Object.values(deps));
    const destroyed = [];
    const part = name => ({destroy: () => destroyed.push(name)});
    const controller = Object.assign(new Controller(), {
        _timeouts: new Map(), _pages: [], _barHider: part('bar'), _sessionRestore: part('session'),
        _unbindPageShortcuts: nothing, _setKeyboard: nothing, _releaseScanout: nothing, _stopRevealWait: nothing,
        _sayPresent: nothing, _destroyMirrors: nothing,
    });
    controller._destroyPartial();
    assert.deepEqual(destroyed.sort(), ['bar', 'session']);
});
