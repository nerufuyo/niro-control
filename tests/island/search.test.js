// The search's pure parts: calculator, unit conversion, the action registry.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {calculate} from '../../shell/search/build/calc.js';
import {Registry, validateArgs} from '../../shell/search/build/registry.js';
import {convert, moneyQuery, moneyText} from '../../shell/search/build/units.js';
import {zoneQuery} from '../../shell/search/build/zones.js';
import {fileNeedle, findArgs, rankFiles} from '../../shell/search/build/files.js';
import {toolQuery, parseDate, password} from '../../shell/search/build/tools.js';
import {contentNeedle, defineQuery, definitions, grepArgs, historyMatches, historyNeedle, killName, matchProcesses, qrText, translateQuery, translated} from '../../shell/search/build/lookups.js';
import {qrMatrix, qrPng} from '../../shell/search/build/qrmatrix.js';
import {habitLog, habitQuery, habitStats, markDone, noteLine, noteText, openTodos, recentNotes, todoLine, todoQuery} from '../../shell/search/build/notes.js';
import {describe as weatherLines, forecastUrl, geocodeUrl, parsePlace, weatherQuery, worldQuery} from '../../shell/search/build/weather.js';
import {entities, haQuery, serviceFor, validBase, validEntity} from '../../shell/search/build/homeAssistant.js';
import {agendaQuery, parseEvents, upcoming} from '../../shell/search/build/agenda.js';
import {layoutQuery, planMoves} from '../../shell/search/build/layouts.js';
import {autostartOverride, batteryReport, formatRate, netTotals, parseDesktop, parseNeighbours, parseVpns} from '../../shell/search/build/sysinfo.js';

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

test('money: both sides must be currencies; units stay units', () => {
    assert.deepEqual(moneyQuery('150 usd to idr'), {amount: 150, from: 'USD', to: 'IDR'});
    assert.deepEqual(moneyQuery('20 euro in rupiah'), {amount: 20, from: 'EUR', to: 'IDR'});
    assert.deepEqual(moneyQuery('1,000 JPY = usd'), {amount: 1000, from: 'JPY', to: 'USD'});
    assert.equal(moneyQuery('5 km to miles'), null);
    assert.equal(moneyQuery('20 gb to mb'), null);
    assert.equal(moneyQuery('5 usd to usd'), null);
    assert.equal(moneyQuery('usd to idr'), null);
    assert.equal(moneyText({amount: 150, from: 'USD', to: 'IDR'}, 16200.5), '2,430,075 IDR');
});

test('time zones: the time somewhere, and a time converted between places', () => {
    const now = Date.UTC(2026, 10, 21, 3, 0); // 03:00 UTC, Saturday
    assert.equal(zoneQuery('time in tokyo', now, 'Asia/Jakarta').copy, '12:00');
    assert.match(zoneQuery('jam di new york', now, 'Asia/Jakarta').title, /^New York: 22:00  ·  yesterday$/);
    assert.equal(zoneQuery('10:00 jakarta to london', now, 'Asia/Jakarta').copy, '03:00');
    assert.equal(zoneQuery('9pm wib to tokyo', now, 'UTC').copy, '23:00');
    assert.match(zoneQuery('23:00 london to tokyo', now, 'UTC').title, /\(next day\)$/);
    assert.equal(zoneQuery('14:30 to tokyo', now, 'Asia/Jakarta').copy, '16:30');
    assert.equal(zoneQuery('time in atlantis', now), null);
    assert.equal(zoneQuery('5 km to miles', now), null);
});

