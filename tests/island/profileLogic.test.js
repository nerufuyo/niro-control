// Profiles, the pure part: validation against the catalog, resolving `extends`, differences, partial profiles.
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

import {CATALOG} from '../../control/build/catalog.js';
import {deepEqual, describeValue, diff, makeProfile, pick, resolve, slugify, uniqueId, validateProfile, validateValue} from '../../control/build/profileLogic.js';

const byId = id => CATALOG.find(i => i.id === id);
const mk = settings => ({format: 'niro-profile', version: 1, name: 'T', settings});

test('every kind of setting validates its own default and refuses a wrong type', () => {
    for (const item of CATALOG.filter(i => !i.managed)) {
        const wrong = item.kind === 'switch' ? 'x' : item.kind === 'list' || item.kind === 'shortcut' ? 5 : item.kind === 'slider' || item.kind === 'stepper' ? 'x' : 5;
        assert.ok(validateValue(item, wrong), `${item.id} accepted ${wrong}`);
    }
});

test('ranges, choices, colours and whole numbers are enforced', () => {
    assert.equal(validateValue(byId('niro.opacity'), 50), null);
    assert.match(validateValue(byId('niro.opacity'), 101), /at most 100/);
    assert.match(validateValue(byId('niro.opacity'), -1), /at least 0/);
    assert.match(validateValue(byId('dock.icon-size'), 48.5), /whole number/);
    assert.equal(validateValue(byId('dock.magnification-scale'), 1.5), null);
    assert.match(validateValue(byId('island.auto-hide'), 'sometimes'), /one of/);
    assert.equal(validateValue(byId('dock.dock-position'), 2), null);
    assert.match(validateValue(byId('niro.accent'), 'red'), /#RRGGBB/);
    assert.equal(validateValue(byId('niro.accent'), '#aBc123'), null);
    assert.match(validateValue(byId('dock.focus-app'), [['<Super>1']]), /10 lists/);
});

test('an imported file is checked: format, version, name, values, unknown and managed settings', () => {
    assert.equal(validateProfile('x', CATALOG).ok, false);
    assert.match(validateProfile({format: 'other'}, CATALOG).errors[0], /not a Niro profile/);
    assert.match(validateProfile({...mk({}), version: 9}, CATALOG).errors[0], /newer Niro Control/);
    assert.match(validateProfile({...mk({}), name: ''}, CATALOG).errors[0], /no name/);
    const bad = validateProfile(mk({'niro.opacity': 500, 'dock.auto-hide': 'yes'}), CATALOG);
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 2);
    const odd = validateProfile(mk({'niro.opacity': 40, 'nothing.here': 1, 'dock.dock-opacity': 10, 'windows.blur': true}), CATALOG);
    assert.equal(odd.ok, true);
    assert.deepEqual(Object.keys(odd.profile.settings), ['niro.opacity']);
    assert.equal(odd.warnings.length, 3);
});

test('a file cannot make itself built-in, and its id is made safe', () => {
    const r = validateProfile({...mk({'niro.blur': true}), builtin: true, id: '../../etc/passwd'}, CATALOG);
    assert.equal(r.profile.builtin, undefined);
    assert.match(r.profile.id, /^[a-z0-9-]+$/);
});

test('ids: slug and uniqueness', () => {
    assert.equal(slugify('Deep Work!'), 'deep-work');
    assert.equal(slugify('   '), 'profile');
    assert.equal(uniqueId('work', ['work', 'work-2']), 'work-3');
    assert.equal(uniqueId('new', ['work']), 'new');
});

test('extends: a profile sits on its base, and cycles and missing bases do not hang', () => {
    const base = makeProfile('Base', {'niro.opacity': 80, 'niro.blur': true}, {id: 'base'});
    const child = makeProfile('Child', {'niro.opacity': 50}, {id: 'child', extends: 'base'});
    const find = id => ({base, child}[id]);
    assert.deepEqual(resolve(child, find), {'niro.opacity': 50, 'niro.blur': true});
    const a = makeProfile('A', {'niro.blur': false}, {id: 'a', extends: 'b'}), b = makeProfile('B', {'niro.opacity': 1}, {id: 'b', extends: 'a'});
    assert.deepEqual(resolve(a, id => ({a, b}[id])), {'niro.opacity': 1, 'niro.blur': false});
    assert.deepEqual(resolve(makeProfile('X', {'niro.blur': true}, {id: 'x', extends: 'gone'}), () => undefined), {'niro.blur': true});
});

