// System Experience (workstream F): the hub that turns the clipboard, notification, performance, audio, HUD, privacy and shelf cores into
// opt-in Search actions. Fake services stand in for the shell: a clock, timers, the daemon's clipboard, /proc, pactl, the OSD.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../../shell/search/build/registry.js';
import {createSystemHub, parseCpu, parseMem, safePactl, micApps, SETTING_KEYS} from '../../shell/search/build/systemHub.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

function rig(prefs = {}, extra = {}) {
    const st = {
        now: 1_000_000, prefs: {...prefs}, timers: new Map(), nextTimer: 1, files: {}, osd: [], pactl: [], watchN: [], watchS: [], removed: [],
        clip: [], clipText: {}, textReads: 0, proc: {}, procReads: 0, sys: {battery: {percent: 80, plugged: true}, camera_in_use: false}, live: {wayland: true, screenShares: 0, recorder: false},
        pactlOut: {}, ...extra,
    };
    const services = {
        pref: (k, d) => (k in st.prefs ? st.prefs[k] : d),
        now: () => st.now,
        setTimer: (ms, fn) => { const id = st.nextTimer++; st.timers.set(id, {ms, fn}); return id; },
        clearTimer: id => st.timers.delete(id),
        sleep: async () => {},
        readConfig: n => st.files[n] ?? null,
        writeConfig: (n, t) => { st.files[n] = t; },
        readProc: async p => { st.procReads++; return st.proc[p] ?? null; },
        systemState: async () => st.sys,
        clipboard: {
            items: async () => st.clip,
            text: async id => { st.textReads++; return st.clipText[id]; },
            remove: async id => { st.removed.push(id); st.clip = st.clip.filter(i => i.id !== id); },
        },
        pactl: async args => {
            st.pactl.push(args);
            const key = args.join(' ');
            if (/^(set|move)-/.test(args[0])) return '';
            if (!(key in st.pactlOut)) throw new Error('Connection failure');
            const v = st.pactlOut[key];
            return typeof v === 'string' ? v : JSON.stringify(v);
        },
        osd: (icon, label, level) => st.osd.push({icon, label, level}),
        privacyLive: async () => st.live,
        watchNotifications: on => st.watchN.push(on),
        watchScreen: on => st.watchS.push(on),
        version: '1.0', shellVersion: '51',
    };
    const hub = createSystemHub(services);
    const r = hub.register(new Registry());
    const go = (id, args = {}) => r.run(id, args, {}, 'ui', async () => true);
    // fire the next due timer (a loop re-arms itself after its function ran)
    const fire = async () => {
        const [id, t] = [...st.timers][0] ?? [];
        if (!id) return false;
        st.timers.delete(id);
        t.fn();
        await new Promise(res => setImmediate(res));
        return true;
    };
    return {st, hub, r, go, fire};
}

const ALL = ['clipboard.smart.sweep', 'notifications.summary', 'notifications.snooze', 'notifications.rule', 'notifications.quiet', 'notifications.clear',
    'perf.report', 'perf.export', 'privacy.status', 'privacy.history', 'audio.devices', 'audio.streams', 'audio.stream.volume', 'audio.stream.move',
    'hud.show', 'collection.list', 'collection.create', 'collection.add', 'collection.remove', 'collection.delete', 'widgets.list', 'widgets.show'];

test('every setting is a known key, and every gated action is unavailable until its setting is on', async () => {
    assert.equal(new Set(SETTING_KEYS).size, 11);
    const {r, go} = rig();
    for (const id of ALL) assert.ok(r.get(id), id);
    const gated = ALL.filter(id => !id.startsWith('perf.'));
    for (const id of gated) {
        const a = r.get(id);
        assert.ok(a.available({}), `${id} is not gated`);
        const args = Object.fromEntries((a.params ?? []).filter(p => p.required).map(p => [p.name, p.type === 'number' ? 1 : p.type === 'enum' ? p.enum[0] : 'x']));
        assert.equal((await go(id, args)).code, 'unavailable', id);
    }
    // the ones that ask first, ask
    for (const id of ['clipboard.smart.sweep', 'audio.stream.volume', 'audio.stream.move', 'collection.delete']) assert.equal(r.get(id).permission, 'confirm', id);
});