test('files: only with the trigger; no shell, no globs from the person; nearer and prefix matches first', () => {
    assert.equal(fileNeedle('f invoice 2026'), 'invoice 2026');
    assert.equal(fileNeedle('cari skripsi'), 'skripsi');
    assert.equal(fileNeedle('firefox'), null);
    assert.equal(fileNeedle('f'), null);
    const args = findArgs('/home/u', 'a*b [x]');
    assert.ok(args.includes('*a\\*b*') && args.includes('*\\[x\\]*'));
    assert.equal(args[0], '/home/u');
    const found = rankFiles(['/home/u/a/b/c/invoice.pdf', '/home/u/old-invoice.txt', '/home/u/Documents/invoice-2026.pdf', ''], 'invoice', '/home/u');
    assert.deepEqual(found.map(f => f.name), ['invoice-2026.pdf', 'invoice.pdf', 'old-invoice.txt']);
    assert.equal(found[0].folder, '~/Documents');
});

test('calculator: names and ans, and 8jt / 5rb / 2k', () => {
    assert.equal(calculate('8jt * 12')?.value, 96000000);
    assert.equal(calculate('5rb + 2k')?.value, 7000);
    assert.equal(calculate('5 km to miles'), null);
    const set = calculate('gaji = 8jt');
    assert.deepEqual([set.assign, set.value], ['gaji', 8000000]);
    assert.equal(calculate('gaji * 12', {gaji: 8000000})?.text, '96,000,000');
    assert.equal(calculate('ans / 2', {ans: 10})?.value, 5);
    assert.equal(calculate('gaji', {gaji: 5}), null);           // a lone name is not a sum
    assert.equal(calculate('sqrt = 4'), null);                  // a function's name cannot be taken
    assert.equal(calculate('foo * 12'), null);                  // an unknown name is not a sum
});

