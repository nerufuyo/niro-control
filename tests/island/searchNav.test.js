// The palette's keyboard behaviour: which key means what, how the selection moves, one execution at a time.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {hint, keyIntent, move, Once} from '../../shell/search/build/nav.js';

test('keys: Esc closes, arrows/Tab/Ctrl+N/P move, Enter activates, Ctrl+1-9 pick, letters pass through', () => {
    assert.deepEqual(keyIntent(0xff1b, false), {type: 'close'});
    assert.deepEqual(keyIntent(0xff54, false), {type: 'next'});
    assert.deepEqual(keyIntent(0xff09, false), {type: 'next'});
    assert.deepEqual(keyIntent(0x6e, true), {type: 'next'});
    assert.deepEqual(keyIntent(0xff52, false), {type: 'previous'});
    assert.deepEqual(keyIntent(0xfe20, false), {type: 'previous'});
    assert.deepEqual(keyIntent(0xff0d, false), {type: 'activate'});
    assert.deepEqual(keyIntent(0xff8d, false), {type: 'activate'});
    assert.deepEqual(keyIntent(0x33, true), {type: 'quick', index: 2});
    assert.equal(keyIntent(0x33, false), null);   // a plain 3 is text
    assert.equal(keyIntent(0x6e, false), null);   // so is a plain n
    assert.equal(keyIntent(0xff51, false), null); // Left/Right belong to the text field
});

test('selection wraps at both ends and survives an empty list', () => {
    assert.equal(move(0, 1, 3), 1);
    assert.equal(move(2, 1, 3), 0);
    assert.equal(move(0, -1, 3), 2);
    assert.equal(move(-1, 1, 3), 0);
    assert.equal(move(-1, -1, 3), 2);
    assert.equal(move(0, 1, 0), -1);
    assert.equal(move(0, 1, 1), 0);
});

test('the hint says Enter confirms for protected actions', () => {
    assert.match(hint({title: 'Restart', permission: 'confirm'}), /^Enter asks to confirm/);
    assert.match(hint({title: 'Files', permission: 'none'}), /^Enter opens/);
    assert.match(hint(undefined), /Esc close/);
});

test('Once refuses a second activation until the first ends', () => {
    const once = new Once();
    assert.equal(once.begin(), true);
    assert.equal(once.begin(), false);
    once.end();
    assert.equal(once.begin(), true);
});
