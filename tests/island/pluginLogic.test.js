// Plugin manifest check (validation only): the report for valid and invalid manifests, the permissions listed, and that nothing is loaded.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {checkManifestText, formatReport, MAX_MANIFEST_BYTES} from '../../control/build/pluginLogic.js';

const good = (over = {}) => JSON.stringify({id: 'com.example.hello', name: 'Hello', version: '1.0.0', apiVersion: '1.0', capabilities: ['notifications'], entryPoint: 'main.js', ...over});

test('a valid manifest: ok, no problems, permissions listed, the not-a-host line printed', () => {
    const r = checkManifestText(good());
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.permissions, [{capability: 'notifications', risky: false, reason: ''}]);
    const lines = formatReport(r, 'x/manifest.json').join('\n');
    assert.match(lines, /^valid: x\/manifest\.json/);
    assert.match(lines, /Nothing was loaded or run/);
    assert.match(lines, /no plugin host/);
});

test('risky capabilities need a reason and are marked sensitive', () => {
    const bad = checkManifestText(good({capabilities: ['network']}));
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join('\n'), /"network" needs a permission entry/);
    const ok = checkManifestText(good({capabilities: ['network', 'file'], permissions: [{capability: 'network', reason: 'fetch the weather'}, {capability: 'file', reason: 'save a cache'}]}));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.permissions.map(p => [p.capability, p.risky, p.reason]), [['network', true, 'fetch the weather'], ['file', true, 'save a cache']]);
    assert.match(formatReport(ok, 'm').join('\n'), /network \(sensitive\): fetch the weather/);
});

test('problems: not JSON, empty, too big, unknown key, bad id, path escape, scheme, incompatible API, unknown capability', () => {
    assert.match(checkManifestText('{oops').problems[0], /not valid JSON/);
    assert.match(checkManifestText('  ').problems[0], /empty/);
    assert.match(checkManifestText('x'.repeat(MAX_MANIFEST_BYTES + 1)).problems[0], /larger than/);
    const all = checkManifestText(good({extra: 1, id: 'Bad', entryPoint: '../evil.js', apiVersion: '2.0', capabilities: ['root']})).problems.join('\n');
    for (const re of [/unknown key "extra"/, /id must look like/, /entryPoint must be a relative/, /not compatible with host API/, /unknown capability "root"/]) assert.match(all, re);
    assert.match(checkManifestText(good({entryPoint: 'https://x.example/a.js'})).problems.join(), /entryPoint/);
    assert.equal(checkManifestText('[]').ok, false);
    assert.equal(checkManifestText('null').ok, false);
});

test('the report holds no more than a bounded copy of what the manifest says, and never an object as text', () => {
    const r = checkManifestText(good({name: 'N'.repeat(500), id: 7, dependencies: {'com.other.thing': '^1.2.3'}}));
    assert.equal(r.id, null);
    assert.equal(r.name.length, 60);
    assert.deepEqual(r.dependencies, ['com.other.thing ^1.2.3']);
    assert.equal(r.ok, false);
});
