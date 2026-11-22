// Context engine core (vNext 11, 15): suggestion-first, hysteresis, lock, override, cooldown, sources, history.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildSnapshot, createContextEngine, HISTORY_MAX, matches, validateRule} from '../../shell/shared/contextEngine.js';

const clock = (t = 1000000) => { const c = {t, now: () => c.t, tick(ms) { c.t += ms; }}; return c; };
const code = {id: 'code', priority: 20, conditions: {apps: ['code']}, action: {type: 'profile.apply', profile: 'deep-work'}, confidence: 0.8, cooldownMs: 60000};
const low = {id: 'low', priority: 10, conditions: {batteryBelow: 20, onAc: false}, action: {type: 'profile.apply', profile: 'saver'}, confidence: 0.9, release: 5, cooldownMs: 0};
const mk = (rules, c = clock(), o = {}) => ({c, e: createContextEngine({rules, now: c.now, ...o})});

test('snapshot normalises bad input and a disabled source becomes unknown', () => {
    const s = buildSnapshot({app: ' Code ', battery: 140, minute: -10, online: 'yes', workspace: 2});
    assert.equal(s.app, 'code'); assert.equal(s.battery, 100); assert.equal(s.minute, 1430); assert.equal(s.online, null);
    assert.equal(buildSnapshot({app: 'x', battery: 50}, ['app']).battery, null);
    assert.equal(buildSnapshot({time: new Date(2026, 0, 1, 9, 30)}).minute, 570);
});

test('rule validation rejects unknown conditions and actions other than profile.apply', () => {
    assert.deepEqual(validateRule(code), []);
    assert.ok(validateRule({...code, action: {type: 'shell', cmd: 'rm'}}).length);
    assert.ok(validateRule({...code, conditions: {exec: 'x'}}).some(p => /unknown condition/.test(p)));
    assert.ok(validateRule({...code, confidence: 2}).length);
    assert.ok(validateRule({...code, conditions: {}}).length);
    const {e} = mk([code, {...code, action: {type: 'x'}}]);
    assert.equal(e.rejected.length, 1);
});

test('a suggestion needs N consecutive evaluations, is explained and never auto-applies', () => {
    const {e, c} = mk([code]);
    let r = e.evaluate({app: 'code'});
    assert.equal(r.decision, null); assert.match(r.suppressed[0].reason, /waiting/);
    c.tick(1000);
    r = e.evaluate({app: 'code'});
    assert.equal(r.decision.action.profile, 'deep-work');
    assert.equal(r.decision.autoApply, false);
    assert.match(r.decision.explanation, /code is in front.*nothing was applied/);
    c.tick(1000);
    assert.equal(e.evaluate({app: 'code'}).decision, null, 'not repeated while it stays true');
});

test('a flapping signal never produces a suggestion (no profile switching loop)', () => {
    const {e, c} = mk([code]);
    for (let i = 0; i < 40; i++) {
        c.tick(500);
        assert.equal(e.evaluate({app: i % 2 ? 'code' : 'firefox'}).decision, null);
    }
    assert.equal(e.history().length, 0);
});

test('a suggestion that was accepted is not suggested again, even if the signal flaps afterwards', () => {
    const {e, c} = mk([code]);
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.ok(e.evaluate({app: 'code'}).decision);
    e.recordOutcome('code', 'accepted');
    for (let i = 0; i < 10; i++) {
        c.tick(1000);
        assert.equal(e.evaluate({app: i % 2 ? 'code' : 'firefox'}, {current: 'deep-work'}).decision, null);
    }
});

test('cooldown holds a rule back after it released and came back', () => {
    const {e, c} = mk([code]);
    e.evaluate({app: 'code'}); c.tick(1000); assert.ok(e.evaluate({app: 'code'}).decision);
    e.evaluate({app: 'firefox'});
    c.tick(1000); e.evaluate({app: 'code'}); c.tick(1000);
    let r = e.evaluate({app: 'code'});
    assert.equal(r.decision, null); assert.equal(r.suppressed[0].reason, 'cooldown');
    e.evaluate({app: 'firefox'});
    c.tick(61000); e.evaluate({app: 'code'}); c.tick(1000);
    assert.ok(e.evaluate({app: 'code'}).decision);
});

test('dwell time must pass in addition to the evaluation count', () => {
    const {e, c} = mk([{...code, dwellMs: 5000}]);
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.equal(e.evaluate({app: 'code'}).decision, null);
    c.tick(4000);
    assert.ok(e.evaluate({app: 'code'}).decision);
});

