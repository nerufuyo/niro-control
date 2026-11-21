import test from 'node:test';
import assert from 'node:assert/strict';
import {isDarkAt, minutesOf} from '../../shell/island/build/src/themeRules.js';
import {partialDownloads, stackTitle} from '../../shell/dock/dist/lib/downloadRules.js';

test('schedule times: HH:MM only, anything else falls back', () => {
    assert.equal(minutesOf('07:30', 0), 450);
    assert.equal(minutesOf(' 7:05 ', 0), 425);
    assert.equal(minutesOf('24:00', 99), 99);
    assert.equal(minutesOf('7pm', 99), 99);
    assert.equal(minutesOf('', 99), 99);
});

test('schedule: dark from the evening to the morning, over midnight; light the other way round', () => {
    const light = 7 * 60, dark = 18 * 60;
    assert.equal(isDarkAt(12 * 60, light, dark), false);
    assert.equal(isDarkAt(18 * 60, light, dark), true);       // the minute the dark style starts
    assert.equal(isDarkAt(23 * 60 + 59, light, dark), true);
    assert.equal(isDarkAt(0, light, dark), true);
    assert.equal(isDarkAt(6 * 60 + 59, light, dark), true);
    assert.equal(isDarkAt(7 * 60, light, dark), false);       // the minute the light style starts
    assert.equal(isDarkAt(2 * 60, 22 * 60, 6 * 60), false);   // light from 22:00, dark from 06:00: 02:00 is light
    assert.equal(isDarkAt(12 * 60, 22 * 60, 6 * 60), true);
    assert.equal(isDarkAt(5 * 60, 7 * 60, 7 * 60), false);    // the same time twice: never dark
});

test('downloads: the names browsers give a file still being written', () => {
    assert.equal(partialDownloads(['a.pdf', 'b.zip.crdownload', 'c.iso.part', 'd.opdownload', '.hidden.part', 'notes.txt']), 3);
    assert.equal(partialDownloads([]), 0);
    assert.equal(partialDownloads(['.com.google.Chrome.AbC123']), 1);
    assert.equal(stackTitle('Downloads', 0), 'Downloads');
    assert.equal(stackTitle('Downloads', 2), 'Downloads · 2 downloading');
});
