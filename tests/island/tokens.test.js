// Motion and colour tokens (vNext S5).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {COLOR_TOKENS, MOTION_PRESETS, buildPalette, contrast, createMotion, ensureContrast} from '../../shell/shared/tokens.js';

test('durations follow the preset; reduced motion and per-component off give zero; unknown input is safe', () => {
    assert.equal(createMotion({preset: 'minimal'}).duration('normal', 'dock'), MOTION_PRESETS.minimal.normal);
    assert.equal(createMotion({preset: 'nope'}).duration('fast', 'dock'), MOTION_PRESETS.smooth.fast);
    assert.equal(createMotion({reduced: true}).duration('normal', 'dock'), 0);
    const m = createMotion({off: ['island']});
    assert.equal(m.duration('slow', 'island'), 0);
    assert.ok(m.duration('slow', 'dock') > 0);
    assert.equal(m.duration('easing', 'dock'), 0);
    assert.equal(m.duration('bogus', 'dock'), 0);
    assert.equal(createMotion({preset: 'smooth', scale: 100}).duration('normal', 'x'), 400);
    assert.equal(createMotion({reduced: true}).spring('dock').animated, false);
});

test('presets get slower from minimal to cinematic', () => {
    const d = ['minimal', 'smooth', 'dynamic', 'cinematic'].map(p => MOTION_PRESETS[p].normal);
    assert.deepEqual(d, [...d].sort((a, b) => a - b));
});

test('contrast is the WCAG ratio, and ensureContrast fixes a pale accent on white', () => {
    assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
    assert.equal(contrast('#ffffff', '#ffffff'), 1);
    assert.equal(contrast('red', '#fff'), null);
    const fixed = ensureContrast('#ffe066', '#fafafa');
    assert.ok(contrast(fixed, '#fafafa') >= 4.5);
    assert.equal(ensureContrast('#1b1b1b', '#fafafa'), '#1b1b1b');
    assert.equal(ensureContrast('nope', '#fff'), null);
});

test('every palette token is present and readable in light and dark', () => {
    for (const dark of [false, true]) {
        const p = buildPalette('#ffe066', dark);
        for (const t of COLOR_TOKENS)
            assert.ok(t in p && p[t], `${t} missing`);
        for (const t of ['foreground', 'muted', 'primary', 'secondary', 'danger', 'success', 'warning'])
            assert.ok(contrast(p[t], p.surface) >= 4.5, `${t} (${dark ? 'dark' : 'light'}) unreadable`);
        assert.ok(contrast(p.accent, p.surface) >= 3);
    }
    assert.equal(buildPalette('blue', false), null);
});

import {deriveAccent, contrast as wcag} from '../../shell/shared/tokens.js';

test('deriveAccent: the default accent and tint give exactly the strings the stylesheets always had', () => {
    const d = deriveAccent('#E8472B', '#1C1C1E');
    assert.deepEqual(d, {fill: '#E8472B', onFill: '#ffffff', onDark: '#E8472B', indicator: '#E8472B'});
});

test('deriveAccent: a light accent gets dark text and everything derived reads', () => {
    for (const accent of ['#ffee00', '#ffffff', '#f5f5f5', '#00ffcc']) {
        const d = deriveAccent(accent, '#ffffff');
        assert.ok(wcag(d.onFill, accent) >= 3, `${accent} text`);
        assert.ok(wcag(d.indicator, '#ffffff') >= 3, `${accent} indicator on a light tint`);
        assert.ok(wcag(d.onDark, '#121212') >= 3, `${accent} on dark`);
    }
    assert.equal(deriveAccent('#ffee00').onFill, '#111111');
    assert.ok(wcag(deriveAccent('#202040', '#1c1c1e').onDark, '#121212') >= 3);   // a dark accent is lifted as text
});

test('deriveAccent: not a colour gives null (callers keep what they had)', () => {
    for (const bad of ['', 'red', '#fff', null, undefined, '#12345g'])
        assert.equal(deriveAccent(bad), null);
    assert.equal(deriveAccent('#E8472B', 'nonsense').indicator, '#E8472B');
});