const env = {
    now: Date.UTC(2026, 10, 21, 10), uuid: () => '00000000-0000-4000-8000-000000000000',
    randomBytes: n => Uint8Array.from({length: n}, (_, i) => (i * 37 + 11) % 256),
    hash: (k, t) => `${k}:${t}`,
    base64: (t, d) => d ? Buffer.from(t, 'base64').toString() : Buffer.from(t).toString('base64'),
};
test('tools: dates', () => {
    assert.equal(toolQuery('30 days from now', env).copy, 'Mon, 21 Dec 2026');
    assert.equal(toolQuery('2 minggu lalu', env).copy, 'Sat, 7 Nov 2026');
    assert.equal(toolQuery('1 bulan lagi', env).copy, 'Mon, 21 Dec 2026');
    assert.equal(toolQuery('selisih 1 jan ke 17 agu', env).copy, '228');
    assert.equal(toolQuery('days until 25 dec', env).copy, '34');
    assert.equal(toolQuery('selisih 31 feb ke 1 mar', env), null);   // no such day
    assert.equal(parseDate('2026-08-17', env.now), Date.UTC(2026, 7, 17));
});
test('tools: uuid, passwords, base64, hashes', () => {
    assert.equal(toolQuery('uuid', env).copy, '00000000-0000-4000-8000-000000000000');
    assert.equal(toolQuery('pass 20', env).copy.length, 20);
    assert.equal(toolQuery('pass', env).copy.length, 16);
    assert.equal(toolQuery('pass 2', env).copy.length, 8);          // never shorter than 8
    assert.match(password(env, 30), /^[A-Za-z2-9!#$%&*+=?@^_-]{30}$/);
    assert.equal(toolQuery('b64 halo', env).copy, 'aGFsbw==');
    assert.equal(toolQuery('unb64 aGFsbw==', env).copy, 'halo');
    assert.equal(toolQuery('sha256 abc', env).copy, 'sha256:abc');
    assert.equal(toolQuery('firefox', env), null);
});

test('lookups: translate and define are built from what is typed, and read from the reply', () => {
    const t = translateQuery('tr id good morning');
    assert.deepEqual([t.text, t.to], ['good morning', 'id']);
    assert.match(t.url, /^https:\/\/api\.mymemory\.translated\.net\/get\?q=good%20morning&langpair=Autodetect\|id$/);
    assert.equal(translateQuery('translate selamat pagi to english').to, 'en');
    assert.equal(translateQuery('terjemah hello ke jepang').to, 'ja');
    assert.equal(translateQuery('tr xx hello'), null);                // not a language
    assert.equal(translateQuery('truck id 5'), null);
    assert.equal(translated({responseData: {translatedText: ' Halo '}, responseStatus: 200}), 'Halo');
    assert.equal(translated({responseData: {translatedText: ''}}), null);
    assert.equal(defineQuery('define serendipity').word, 'serendipity');
    assert.equal(defineQuery('define two words'), null);
    assert.deepEqual(definitions([{meanings: [{partOfSpeech: 'noun', definitions: [{definition: 'luck'}, {definition: 'x'}]}, {partOfSpeech: 'verb', definitions: [{definition: 'to find'}]}]}]), ['noun: luck', 'verb: to find']);
    assert.deepEqual(definitions({title: 'No Definitions Found'}), []);
});

test('lookups: qr, kill, history, contents', () => {
    assert.equal(qrText('qr https://a.b'), 'https://a.b');
    assert.equal(qrText('qrcode  hi there '), 'hi there');
    assert.equal(qrText('qrs'), null);
    assert.equal(killName('kill firefox'), 'firefox');
    assert.equal(killName('kill x'), null);
    assert.equal(killName('kill -9 1'), null);
    const ps = ' 100 firefox\n 200 firefox-bin\n 300 gnome-shell\n   1 systemd\n 400 bash\n 500 my-firefox-helper';
    assert.deepEqual(matchProcesses(ps, 'firefox', 999).map(p => p.pid), [100, 200, 500]);
    assert.deepEqual(matchProcesses(ps, 'gnome', 999), []);        // the session is never offered
    assert.deepEqual(matchProcesses(' 100 firefox', 'firefox', 100), []);
    assert.equal(historyNeedle('h docker run'), 'docker run');
    assert.equal(historyNeedle('hello'), null);
    assert.deepEqual(historyMatches(': 1:0;git push\ngit status\n: 2:0;git push\n# note\nls', 'git'), ['git push', 'git status']);
    assert.equal(contentNeedle('fc invoice 2026'), 'invoice 2026');
    assert.equal(contentNeedle('fc ab'), null);
    const args = grepArgs('a b', ['/home/u/Documents']);
    assert.ok(args.includes('-F') && args.includes('--') && args.at(-1) === '/home/u/Documents' && args[args.indexOf('-e') + 1] === 'a b');
});

test('qr: the cells and the PNG exist, and refuse what will not scan', () => {
    const cells = qrMatrix('https://example.com');
    assert.ok(cells.length >= 21 && cells.every(r => r.length === cells.length));
    assert.equal(qrMatrix(''), null);
    assert.equal(qrMatrix('y'.repeat(1200)), null);
    const png = qrPng(cells, 4);
    assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('system readings: battery, VPN, network, neighbours, autostart', () => {
    assert.equal(batteryReport({fullNow: 45000000, fullDesign: 50000000, now: 20000000, rate: 10000000, status: 'Discharging', cycles: 214}), 'Health 90%, 214 cycles, discharging, about 2 h 0 min left');
    assert.equal(batteryReport({fullNow: 50, fullDesign: 50, now: 25, rate: 10, status: 'Charging', cycles: null}), 'Health 100%, charging, about 2 h 30 min to full');
    assert.equal(batteryReport({fullNow: 0, fullDesign: 0, now: 0, rate: 0, status: 'Full', cycles: 3}), '3 cycles, full');
    assert.deepEqual(parseVpns('Wired:ethernet:enp1s0\nwork\\:vpn:vpn:tun0\nhome:wireguard:\nwifi:802-11-wireless:wlp2s0'), [{name: 'work:vpn', type: 'vpn', active: true}, {name: 'home', type: 'wireguard', active: false}]);
    const dev = 'Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n wlan0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0';
    assert.deepEqual(netTotals(dev), {rx: 1300, tx: 2400});
    assert.equal(formatRate(1234567), '1.2 MB/s');
    assert.equal(formatRate(512), '512 B/s');
    assert.deepEqual(parseNeighbours('192.168.1.1 dev wlan0 lladdr AA:BB:CC:DD:EE:FF REACHABLE\n192.168.1.9 dev wlan0  FAILED\n192.168.1.5 dev wlan0 lladdr 11:22:33:44:55:66 STALE').map(n => n.ip), ['192.168.1.1', '192.168.1.5']);
    const d = '[Desktop Entry]\nName=Dropbox\nExec=dropbox\nX-GNOME-Autostart-enabled=true\n[Desktop Action x]\nName=Other';
    assert.deepEqual(parseDesktop(d), {name: 'Dropbox', exec: 'dropbox', hidden: false});
    assert.equal(parseDesktop('[Desktop Entry]\nName=A\nHidden=true').hidden, true);
    assert.equal(parseDesktop('nothing'), null);
    const off = autostartOverride(d, true);
    assert.match(off, /\[Desktop Entry\]\nHidden=true/);
    assert.equal(parseDesktop(off).hidden, true);
    assert.equal(parseDesktop(autostartOverride(off, false)).hidden, false);
});

test('notes, to-dos, habits', () => {
    assert.equal(noteText('note buy milk'), 'buy milk');
    assert.equal(noteText('notes'), null);
    assert.equal(noteLine('2026-11-21 10:30', ' buy   milk '), '- 2026-11-21 10:30 buy milk\n');
    assert.deepEqual(recentNotes('- a\n- b\nnot a note\n- c'), ['c', 'b', 'a']);
    assert.deepEqual(todoQuery('todo call bank'), {add: 'call bank'});
    assert.deepEqual(todoQuery('todos'), {list: true});
    assert.equal(todoQuery('todolist x'), null);
    const file = '- [ ] one\n- [x] two\n- [ ] three\n';
    assert.deepEqual(openTodos(file), ['one', 'three']);
    assert.equal(markDone(file, 'three'), '- [ ] one\n- [x] two\n- [x] three\n');
    assert.equal(markDone(file, 'two'), null);                       // already done
    assert.equal(todoLine('x  y'), '- [ ] x y\n');
    assert.deepEqual(habitQuery('habit Water'), {log: 'water'});
    assert.deepEqual(habitQuery('habits'), {list: true});
    assert.equal(habitQuery('habit a/b'), null);
    const log = '2026-11-18\twater\n2026-11-19\twater\n2026-11-20\twater\n2026-11-20\tgym\n2026-11-15\tgym\n';
    assert.deepEqual(habitStats(log, '2026-11-21'), [{name: 'gym', streak: 1, doneToday: false, total: 2}, {name: 'water', streak: 3, doneToday: false, total: 3}]);
    assert.equal(habitStats(log + '2026-11-21\twater\n', '2026-11-21').find(h => h.name === 'water').streak, 4);
    assert.equal(habitLog(log, '2026-11-20', 'gym'), null);
    assert.equal(habitLog(log, '2026-11-21', 'gym'), '2026-11-21\tgym\n');
});

test('weather, world clock, layouts, Home Assistant', () => {
    assert.equal(weatherQuery('cuaca bandung'), 'bandung');
    assert.equal(weatherQuery('weather new york'), 'new york');
    assert.equal(weatherQuery('weather'), null);
    assert.equal(geocodeUrl('são paulo'), 'https://geocoding-api.open-meteo.com/v1/search?name=s%C3%A3o%20paulo&count=1&language=en&format=json');
    const place = parsePlace({results: [{name: 'Bandung', country: 'Indonesia', latitude: -6.9, longitude: 107.6}]});
    assert.deepEqual(place, {name: 'Bandung', country: 'Indonesia', lat: -6.9, lon: 107.6});
    assert.equal(parsePlace({}), null);
    assert.match(forecastUrl(place), /latitude=-6.9&longitude=107.6&current=/);
    const lines = weatherLines({current: {temperature_2m: 24.4, weather_code: 61, wind_speed_10m: 8.2}, daily: {time: ['d1', 'd2'], temperature_2m_min: [21.2, 22], temperature_2m_max: [28.7, 29], precipitation_probability_max: [60, null], weather_code: [63, 2]}}, place);
    assert.deepEqual(lines, ['Bandung, Indonesia: 24°C, light rain, wind 8 km/h', 'Today: 21–29°C, rain, rain 60%', 'Tomorrow: 22–29°C, partly cloudy, rain 0%']);
    assert.equal(worldQuery('jam dunia'), true);
    assert.equal(worldQuery('world map'), false);
    assert.deepEqual(layoutQuery('layout save Work'), {save: 'work'});
    assert.deepEqual(layoutQuery('layout work'), {restore: 'work'});
    assert.deepEqual(layoutQuery('layouts'), {list: true});
    assert.equal(layoutQuery('layout save'), null);
    const moves = planMoves([{cls: 'a'}, {cls: 'a'}, {cls: 'b'}, {cls: 'c'}], [{cls: 'b'}, {cls: 'a'}, {cls: 'a'}, {cls: 'a'}]);
    assert.deepEqual(moves.map(m => [m.saved.cls, m.index]), [['a', 1], ['a', 2], ['b', 0]]);      // each open window used once; 'c' is not open
    assert.equal(haQuery('ha light'), 'light');
    assert.equal(haQuery('ha'), '');
    assert.equal(haQuery('hash'), null);
    assert.equal(validBase('http://homeassistant.local:8123/'), 'http://homeassistant.local:8123');
    assert.equal(validBase('javascript:alert(1)'), null);
    assert.equal(validBase('ftp://x'), null);
    assert.equal(validEntity('light.kamar_tidur'), true);
    assert.equal(validEntity('lock.front_door'), false);              // locks are not offered
    assert.equal(validEntity('light.x/../y'), false);
    assert.deepEqual(serviceFor('scene.movie'), {domain: 'scene', service: 'turn_on'});
    assert.deepEqual(serviceFor('light.x'), {domain: 'light', service: 'toggle'});
    const list = entities([{entity_id: 'light.kamar', state: 'on', attributes: {friendly_name: 'Lampu Kamar'}}, {entity_id: 'lock.door', state: 'locked'}, {entity_id: 'sensor.t', state: '3'}], 'lampu');
    assert.deepEqual(list, [{id: 'light.kamar', name: 'Lampu Kamar', state: 'on'}]);
});

test('agenda: the coming events with the time left', () => {
    assert.equal(agendaQuery('rapat'), true);
    assert.equal(agendaQuery('rapat tim'), false);
    const events = parseEvents(JSON.stringify([
        {id: 1, title: 'Standup', date: '2026-11-21', start: '09:30', end: '10:00'}, {id: 2, title: 'Past', date: '2026-11-21', start: '08:00'},
        {id: 3, title: 'Dentist', date: '2026-11-22', start: '14:00'}, {id: 4, title: 'Holiday', date: '2026-11-21', start: null},
        {id: 5, title: 'Old', date: '2026-11-20', start: '10:00'}, {id: 6, title: 'Bad', date: 'x'}, {title: 7}]));
    assert.equal(events.length, 5);
    const c = upcoming(events, '2026-11-21', 8 * 60 + 45);
    assert.deepEqual(c.map(e => [e.title, e.text]), [['Holiday', 'today, all day'], ['Standup', 'in 45 min, at 09:30'], ['Dentist', 'in 29 h 15 min, at 14:00']]);
    assert.deepEqual(parseEvents('nonsense'), []);
});
