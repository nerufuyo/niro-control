// The panel's layers: the opacity of the glass must never reach the foreground, and text must stay readable over any wallpaper.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {contrast, glassAlpha, stylesheet, textContrast, tokens} from '../../control/build/appearanceTokens.js';

const WALLPAPERS = {black: [0, 0, 0], white: [255, 255, 255], mid: [128, 128, 128], red: [220, 40, 40], sky: [120, 180, 240]};
const OPACITIES = [0, 20, 50, 80, 100];

test('glass alpha follows Look opacity, monotonic, 80 is half and 100 is solid', () => {
    const a = OPACITIES.map(glassAlpha);
    assert.deepEqual(a, [...a].sort((x, y) => x - y));
    assert.equal(glassAlpha(80), 0.5);
    assert.equal(glassAlpha(100), 1);
    assert.ok(glassAlpha(0) >= 0.2);
    assert.equal(glassAlpha(NaN), 0.5);
});

test('only the glass changes with opacity: every surface and foreground token is identical at 0 and 100', () => {
    for (const scheme of ['dark', 'light']) {
        const lo = tokens(scheme, 0), hi = tokens(scheme, 100);
        for (const key of Object.keys(lo)) {
            if (key === 'glass') assert.notDeepEqual(lo.glass.a, hi.glass.a);
            else assert.deepEqual(lo[key], hi[key], `${scheme}.${key} must not follow the glass`);
        }
    }
});

test('the stylesheet: foreground colours carry no opacity property, libadwaita dimming is replaced by colour', () => {
    for (const scheme of ['dark', 'light']) {
        const css = stylesheet(scheme, 30, '#1E1E1E');
        assert.match(css, /\.dim-label[^}]*opacity: 1;[^}]*color: @niro_text_2/);
        assert.match(css, /@define-color window_fg_color @niro_text_1/);
        // nothing sets `opacity:` on a container except the reset to 1
        assert.deepEqual([...css.matchAll(/opacity: ([^;]+);/g)].map(m => m[1]).filter(v => v !== '1'), []);
    }
    // the only thing in the stylesheet that depends on the opacity is the glass colour
    const strip = css => css.replace(/@define-color niro_glass [^;]+;/, '');
    assert.equal(strip(stylesheet('dark', 10)), strip(stylesheet('dark', 100)));
});

test('contrast: primary and secondary text reach WCAG AA on content and group surfaces over every wallpaper and opacity', () => {
    for (const scheme of ['dark', 'light']) {
        for (const o of OPACITIES) for (const [name, w] of Object.entries(WALLPAPERS)) {
            const t = tokens(scheme, o);
            for (const where of ['group', 'content']) {
                assert.ok(textContrast(t, 'text1', w, where) >= 4.5, `${scheme} ${o}% ${name} ${where} primary ${textContrast(t, 'text1', w, where).toFixed(2)}`);
                assert.ok(textContrast(t, 'text2', w, where) >= 4.5, `${scheme} ${o}% ${name} ${where} secondary ${textContrast(t, 'text2', w, where).toFixed(2)}`);
                assert.ok(textContrast(t, 'text3', w, where) >= 3, `${scheme} ${o}% ${name} ${where} tertiary ${textContrast(t, 'text3', w, where).toFixed(2)}`);
            }
            // the sidebar is the most see-through surface: its labels still reach AA
            assert.ok(textContrast(t, 'text1', w, 'sidebar') >= 4.5, `${scheme} ${o}% ${name} sidebar ${textContrast(t, 'text1', w, 'sidebar').toFixed(2)}`);
        }
    }
});

test('the dark tint is used for the glass only when it is dark; a light tint falls back', () => {
    assert.deepEqual(tokens('dark', 80, '#101820').glass.rgb, [16, 24, 32]);
    assert.deepEqual(tokens('dark', 80, '#FFFFFF').glass.rgb, [20, 20, 24]);
    assert.deepEqual(tokens('dark', 80, 'nonsense').glass.rgb, [20, 20, 24]);
    assert.deepEqual(tokens('light', 80, '#101820').glass.rgb, [244, 244, 248]);
});

test('contrast helper: black on white is 21', () => assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21));

import {FLOORS} from '../../control/build/appearance.js';
test('even at the lowest allowed surface solidity, text reaches AA over black, white and mid wallpapers at every glass opacity', () => {
    const floor = {sidebar: FLOORS.sidebar, content: FLOORS.content, elevated: FLOORS.elevated};
    for (const scheme of ['dark', 'light']) for (const o of OPACITIES) for (const [name, w] of Object.entries(WALLPAPERS)) {
        const t = tokens(scheme, o, undefined, floor);
        for (const where of ['group', 'content', 'sidebar']) for (const text of ['text1', 'text2'])
            assert.ok(textContrast(t, text, w, where) >= 4.5, `${scheme} ${o}% ${name} ${where} ${text} ${textContrast(t, text, w, where).toFixed(2)}`);
    }
});
