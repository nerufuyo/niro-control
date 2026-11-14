// The control panel's pure logic and its catalog: nothing may be missing, duplicated or shown with raw HTML entities.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {CATALOG} from '../../control/build/catalog.js';
import {canonicalAccel, decodeEntities, dependencyBlocks, dependencyMet, findConflict, hasModifier, normalizeAccel, searchItems} from '../../control/build/logic.js';

const csv = readFileSync(new URL('../../docs/control-panel-items.csv', import.meta.url), 'utf8').trim().split('\n').slice(1);

test('the catalog has all 143 settings, once each, in step with the CSV', () => {
    assert.equal(CATALOG.length, 143);
    assert.equal(new Set(CATALOG.map(i => i.id)).size, 143);
    assert.equal(csv.length, 143);
});

test('every menu and group the design names is there with the right number of items', () => {
    const count = (menu, group) => CATALOG.filter(i => i.menu === menu && (!group || i.group === group)).length;
    assert.deepEqual(['Look', 'Island', 'Dock', 'Windows', 'Search'].map(m => count(m)), [16, 77, 30, 19, 1]);
    assert.equal(count('Dock', 'Appearance') + count('Dock', 'Motion') + count('Dock', 'Applications and Indicators')
        + count('Dock', 'Windows and Media') + count('Dock', 'Shortcuts'), 30);
    assert.equal(count('Windows', 'Window Blur') + count('Windows', 'Rounded Corners'), 19);
    const island = new Set(CATALOG.filter(i => i.menu === 'Island').map(i => i.group));
    assert.deepEqual([...island].sort(), ['AI Agents', 'AI Usage', 'Alerts', 'Appearance and Behavior', 'Clipboard', 'Focus', 'Music',
        'Pages and Features', 'Shortcuts', 'Voice Assistant']);
});

test('no raw HTML entity reaches the screen, and every item has a title and a control', () => {
    for (const i of CATALOG) {
        assert.ok(i.title.length > 0 && i.kind, i.id);
        assert.doesNotMatch(`${i.title} ${i.help} ${i.detail}`, /&(apos|quot|amp|lt|gt|#\d+);/, i.id);
    }
    assert.equal(decodeEntities('the island&apos;s &quot;look&quot;'), `the island's "look"`);
});

test('blur strength is the Look item, not the old sigma key', () => {
    assert.ok(CATALOG.some(i => i.id === 'niro.blur-strength'));
    assert.ok(!CATALOG.some(i => /sigma/i.test(i.key)));
});

test('a setting has one owner: the ones Look writes are marked managed and point at a Look item', () => {
    for (const i of CATALOG.filter(i => i.managed))
        assert.ok(CATALOG.some(o => o.id === i.managed && o.menu === 'Look'), `${i.id} -> ${i.managed}`);
    assert.ok(CATALOG.filter(i => i.managed).length >= 8);
});

test('dependencies point at items that exist', () => {
    for (const i of CATALOG.filter(i => i.depends))
        assert.ok(CATALOG.some(o => o.id === i.depends.id), `${i.id} -> ${i.depends.id}`);
    const hover = CATALOG.find(i => i.id === 'island.hover-delay');
    assert.equal(dependencyMet(hover, () => 'hover'), true);
    assert.equal(dependencyMet(hover, () => 'click'), false);
});

test('search finds a setting by its title, its help, its group or its key', () => {
    assert.equal(searchItems(CATALOG, 'magnification')[0].menu, 'Dock');
    assert.ok(searchItems(CATALOG, 'lyrics').some(i => i.id === 'island.lyrics-online'));
    assert.ok(searchItems(CATALOG, 'AI Usage').length >= 6);
    assert.ok(searchItems(CATALOG, 'hover-delay').some(i => i.key === 'hover-delay'));
    assert.equal(searchItems(CATALOG, 'zzzz').length, 0);
    assert.ok(searchItems(CATALOG, 'blur').some(i => i.id === 'windows.blur-strength'));
});

test('shortcuts: the same keys in another order are the same shortcut; conflicts name the owner', () => {
    assert.equal(normalizeAccel('<Super><Alt>M'), normalizeAccel('<Alt><Super>m'));
    const taken = [{owner: 'Island › Music', accel: '<Super><Alt>m'}];
    assert.equal(findConflict('<Alt><Super>M', taken).owner, 'Island › Music');
    assert.equal(findConflict('<Super>n', taken), null);
    assert.equal(hasModifier('m'), false);
    assert.equal(hasModifier('<Super>m'), true);
    assert.equal(hasModifier('F5'), true);
});

test('every shortcut default in the catalog is free of conflicts with the others', () => {
    const seen = new Map();
    for (const i of CATALOG.filter(i => i.kind === 'shortcut' && i.source !== 'niro')) {
        const accel = normalizeAccel(i.default.replace(/^\[|\]$/g, '').replace(/['"]/g, ''));
        if (!accel) continue;
        assert.ok(!seen.has(accel) || seen.get(accel).source !== i.source, `${i.id} clashes with ${seen.get(accel)?.id}`);
        seen.set(accel, i);
    }
});

test('a recorded shortcut is written the way the schemas write theirs', () => {
    assert.equal(canonicalAccel('<Alt><Super>z'), '<Super><Alt>z');
    assert.equal(canonicalAccel('<Shift><Control>F5'), '<Control><Shift>F5');
    assert.equal(canonicalAccel('<Super>space'), '<Super>space');
});
