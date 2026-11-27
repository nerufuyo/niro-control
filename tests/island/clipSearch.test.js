// A new copy while a search is unanswered must not bring back the search before it. GNOME is stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('update() during a pending search asks the pending words again', async () => {
    const source = readFileSync(new URL('../../shell/island/src/pages/clips.ts', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '').replace('export const', 'const');
    const ClipsView = new Function('GObject', 'St', `${source}\nreturn ClipsView;`)(
        {registerClass: (_meta, c) => c, TYPE_JSOBJECT: 0, TYPE_BOOLEAN: 0}, {Widget: class {}});
    const asked = [];
    const view = Object.assign(new ClipsView(), {
        _daemon: {state: {}, call: (_a, _b, query) => new Promise(answer => asked.push({query, answer}))},
        _query: '', _searching: null, _searches: 0, _selected: 0, _all: [], _cards: new Map(),
        refreshAges() {}, _filter() {},
    });
    const answer = async i => { asked[i].answer([[]]); await new Promise(setImmediate); };

    view.query = 'old';
    await answer(0);
    view.query = 'new';
    view._selected = 3;
    view.update({off: false, hidden: false});
    assert.equal(asked.at(-1).query, 'new');
    await answer(1);
    await answer(2);
    assert.equal(view._query, 'new');
    assert.equal(view._selected, 0);                          // typed words still start at the first card

    view._selected = 2;
    view.update();
    await answer(3);
    assert.equal(view._selected, 2);                          // a refresh keeps the selection
});
