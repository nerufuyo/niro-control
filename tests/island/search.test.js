// The search's pure parts: calculator, unit conversion, the action registry.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {calculate} from '../../shell/search/build/calc.js';
import {Registry, validateArgs} from '../../shell/search/build/registry.js';
import {convert} from '../../shell/search/build/units.js';

const calc = q => calculate(q)?.text ?? null;

test('calculator: arithmetic, precedence, brackets, powers, functions', () => {
    assert.equal(calc('1250 * 0.15'), '187.5');
    assert.equal(calc('2 + 3 * 4'), '14');
    assert.equal(calc('(2 + 3) * 4'), '20');
    assert.equal(calc('2^10'), '1,024');
    assert.equal(calc('2 ** 3 ** 2'), '512');
    assert.equal(calc('-3 + 5'), '2');
    assert.equal(calc('sqrt(144) + abs(-2)'), '14');
    assert.equal(calc('10 / 4'), '2.5');
    assert.equal(calc('1,000 * 3'), '3,000');
    assert.equal(calc('7 % 4'), '3');
    assert.equal(calc('2 x 3'), '6');
    assert.equal(calc('0.1 + 0.2'), '0.3');
    assert.equal(calc('2*pi'), '6.283185307');
    assert.equal(calc('1250*0.15='), '187.5');
});

test('calculator: percentages', () => {
    assert.equal(calc('15% of 80'), '12');
    assert.equal(calc('100 + 10%'), '110');
    assert.equal(calc('200 - 25%'), '150');
    assert.equal(calc('50%'), '0.5');
});

test('calculator: what is not a calculation is left alone, and nothing is evaluated as code', () => {
    for (const q of ['firefox', '5', 'hello 2 + 2', '1 +', '(1 + 2', 'process.exit()', 'constructor', '2 + alert(1)', '__proto__', '', '1/0', 'abc * 2', '$(rm -rf)'])
        assert.equal(calculate(q), null, q);
    assert.equal(calculate('1e400 * 10'), null);
});

test('conversion: length, data, time, speed, volume, mass', () => {
    assert.equal(convert('20 GB to MB').text, '20,000 MB');
    assert.equal(convert('1 GiB in MiB').text, '1,024 MiB');
    assert.equal(convert('5 km in miles').text, '3.106855961 mi');
    assert.equal(convert('2 hours to min').text, '120 min');
    assert.equal(convert('100 km/h to mph').text, '62.13711922 mph');
    assert.equal(convert('1 gallon to l').text, '3.785411784 l');
    assert.equal(convert('10 lb to kg').text, '4.5359237 kg');
    assert.equal(convert('1,500 m to km').text, '1.5 km');
});

test('conversion: temperature, and refusals', () => {
    assert.equal(convert('72 f to c').text, '22.222222 °C');
    assert.equal(convert('0 c to k').text, '273.15 K');
    assert.equal(convert('100 celsius to fahrenheit').text, '212 °F');
    assert.equal(convert('5 km to kg'), null);       // different kinds
    assert.equal(convert('5 foo to bar'), null);
    assert.equal(convert('firefox to chrome'), null);
});

const mk = () => {
    const r = new Registry();
    const ran = [];
    r.register({id: 'system.lock', title: 'Lock screen', description: 'Locks the session', category: 'System', keywords: ['sleep', 'secure'], permission: 'none', run: async () => { ran.push('lock'); }});
    r.register({id: 'system.logout', title: 'Log out', description: 'Ends the session', category: 'System', keywords: ['sign out'], permission: 'confirm',
        confirm: 'Log out?', run: async () => { ran.push('logout'); }});
    r.register({id: 'profile.apply', title: 'Apply profile', description: 'Applies a profile', category: 'Niro', keywords: ['theme'], permission: 'none',
        params: [{name: 'id', type: 'enum', required: true, enum: ['everyday', 'gaming']}, {name: 'note', type: 'string', maxLength: 5}],
        available: env => env.profiles ? null : 'Niro Control is not installed', run: async a => `applied ${a.id}`});
    r.register({id: 'system.broken', title: 'Broken', description: 'Always fails', category: 'System', keywords: [], permission: 'none', run: async () => { throw new Error('boom'); }});
    return {r, ran};
};