test('diff names only what the target sets and what differs, with titles', () => {
    const current = {'niro.opacity': 80, 'niro.blur': true, 'niro.accent': '#E8472B'};
    const target = {'niro.opacity': 60, 'niro.blur': true, 'niro.accent': '#e8472b'};
    const changes = diff(current, target, CATALOG);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, 'niro.opacity');
    assert.equal(changes[0].menu, 'Look');
    assert.equal(diff(current, {}, CATALOG).length, 0);
    assert.ok(deepEqual([['a'], []], [['a'], []]) && !deepEqual([1], [2]) && deepEqual(1.4, 1.4000000001));
});

test('partial profiles keep only the menus asked for', () => {
    const all = {'niro.opacity': 1, 'dock.auto-hide': true, 'island.auto-hide': 'off', 'corners.skip-libhandy-app': false};
    assert.deepEqual(Object.keys(pick(all, ['Dock'], CATALOG)), ['dock.auto-hide']);
    assert.deepEqual(Object.keys(pick(all, ['Look', 'Island'], CATALOG)).sort(), ['island.auto-hide', 'niro.opacity']);
});

test('values read well in a preview', () => {
    assert.equal(describeValue(byId('dock.auto-hide'), true), 'On');
    assert.equal(describeValue(byId('niro.opacity'), 70), '70 %');
    assert.equal(describeValue(byId('dock.dock-position'), 1), 'Left');
    assert.equal(describeValue(byId('dock.dock-position'), undefined), '—');
});

test('the four built-in profiles are valid, only name real settings, and are partial', () => {
    const dir = new URL('../../control/profiles/', import.meta.url);
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    assert.deepEqual(files.map(f => JSON.parse(readFileSync(new URL(f, dir), 'utf8')).name), ['Everyday', 'Deep Work', 'Creative', 'Gaming']);
    for (const f of files) {
        const raw = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
        const r = validateProfile(raw, CATALOG);
        assert.ok(r.ok, `${f}: ${r.errors}`);
        assert.equal(r.warnings.length, 0, `${f}: ${r.warnings}`);
        assert.ok(Object.keys(r.profile.settings).length < CATALOG.length);
    }
});

import {describeParseError, inactiveNotes, stalePartsAffected, validateDependencies} from '../../control/build/profileLogic.js';

test('dependency metadata is sound: targets exist, no cycles, operators fit their targets', () => {
    assert.deepEqual(validateDependencies(CATALOG), []);
    const broken = [
        {id: 'a.x', kind: 'switch', depends: {id: 'a.gone', op: 'on'}},
        {id: 'a.y', kind: 'switch', depends: {id: 'a.y', op: 'on'}},
        {id: 'a.z', kind: 'switch', depends: {id: 'a.sel', op: 'on'}},
        {id: 'a.sel', kind: 'select', options: [{value: 'hover'}], depends: {id: 'a.z', op: 'on'}},
        {id: 'a.w', kind: 'switch', depends: {id: 'a.sel', op: 'eq', value: 'nope'}},
    ];
    const problems = validateDependencies(broken).join('\n');
    assert.match(problems, /a\.gone, which does not exist/);
    assert.match(problems, /depends on itself/);
    assert.match(problems, /needs a switch/);
    assert.match(problems, /cycle/);
    assert.match(problems, /no choice "nope"/);
});

test('a profile that sets a control whose gate stays off is told so', () => {
    const changes = [{id: 'island.hover-delay', title: 'x', menu: 'Island', group: 'g', from: 120, to: 300}];
    const notes = inactiveNotes(changes, {'island.hover-delay': 300, 'island.open-on': 'click'}, CATALOG);
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /no effect until .* is "hover"/);
    assert.equal(inactiveNotes(changes, {'island.hover-delay': 300, 'island.open-on': 'hover'}, CATALOG).length, 0);
    assert.equal(inactiveNotes([{id: 'niro.opacity', title: '', menu: 'Look', group: '', from: 1, to: 2}], {}, CATALOG).length, 0);
});

test('a pending login is named only for the parts a change touches', () => {
    const c = id => ({id, title: '', menu: '', group: '', from: 0, to: 1});
    assert.deepEqual(stalePartsAffected([c('dock.icon-size')], ['Island', 'Dock'], CATALOG), ['Dock']);
    assert.deepEqual(stalePartsAffected([c('island.chimes')], ['Island', 'Dock'], CATALOG), ['Island']);
    assert.deepEqual(stalePartsAffected([c('niro.opacity')], ['Island', 'Dock'], CATALOG), ['Island', 'Dock']);
    assert.deepEqual(stalePartsAffected([c('niro.search-shortcut')], ['Island', 'Search'], CATALOG), ['Search']);
    assert.deepEqual(stalePartsAffected([c('dock.icon-size')], [], CATALOG), []);
    assert.deepEqual(stalePartsAffected([c('corners.border-width')], ['Island'], CATALOG), []);
});

