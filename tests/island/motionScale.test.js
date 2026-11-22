// Motion Studio (3) for the island: scaleDuration in shared/tokens.js, and the island's motion.ts on top of it with a fake clock of
// settings changes. 'default' changes nothing; a preset scales; 'off' and reduced motion give 0; cleanup disconnects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {scaleDuration, MOTION_PRESETS, MOTION_REFERENCE_MS} from '../../shell/shared/tokens.js';

test('default and empty leave every hard-coded duration exactly as it was, even with reduced motion', () => {
    for (const preset of [undefined, '', 'default'])
        for (const ms of [1, 120, 260, 360])
            assert.equal(scaleDuration(ms, {preset, reduced: true}), ms);
    assert.equal(scaleDuration(200), 200);
});

test('a preset scales by its normal duration over the smooth one; smooth is identity', () => {
    assert.equal(MOTION_REFERENCE_MS, MOTION_PRESETS.smooth.normal);
    assert.equal(scaleDuration(260, {preset: 'smooth'}), 260);
    assert.equal(scaleDuration(200, {preset: 'minimal'}), 120);
    assert.equal(scaleDuration(200, {preset: 'cinematic'}), 400);
    assert.ok(scaleDuration(1, {preset: 'minimal'}) >= 1);          // a real animation never rounds to nothing
    assert.equal(scaleDuration(200, {preset: 'unknown'}), 200);     // an unknown name is not a surprise
});

test('off, and reduced motion with a preset chosen, give 0; bad input gives 0', () => {
    assert.equal(scaleDuration(260, {preset: 'off'}), 0);
    assert.equal(scaleDuration(260, {preset: 'dynamic', reduced: true}), 0);
    for (const bad of [0, -5, NaN, null, undefined, 'x'])
        assert.equal(scaleDuration(bad, {preset: 'smooth'}), 0);
});

import {readFileSync} from 'node:fs';
import {motionAllowed} from '../../shell/shared/tokens.js';

test('motionAllowed: off and reduced stop loops; default and empty equal the plain animations check', () => {
    assert.equal(motionAllowed({preset: 'off'}), false);
    assert.equal(motionAllowed({preset: 'off', reduced: false}), false);
    for (const preset of [undefined, '', 'default', 'smooth', 'cinematic']) {
        assert.equal(motionAllowed({preset, reduced: true}), false);
        assert.equal(motionAllowed({preset, reduced: false}), true);
    }
    assert.equal(motionAllowed(), true);
});

test('default keeps every extended duration byte for byte; off zeroes them', () => {
    // The auto-hide slide, bar slide, voice and chat fades that now go through dur().
    for (const ms of [220, 320, 80, 240, 260, 200, 60, 180, 600])
        for (const reduced of [false, true]) {
            assert.equal(scaleDuration(ms, {preset: 'default', reduced}), ms);
            assert.equal(scaleDuration(ms, {preset: 'off', reduced}), 0);
        }
});

test('the extended sites go through dur()/motionOn() and no raw animations gate is left outside motion.ts', () => {
    const src = f => readFileSync(new URL(`../../shell/island/src/${f}`, import.meta.url), 'utf8');
    assert.match(src('barHider.ts'), /duration: dur\(220\)/);
    assert.match(src('island.ts'), /dur\(hidden \? AUTO_HIDE_UP : AUTO_HIDE_DOWN\)/);
    assert.match(src('island.ts'), /mapped && motionOn\(\)/);          // the breath
    assert.match(src('pages/lyrics.ts'), /motionOn\(\)/);              // the endless dots
    assert.match(src('voice.ts'), /dur\(FADE_IN_MS\)/);
    assert.match(src('chat.ts'), /dur\(320\)/);
    for (const f of ['island.ts', 'voice.ts', 'chat.ts', 'compact.ts', 'expanded.ts', 'widgets.ts', 'botIcon.ts', 'slimeView.ts', 'pages/lyrics.ts'])
        assert.doesNotMatch(src(f), /St\.Settings\.get\(\)\.enable_animations/, f);
});
