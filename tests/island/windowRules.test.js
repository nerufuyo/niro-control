// Window rules engine (vNext S2): validation, priority, stop, dry-run trace, conflicts, loop guard, legacy conversion.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {activeProfileId, checkRules, createGuard, createOpacityControl, evaluate, findConflicts, fromLegacy, parseRules, pending, setsOpacity, usesProfile} from '../../shell/tile/windowRules.js';
import {parseRules as parseLegacy} from '../../shell/tile/config.js';

const rule = (id, conditions, actions, extra = {}) => ({id, conditions, actions, ...extra});
const win = (o = {}) => ({appIds: ['org.gnome.Calculator'], title: 'Calculator', workspace: 1, monitor: 0, type: 'normal', ...o});

test('validation says what is wrong, and invalid rules are dropped, not guessed at', () => {
    assert.deepEqual(checkRules([rule('a', {appId: 'x'}, {workspace: 2})]), []);
    assert.match(checkRules('nope')[0], /not JSON/);
    assert.match(checkRules('{}')[0], /not a list/);
    assert.match(checkRules([rule('a', {}, {workspace: 2})]).join(), /no condition/);
    assert.match(checkRules([rule('a', {appId: 'x'}, {})]).join(), /does nothing/);
    assert.match(checkRules([rule('a', {appId: 'x'}, {workspace: 99})]).join(), /1 to 36/);
    assert.match(checkRules([rule('a', {appId: 'x', bogus: 1}, {workspace: 2})]).join(), /unknown condition/);
    assert.match(checkRules([rule('a', {appId: 'x'}, {shell: 'rm -rf /'})]).join(), /unknown action "shell"/);
    assert.match(checkRules([rule('a', {appId: 'x'}, {tile: 'x'})]).join(), /float or tile/);
    assert.match(checkRules([rule('a', {time: {from: '25:00', to: '06:00'}}, {above: true})]).join(), /HH:MM/);
    assert.match(checkRules([rule('a', {appId: 'x'}, {workspace: 2}), rule('a', {appId: 'y'}, {workspace: 3})]).join(), /used twice/);
    assert.match(checkRules([rule('a', {title: '/(a+)+$/'}, {above: true})]).join(), /safe/);
    assert.equal(parseRules([rule('a', {appId: 'x'}, {workspace: 2}), rule('bad id!', {appId: 'x'}, {workspace: 2})]).length, 1);
});

test('priority orders rules, the first rule to set an action wins that action, others still add theirs', () => {
    const rules = parseRules([
        rule('low', {appId: 'org.gnome.Calculator'}, {workspace: 3, above: true}, {priority: 1}),
        rule('high', {appId: 'org.gnome.Calculator'}, {workspace: 2}, {priority: 10}),
    ]);
    assert.deepEqual(rules.map(r => r.id), ['high', 'low']);
    const r = evaluate(rules, win());
    assert.deepEqual(r.actions, {workspace: 2, above: true});
    assert.deepEqual(r.from, {workspace: 'high', above: 'low'});
});

test('stop ends the walk; later rules are traced as skipped', () => {
    const rules = parseRules([
        rule('first', {appId: 'org.gnome.Calculator'}, {tile: 'float'}, {priority: 5, stop: true}),
        rule('second', {appId: 'org.gnome.Calculator'}, {above: true}),
    ]);
    const r = evaluate(rules, win());
    assert.deepEqual(r.actions, {tile: 'float'});
    assert.match(r.trace[1].skipped, /stopped/);
});

test('conditions are ANDed; disabled rules do nothing and do not appear in the trace', () => {
    const rules = parseRules([
        rule('a', {appId: 'org.gnome.calculator', title: 'calc', workspace: 1}, {above: true}),
        rule('b', {appId: 'org.gnome.Calculator', workspace: 2}, {opacity: 0.5}),
        rule('c', {appId: 'org.gnome.Calculator'}, {tile: 'float'}, {enabled: false}),
    ]);
    const r = evaluate(rules, win());
    assert.deepEqual(r.actions, {above: true});
    assert.equal(r.trace.length, 2);
    assert.deepEqual(r.trace[1].why, [{key: 'appId', ok: true}, {key: 'workspace', ok: false}]);
});

