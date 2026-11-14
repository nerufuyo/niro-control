// Universal Appearance: presets, safety, per-application rules, the compatibility matrix.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {classify, detectPreset, effective, FAMILIES, FLOORS, parseRules, PRESETS, serializeRules, setRule, windowEffect} from '../../control/build/appearance.js';

test('presets are recognised, anything else is custom', () => {
    for (const [name, v] of Object.entries(PRESETS)) assert.equal(detectPreset(v), name);
    assert.equal(detectPreset({...PRESETS.balanced, opacity: 81}), 'custom');
    assert.equal(detectPreset({}), 'custom');
});

test('every preset stays above the readability floors', () => {
    for (const [name, v] of Object.entries(PRESETS)) {
        assert.ok(v['sidebar-opacity'] >= FLOORS.sidebar && v['content-opacity'] >= FLOORS.content && v['elevated-opacity'] >= FLOORS.elevated, name);
    }
    assert.equal(PRESETS.solid.blur, false);
    assert.equal(PRESETS.performance['performance-mode'], true);
});

test('effective: floors, performance mode, high contrast and safe mode make things more solid, never less', () => {
    const off = {safeMode: false, highContrast: false};
    assert.deepEqual(effective(PRESETS.balanced, off).reasons, []);
    // a value below the floor (hand-edited dconf) is lifted
    const low = effective({...PRESETS.balanced, 'content-opacity': 10, 'sidebar-opacity': 0, 'elevated-opacity': 5}, off);
    assert.deepEqual([low.sidebar, low.content, low.elevated], [FLOORS.sidebar, FLOORS.content, FLOORS.elevated]);
    const perf = effective({...PRESETS.crystal, 'performance-mode': true}, off);
    assert.equal(perf.blur, false);
    assert.ok(perf.content >= 90);
    for (const safety of [{safeMode: true, highContrast: false}, {safeMode: false, highContrast: true}]) {
        const e = effective(PRESETS.crystal, safety);
        assert.deepEqual([e.glass, e.sidebar, e.content, e.elevated, e.blur], [100, 100, 100, 100, false]);
        assert.ok(e.reasons.length === 1);
    }
    assert.equal(effective({...PRESETS.balanced, opacity: NaN}, off).glass, 0);
});

test('rules: only valid ones survive, keyed by application id', () => {
    const r = parseRules(JSON.stringify({'org.gnome.Nautilus': {mode: 'exclude'}, chrome: {mode: 'fade', opacity: 5}, 'bad id!': {mode: 'exclude'}, x: {mode: 'weird'}, y: 7, z: {mode: 'inherit', blur: false}}));
    assert.deepEqual(Object.keys(r).sort(), ['chrome', 'org.gnome.Nautilus', 'z']);
    assert.equal(r.chrome.opacity, 20);                 // clamped
    assert.deepEqual(parseRules('not json'), {});
    assert.deepEqual(parseRules('[1,2]'), {});
    assert.deepEqual(parseRules(serializeRules(r)), r);
    assert.deepEqual(setRule({}, 'a', {mode: 'inherit'}), {});                       // inherit is the absence of a rule
    assert.deepEqual(Object.keys(setRule(r, 'chrome', null)).sort(), ['org.gnome.Nautilus', 'z']);
});

test('windowEffect: no fade by default, exclusion wins, safe mode and the global switch switch effects off', () => {
    const on = {universal: true, safeMode: false, thirdParty: false, blurOn: true};
    assert.deepEqual(windowEffect('any.app', {}, on), {blur: true, fade: null, excluded: false});
    assert.equal(windowEffect('a', {a: {mode: 'exclude'}}, on).excluded, true);
    assert.equal(windowEffect('a', {a: {mode: 'fade', opacity: 70}}, on).fade, null);               // not without the global allowance
    assert.equal(windowEffect('a', {a: {mode: 'fade', opacity: 70}}, {...on, thirdParty: true}).fade, 70);
    assert.equal(windowEffect('a', {a: {mode: 'inherit', blur: false}}, on).blur, false);
    assert.equal(windowEffect('a', {a: {mode: 'fade', opacity: 70}}, {...on, safeMode: true}).fade, null);
    assert.equal(windowEffect('a', {}, {...on, universal: false}).excluded, true);
    assert.equal(windowEffect('a', {}, {...on, blurOn: false}).blur, false);
});

test('matrix: nothing is called supported on a toolkit alone, every entry says what it cannot do', () => {
    for (const f of FAMILIES) assert.ok(f.how && f.limit && f.evidence, f.id);
    assert.equal(classify('org.gnome.Nautilus').status, 'theme');
    assert.equal(classify('google-chrome').status, 'compositor');
    assert.equal(classify('code', '/usr/share/code/code --unity-launch').id, 'electron');
    assert.equal(classify('org.kde.dolphin').status, 'unsupported');
    assert.equal(classify('org.niro.Control').status, 'native');
    assert.equal(classify('com.example.Unknown'), null);
    // only what was actually looked at is "tested"
    assert.deepEqual(FAMILIES.filter(f => f.evidence === 'tested').map(f => f.id), ['niro']);
});
