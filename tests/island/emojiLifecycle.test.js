// Emoji Copy can be disabled while enable() is still loading the database. The extension's class runs with the Shell stubbed out.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('disable during the database load: nothing is built, bound or left open', async () => {
    let loaded, destroyed = 0, built = 0;
    const deps = {
        Extension: class { getSettings() { return {get_string: () => 'top'}; } },
        SQLite: class { initializeDB() { return new Promise(r => { loaded = r; }); } destroy() { destroyed++; } },
        PanelMenu: {Button: class { constructor() { built++; } }},
        _: s => s,
    };
    const js = readFileSync(new URL('../../shell/emoji/extension.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;$/gm, '').replace('export default class', 'return class');
    const emoji = new (new Function(...Object.keys(deps), js)(...Object.values(deps)))();
    const enabling = emoji.enable();
    emoji.disable();
    loaded();
    await enabling;
    assert.equal(built, 0);
    assert.equal(destroyed, 1);
});