test('title substring and a safe regex; a time range that crosses midnight; the active profile', () => {
    const t = (h, m) => ({now: new Date(2026, 0, 1, h, m)});
    const rules = parseRules([
        rule('re', {title: '/^Meeting \\d+$/i'}, {above: true}),
        rule('night', {appId: 'org.gnome.Calculator', time: {from: '22:00', to: '06:00'}}, {opacity: 0.8}),
        rule('prof', {appId: 'org.gnome.Calculator', profile: 'gaming'}, {workspace: 4}),
    ]);
    assert.deepEqual(evaluate(rules, win({title: 'meeting 42'}), {...t(23, 30), profile: 'gaming'}).actions, {above: true, opacity: 0.8, workspace: 4});
    assert.deepEqual(evaluate(rules, win({title: 'x'}), {...t(12, 0)}).actions, {});
    assert.deepEqual(evaluate(rules, win({title: 'x'}), {...t(5, 59)}).actions, {opacity: 0.8});
});

test('pending drops what the window already satisfies, so re-running is a no-op', () => {
    const w = win({workspace: 2, floating: true});
    assert.deepEqual(pending({workspace: 2, tile: 'float', above: true}, w), {above: true});
    assert.deepEqual(pending({workspace: 2, tile: 'float'}, w), {});
});

test('conflicts: overriding actions, and a rule shadowed by a stop rule; disjoint rules are fine', () => {
    const rules = parseRules([
        rule('a', {appId: 'firefox'}, {workspace: 2}, {priority: 2}),
        rule('b', {appId: 'Firefox'}, {workspace: 3}),
        rule('c', {appId: 'code'}, {workspace: 3}),
        rule('d', {appId: 'term'}, {tile: 'float'}, {priority: 9, stop: true}),
        rule('e', {appId: 'term'}, {above: true}),
    ]);
    const c = findConflicts(rules);
    assert.deepEqual(c.filter(x => x.kind === 'override').map(x => [x.a, x.b, x.key, x.certain]), [['a', 'b', 'workspace', true]]);
    assert.deepEqual(c.filter(x => x.kind === 'shadowed').map(x => [x.a, x.b]), [['d', 'e']]);
    assert.deepEqual(findConflicts(parseRules([rule('a', {appId: 'x'}, {workspace: 2}), rule('b', {appId: 'y'}, {workspace: 3})])), []);
});

test('the loop guard allows a few applications, then refuses, then recovers', () => {
    const g = createGuard({max: 2, windowMs: 1000});
    assert.equal(g.allow(1, 'r', 0), true);
    assert.equal(g.allow(1, 'r', 10), true);
    assert.equal(g.allow(1, 'r', 20), false);
    assert.equal(g.allow(2, 'r', 20), true);
    assert.equal(g.allow(1, 'r', 1500), true);
    g.forget(1);
    assert.equal(g.size(), 1);
    g.clear();
    assert.equal(g.size(), 0);
});

test('v1.5 rules keep their meaning', () => {
    const legacy = parseLegacy('[{"match":"org.gnome.Calculator","action":"float","workspace":2}]');
    const r = evaluate(parseRules(fromLegacy(legacy)), win());
    assert.deepEqual(r.actions, {tile: 'float', workspace: 2});
});

test('the profile condition matches the active profile read from the state file', () => {
    assert.equal(activeProfileId('{"active":"focus"}'), 'focus');
    assert.equal(activeProfileId(''), null);
    assert.equal(activeProfileId('not json'), null);
    assert.equal(activeProfileId('{"active":5}'), null);
    const rules = parseRules([{id: 'p', conditions: {profile: 'focus'}, actions: {opacity: 0.8}}]);
    assert.equal(usesProfile(rules), true);
    assert.equal(setsOpacity(rules), true);
    assert.deepEqual(evaluate(rules, win(), {profile: activeProfileId('{"active":"focus"}')}).actions, {opacity: 0.8});
    assert.deepEqual(evaluate(rules, win(), {profile: activeProfileId('{"active":"gaming"}')}).actions, {});
    assert.deepEqual(evaluate(rules, win(), {profile: activeProfileId('')}).actions, {});
    assert.equal(usesProfile(parseRules([{id: 'q', conditions: {appId: 'x'}, actions: {tile: 'float'}}])), false);
    assert.equal(usesProfile(parseRules([{id: 'q', enabled: false, conditions: {profile: 'x'}, actions: {tile: 'float'}}])), false);
});

