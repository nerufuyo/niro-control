// The genie hides the real window while its clone flies; the window's own opacity must always come back. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const clones = [];
class Clone {
    constructor() { clones.push(this); }
    ease(p) { this.onStopped = p.onStopped; }
    destroy() { this.onStopped?.(); }                   // destroying an animating actor stops its ease
    add_child() {} set_position() {} set_size() {} set_pivot_point() {} add_effect_with_name() {} set() {}
}
globalThis.__fake = {
    Clutter: {Clone, AnimationMode: {}, Timeline: class { connect() {} start() {} }},
    GObject: {registerClass: c => c},
};
const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) return fake(`export default globalThis.__fake['${spec.slice(5)}'] ?? {};`);
    if (spec.endsWith('/ui/main.js')) return fake('export const uiGroup = {add_child() {}};');
    if (spec === './compat.js') return fake('export const glslEffectBase = () => class {}; export const fragmentHook = () => 0;');
    return next(spec, ctx);
}});

test('dock genie keeps the window\'s own opacity, also when interrupted', async () => {
    const {genie, stopGenies} = await import('../../shell/dock/dist/lib/genie.js');
    let cut = 0;
    const win = {opacity: 204, get_transformed_position: () => [0, 0], get_size: () => [800, 600], remove_all_transitions: () => cut++};
    const rect = {x: 0, y: 900, width: 48, height: 48};

    for (const reverse of [false, true]) {
        genie(win, rect, {reverse});
        assert.equal(win.opacity, 0);
        clones.at(-1).onStopped();
        assert.equal(win.opacity, 204);
    }

    cut = 0;
    genie(win, rect);
    genie(win, rect, {reverse: true});
    genie(win, rect);                                   // minimized again before the animation ended
    assert.equal(cut, 0);                               // a replaced genie leaves the window's animations alone
    assert.equal(win.opacity, 0);
    clones.at(-1).onStopped();
    assert.equal(win.opacity, 204);

    genie(win, rect);
    stopGenies();                                       // dock disabled mid-animation
    assert.equal(win.opacity, 204);
});
