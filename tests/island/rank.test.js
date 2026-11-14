// How search results are ordered.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {arrange, bestScore, scoreText} from '../../shell/search/build/rank.js';

test('scoreText: exact > prefix > word start > inside > none', () => {
    const s = t => scoreText('wi', t);
    assert.equal(scoreText('wifi', 'WiFi'), 100);
    assert.ok(s('Wifi settings') > s('Network wi-fi') - 1);
    assert.ok(scoreText('net', 'Network') > scoreText('net', 'Home network') && scoreText('net', 'Home network') > scoreText('net', 'Cabinet'));
    assert.equal(scoreText('zzz', 'Network'), 0);
});

test('bestScore: a keyword counts a little less than the title', () => {
    assert.ok(bestScore('lock', ['lock']) > bestScore('lock', ['Security', 'lock']));
});

test('arrange: the best match with a kind bonus leads, sections never split, calculator beats the rest', () => {
    const r = (section, title, score) => ({section, title, score});
    const out = arrange([r('Settings', 'a', 40), r('Applications', 'b', 30), r('Settings', 'c', 90), r('Applications', 'd', 85)]);
    assert.deepEqual(out.map(x => x.title), ['d', 'b', 'c', 'a']);
    const calc = arrange([r('Applications', 'x', 100), r('Calculator', '4', 100)]);
    assert.equal(calc[0].section, 'Calculator');
});