test('nothing runs or listens until a setting is on, and stop() leaves nothing behind', () => {
    const {st, hub} = rig();
    hub.sync();
    assert.equal(st.timers.size, 0);
    assert.deepEqual(hub._state().loops, []);
    assert.deepEqual(st.watchN, []);
    assert.deepEqual(st.watchS, []);
    st.prefs = {'smart-clipboard': true, 'perf-recording': true, 'privacy-dashboard': true, 'privacy-history': true, 'notification-hub': true};
    hub.sync();
    hub.sync();                                              // idempotent: no second timer, no second listener
    assert.deepEqual(hub._state().loops.sort(), ['clipboard', 'perf', 'privacy']);
    assert.equal(st.timers.size, 3);
    assert.deepEqual(st.watchN, [true]);
    assert.deepEqual(st.watchS, [true]);
    st.prefs = {};
    hub.sync();
    assert.equal(st.timers.size, 0);
    assert.deepEqual(st.watchN, [true, false]);
    assert.deepEqual(st.watchS, [true, false]);
    st.prefs = {'smart-clipboard': true, 'perf-recording': true, 'notification-hub': true, 'privacy-dashboard': true};
    hub.sync();
    hub.stop();                                              // the extension is disabled
    assert.equal(st.timers.size, 0);
    assert.deepEqual(hub._state().loops, []);
    assert.equal(st.watchN.at(-1), false);
    assert.equal(st.watchS.at(-1), false);
});

// ---- Smart Clipboard
test('clipboard sweep removes secrets and old items, keeps pinned and normal ones, and never repeats the text', async () => {
    const {st, go} = rig({'smart-clipboard': true, 'smart-clipboard-minutes': 30});
    const old = st.now - 31 * 60000;
    st.clip = [
        {id: 1, kind: 'text', pinned: false, at_ms: st.now - 1000},
        {id: 2, kind: 'text', pinned: false, at_ms: st.now - 1000},
        {id: 3, kind: 'text', pinned: true, at_ms: st.now - 1000},
        {id: 4, kind: 'text', pinned: false, at_ms: old},
        {id: 5, kind: 'image', pinned: false, at_ms: st.now - 1000},
        {id: 6, kind: 'link', pinned: false, at_ms: st.now - 1000},
        {id: 7, kind: 'text', pinned: true, at_ms: old},
    ];
    st.clipText = {1: 'shopping list', 2: SECRET, 3: SECRET, 4: 'hello', 5: undefined, 6: 'https://example.org/'};
    const out = await go('clipboard.smart.sweep');
    assert.equal(out.ok, true);
    assert.match(out.message, /Removed 1 secret and 1 old item; 5 kept/);
    assert.ok(!out.message.includes('ghp_'));
    assert.deepEqual(st.removed.sort(), [2, 4]);              // 3 and 7 are pinned: the person's choice; 5 is an image
    assert.ok(!st.clip.some(i => i.id === 2));
    // text is read once per item, not every minute
    const reads = st.textReads;
    await go('clipboard.smart.sweep');
    assert.equal(st.textReads, reads);
});

test('clipboard loop: first look soon, then every minute; with minutes 0 nothing old is removed', async () => {
    const {st, hub, fire} = rig({'smart-clipboard': true, 'smart-clipboard-minutes': 0});
    st.clip = [{id: 1, kind: 'text', pinned: false, at_ms: st.now - 10 * 86400000}, {id: 2, kind: 'text', pinned: false, at_ms: st.now}];
    st.clipText = {1: 'old but fine', 2: 'password: hunter2hunter2'};
    hub.sync();
    assert.equal([...st.timers.values()][0].ms, 3000);
    await fire();
    assert.deepEqual(st.removed, [2]);
    assert.equal([...st.timers.values()][0].ms, 60000);
    hub.stop();
});

