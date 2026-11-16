// The Hyprland page's logic: what is written to niro.conf, read back, and the one line added to hyprland.conf.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {addSource, BY_KEY, changed, DEFS, format, hasSource, keywordArgs, parse, parseValue, PRESETS, removeSource, serialize, sourceLine} from '../../control/build/hyprland.js';

test('every setting is unique, in a known group, with a default that suits it', () => {
    assert.equal(new Set(DEFS.map(d => d.key)).size, DEFS.length);
    for (const d of DEFS) {
        assert.ok(parseValue(d, format(d, d.default)) !== undefined, d.key);
        if (d.kind === 'select') assert.ok(d.options.some(([v]) => v === String(d.default)), d.key);
    }
});

test('what is written is read back the same, and an unknown or broken line is skipped', () => {
    const values = {'decoration:rounding': 14, 'decoration:blur:enabled': false, 'general:layout': 'master', 'decoration:active_opacity': 0.85};
    const text = serialize(values);
    assert.deepEqual(parse(text), values);
    assert.deepEqual(parse('general:gaps_in = lots\nnonsense:key = 1\ndecoration:rounding = 9 # note\n\n'), {'decoration:rounding': 9});
    assert.deepEqual(parse('general:layout = floating'), {});
});

test('numbers are held to the range, and the file keeps the panel\'s order', () => {
    assert.equal(parseValue(BY_KEY.get('decoration:rounding'), '400'), 40);
    assert.equal(parseValue(BY_KEY.get('decoration:blur:size'), '0'), 1);
    const text = serialize({'misc:vfr': false, 'general:gaps_in': 2});
    assert.ok(text.indexOf('general:gaps_in') < text.indexOf('misc:vfr'));
});

test('a value equal to Hyprland\'s default is not worth writing', () => {
    assert.deepEqual(changed({'general:gaps_in': 5, 'general:gaps_out': 8, 'decoration:blur:enabled': true}), {'general:gaps_out': 8});
});

test('the presets name real settings with values that suit them', () => {
    for (const p of Object.values(PRESETS))
        for (const [k, v] of Object.entries(p.values)) assert.ok(parseValue(BY_KEY.get(k), format(BY_KEY.get(k), v)) !== undefined, k);
});

test('hyprland.conf gets one marked line, once, and only that line is ever removed', () => {
    const conf = '# my config\nmonitor=,preferred,auto,1\nsource = ~/.config/hypr/colors.conf\n';
    const added = addSource(conf, '~/.config/hypr/niro.conf');
    assert.ok(hasSource(added) && !hasSource(conf));
    assert.equal(addSource(added, '~/.config/hypr/niro.conf'), added);
    assert.equal(removeSource(added), conf);
    assert.equal(removeSource(conf), conf);
    assert.equal(addSource('', '/x/niro.conf'), `\n${sourceLine('/x/niro.conf')}\n`);
    assert.equal(addSource('no newline', '/x'), `no newline\n\n${sourceLine('/x')}\n`);
});

test('hyprctl is given the option and the value as Hyprland writes them', () => {
    assert.deepEqual(keywordArgs(BY_KEY.get('decoration:blur:enabled'), true), ['keyword', 'decoration:blur:enabled', 'true']);
    assert.deepEqual(keywordArgs(BY_KEY.get('decoration:active_opacity'), 0.8500001), ['keyword', 'decoration:active_opacity', '0.85']);
});
