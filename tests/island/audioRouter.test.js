// Smart Audio Router core (vNext 21). Fixtures follow real `pactl -f json` and `wpctl status` output (trimmed).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parsePactlDevices, parsePactlStreams, parseWpctlStatus, planStreamVolume, planRules, createLoopGuard, recordMoves,
    planPreset, planDisconnectFallback} from '../../shell/shared/audioRouter.js';

const vol = v => ({'front-left': {value: Math.round(v * 65536)}, 'front-right': {value: Math.round(v * 65536)}});
const sinksJson = JSON.stringify([
    {index: 59, name: 'alsa_output.pci-0000_05_00.6.analog-stereo', description: 'Ryzen Analog', mute: false, volume: vol(1), active_port: 'lineout',
        ports: [{name: 'lineout', availability: 'tersedia'}]},
    {index: 70, name: 'bluez_output.AA_BB.1', description: 'Headset', mute: false, volume: vol(0.5), active_port: 'hp', ports: [{name: 'hp', availability: 'no'}]},
    {index: 71, name: 'alsa_output.hdmi', description: 'HDMI', mute: true, volume: vol(1)},
    {index: 72, name: 'bad name; rm -rf', description: 'x'},
]);
const inputsJson = JSON.stringify([
    {index: 10, sink: 59, mute: false, corked: false, volume: vol(0.8), properties: {'application.name': 'Firefox', 'application.process.binary': 'firefox', 'media.name': 'Video'}},
    {index: 11, sink: 59, mute: false, volume: vol(1), properties: {'application.name': 'Spotify', 'application.id': 'spotify'}},
]);
const sinks = () => parsePactlDevices(sinksJson);
const streams = () => parsePactlStreams(inputsJson);

test('pactl parsing: devices, availability, volume, unsafe names dropped; garbage tolerated', () => {
    const d = sinks();
    assert.equal(d.length, 3);
    assert.equal(d[0].available, true);          // localised availability is not trusted as "no"
    assert.equal(d[1].available, false);
    assert.equal(d[2].muted, true);
    assert.equal(d[1].volume, 0.5);
    assert.deepEqual(parsePactlDevices('not json'), []);
    assert.deepEqual(parsePactlStreams(null), []);
    const s = streams();
    assert.equal(s[0].appId, 'firefox');
    assert.equal(s[1].appId, 'spotify');
    assert.equal(s[0].volume, 0.8);
});

test('wpctl status parsing', () => {
    const text = `PipeWire 'pipewire-0' [1.6.11]
Audio
 ├─ Devices:
 │      44. GP107GL High Definition Audio Controller [alsa]
 ├─ Sinks:
 │  *   59. Ryzen HD Audio Controller Analog Stereo [vol: 1.00]
 │      61. Headset [vol: 0.40 MUTED]
 ├─ Sources:
 │  *   58. Camera Analog Stereo [vol: 1.00]
 ├─ Streams:
 │      95. Firefox
 │           99. output_FL  > Ryzen:playback_FL [active]

Video
 ├─ Sinks:
 │      12. not audio [vol: 1.00]`;
    const r = parseWpctlStatus(text);
    assert.equal(r.sinks.length, 2);
    assert.equal(r.sinks[0].default, true);
    assert.equal(r.sinks[1].muted, true);
    assert.equal(r.sinks[1].volume, 0.4);
    assert.equal(r.sources.length, 1);
    assert.deepEqual(r.streams, [{id: 95, app: 'Firefox'}]);
    assert.deepEqual(parseWpctlStatus(5), {sinks: [], sources: [], streams: []});
});

test('per-app volume and mute plan: clamped, no boost by default', () => {
    const s = streams()[0];
    assert.deepEqual(planStreamVolume(s, {volume: 2}).commands[0], ['pactl', 'set-sink-input-volume', '10', '100%']);
    assert.equal(planStreamVolume(s, {volume: 2}, {allowBoost: true}).commands[0][3], '150%');
    assert.equal(planStreamVolume(s, {delta: -0.3}).commands[0][3], '50%');
    assert.deepEqual(planStreamVolume(s, {mute: 'toggle'}).commands[0], ['pactl', 'set-sink-input-mute', '10', 'toggle']);
    assert.equal(planStreamVolume(null, {volume: 1}).ok, false);
});

