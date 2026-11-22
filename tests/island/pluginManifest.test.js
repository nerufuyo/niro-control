import assert from 'node:assert/strict';
import {test} from 'node:test';

import {authorize, isCompatible, safeRelativePath, uninstallPlan, validateManifest} from '../../shell/shared/pluginManifest.js';
import {createPermissions} from '../../shell/shared/permissions.js';

const good = () => ({id: 'com.example.clock', name: 'Clock', version: '1.2.3', apiVersion: '1.0', capabilities: ['notifications', 'network'],
    permissions: [{capability: 'network', reason: 'fetches the time zone'}], entryPoint: 'dist/main.js', dependencies: {'com.example.base': '^1.0.0'}});

test('a good manifest validates', () => {
    assert.deepEqual(validateManifest(good()), {ok: true, errors: []});
});

test('field checks', () => {
    const bad = (mut, re) => {
        const m = good();
        mut(m);
        const r = validateManifest(m);
        assert.equal(r.ok, false);
        assert.ok(r.errors.some(e => re.test(e)), `${re} in ${r.errors}`);
    };
    bad(m => { m.id = 'Clock'; }, /id/);
    bad(m => { m.name = ''; }, /name/);
    bad(m => { m.version = '1.2'; }, /semver/);
    bad(m => { m.apiVersion = 'one'; }, /apiVersion/);
    bad(m => { m.extra = 1; }, /unknown key/);
    bad(m => { m.permissions = [{capability: 'network'}]; }, /reason/);
    bad(m => { m.capabilities = ['file']; m.permissions = []; }, /needs a permission/);
    bad(m => { m.dependencies = {'com.example.clock': '1.0.0'}; }, /itself/);
    bad(m => { m.dependencies = {'com.example.base': 'latest'}; }, /version like/);
    bad(m => { m.permissions = [{capability: 'device', reason: 'x'}]; }, /not among/);
});

test('unknown capability is refused', () => {
    const m = good();
    m.capabilities = ['root-shell'];
    assert.match(validateManifest(m).errors.join(';'), /unknown capability "root-shell"/);
});

test('entryPoint cannot escape or point somewhere else', () => {
    for (const p of ['../evil.js', 'a/../../evil.js', '/etc/passwd.js', '~/x.js', 'a\\..\\b.js', 'file:///x.js', 'https://x.test/a.js', 'a/./b.js', 'a//b.js', '%2e%2e/x.js', 'x\0.js', '..hidden/x.js', 'main.sh', '']) {
        const m = good();
        m.entryPoint = p;
        assert.equal(validateManifest(m).ok, false, JSON.stringify(p));
    }
    assert.equal(safeRelativePath('lib/main.js'), true);
    assert.equal(safeRelativePath(null), false);
});

test('API compatibility', () => {
    assert.equal(isCompatible('1.0'), true);
    assert.equal(isCompatible('1.1'), false);                 // asks for a newer minor than the host
    assert.equal(isCompatible('2.0'), false);
    assert.equal(isCompatible('1.1', {major: 1, minor: 3}), true);
    assert.equal(isCompatible('x'), false);
    const m = good();
    m.apiVersion = '2.0';
    assert.match(validateManifest(m).errors.join(), /not compatible/);
});

test('authorize enforces declared capability, then the grant', () => {
    const m = good();
    assert.equal(authorize(m, 'device').allowed, false);
    assert.match(authorize(m, 'device').reason, /not declared/);
    assert.match(authorize(m, 'root-shell').reason, /unknown/);
    assert.equal(authorize(m, 'network').verdict, 'ask');
    const perms = createPermissions();
    assert.equal(authorize(m, 'network', perms).verdict, 'ask');
    perms.grant('plugin:com.example.clock', 'network', 'always');
    assert.equal(authorize(m, 'network', perms).allowed, true);
    assert.equal(authorize(m, 'device', perms).allowed, false);   // a grant for one capability does not cover another
    perms.grant('plugin:com.example.clock', 'network', 'deny');
    assert.equal(authorize(m, 'network', perms).allowed, false);
    assert.equal(authorize({...m, entryPoint: '../x.js'}, 'network', perms).allowed, false);   // an invalid manifest gets nothing
});

test('uninstall plan lists owned resources and refuses outside paths', () => {
    const p = uninstallPlan(good(), {files: ['cache/a.json', '../../.ssh/id_rsa'], settings: ['plugin.com.example.clock.zone', 'org.gnome.x'], schedules: ['tick']});
    assert.deepEqual(p.files, ['plugins/com.example.clock/', 'plugins/com.example.clock/cache/a.json']);
    assert.deepEqual(p.settings, ['plugin.com.example.clock.zone']);
    assert.deepEqual(p.refused.sort(), ['../../.ssh/id_rsa', 'org.gnome.x']);
    assert.equal(p.grants.length, 2);
    assert.deepEqual(p.schedules, ['tick']);
});