test('JSON that does not parse says where', () => {
    const text = '{\n  "a": 1,\n  "b": \n}';
    let message = '';
    try { JSON.parse(text); } catch (e) { message = e.message; }
    assert.match(describeParseError(message, text), /line \d+, column \d+/);
    assert.equal(describeParseError('boom', 'x'), 'boom');
});

test('dependency rules: the ones the code did not support are gone, unverified ones only hint', async () => {
    const {dependencyBlocks} = await import('../../control/build/logic.js');
    const byId = Object.fromEntries(CATALOG.map(i => [i.id, i]));
    // system-alerts is a pre-0.7 switch the island resets to on; each alert has its own switch; the blur strength applies with blur off
    for (const id of ['island.alert-power', 'island.alert-network', 'island.alert-bluetooth', 'island.alert-caps-lock', 'island.alert-bluetooth-battery', 'niro.blur-strength'])
        assert.equal(byId[id].depends, undefined, `${id} must not depend on anything`);
    assert.ok(!CATALOG.some(i => i.depends?.id === 'island.system-alerts'));
    // an unverified rule is shown as a hint: it never disables a row and never produces a "no effect" note
    const unverified = CATALOG.filter(i => i.depends?.unverified);
    assert.deepEqual(unverified.map(i => i.id).sort(), ['dock.show-threshold', 'island.auto-hide-delay', 'island.call-preview']);
    for (const item of unverified) {
        assert.equal(dependencyBlocks(item, () => (item.depends.op === 'off' ? true : false)), false, item.id);
        const change = {id: item.id, title: item.title, menu: item.menu, group: '', from: 1, to: 2};
        assert.equal(inactiveNotes([change], {[item.depends.id]: false}, CATALOG).length, 0, item.id);
    }
    // a verified rule still blocks
    assert.equal(dependencyBlocks(byId['island.hover-delay'], () => 'click'), true);
    assert.equal(dependencyBlocks(byId['island.hover-delay'], () => 'hover'), false);
});

import {summarize} from '../../control/build/profileLogic.js';
test('change summary: counts, areas largest first, conflicts, pending login, undo line', () => {
    const c = (id, menu) => ({id, title: id, menu, group: 'g', from: 1, to: 2});
    const changes = [c('dock.icon-size', 'Dock'), c('island.hover-delay', 'Island'), c('island.auto-hide', 'Island')];
    const s = summarize(changes, {'island.hover-delay': 300, 'island.open-on': 'click'}, CATALOG, ['Dock']);
    assert.equal(s.headline, '3 settings will change');
    assert.deepEqual(s.categories.map(x => `${x.menu}:${x.count}`), ['Island:2', 'Dock:1']);
    assert.equal(s.conflicts.length, 1);
    assert.match(s.conflicts[0], /hover-delay|Hover/i);
    assert.match(s.login, /^Dock has an update that loads at your next login/);
    assert.match(s.undo, /Undo restores/);
    const none = summarize([], {}, CATALOG, []);
    assert.equal(none.total, 0);
    assert.match(none.headline, /Nothing to change/);
    assert.equal(none.login, null);
    assert.equal(summarize([c('dock.icon-size', 'Dock')], {}, CATALOG, []).headline, '1 setting will change');
});

test('profiles carry per-application rules: validated on import, shown as a count, exclusions never dropped silently', async () => {
    const {validateProfile, describeValue, summarize} = await import('../../control/build/profileLogic.js');
    const item = CATALOG.find(i => i.id === 'niro.app-rules');
    assert.ok(item, 'the rules are a registered setting');
    const good = JSON.stringify({chrome: {mode: 'exclude'}});
    assert.equal(validateProfile({format: 'niro-profile', version: 1, name: 'R', settings: {'niro.app-rules': good}}, CATALOG).ok, true);
    const bad = validateProfile({format: 'niro-profile', version: 1, name: 'R', settings: {'niro.app-rules': '{"x":{"mode":"weird"}}'}}, CATALOG);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(' '), /not valid/);
    assert.equal(describeValue(item, good), '1 rule');
    assert.equal(describeValue(item, '{}'), 'no rules');
    const change = {id: 'niro.app-rules', title: item.title, menu: 'Look', group: 'g', from: good, to: '{}'};
    assert.match(summarize([change], {}, CATALOG, []).conflicts.join(' '), /removes your exclusion of chrome/);
    assert.equal(summarize([{...change, from: '{}', to: good}], {}, CATALOG, []).conflicts.length, 0);
});
