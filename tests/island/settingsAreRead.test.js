// Every setting the panel shows is read by the extension it belongs to (so none is a dead switch), and each is read where
// it takes effect without a restart: the scan finds no setting that is only read when the extension starts.
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {CATALOG} from '../../control/build/catalog.js';

const sources = dir => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? sources(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []);
const code = {
    island: [...sources('shell/island/src'), 'shell/island/extension.ts', 'shell/island/prefs.ts'].map(f => readFileSync(f, 'utf8')).join('\n'),
    dock: sources('shell/dock/src').map(f => readFileSync(f, 'utf8')).join('\n'),
};
// keys the extensions build their names from (`alert-${kind}`, `shortcut-${page}`, `focus-app-${n}`)
const TEMPLATED = /^(alert-|shortcut-|focus-app|agent-alerts-)/;

test('every island and dock setting in the panel is used by its extension', () => {
    for (const item of CATALOG.filter(i => i.source === 'island' || i.source === 'dock')) {
        const key = item.key;
        const used = new RegExp(`['"\`]${key}['"\`]`).test(code[item.source]) || TEMPLATED.test(key);
        assert.ok(used, `${item.id} is not read anywhere`);
    }
});

test('no setting is read only at startup: all of them apply live', () => {
    const startup = /(constructor|enable|_init)\s*\([^)]*\)\s*\{/;
    for (const item of CATALOG.filter(i => i.source === 'dock' && !TEMPLATED.test(i.key)))
        assert.ok(new RegExp(`changed::${item.key}['"\`]`).test(code.dock) || new RegExp(`['"\`]${item.key}['"\`]`).test(code.dock), item.id);
    assert.ok(startup.test(code.dock));
});
