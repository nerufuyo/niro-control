// The tiling's data: layout map, rules, and the nearest window in a direction.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {checkLayoutMap, checkRules, matchRule, neighbor, parseLayoutMap, parseRules, resolveLayout, withLayout, withoutLayout} from '../../shell/tile/config.js';
import {arrange} from '../../shell/tile/layouts.js';

test('a layout map: workspace beats monitor beats the general layout; junk is dropped', () => {
    const map = parseLayoutMap('{"workspaces":{"2":"grid","x":"grid","3":"nope"},"monitors":{"1":"monocle"}}');
    assert.deepEqual(map, {workspaces: {2: 'grid'}, monitors: {1: 'monocle'}});
    assert.equal(resolveLayout(map, 1, 0, 'dwindle'), 'grid');       // workspace 2 (index 1)
    assert.equal(resolveLayout(map, 0, 1, 'dwindle'), 'monocle');    // workspace 1, monitor 1
    assert.equal(resolveLayout(map, 0, 0, 'dwindle'), 'dwindle');
    assert.equal(resolveLayout(map, 1, 1, 'dwindle'), 'grid');
    assert.deepEqual(parseLayoutMap('not json'), {workspaces: {}, monitors: {}});
    assert.deepEqual(parseLayoutMap('[]'), {workspaces: {}, monitors: {}});
});

test('setting and clearing a layout does not change the map it was given', () => {
    const map = parseLayoutMap('{}');
    const a = withLayout(map, 'grid', {workspace: 0});
    assert.deepEqual(a.workspaces, {1: 'grid'});
    assert.deepEqual(map.workspaces, {});
    assert.deepEqual(withLayout(a, 'monocle', {monitor: 1}).monitors, {1: 'monocle'});
    assert.deepEqual(withoutLayout(a, {workspace: 0}).workspaces, {});
});

test('the checks say what is wrong, in words', () => {
    assert.deepEqual(checkLayoutMap('{"workspaces":{"1":"grid"}}'), []);
    assert.match(checkLayoutMap('{"workspaces":{"a":"grid"}}')[0], /not a number/);
    assert.match(checkLayoutMap('{"monitors":{"0":"zig"}}')[0], /not a layout/);
    assert.match(checkLayoutMap('{')[0], /not JSON/);
    assert.deepEqual(checkRules('[{"match":"a","action":"float"},{"match":"b","workspace":2}]'), []);
    assert.equal(checkRules('[{"action":"float"},{"match":"x"},{"match":"y","action":"hover"},{"match":"z","workspace":99}]').length, 4);
});

test('rules: parsed, junk dropped, matched without regard to case', () => {
    const rules = parseRules('[{"match":" Calc ","action":"float"},{"match":"","action":"float"},{"match":"ff","workspace":2},{"nope":1}]');
    assert.deepEqual(rules, [{match: 'Calc', action: 'float'}, {match: 'ff', workspace: 2}]);
    assert.equal(matchRule(rules, [null, 'calc']).action, 'float');
    assert.equal(matchRule(rules, ['FF']).workspace, 2);
    assert.equal(matchRule(rules, ['other']), null);
});

test('the nearest window in a direction, on a real layout', () => {
    const area = {x: 0, y: 0, width: 2000, height: 1000};
    const r = arrange('master-left', 3, area, {gapInner: 10, gapOuter: 10});   // 0 is the master; 1 above 2 on the right
    assert.equal(neighbor(r, 0, 'right'), 1);
    assert.equal(neighbor(r, 1, 'down'), 2);
    assert.equal(neighbor(r, 2, 'up'), 1);
    assert.equal(neighbor(r, 2, 'left'), 0);
    assert.equal(neighbor(r, 0, 'left'), -1);
    assert.equal(neighbor(r, 1, 'up'), -1);
    const g = arrange('grid', 4, area, {gapInner: 10, gapOuter: 10});
    assert.equal(neighbor(g, 0, 'right'), 1);
    assert.equal(neighbor(g, 0, 'down'), 2);
    assert.equal(neighbor(g, 3, 'left'), 2);
});
