// Opening the shelf again must not delete collections that creating them allowed.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createSystemHub} from '../../shell/search/build/systemHub.js';

test('every collection that could be created is still there after reopening', async () => {
    const files = {};
    const open = () => {
        const actions = new Map();
        createSystemHub({
            pref: (k, d) => k === 'shelf-collections' ? true : d,
            now: () => 1000,
            readConfig: n => files[n] ?? null,
            writeConfig: (n, t) => { files[n] = t; },
        }).register({register: a => actions.set(a.id, a)});
        return actions;
    };
    const first = open();
    for (let i = 0; i < 50; i++)
        await first.get('collection.create').run({name: `c${i}`});
    const next = open();
    const listed = await next.get('collection.list').run({});
    for (let i = 0; i < 50; i++)
        assert.match(listed, new RegExp(`\\bc${i}\\b`));
});
