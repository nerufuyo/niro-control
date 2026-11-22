import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createMacro, createPlayer, exportMacro, importMacro, normalizeAccelerator, playbackPlan, validateShortcut} from '../../shell/shared/macro.js';

const rec = (m, action = 'app.launch', args = {id: 'firefox'}, delayMs = 0) => m.record({action, args, delayMs});

test('record keeps a copy of semantic steps', () => {
    const m = createMacro();
    const args = {id: 'firefox'};
    assert.equal(m.record({action: 'app.launch', args, delayMs: 500}).ok, true);
    args.id = 'changed';
    assert.equal(m.steps()[0].args.id, 'firefox');
    assert.equal(m.record({action: 'bad id'}).ok, false);
    assert.equal(m.record({action: 'app.launch', delayMs: -1}).ok, false);
    assert.equal(m.record({action: 'app.launch', args: [1]}).ok, false);
});

test('sensitive steps are rejected', () => {
    const m = createMacro();
    assert.match(m.record({action: 'app.launch', args: {}, sensitive: true}).error, /sensitive/);
    assert.match(m.record({action: 'vault.unlock', args: {}}).error, /sensitive/);
    assert.match(m.record({action: 'login.fill', args: {password: 'x'}}).error, /password/);
    assert.match(m.record({action: 'note.add', args: {text: 'sk-abcdefghijklmnopqrstuvwx'}}).error, /credential/);
    assert.match(m.record({action: 'note.add', args: {nested: {apiKey: 'x'}}}).error, /apiKey/);
    assert.equal(m.length(), 0);
});

test('timeline editing', () => {
    const m = createMacro();
    rec(m, 'a.one'); rec(m, 'a.two'); rec(m, 'a.three');
    assert.equal(m.insert(1, {action: 'a.mid'}).ok, true);
    assert.deepEqual(m.steps().map(s => s.action), ['a.one', 'a.mid', 'a.two', 'a.three']);
    m.move(3, 0);
    assert.equal(m.steps()[0].action, 'a.three');
    m.remove(1);
    assert.equal(m.length(), 3);
    assert.equal(m.setDelay(0, 1500).ok, true);
    assert.equal(m.steps()[0].delayMs, 1500);
    assert.equal(m.setDelay(0, 999999).ok, false);
    assert.equal(m.remove(9).ok, false);
    assert.equal(m.move(0, 9).ok, false);
    assert.equal(m.insert(9, {action: 'a.x'}).ok, false);
});

test('step count is bounded', () => {
    const m = createMacro({maxSteps: 2});
    rec(m, 'a.one'); rec(m, 'a.two');
    assert.equal(rec(m, 'a.three').ok, false);
});

test('playback plan: loops, hard cap and total duration', () => {
    const m = createMacro();
    rec(m, 'a.one', {}, 1000); rec(m, 'a.two', {}, 500);
    const p = playbackPlan(m, {loops: 2, loopDelayMs: 100});
    assert.equal(p.ok, true);
    assert.deepEqual(p.steps.map(s => s.at), [1000, 1500, 2600, 3100]);
    assert.equal(p.totalMs, 3100);
    assert.equal(playbackPlan(m, {loops: 21}).ok, false);
    assert.equal(playbackPlan(m, {loops: 20}).ok, true);
    assert.equal(playbackPlan(m, {loops: 0}).ok, false);
    assert.equal(playbackPlan(m, {loops: 1.5}).ok, false);
    assert.match(playbackPlan(m, {loops: 20, maxTotalMs: 5000}).error, /exceed/);
    assert.equal(playbackPlan([], {}).ok, false);
});

test('a hard total cap holds even if a larger one is asked for', () => {
    const m = createMacro();
    for (let i = 0; i < 20; i++) m.record({action: 'a.one', delayMs: 60000});
    assert.equal(playbackPlan(m, {loops: 1, maxTotalMs: 1e12}).ok, false);
});

test('stop flag halts playback', () => {
    const m = createMacro();
    rec(m, 'a.one'); rec(m, 'a.two'); rec(m, 'a.three');
    const pl = createPlayer(playbackPlan(m));
    assert.equal(pl.next().action, 'a.one');
    pl.stop();
    assert.equal(pl.next(), null);
    assert.equal(pl.done(), true);
    assert.equal(createPlayer(playbackPlan([])).next(), null);
});

test('export and import validate every step', () => {
    const m = createMacro({name: 'Morning'});
    rec(m, 'app.launch', {id: 'firefox'}, 200);
    const text = exportMacro(m);
    const r = importMacro(text);
    assert.equal(r.ok, true);
    assert.equal(r.macro.name(), 'Morning');
    assert.deepEqual(r.macro.steps(), m.steps());
    assert.equal(importMacro('nope').ok, false);
    assert.equal(importMacro(JSON.stringify({version: 2, steps: []})).ok, false);
    const evil = JSON.stringify({version: 1, steps: [{action: 'app.launch', args: {id: 'x'}}, {action: 'note.add', args: {password: 'p'}}]});
    assert.match(importMacro(evil).error, /step 2/);
    assert.equal(importMacro(JSON.stringify({version: 1, steps: Array.from({length: 101}, () => ({action: 'a.b'}))})).ok, false);
    assert.equal(importMacro('x'.repeat(300000)).ok, false);
});

test('shortcut validation', () => {
    assert.equal(normalizeAccelerator('<Control><Alt>k'), 'Alt+Ctrl+K');
    assert.equal(normalizeAccelerator('ctrl+alt+k'), 'Alt+Ctrl+K');
    assert.equal(normalizeAccelerator('Ctrl+Alt+'), null);
    assert.equal(normalizeAccelerator('Ctrl+Foo'), null);
    assert.equal(validateShortcut('Ctrl+Alt+K').ok, true);
    assert.equal(validateShortcut('Super+L').ok, false);
    assert.equal(validateShortcut('<Alt>Tab').ok, false);
    assert.equal(validateShortcut('<Primary>c').ok, false);
    assert.match(validateShortcut('K').error, /modifier/);
    assert.match(validateShortcut('Ctrl+Alt+K', {taken: ['<Alt><Control>k']}).error, /already used/);
    assert.equal(validateShortcut(42).ok, false);
});