test('a clipboard that cannot be read is not an error that stops the loop', async () => {
    const {st, hub, fire} = rig({'smart-clipboard': true});
    st.clip = null;                                          // the daemon sent nothing useful
    hub.sync();
    await fire();
    assert.equal(st.timers.size, 1);                         // armed again
    hub.stop();
});

// ---- Notification Hub
test('notification hub: metadata only, rules decide, apply is a separate switch, critical is never hidden', async () => {
    const {st, hub, go} = rig({'notification-hub': true});
    hub.sync();
    assert.deepEqual(st.watchN, [true]);
    assert.equal((await go('notifications.rule', {app: 'chat', verdict: 'hide'})).ok, true);
    assert.match(JSON.parse(st.files['notification-rules.json']).rules[0].app, /chat/);
    const tick = () => { st.now += 3000; };
    let o = hub.onNotification({appId: 'chat', urgency: 'normal', title: 'secret subject', body: 'secret body'});
    assert.deepEqual([o.verdict, o.apply], ['hide', false]);                         // counted, not applied
    st.prefs['notification-hub-apply'] = true;
    tick(); o = hub.onNotification({appId: 'chat', urgency: 'normal'});
    assert.deepEqual([o.verdict, o.apply], ['hide', true]);
    tick(); assert.equal(hub.onNotification({appId: 'chat', urgency: 'critical'}).verdict, 'show');
    tick(); assert.equal(hub.onNotification({appId: 'mail', urgency: 'low'}).verdict, 'show');
    const sum = await go('notifications.summary');
    assert.match(sum.message, /4 notifications seen; 1 rule/);
    assert.match(sum.message, /chat: 3/);
    assert.match(sum.message, /mail: 1/);
    assert.ok(!JSON.stringify(st).includes('secret subject') && !JSON.stringify(st).includes('secret body'));
    assert.equal((await go('notifications.rule', {app: 'chat', verdict: 'remove'})).ok, true);
    assert.equal(hub.onNotification({appId: 'chat', urgency: 'normal'}).verdict, 'show');
});

test('notification hub: snooze, quiet hours, bad input, bounded history, off forgets everything', async () => {
    const {st, hub, go} = rig({'notification-hub': true, 'notification-hub-apply': true});
    hub.sync();
    await go('notifications.snooze', {app: 'mail', minutes: 10});
    assert.equal(hub.onNotification({appId: 'mail', urgency: 'normal'}).verdict, 'snoozed');
    assert.equal(hub.onNotification({appId: 'mail', urgency: 'critical'}).verdict, 'show');
    st.now += 11 * 60000;
    assert.equal(hub.onNotification({appId: 'mail', urgency: 'normal'}).verdict, 'show');
    assert.equal((await go('notifications.quiet', {from: '25:00', to: '07:00'})).ok, false);
    assert.equal((await go('notifications.quiet', {from: '00:00', to: '23:59'})).ok, true);
    assert.equal(hub.onNotification({appId: 'x', urgency: 'normal'}).verdict, 'silent');
    assert.equal(hub.onNotification({appId: 'x', urgency: 'critical'}).verdict, 'show');
    await go('notifications.quiet', {from: 'off', to: 'off'});
    assert.equal(hub.onNotification({appId: 'x', urgency: 'normal'}).verdict, 'show');
    for (let i = 0; i < 300; i++) { st.now += 5000; hub.onNotification({appId: `app${i}`, urgency: 'low'}); }
    assert.equal(hub._state().history, 200);
    for (let i = 0; i < 50; i++) await go('notifications.rule', {app: `r${i}`, verdict: 'silent'});
    assert.equal((await go('notifications.rule', {app: 'one-too-many', verdict: 'silent'})).ok, false);
    st.prefs['notification-hub'] = false;
    hub.sync();
    assert.equal(hub.onNotification({appId: 'x', urgency: 'normal'}), null);
    assert.equal(hub._state().history, 0);
    assert.deepEqual(st.watchN, [true, false]);
});

