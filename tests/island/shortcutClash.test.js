// No two of Niro's default shortcuts are the same key: the one that grabs it first wins and the other never reacts.
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const files = [];
for (const dir of readdirSync(new URL('shell/', ROOT)))
    try { for (const f of readdirSync(new URL(`shell/${dir}/schemas/`, ROOT))) if (f.endsWith('.gschema.xml')) files.push(`shell/${dir}/schemas/${f}`); } catch (_e) { /* no schemas */ }
files.push('control/org.niro.control.gschema.xml');

test('every default shortcut is used by one setting only', () => {
    const seen = new Map();
    for (const file of files) {
        const xml = readFileSync(new URL(file, ROOT), 'utf8');
        for (const m of xml.matchAll(/<key name="([^"]+)" type="as">\s*<default>(.*?)<\/default>/gs)) {
            for (const accel of [...m[2].matchAll(/["']([^"']*)["']/g)].map(x => x[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>')).filter(a => a.includes('<'))) {
                const key = `${file.split('/').slice(-3)[0]}:${m[1]}`;
                const norm = accel.toLowerCase();
                assert.ok(!seen.has(norm), `${accel} is the default of both ${seen.get(norm)} and ${key}`);
                seen.set(norm, key);
            }
        }
    }
    assert.ok(seen.size > 20, 'shortcuts were found');
});
