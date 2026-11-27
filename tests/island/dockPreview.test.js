// The dock's window preview must not rebuild (blink) when the pointer returns to it. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

let built = 0;
class Actor {
    opacity = 255; y = 0; pending = null;
    constructor(p) { if (p?.style_class === 'dock-preview-popup') built++; this.clutter_text = {set_ellipsize() {}}; }
    ease(p) { this.pending = p; }                       // an animation stays "running" until the test says otherwise
    remove_all_transitions() { this.pending = null; }
    get_size() { return [100, 100]; }
    get_transformed_position() { return [500, 900]; }
    get_preferred_width() { return [0, 200]; }
    get_preferred_height() { return [0, 150]; }
    set_position(_x, y) { this.y = y; }
    connect() { return 1; }
    add_child() {} set_style() {} set_size() {} set_pivot_point() {} set_x_expand() {} destroy() {}
    add_style_class_name() {} remove_style_class_name() {} has_style_class_name() { return false; }
}
globalThis.__fake = {
    Clutter: {ActorAlign: {}, AnimationMode: {}, EVENT_STOP: true, EVENT_PROPAGATE: false},
    GLib: {timeout_add: () => 1, source_remove() {}},
    St: {BoxLayout: Actor, Label: Actor, Button: Actor},
    Shell: {},
};
globalThis.global = Object.assign(globalThis, {get_window_actors: () => []});
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    if (spec.endsWith('/ui/main.js')) return fake('export const layoutManager = {primaryMonitor: {x: 0, y: 0, width: 1920}, addTopChrome() {}, removeChrome() {}};');
    if (spec === './compat.js') return fake('export const box = () => ({});');
    if (spec === './signalManager.js') return fake('export class SignalManager { connect() {} disconnectAll() {} }');
    return next(spec, ctx);
}});

const app = n => ({get_windows: () => Array.from({length: n}, () => ({minimized: false, get_title: () => 'w', has_focus: () => false}))});

test('dock window preview does not blink when the pointer returns', async () => {
    const {WindowPreviewPopup} = await import('../../shell/dock/dist/lib/windowPreview.js');
    const p = new WindowPreviewPopup();
    const a = app(1), icon = new Actor();

    p.show(a, icon);
    p.show(a, icon);                                    // again while still fading in
    assert.equal(built, 1);

    const popup = p._popup, rest = popup.pending.y;
    p.hide();                                           // fade-out starts
    p.cancelScheduledHide();                            // pointer comes back
    assert.equal(p._popup, popup);
    assert.deepEqual([popup.pending.opacity, popup.pending.y], [255, rest]);

    p.show(app(0), icon);                               // an app without windows hides the old popup
    assert.equal(popup.pending.opacity, 0);
    assert.equal(built, 1);
});

test('a dismissed dock preview is not revived by a returning pointer', async () => {
    const {WindowPreviewPopup} = await import('../../shell/dock/dist/lib/windowPreview.js');
    const p = new WindowPreviewPopup();
    const a = app(1), icon = new Actor();
    p.show(a, icon);

    const popup = p._popup, before = built;
    p.dismiss();                                        // thumbnail clicked, or previews turned off
    p.cancelScheduledHide();                            // enter event during the fade
    assert.equal(popup.pending.opacity, 0);

    p.show(a, icon);                                    // a new hover on the icon opens a fresh one
    assert.equal(built, before + 1);
});