test('registry: ids are checked and unique, dangerous actions must carry a question', () => {
    const {r} = mk();
    assert.throws(() => r.register({id: 'Bad Id', title: '', description: '', category: '', keywords: [], permission: 'none', run: async () => {}}), /bad action id/);
    assert.throws(() => r.register({id: 'system.lock', title: '', description: '', category: '', keywords: [], permission: 'none', run: async () => {}}), /twice/);
    assert.throws(() => r.register({id: 'system.off', title: '', description: '', category: '', keywords: [], permission: 'confirm', run: async () => {}}), /confirmation question/);
});

test('registry: finding actions ranks title, then keyword, then description; hides what is unavailable', () => {
    const {r} = mk();
    assert.deepEqual(r.find('lock', {profiles: true}).map(a => a.id), ['system.lock']);
    assert.deepEqual(r.find('sign', {profiles: true}).map(a => a.id), ['system.logout']);
    assert.deepEqual(r.find('theme', {profiles: true}).map(a => a.id), ['profile.apply']);
    assert.deepEqual(r.find('theme', {profiles: false}).map(a => a.id), []);
    assert.deepEqual(r.find('ends', {}).map(a => a.id), ['system.logout']);
    assert.equal(r.find('', {}).length, 0);
    assert.equal(r.find('zzz', {}).length, 0);
});

test('registry: arguments are validated, unknown ones refused', () => {
    const p = [{name: 'id', type: 'enum', required: true, enum: ['a']}, {name: 'n', type: 'number', min: 1, max: 5}, {name: 's', type: 'string', maxLength: 3}, {name: 'b', type: 'boolean'}];
    assert.equal(validateArgs(p, {id: 'a'}), null);
    assert.match(validateArgs(p, {}), /required/);
    assert.match(validateArgs(p, {id: 'x'}), /one of/);
    assert.match(validateArgs(p, {id: 'a', n: 9}), /at most 5/);
    assert.match(validateArgs(p, {id: 'a', n: 'x'}), /must be a number/);
    assert.match(validateArgs(p, {id: 'a', s: 'abcd'}), /too long/);
    assert.match(validateArgs(p, {id: 'a', b: 1}), /true or false/);
    assert.match(validateArgs(p, {id: 'a', extra: 1}), /unknown argument/);
});

test('registry: running reports unknown, invalid, unavailable, declined, failed and done, and asks only when it must', async () => {
    const {r, ran} = mk();
    const yes = async () => true, no = async () => false;
    assert.equal((await r.run('nope.x', {}, {}, 'ui', yes)).code, 'unknown');
    assert.equal((await r.run('profile.apply', {id: 'zzz'}, {profiles: true}, 'ui', yes)).code, 'invalid');
    assert.equal((await r.run('profile.apply', {id: 'gaming'}, {}, 'ui', yes)).code, 'unavailable');
    assert.deepEqual(await r.run('profile.apply', {id: 'gaming'}, {profiles: true}, 'ui', yes), {ok: true, message: 'applied gaming'});
    assert.equal((await r.run('system.broken', {}, {}, 'ui', yes)).error, 'boom');
    let asked = 0;
    const count = async () => { asked++; return true; };
    await r.run('system.lock', {}, {}, 'external', count);
    assert.equal(asked, 0, 'a harmless action is not asked about');
    assert.equal((await r.run('system.logout', {}, {}, 'ui', no)).code, 'declined');
    assert.ok(!ran.includes('logout'), 'a declined action must not run');
    assert.equal((await r.run('system.logout', {}, {}, 'external', count)).ok, true);
    assert.equal(asked, 1, 'a dangerous action is asked about');
    assert.equal((await r.run('system.logout', {}, {}, 'ui', async () => { throw new Error('x'); })).code, 'declined');
});

test('registry: the manifest an outside caller sees has no handlers', () => {
    const {r} = mk();
    const m = r.manifest();
    assert.equal(m.length, 4);
    assert.ok(m.every(a => !('run' in a) && a.id && a.permission));
    const withEnv = r.manifest({profiles: false}).find(a => a.id === 'profile.apply');
    assert.equal(withEnv.available, false);
    assert.equal(withEnv.reason, 'Niro Control is not installed');
    assert.equal(r.manifest({profiles: true}).find(a => a.id === 'profile.apply').available, true);
    assert.equal(r.manifest({}).find(a => a.id === 'system.lock').available, true);
});
