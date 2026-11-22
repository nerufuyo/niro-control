import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry, validateArgs} from '../../shell/search/build/registry.js';
import {registerSharedActions} from '../../shell/search/build/sharedActions.js';

const env = {extensions: () => [
    {uuid: 'niro-dock@x', enabled: true, shellVersions: ['48']},
    {uuid: 'dash-to-dock@micxgx.gmail.com', enabled: true, shellVersions: ['47']},
    {uuid: 'off@x', enabled: false}], shellMajor: () => 48};
const r = registerSharedActions(new Registry(), env);
const go = (id, args) => r.run(id, args, {}, 'external', async () => true);
const get = id => r.get ? r.get(id) : r.list().find(a => a.id === id);

test('shared actions: registered, all need no confirmation', () => {
    for (const id of ['text.transform', 'url.clean', 'clipboard.sensitive.check', 'extensions.check'])
        assert.equal(get(id).permission, 'none');
});

test('text.transform validates its arguments and transforms', async () => {
    const p = get('text.transform').params;
    assert.match(validateArgs(p, {text: 'a'}), /required/);
    assert.match(validateArgs(p, {text: 'a', kind: 'rot13'}), /one of/);
    assert.match(validateArgs(p, {text: 'a', kind: 'upper', x: 1}), /unknown argument/);
    assert.match(validateArgs(p, {text: 'x'.repeat(20001), kind: 'upper'}), /too long/);
    assert.equal((await go('text.transform', {text: 'hello world', kind: 'snake'})).message, 'hello_world');
    assert.equal((await go('text.transform', {text: '{"a":1}', kind: 'json'})).message, '{\n  "a": 1\n}');
    assert.equal((await go('text.transform', {text: '<b>hi</b>', kind: 'plain'})).message, 'hi');
    const bad = await go('text.transform', {text: '{', kind: 'json'});
    assert.equal(bad.ok, false);
});

test('url.clean strips tracking', async () => {
    assert.match(validateArgs(get('url.clean').params, {}), /required/);
    assert.equal((await go('url.clean', {url: 'https://a.com/p?utm_source=x&q=1'})).message, 'https://a.com/p?q=1');
});

test('clipboard.sensitive.check never echoes the text', async () => {
    const secret = 'password: hunter2hunter2';
    const out = await go('clipboard.sensitive.check', {text: secret});
    assert.equal(out.ok, true);
    assert.match(out.message, /sensitive/);
    assert.ok(!out.message.includes('hunter2'));
    assert.equal((await go('clipboard.sensitive.check', {text: 'hello'})).message, 'Looks fine');
});

test('extensions.check reports conflicts and changes nothing', async () => {
    assert.match(validateArgs(get('extensions.check').params ?? [], {a: 1}), /unknown argument/);
    const out = await go('extensions.check', {});
    assert.match(out.message, /Conflict \(high\)/);
    assert.match(out.message, /dash-to-dock/);
    assert.match(out.message, /Not made for this Shell/);
});
