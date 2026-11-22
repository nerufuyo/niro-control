// Appearance Studio logic (no screen): the draft, apply with read-back and rollback, unavailable keys, accent contrast, motion presets.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ALL_IDS, COMPONENTS, MOTION_CONSUMERS, MOTION_KEYS, constrainAppearance, createStudio, detectPreset, motionPlan, paletteReport, parseDefault, sameValue} from '../../control/build/appearanceLogic.js';
import {CATALOG} from '../../control/build/catalog.js';
import {contrast} from '../../shell/shared/tokens.js';

/** Fake settings: a map, with hooks to fail or to ignore a write. */
function fake(initial, {failOn = null, ignore = [], missing = []} = {}) {
    const store = {...initial}, writes = [];
    return {
        store, writes,
        read: id => store[id],
        write(id, v) {
            writes.push([id, v]);
            if (id === failOn) throw new Error('locked');
            if (!ignore.includes(id)) store[id] = v;
        },
        available: id => !missing.includes(id),
    };
}
const ids = ['dock.icon-size', 'dock.dock-position', 'niro.accent', 'niro.tint'];
const start = {'dock.icon-size': 38, 'dock.dock-position': 0, 'niro.accent': '#E8472B', 'niro.tint': '#1C1C1E'};

test('every id the Studio edits is a real catalog item, so no new setting is needed', () => {
    const known = new Set(CATALOG.map(i => i.id));
    for (const id of ALL_IDS) assert.ok(known.has(id), `${id} is not in the catalog`);
    assert.equal(new Set(ALL_IDS).size, ALL_IDS.length);
    assert.deepEqual(COMPONENTS.map(c => c.label), ['Dock', 'Island', 'Windows', 'Panel look']);
    for (const id of ALL_IDS) assert.equal(CATALOG.find(i => i.id === id).managed, undefined, `${id} is written by Look`);
});

test('a draft changes nothing until apply; cancel drops it', () => {
    const s = fake(start), st = createStudio(ids, s);
    st.load();
    assert.equal(st.state, 'ready');
    assert.deepEqual(st.set('dock.icon-size', 64), {ok: true, value: 64, note: undefined});
    assert.equal(st.value('dock.icon-size'), 64);
    assert.equal(st.view('dock.icon-size'), 64);
    st.setShowBefore(true);
    assert.equal(st.view('dock.icon-size'), 38);
    st.setShowBefore(false);
    assert.equal(s.writes.length, 0);
    assert.equal(st.changes().length, 1);
    st.cancel();
    assert.equal(st.changes().length, 0);
    assert.equal(st.value('dock.icon-size'), 38);
    assert.equal(s.writes.length, 0);
    assert.equal(st.state, 'ready');
});

test('apply writes, reads back, and the next draft starts from the new values', () => {
    const s = fake(start), st = createStudio(ids, s);
    st.load();
    st.set('dock.icon-size', 64); st.set('dock.dock-position', 3);
    const r = st.apply();
    assert.equal(r.ok, true);
    assert.equal(r.written, 2);
    assert.equal(s.store['dock.icon-size'], 64);
    assert.equal(st.state, 'success');
    assert.deepEqual(st.history.slice(-2), ['applying', 'success']);
    assert.equal(st.changes().length, 0);
    // restore previous: the draft goes back, the settings stay until apply
    assert.equal(st.canRestore(), true);
    st.restorePrevious();
    assert.equal(s.store['dock.icon-size'], 64);
    assert.equal(st.value('dock.icon-size'), 38);
    assert.equal(st.apply().ok, true);
    assert.equal(s.store['dock.icon-size'], 38);
});

test('a failed write puts the earlier writes back', () => {
    const s = fake(start, {failOn: 'dock.dock-position'}), st = createStudio(ids, s);
    st.load();
    st.set('dock.icon-size', 64); st.set('dock.dock-position', 3);
    const r = st.apply();
    assert.equal(r.ok, false);
    assert.equal(st.state, 'rollback');
    assert.match(r.message, /dock\.dock-position: locked/);
    assert.match(r.message, /put back/);
    assert.equal(s.store['dock.icon-size'], 38);
    assert.equal(s.store['dock.dock-position'], 0);
    // the draft is kept so the person can retry or cancel
    assert.equal(st.changes().length, 2);
});

