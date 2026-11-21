import test from 'node:test';
import assert from 'node:assert/strict';
import {isDarkAt, isInside, minutesOf} from '../../shell/island/build/src/themeRules.js';
import {appTitle, memoryText, partialDownloads, stackTitle} from '../../shell/dock/dist/lib/downloadRules.js';

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

test('downloads: only a partial file that is still changing counts', () => {
    const now = 1000000;
    const f = (name, ago) => ({name, modified: now - ago});
    assert.equal(partialDownloads([f('a.pdf', 1), f('b.zip.crdownload', 5), f('c.iso.part', 60), f('d.opdownload', 89), f('.hidden.part', 1), f('notes.txt', 1)], now), 3);
    assert.equal(partialDownloads([f('old.sql.crdownload', 6 * 86400), f('stale.part', 91)], now), 0);   // abandoned downloads do not pulse for ever
    assert.equal(partialDownloads([], now), 0);
    assert.equal(partialDownloads([f('.com.google.Chrome.AbC123', 3)], now), 1);
    assert.equal(stackTitle('Downloads', 0), 'Downloads');
    assert.equal(stackTitle('Downloads', 2), 'Downloads · 2 downloading');
});

test('app tooltip: the name and the memory it holds', () => {
    assert.equal(memoryText(1.234e9), '1.2 GB');
    assert.equal(memoryText(340e6), '340 MB');
    assert.equal(memoryText(100), '1 MB');
    assert.equal(appTitle('Firefox', 1.2e9), 'Firefox · 1.2 GB');
    assert.equal(appTitle('Files', 0), 'Files');
});

test('downloads: the time that counts as going on can be changed', () => {
    const now = 1000000, f = (name, ago) => ({name, modified: now - ago});
    assert.equal(partialDownloads([f('a.part', 200)], now, 300), 1);
    assert.equal(partialDownloads([f('a.part', 200)], now, 90), 0);
    assert.equal(partialDownloads([f('a.part', 200)], now), 0);           // the default is 90 seconds
});