test('battery hysteresis: hovering around the threshold does not release or re-arm the rule', () => {
    const {e, c} = mk([low]);
    const ev = b => { c.tick(1000); return e.evaluate({battery: b, onAc: false}); };
    ev(19);
    assert.ok(ev(18).decision, 'enters below 20');
    for (const b of [21, 22, 20, 24, 19, 23]) assert.equal(ev(b).decision, null, `battery ${b}`);
    assert.equal(matches(low.conditions, {battery: 22, onAc: false}, {held: true, release: 5}), true);
    assert.equal(matches(low.conditions, {battery: 22, onAc: false}), false);
    ev(26); ev(19);
    assert.ok(ev(19).decision, 'released above 25, so it can speak again');
});

test('a locked mode produces no suggestions and unlocking restores them', () => {
    const {e, c} = mk([code]);
    e.setMode('presentation', {lock: true});
    assert.equal(e.isLocked(), true);
    for (let i = 0; i < 4; i++) { c.tick(1000); const r = e.evaluate({app: 'code'}); assert.equal(r.decision, null); assert.equal(r.suppressed[0].reason, 'mode is locked'); }
    e.unlock();
    c.tick(1000);
    assert.ok(e.evaluate({app: 'code'}).decision);
});

test('a manual override silences suggestions until it expires or is cleared', () => {
    const {e, c} = mk([code]);
    e.setOverride('gaming', 10000);
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.equal(e.evaluate({app: 'code'}).suppressed[0].reason, 'manual override is active');
    c.tick(10000);
    assert.ok(e.evaluate({app: 'code'}).decision, 'expired');
    e.setOverride('gaming', null);
    e.resetState();
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.equal(e.evaluate({app: 'code'}).decision, null);
    e.clearOverride(); e.resetState();
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.ok(e.evaluate({app: 'code'}).decision);
});

test('a disabled source silences the rules that need it and can be turned back on', () => {
    const {e, c} = mk([code, low], clock(), {enabledSources: ['power']});
    e.evaluate({app: 'code', battery: 10, onAc: false}); c.tick(1000);
    const r = e.evaluate({app: 'code', battery: 10, onAc: false});
    assert.equal(r.snapshot.app, null);
    assert.equal(r.decision.ruleId, 'low');
    assert.ok(r.suppressed.some(s => s.ruleId === 'code' && /source "app" is off/.test(s.reason)));
    e.setSourceEnabled('power', false);
    c.tick(1000);
    assert.equal(e.evaluate({battery: 10, onAc: false}).decision, null);
    assert.throws(() => e.setSourceEnabled('gps', true), /unknown source/);
});

test('minimum confidence, priority order and an already-active profile', () => {
    const {e, c} = mk([{...code, confidence: 0.3}]);
    e.evaluate({app: 'code'}); c.tick(1000);
    assert.equal(e.evaluate({app: 'code'}).suppressed[0].reason, 'confidence below minimum');
    const both = mk([code, {...code, id: 'hi', priority: 99, action: {type: 'profile.apply', profile: 'creative'}}]);
    both.e.evaluate({app: 'code'}); both.c.tick(1000);
    const r = both.e.evaluate({app: 'code'});
    assert.deepEqual(r.suggestions.map(s => s.ruleId), ['hi', 'code']);
    assert.equal(r.decision.ruleId, 'hi');
    const {e: e2, c: c2} = mk([code]);
    e2.evaluate({app: 'code'}, {current: 'deep-work'}); c2.tick(1000);
    assert.equal(e2.evaluate({app: 'code'}, {current: 'deep-work'}).suppressed[0].reason, 'profile already active');
});

test('conditions: time over midnight, monitors, online, calendar busy, mode', () => {
    const s = buildSnapshot({minute: 30, monitors: 2, online: false, busy: true, mode: 'focus'});
    assert.equal(matches({between: [1380, 360]}, s), true);
    assert.equal(matches({between: [360, 1380]}, s), false);
    assert.equal(matches({monitorsAtLeast: 2, monitorsAtMost: 2, online: false, busy: true, mode: 'focus'}, s), true);
    assert.equal(matches({monitorsAtLeast: 3}, s), false);
    assert.equal(matches({apps: ['x']}, s), false);
});

test('history is metadata only, bounded and clearable', () => {
    const {e, c} = mk([{...code, cooldownMs: 0}]);
    e.evaluate({app: 'code', title: 'secret doc'}); c.tick(1000);
    e.evaluate({app: 'code'});
    e.recordOutcome('code', 'dismissed');
    assert.throws(() => e.recordOutcome('code', 'maybe'));
    const h = e.history();
    assert.deepEqual(h.map(x => x.outcome), ['suggested', 'dismissed']);
    assert.ok(!JSON.stringify(h).includes('secret'));
    for (let i = 0; i < HISTORY_MAX + 50; i++) e.recordOutcome('code', 'accepted');
    assert.equal(e.history().length, HISTORY_MAX);
    e.clearHistory();
    assert.deepEqual(e.history(), []);
});