test('notification rules file is untrusted: junk is ignored', async () => {
    const {st, hub} = rig({'notification-hub': true, 'notification-hub-apply': true}, {files: {'notification-rules.json': JSON.stringify({rules: [{app: 'a', verdict: 'rm -rf'}, {app: 5, verdict: 'hide'}, {app: 'ok', verdict: 'hide'}], quiet: {from: 'x', to: 'y'}})}});
    hub.sync();
    assert.equal(hub.onNotification({appId: 'ok', urgency: 'normal'}).verdict, 'hide');
    assert.equal(hub.onNotification({appId: 'a', urgency: 'normal'}).verdict, 'show');
    void st;
});

// ---- Performance Center
const STAT = (idle, busy) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 1 1 1 0 0 0 0 0 0\n`;
const MEM = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n';

test('performance parsers', () => {
    assert.deepEqual(parseCpu(STAT(900, 100)), {total: 1000, idle: 900});
    assert.equal(parseCpu('nothing'), null);
    const m = parseMem(MEM);
    assert.equal(m.memTotal, 16000000 * 1024);
    assert.equal(m.memUsed, 8000000 * 1024);
    assert.equal(m.swapUsed, 500000 * 1024);
    assert.deepEqual(parseMem(''), {memTotal: undefined, memUsed: undefined, swapUsed: undefined});
});

test('perf.report: a reading on demand keeps nothing; recording is slow, bounded, and cleared when switched off', async () => {
    const {st, hub, go, fire} = rig();
    st.proc = {'/proc/stat': STAT(900, 100), '/proc/meminfo': MEM, '/proc/loadavg': '0.82 0.5 0.3 1/200 123\n'};
    const first = await go('perf.report');
    assert.equal(first.ok, true);
    assert.match(first.message, /Memory 7\.6 GB of 15\.3 GB/);
    assert.match(first.message, /Swap 0\.5 GB/);
    assert.match(first.message, /Load 0\.82/);
    assert.match(first.message, /Battery 80%/);
    assert.match(first.message, /Recording is off/);
    assert.equal(hub._state().perf, 0);                       // nothing kept
    // recording
    st.prefs['perf-recording'] = true;
    hub.sync();
    assert.equal([...st.timers.values()][0].ms, 30000);
    st.sys = {battery: {percent: 50, plugged: false}};
    await fire();                                             // first sample (battery state is learned from it)
    assert.equal([...st.timers.values()][0].ms, 60000);       // slower on battery
    st.proc['/proc/stat'] = STAT(1700, 300);
    await fire();
    assert.equal(hub._state().perf, 2);
    // a report right after reuses the reading: no second poll of /proc
    const reads = st.procReads;
    const rep = await go('perf.report');
    assert.equal(st.procReads, reads);
    assert.match(rep.message, /CPU 20%/);
    assert.match(rep.message, /Recording: 2 of 360/);
    for (let i = 0; i < 400; i++) { st.now += 60000; await fire(); }
    assert.equal(hub._state().perf, 360);                      // bounded
    st.prefs['perf-recording'] = false;
    hub.sync();
    assert.equal(hub._state().perf, 0);
    assert.equal(st.timers.size, 0);
});

test('perf.export carries numbers only and lists what is unavailable', async () => {
    const {st, go} = rig();
    st.proc = {'/proc/stat': STAT(900, 100), '/proc/meminfo': MEM, '/proc/loadavg': '0.1 0 0 1/2 3'};
    const out = await go('perf.export');
    const report = JSON.parse(out.message);
    assert.ok(report.unavailable.includes('temp') && report.unavailable.includes('diskUsed'));
    assert.ok(Number.isFinite(report.latest.memUsed));
    assert.equal(report.appVersion, '1.0');
    assert.ok(!/cmdline|environ|token|password/i.test(out.message));
    const again = JSON.parse((await go('perf.export')).message);
    assert.equal(again.samples, 1);                            // the on-demand reading was not kept
});

// ---- Audio Router
const SINKS = [
    {index: 1, name: 'alsa_output.speakers', description: 'Speakers', mute: false, volume: {'front-left': {value: 65536}}, active_port: 'p', ports: [{name: 'p', availability: 'available'}]},
    {index: 2, name: 'alsa_output.headphones', description: 'Headphones', mute: false, volume: {'front-left': {value: 32768}}, active_port: 'p', ports: [{name: 'p'}]},
];
const INPUTS = [
    {index: 40, sink: 1, mute: false, corked: false, volume: {'front-left': {value: 65536}}, properties: {'application.name': 'Firefox', 'media.name': 'Song'}},
    {index: 41, sink: 2, mute: false, corked: false, volume: {'front-left': {value: 65536}}, properties: {'application.name': 'Player'}},
];
const audioRig = () => rig({'audio-router': true}, {pactlOut: {
    '-f json list sinks': SINKS, '-f json list sources': [{index: 5, name: 'mic', description: 'Mic', volume: {}}, {index: 6, name: 'alsa_output.speakers.monitor', description: 'Monitor', monitor_of_sink: 1, volume: {}}],
    '-f json list sink-inputs': INPUTS, 'get-default-sink': 'alsa_output.speakers\n',
}});

test('audio: only a fixed set of pactl commands can run', () => {
    assert.deepEqual(safePactl(['move-sink-input', '40', 'alsa_output.x']), ['move-sink-input', '40', 'alsa_output.x']);
    for (const bad of [['set-default-sink', 'x'], ['move-sink-input', '40; rm', 'x'], ['move-sink-input', 'x', 'a b'], ['set-sink-input-volume', '1', '900000%'], ['load-module', 'x'], ['-f', 'json', 'list', 'cards'], []])
        assert.throws(() => safePactl(bad), /not allowed/, JSON.stringify(bad));
});

test('audio.devices and audio.streams read through pactl and change nothing', async () => {
    const {st, go} = audioRig();
    const d = await go('audio.devices');
    assert.match(d.message, /\* Speakers \(100%\)/);
    assert.match(d.message, /Headphones \(50%\)/);
    assert.ok(!d.message.includes('Monitor'));
    const s = await go('audio.streams');
    assert.match(s.message, /Firefox \(Song\): 100% on Speakers/);
    assert.match(s.message, /Player: 100% on Headphones/);
    assert.ok(st.pactl.every(a => a[0] === '-f' || a[0] === 'get-default-sink'));
});

test('audio: volume and move are checked, planned by the core, run as fixed commands, and the default output is never changed', async () => {
    const {st, go} = audioRig();
    assert.equal((await go('audio.stream.volume', {app: 'Firefox'})).ok, false);          // neither percent nor mute
    assert.equal((await go('audio.stream.volume', {app: 'Nobody', percent: 10})).ok, false);
    const v = await go('audio.stream.volume', {app: 'firefox', percent: 30, mute: 'on'});
    assert.equal(v.ok, true);
    assert.deepEqual(st.pactl.filter(a => a[0].startsWith('set-sink-input')), [['set-sink-input-volume', '40', '30%'], ['set-sink-input-mute', '40', '1']]);
    assert.equal((await go('audio.stream.volume', {app: 'Firefox', percent: 101})).code, 'invalid');   // no boost
    st.pactl.length = 0;
    assert.equal((await go('audio.stream.move', {app: 'Firefox', output: 'nothing like it'})).ok, false);
    assert.equal((await go('audio.stream.move', {app: 'Firefox', output: 'alsa_output'})).ok, false);   // two outputs match
    assert.match((await go('audio.stream.move', {app: 'Firefox', output: 'speakers'})).error, /already plays/);
    const m = await go('audio.stream.move', {app: 'Firefox', output: 'headphones'});
    assert.equal(m.ok, true, m.error);
    assert.deepEqual(st.pactl.at(-1), ['move-sink-input', '40', 'alsa_output.headphones']);
    assert.ok(!st.pactl.some(a => a[0] === 'set-default-sink'));
    // the loop guard: the same app moved back and forth is stopped
    st.pactl.length = 0;
    st.pactlOut['-f json list sink-inputs'] = [{...INPUTS[0], sink: 2}, INPUTS[1]];
    assert.equal((await go('audio.stream.move', {app: 'Firefox', output: 'speakers'})).ok, true);
    st.pactlOut['-f json list sink-inputs'] = INPUTS;
    const third = await go('audio.stream.move', {app: 'Firefox', output: 'headphones'});
    assert.equal(third.ok, false);
    assert.match(third.error, /twice in the last minute/);
});

test('audio: when the sound server is not there, the action says so', async () => {
    const {go} = rig({'audio-router': true});
    const o = await go('audio.devices');
    assert.equal(o.ok, false);
    assert.match(o.error, /Connection failure/);
});

// ---- Universal HUD
test('hud.show goes to the on-screen display, dedupes, and clamps', async () => {
    const {st, hub, go} = rig({'universal-hud': true});
    hub.sync();
    assert.equal((await go('hud.show', {kind: 'battery', label: 'Battery 40%', level: 40})).ok, true);
    assert.deepEqual(st.osd[0], {icon: 'battery-symbolic', label: 'Battery 40%', level: 0.4});
    assert.equal((await go('hud.show', {kind: 'custom', label: 'Saved'})).ok, true);
    assert.equal(st.osd[1].level, null);
    assert.equal((await go('hud.show', {kind: 'volume', level: 150})).code, 'invalid');
    assert.equal((await go('hud.show', {kind: 'bogus'})).code, 'invalid');
    assert.equal((await go('hud.show', {kind: 'x'.repeat(10), label: 'y'.repeat(81)})).code, 'invalid');
    st.prefs['universal-hud'] = false;
    hub.sync();
    assert.equal((await go('hud.show', {kind: 'battery'})).code, 'unavailable');
});

// ---- Privacy
test('privacy: mic apps exclude level meters, corked and speaker-monitor captures', () => {
    const sources = JSON.stringify([{index: 5, name: 'mic', description: 'Mic', volume: {}}, {index: 6, name: 'x.monitor', description: 'M', monitor_of_sink: 1, volume: {}}]);
    const outs = JSON.stringify([
        {index: 1, source: 5, corked: false, properties: {'application.name': 'Zoom'}},
        {index: 2, source: 6, corked: false, properties: {'application.name': 'Equalizer'}},
        {index: 3, source: 5, corked: true, properties: {'application.name': 'Idle'}},
    ]);
    assert.deepEqual(micApps(outs, sources), [{kind: 'mic', app: 'Zoom'}]);
    assert.deepEqual(micApps('not json', sources), []);
});

test('privacy.status says unknown where GNOME does not tell, and history is opt-in, bounded and cleared', async () => {
    const out = {'-f json list source-outputs': [{index: 1, source: 5, corked: false, properties: {'application.name': 'Zoom'}}], '-f json list sources': [{index: 5, name: 'mic', description: 'Mic', volume: {}}]};
    const {st, hub, go, fire} = rig({'privacy-dashboard': true}, {pactlOut: out});
    hub.sync();
    assert.deepEqual(st.watchS, [true]);
    st.sys = {camera_in_use: true};
    st.live = {wayland: true, screenShares: 1, recorder: false};
    let o = await go('privacy.status');
    assert.match(o.message, /Microphone: in use by Zoom/);
    assert.match(o.message, /Camera: in use/);
    assert.match(o.message, /Screen sharing: in use/);
    assert.match(o.message, /Screen recording: not in use/);
    st.live = {wayland: false, screenShares: 0, recorder: null};
    o = await go('privacy.status');
    assert.match(o.message, /Screen sharing: unknown \(On X11/);
    assert.match(o.message, /Screen recording: unknown/);
    assert.match((await go('privacy.history')).message, /Not remembering/);
    // history on
    st.prefs['privacy-history'] = true;
    hub.sync();
    assert.equal([...st.timers.values()][0].ms, 20000);
    await fire();
    st.now += 60000;
    const h = await go('privacy.history');
    assert.match(h.message, /mic {2}Zoom/);
    st.prefs['privacy-history'] = false;
    hub.sync();
    assert.equal(st.timers.size, 0);
    st.prefs['privacy-history'] = true;
    hub.sync();
    assert.match((await go('privacy.history')).message, /Nothing recorded yet/);       // switching off cleared it
    hub.stop();
});

test('privacy.status without a sound server: the microphone is unknown, not "not in use"', async () => {
    const {go} = rig({'privacy-dashboard': true});
    const o = await go('privacy.status');
    assert.match(o.message, /Microphone: unknown \(The sound server was not reachable/);
});

// ---- Shelf collections
test('shelf collections: references only, saved privately, secrets refused, nothing about the files touched', async () => {
    const {st, hub, go} = rig({'shelf-collections': true});
    hub.sync();
    assert.match((await go('collection.list')).message, /No collections yet/);
    assert.equal((await go('collection.create', {name: 'Trip'})).ok, true);
    assert.equal((await go('collection.create', {name: 'trip'})).ok, false);                  // name taken, case-insensitive
    assert.equal((await go('collection.add', {name: 'Trip', kind: 'file', value: '/home/me/My Docs/a b.pdf'})).ok, true);
    assert.equal((await go('collection.add', {name: 'Trip', kind: 'url', value: 'https://example.org/x'})).ok, true);
    assert.equal((await go('collection.add', {name: 'Trip', kind: 'url', value: 'javascript:alert(1)'})).ok, false);
    assert.equal((await go('collection.add', {name: 'Trip', kind: 'text', value: 'meet at 9'})).ok, true);
    const secret = await go('collection.add', {name: 'Trip', kind: 'text', value: SECRET});
    assert.equal(secret.ok, false);
    assert.ok(!JSON.stringify(st.files).includes('ghp_'));
    assert.equal((await go('collection.add', {name: 'Nope', kind: 'text', value: 'x'})).ok, false);
    const list = await go('collection.list', {name: 'trip'});
    assert.match(list.message, /1\. file:\/\/\/home\/me\/My%20Docs\/a%20b\.pdf/);
    assert.match(list.message, /3\. "meet at 9"/);
    assert.match((await go('collection.list')).message, /Trip: 3 items/);
    const saved = JSON.parse(st.files['shelf-collections.json']);
    assert.equal(saved.collections[0].items.length, 3);
    // a new hub (a new session) reads it back
    const again = rig({'shelf-collections': true}, {files: {...st.files}});
    assert.match((await again.go('collection.list')).message, /Trip: 3 items/);
    assert.equal((await go('collection.remove', {name: 'Trip', item: 2})).ok, true);
    assert.equal((await go('collection.remove', {name: 'Trip', item: 9})).ok, false);
    assert.equal((await go('collection.delete', {name: 'Trip'})).ok, true);
    assert.match((await go('collection.list')).message, /No collections yet/);
    // switched off: nothing in memory, the file stays for next time
    st.prefs['shelf-collections'] = false;
    hub.sync();
    assert.equal((await go('collection.list')).code, 'unavailable');
});

test('shelf collections: a file that is not ours is ignored; expired collections go', async () => {
    const bad = rig({'shelf-collections': true}, {files: {'shelf-collections.json': '{"collections": [{"id": "x1", "name": "../../etc"}, {"id": "c1", "name": "ok", "items": [{"id": "i1", "kind": "file", "uri": "javascript:1"}]}]}'}});
    assert.match((await bad.go('collection.list')).message, /ok: 0 items/);
    const {st, go} = rig({'shelf-collections': true});
    await go('collection.create', {name: 'Temp', hours: 1});
    const next = rig({'shelf-collections': true}, {files: {...st.files}, now: st.now + 2 * 3600000});
    assert.match((await next.go('collection.list')).message, /No collections yet/);
});

test('the cores work where there is no global URL class (GNOME Shell\'s JavaScript has none)', async () => {
    const saved = globalThis.URL;
    delete globalThis.URL;
    try {
        const {cleanUrl} = await import('../../shell/shared/clipboardTools.js');
        const {createShelf} = await import('../../shell/shared/shelfCollections.js');
        assert.equal(typeof URL, 'undefined');
        assert.equal(cleanUrl('https://a.com/p?utm_source=x&q=1&fbclid=2#top'), 'https://a.com/p?q=1#top');
        assert.equal(cleanUrl('https://a.com?utm_source=x'), 'https://a.com/');
        assert.equal(cleanUrl('javascript:alert(1)'), 'javascript:alert(1)');
        assert.equal(cleanUrl('see https://a.com'), 'see https://a.com');
        const shelf = createShelf();
        const c = shelf.create('t').id;
        assert.equal(shelf.add(c, {kind: 'url', uri: 'https://example.org/x'}).ok, true);
        assert.equal(shelf.add(c, {kind: 'file', uri: 'file:///home/u/a%20b.pdf'}).ok, true);
        assert.equal(shelf.add(c, {kind: 'image', uri: 'https://example.org/i.png'}).ok, true);
        for (const bad of [{kind: 'url', uri: 'javascript:alert(1)'}, {kind: 'url', uri: 'https://'}, {kind: 'url', uri: 'https://a b.org'}, {kind: 'file', uri: 'file://'}, {kind: 'file', uri: 'https://x.org/a'}, {kind: 'file', uri: 'file:///'}])
            assert.equal(shelf.add(c, bad).ok, false, JSON.stringify(bad));
    } finally { globalThis.URL = saved; }
});

test('widgets: off by default; on, they list and show from one shared reading, nothing polls, and off drops the hub', async () => {
    const {st, hub, go} = rig();
    assert.equal((await go('widgets.show')).code, 'unavailable');
    st.proc = {'/proc/stat': STAT(900, 100), '/proc/meminfo': MEM, '/proc/loadavg': '0.82 0.5 0.3 1/200 123\n'};
    st.prefs['widgets-in-search'] = true;
    hub.sync();
    assert.equal(hub._state().widgets, 4);
    assert.equal(st.timers.size, 0);                           // manual refresh: no timer
    const list = await go('widgets.list');
    assert.match(list.message, /system\.cpu[^\n]*reads perf/);
    const before = st.procReads;
    const shown = await go('widgets.show');
    assert.match(shown.message, /Memory: 7\.6 GB of 15\.3 GB/);
    assert.match(shown.message, /Load: 0\.82/);
    assert.match(shown.message, /Battery: 80%/);
    assert.equal(st.procReads - before, 6);                    // one reading (two passes for the CPU delta), not one per widget
    assert.equal(hub._state().perf, 0);                        // nothing kept
    assert.match((await go('widgets.show', {id: 'system.load'})).message, /^Load: 0\.82$/);
    assert.equal((await go('widgets.show', {id: 'nope'})).ok, false);
    st.prefs['widgets-in-search'] = false;
    hub.sync();
    assert.equal(hub._state().widgets, 0);
    assert.equal((await go('widgets.list')).code, 'unavailable');
    st.prefs['widgets-in-search'] = true; hub.sync(); hub.stop();
    assert.equal(hub._state().widgets, 0);
});