test('rules route a stream to its sink and never change the default', () => {
    const plan = planRules(streams(), [...sinks().map(d => d), ].filter(Boolean), [{app: 'firefox', sink: 'alsa_output.hdmi'}]);
    assert.equal(plan.moves.length, 1);
    assert.deepEqual(plan.commands, [['pactl', 'move-sink-input', '10', 'alsa_output.hdmi']]);
    assert.ok(!JSON.stringify(plan).includes('set-default'));
});

test('rules skip a missing, unavailable or already-used target and report conflicts', () => {
    const d = sinks();
    const r = planRules(streams(), d, [
        {app: 'Firefox', sink: 'gone'}, {app: 'Firefox', sink: 'alsa_output.hdmi'},      // second conflicts
        {app: 'Spotify', sink: 'bluez_output.AA_BB.1'},
    ]);
    const reasons = r.skipped.map(x => x.reason).sort();
    assert.deepEqual(reasons, ['conflict', 'target-missing', 'target-unavailable']);
    assert.equal(planRules(streams(), d, [{app: 'Spotify', sink: d[0].name}]).skipped[0].reason, 'already-there');
    assert.equal(planRules(streams(), d, [{app: 'Spotify', sink: 'alsa_output.hdmi', enabled: false}]).moves.length, 0);
});

test('loop guard stops a stream being moved back and forth', () => {
    const d = sinks();
    const guard = createLoopGuard({max: 2, windowMs: 1000});
    const flip = (sinkIndex, to, now) => {
        const s = [{...streams()[0], sinkIndex}];
        const plan = planRules(s, d, [{app: 'Firefox', sink: to}], {guard, now});
        recordMoves(guard, plan, now);
        return plan;
    };
    assert.equal(flip(59, 'alsa_output.hdmi', 0).moves.length, 1);
    assert.equal(flip(71, d[0].name, 100).moves.length, 1);          // another rule or device flaps it back
    const third = flip(59, 'alsa_output.hdmi', 200);
    assert.equal(third.moves.length, 0);
    assert.equal(third.skipped[0].reason, 'loop-guard');
    assert.equal(flip(59, 'alsa_output.hdmi', 5000).moves.length, 1);   // window passed
});

test('preset: routes and sets volumes by app', () => {
    const p = planPreset({id: 'meeting', name: 'Meeting', rules: [{app: 'Spotify', sink: 'alsa_output.hdmi'}], volumes: {Spotify: 0.2}}, streams(), sinks());
    assert.equal(p.moves.length, 1);
    assert.deepEqual(p.volumeCommands, [['pactl', 'set-sink-input-volume', '11', '20%']]);
});

test('disconnect fallback: prefers the named sink, never changes default unless allowed', () => {
    const d = sinks();
    const on = streams().map(s => ({...s, sinkIndex: 70}));
    const removed = d[1];
    const plan = planDisconnectFallback(on, d, removed, {defaultSink: d[0].name});
    assert.equal(plan.target, d[0].name);
    assert.equal(plan.moves.length, 2);
    assert.equal(plan.defaultChange, null);
    assert.ok(!JSON.stringify(plan.commands).includes('set-default'));
    const withDefault = planDisconnectFallback(on, d, removed, {defaultSink: removed.name, allowDefaultChange: true, preferred: 'alsa_output.hdmi'});
    assert.equal(withDefault.target, 'alsa_output.hdmi');
    assert.deepEqual(withDefault.commands.at(-1), ['pactl', 'set-default-sink', 'alsa_output.hdmi']);
    assert.equal(planDisconnectFallback(on, [removed], removed).reason, 'no-sink-left');
});