test('a write that does not stick is caught by the read-back and rolled back', () => {
    const s = fake(start, {ignore: ['dock.dock-position']}), st = createStudio(ids, s, {titles: {'dock.dock-position': 'Dock position'}});
    st.load();
    st.set('dock.icon-size', 64); st.set('dock.dock-position', 3);
    const r = st.apply();
    assert.equal(r.ok, false);
    assert.equal(st.state, 'rollback');
    assert.match(r.message, /Rolled back: Dock position is 0, not 3/);
    assert.equal(s.store['dock.icon-size'], 38, 'the key that did stick is put back');
});

test('a setting that cannot be applied is shown unavailable and never forced', () => {
    const s = fake(start, {missing: ['dock.dock-position']}), st = createStudio(ids, s, {reasons: {'dock.dock-position': 'the Dock is not installed'}});
    st.load();
    assert.equal(st.state, 'ready');
    assert.equal(st.isSupported('dock.dock-position'), false);
    assert.deepEqual(st.unavailable(), [{id: 'dock.dock-position', reason: 'the Dock is not installed'}]);
    const r = st.set('dock.dock-position', 2);
    assert.equal(r.ok, false);
    assert.match(r.reason, /unavailable: the Dock is not installed/);
    assert.equal(st.changes().length, 0);
    st.set('dock.icon-size', 50); st.apply();
    assert.ok(!s.writes.some(w => w[0] === 'dock.dock-position'));
});

test('nothing available: disabled; a read that throws: error', () => {
    const none = createStudio(ids, fake(start, {missing: ids}));
    none.load();
    assert.equal(none.state, 'disabled');
    assert.equal(none.set('dock.icon-size', 1).ok, false);
    const bad = createStudio(ids, {read: () => { throw new Error('x'); }, write() {}, available: () => { throw new Error('no schema'); }});
    bad.load();
    assert.equal(bad.state, 'error');
    assert.match(bad.message, /no schema/);
});

test('reset puts defaults in the draft only', () => {
    const s = fake({...start, 'dock.icon-size': 80}), st = createStudio(ids, s, {defaults: {'dock.icon-size': 38}});
    st.load();
    st.reset('dock.icon-size');
    assert.equal(st.value('dock.icon-size'), 38);
    assert.equal(s.store['dock.icon-size'], 80);
    st.resetAll();
    assert.equal(s.writes.length, 0);
});

test('refresh takes outside changes and keeps the draft of what was changed here', () => {
    const s = fake(start), st = createStudio(ids, s);
    st.load();
    st.set('dock.icon-size', 64);
    s.store['dock.dock-position'] = 2;
    st.refresh();
    assert.equal(st.value('dock.dock-position'), 2);
    assert.equal(st.value('dock.icon-size'), 64);
    assert.equal(st.changes().length, 1);
});

