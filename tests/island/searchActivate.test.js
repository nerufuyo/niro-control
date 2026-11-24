// Enter in Search. On GNOME 51 ClutterText takes Return/KP_Enter for its own 'activate' signal and emits no key-press-event for them, so the
// panel starts a result from that signal (found by the E2E runner, tests/e2e). This is the rule that decides when the signal may start one.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

import {canActivateOnReturn, createSearchMachine} from '../../shell/search/build/searchMotion.js';
import {keyIntent} from '../../shell/search/build/nav.js';

test('Return may start a result only while the panel is open', () => {
    for (const s of ['Opening', 'Ready', 'ResultsExpanded']) assert.equal(canActivateOnReturn(s), true, s);   // during the opening animation too
    for (const s of ['Closed', 'Executing', 'Dismissing']) assert.equal(canActivateOnReturn(s), false, s);     // never twice, never while closing
    assert.equal(canActivateOnReturn(null), false);
    assert.equal(canActivateOnReturn(undefined), false);
});

test('one Return, however many paths it takes, starts one activation', () => {
    // both paths (the 'activate' signal, and key-press-event where a GNOME carries Return there) check the state and then `execute`
    const m = createSearchMachine(); m.send('open'); m.send('settled', {count: 3});
    let started = 0;
    const press = () => { if (canActivateOnReturn(m.state)) { started++; m.send('execute'); } };
    press(); press(); press();
    assert.equal(started, 1);
    assert.equal(m.state, 'Executing');
});

test('Return and KP_Enter still mean activate to the key handler', () => {
    assert.deepEqual(keyIntent(0xff0d, false), {type: 'activate'});
    assert.deepEqual(keyIntent(0xff8d, false), {type: 'activate'});
});

test('the entry is wired to the activate signal (guards against the wiring being dropped)', () => {
    const src = readFileSync(new URL('../../shell/search/extension.ts', import.meta.url), 'utf8');
    assert.match(src, /text\.connect\('activate',\s*\(\) => \{ if \(canActivateOnReturn\(this\._sm\?\.state\)\) this\._activate\(/);
});