test('opacity from a rule is applied bounded, restored when the rule stops matching, and on disable', () => {
    const a = {opacity: 255}, b = {opacity: 200}, gone = {};
    const actors = new Map([[gone, a]]);
    const ctl = createOpacityControl(w => actors.get(w) ?? null);
    const w1 = {}, w2 = {};
    actors.set(w1, a); actors.set(w2, b);
    ctl.apply(w1, 0.5);
    assert.equal(a.opacity, 128);
    ctl.apply(w1, 0.5);                       // again: nothing to remember twice
    assert.equal(ctl.size(), 1);
    ctl.apply(w1, undefined);                 // the rule stopped matching
    assert.equal(a.opacity, 255);
    assert.equal(ctl.size(), 0);
    ctl.apply(w2, 0.05);                      // out of bounds: ignored, nothing changed
    ctl.apply(w2, 1.5);
    ctl.apply(w2, 'x');
    assert.equal(b.opacity, 200);
    assert.equal(ctl.size(), 0);
    ctl.apply(w2, 0.1);
    assert.equal(b.opacity, 26);
    ctl.apply(w1, 1);
    assert.equal(a.opacity, 255);
    ctl.restoreAll();                         // disable: the window's own 200 is back
    assert.equal(b.opacity, 200);
    assert.equal(ctl.size(), 0);
    ctl.apply({}, 0.5);                       // a window with no actor (destroyed): no throw
    actors.set(w2, {get opacity() { return 1; }, set opacity(_v) { throw new Error('destroyed'); }});
    ctl.apply(w2, 0.5);
    ctl.restoreAll();
});

test('fullscreen is a boolean action: validated, evaluated, pending only when the window differs, and conflicts are seen', () => {
    assert.deepEqual(checkRules([rule('f', {appId: 'x'}, {fullscreen: true})]), []);
    assert.match(checkRules([rule('f', {appId: 'x'}, {fullscreen: 'yes'})]).join(), /fullscreen must be true or false/);
    assert.match(checkRules([rule('f', {appId: 'x'}, {fullscreen: 1})]).join(), /fullscreen must be true or false/);
    const rules = parseRules([rule('f', {appId: 'org.gnome.Calculator'}, {fullscreen: true, workspace: 2})]);
    const r = evaluate(rules, win());
    assert.deepEqual(r.actions, {fullscreen: true, workspace: 2});
    assert.deepEqual(pending(r.actions, win({workspace: 1, fullscreen: false})), {fullscreen: true, workspace: 2});
    assert.deepEqual(pending(r.actions, win({workspace: 2, fullscreen: true})), {});
    assert.deepEqual(pending({fullscreen: false}, win({fullscreen: true})), {fullscreen: false});
    const c = findConflicts(parseRules([
        rule('a', {appId: 'term'}, {fullscreen: true}, {priority: 2}),
        rule('b', {appId: 'term'}, {fullscreen: false}),
    ]));
    assert.deepEqual(c.map(x => [x.kind, x.a, x.b, x.key, x.certain]), [['override', 'a', 'b', 'fullscreen', true]]);
});

test('applying twice is a no-op: after the actions are done, nothing is pending; the guard bounds a rule that keeps firing', () => {
    const rules = parseRules([rule('f', {appId: 'org.gnome.Calculator'}, {fullscreen: true, workspace: 2, tile: 'float', above: true})]);
    const w = win({workspace: 1, floating: false, above: false, fullscreen: false});
    const first = pending(evaluate(rules, w).actions, w);
    assert.deepEqual(Object.keys(first).sort(), ['above', 'fullscreen', 'tile', 'workspace']);
    const done = {...w, workspace: 2, floating: true, above: true, fullscreen: true};
    assert.deepEqual(pending(evaluate(rules, done).actions, done), {});
    const g = createGuard({max: 3, windowMs: 10000});
    assert.deepEqual([1, 2, 3, 4].map(i => g.allow(7, 'f', i)), [true, true, true, false]);
});