test('an accent that cannot be read on the surface is moved and explained; a bad colour is refused', () => {
    const draft = {'niro.accent': '#E8472B', 'niro.tint': '#1C1C1E'};
    const same = constrainAppearance('niro.accent', '#0A84FF', draft);
    assert.equal(same.value, '#0A84FF');
    const dull = constrainAppearance('niro.accent', '#202020', draft);
    assert.notEqual(dull.value, '#202020');
    assert.ok(contrast(dull.value, '#1C1C1E') >= 3);
    assert.match(dull.note, /moved to/);
    assert.match(constrainAppearance('niro.accent', 'red', draft).refuse, /#RRGGBB/);
    // a tint that swallows the accent moves the accent
    const tint = constrainAppearance('niro.tint', '#E8472B', draft);
    assert.equal(tint.value, '#E8472B');
    assert.ok(tint.also['niro.accent']);
    assert.ok(contrast(tint.also['niro.accent'], '#E8472B') >= 3);
    assert.deepEqual(constrainAppearance('dock.icon-size', 5, draft), {value: 5});
    // through the studio, both change
    const st = createStudio(ids, fake(start));
    st.load();
    st.set('niro.tint', '#E8472B');
    assert.notEqual(st.value('niro.accent'), '#E8472B');
    assert.equal(st.notes.length, 1);
    assert.equal(st.set('niro.accent', 'nope').ok, false);
});

test('the palette report lists contrast for each token on both surfaces', () => {
    for (const dark of [true, false]) {
        const r = paletteReport('#E8472B', dark);
        assert.ok(r.tokens.length >= 8);
        for (const t of r.tokens) if (t.min) assert.ok(t.ok, `${t.token} on ${dark ? 'dark' : 'light'}: ${t.ratio}`);
    }
    assert.equal(paletteReport('nope', true), null);
    assert.equal(paletteReport('#808080', false).adjusted, true);
});

test('motion presets map onto the Dock keys; reduced gives 0 and no bounce; presets get slower', () => {
    const ms = p => motionPlan(p)['dock.animation-duration'];
    assert.ok(ms('minimal') < ms('smooth') && ms('smooth') < ms('dynamic') && ms('dynamic') < ms('cinematic'));
    assert.deepEqual(Object.keys(motionPlan('smooth')), MOTION_KEYS);
    assert.deepEqual(motionPlan('cinematic', true), {'dock.animation-duration': 0, 'dock.bounce-on-launch': false});
    assert.equal(motionPlan('minimal')['dock.bounce-on-launch'], false);
    assert.equal(motionPlan('nope'), null);
    // the Dock's defaults (200 ms, bounce on) are Smooth
    assert.equal(detectPreset(200, true), 'smooth');
    assert.equal(detectPreset(0, false), 'reduced');
    assert.equal(detectPreset(333, true), 'custom');
    assert.deepEqual(MOTION_CONSUMERS.filter(c => c.consumes).map(c => c.component), ['Dock']);
});

test('defaults are read from the catalog text by type', () => {
    assert.equal(parseDefault({type: 'b', default: 'true'}), true);
    assert.equal(parseDefault({type: 'i', default: '38'}), 38);
    assert.equal(parseDefault({type: 'd', default: '1.4'}), 1.4);
    assert.equal(parseDefault({type: 's', default: '#E8472B'}), '#E8472B');
    assert.ok(sameValue('#e8472b', '#E8472B'));
    assert.ok(!sameValue(1, 2));
});

test('colorAdvice: a readable pair says nothing; a weak one warns with ratio and a suggestion; an unreadable one is flagged; nothing is changed', async () => {
    const {colorAdvice} = await import('../../control/build/appearanceLogic.js');
    assert.equal(colorAdvice('#FFFFFF', '#1C1C1E'), null);
    assert.equal(colorAdvice('not a colour', '#1C1C1E'), null);
    // 3:1..4.5:1: low
    const low = colorAdvice('#767676', '#FFFFFF');     // about 4.5 on white; pick something just under
    const weak = colorAdvice('#8A8A8A', '#FFFFFF');
    assert.equal(weak.level, 'low');
    assert.ok(weak.ratio >= 3 && weak.ratio < 4.5);
    assert.ok(weak.suggestedRatio >= 4.5);
    assert.match(weak.text, /:1 on the panel surface #FFFFFF/);
    assert.match(weak.text, /Suggested: #[0-9A-F]{6}/);
    void low;
    // under 3:1: unreadable
    const bad = colorAdvice('#202022', '#1C1C1E');
    assert.equal(bad.level, 'unreadable');
    assert.ok(bad.ratio < 3);
    assert.ok(contrast(bad.suggestion, '#1C1C1E') >= 4.5);
    assert.equal(bad.accent, '#202022');    // reported as chosen: the advice never rewrites it
});

test('every tone preset of the Look page reads on its own tint (3:1 at least)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../control/src/pages.ts', import.meta.url), 'utf8');
    const block = /export const TONES = \[([\s\S]*?)\];/.exec(src)[1];
    const tones = [...block.matchAll(/\['([^']+)', '(#[0-9A-Fa-f]{6})', '(#[0-9A-Fa-f]{6})'\]/g)];
    assert.ok(tones.length >= 5);
    for (const [, name, accent, tint] of tones)
        assert.ok(contrast(accent, tint) >= 3, `${name}: ${accent} on ${tint} is ${contrast(accent, tint)}`);
});
