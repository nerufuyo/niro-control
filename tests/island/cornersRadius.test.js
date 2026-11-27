// The clip radius is limited to half the smaller side of the window. GNOME is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const fake = src => ({url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true});
registerHooks({resolve(spec, ctx, next) {
    if (spec === 'gi://GObject') return fake('export default {registerClass: (_meta, cls) => cls};');
    if (spec === './glsl_effect.js') return fake(`export const FRAGMENT = 0; export class GLSLEffect {
        sent = {}; actor = {get_width: () => 100, get_height: () => 40};
        get_uniform_location(name) { return name; } set_uniform_float(name, _n, v) { this.sent[name] = v; } queue_repaint() {} }`);
    if (spec.endsWith('/file.js')) return fake('export const readShader = () => ["", ""];');
    if (spec.endsWith('/settings.js')) return fake('export const getPref = () => 0;');
    return next(spec, ctx);
}});

test('a radius too big for the window is clamped to half its smaller side', async () => {
    const {RoundedCornersEffect} = await import('../../shell/corners/effect/rounded_corners_effect.js');
    const effect = new RoundedCornersEffect();
    const radius = (borderRadius, height) => {
        effect.updateUniforms(1, {borderRadius, smoothing: 0, padding: {left: 0, top: 0, right: 0, bottom: 0}},
            {x1: 0, y1: 0, x2: 100, y2: height});
        return effect.sent.clipRadius[0];
    };
    assert.equal(radius(12, 40), 12);
    assert.equal(radius(50, 40), 20);
    assert.equal(effect.sent.exponent[0], 2 * 20 / 50);
    assert.equal(radius(50, 0), 0);
});
