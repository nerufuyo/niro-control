// A closed window's signal connections must be dropped, not kept and disconnected again. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

let next = 0, stale = 0;
class Obj {
    live = new Map(); handlers = {};
    connect(signal, fn) { this.live.set(++next, signal); this.handlers[signal] = fn; return next; }
    disconnect(id) { if (!this.live.delete(id)) stale++; }
}
const texture = new Obj();
const actor = Object.assign(new Obj(), {firstChild: {}, metaWindow: new Obj(), get_texture: () => texture});
const wm = new Obj(), display = new Obj();
globalThis.global = Object.assign(globalThis, {windowManager: wm, display, get_window_actors: () => [actor]});
globalThis.__prefs = new Obj();
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.endsWith('/log.js')) return fake('export const logDebug = () => {};');
    if (spec.endsWith('/settings.js')) return fake('export const prefs = globalThis.__prefs;');
    if (spec === './event_handlers.js') return fake('export const onAddEffect = () => {}, onRemoveEffect = onAddEffect, onMinimize = onAddEffect, onUnminimize = onAddEffect, onRestacked = onAddEffect, onSettingsChanged = onAddEffect, onSizeChanged = onAddEffect, onFocusChanged = onAddEffect;');
    if (spec === './utils.js') return fake('export const windowClass = () => "w";');
    return next(spec, ctx);
}});

test('rounded corners drop a closed window\'s connections', async () => {
    const {enableEffect, disableEffect} = await import('../../shell/corners/manager/event_manager.js');
    enableEffect();
    wm.handlers.destroy(wm, actor);                     // the window closes
    assert.deepEqual([actor, texture, actor.metaWindow].map(o => o.live.size), [0, 0, 0]);
    wm.handlers.destroy(wm, actor);
    disableEffect();
    assert.equal(stale, 0);
    assert.equal(wm.live.size + display.live.size, 0);
});
