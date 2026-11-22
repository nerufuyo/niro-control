// Notification rules, performance history, extension conflicts (vNext S20, S25, S29).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {analyze, shortcutClashes} from '../../shell/shared/extensionConflicts.js';
import {decide, inQuietHours, remember, summarize} from '../../shell/shared/notificationRules.js';
import {createHistory, exportDiagnostics, nextInterval, topProcesses} from '../../shell/shared/perfHistory.js';

const at = (h, m = 0) => new Date(2026, 0, 1, h, m);

test('notifications: rules, profile rules, quiet hours, snooze, and critical is never hidden', () => {
    const cfg = {rules: [{app: 'chat', verdict: 'hide'}], quiet: {from: '22:00', to: '07:00'}, snoozed: {mail: at(12).getTime() + 1},
        profileRules: {meeting: [{app: '*', verdict: 'silent'}]}};
    assert.equal(decide({appId: 'chat', urgency: 'normal'}, cfg, {now: at(12)}).verdict, 'hide');
    assert.equal(decide({appId: 'chat', urgency: 'critical'}, cfg, {now: at(12)}).verdict, 'show');
    assert.equal(decide({appId: 'mail', urgency: 'normal'}, cfg, {now: at(12)}).verdict, 'snoozed');
    assert.equal(decide({appId: 'mail', urgency: 'normal'}, cfg, {now: at(13)}).verdict, 'show');
    assert.equal(decide({appId: 'x', urgency: 'normal'}, cfg, {now: at(23)}).verdict, 'silent');
    assert.equal(decide({appId: 'x', urgency: 'critical'}, cfg, {now: at(23)}).verdict, 'show');
    assert.equal(decide({appId: 'x', urgency: 'normal'}, cfg, {now: at(12), profile: 'meeting'}).verdict, 'silent');
    assert.equal(decide({appId: 'x', urgency: 'normal'}, {}, {now: at(12)}).verdict, 'show');
    assert.equal(inQuietHours({from: 'bad', to: '07:00'}, at(1)), false);
});

test('notification history keeps metadata only by default, de-duplicates, and is bounded', () => {
    let h = [];
    h = remember(h, {appId: 'a', urgency: 'normal', title: 'secret subject'}, 1000);
    h = remember(h, {appId: 'a', urgency: 'normal', title: 'secret subject'}, 1500);
    assert.equal(h.length, 1);
    assert.ok(!JSON.stringify(h).includes('secret subject'));
    for (let i = 0; i < 300; i++)
        h = remember(h, {appId: `app${i}`, urgency: 'low'}, 10000 + i * 5000);
    assert.equal(h.length, 200);
    assert.deepEqual(summarize([{appId: 'b'}, {appId: 'a'}, {appId: 'a'}]), [{appId: 'a', count: 2}, {appId: 'b', count: 1}]);
});

test('performance: bounded history, no polling when hidden, numbers-only export with unavailable sensors listed', () => {
    const h = createHistory(3);
    [1, 2, 3, 4].forEach(cpu => h.push({cpu, temp: undefined}));
    assert.equal(h.samples().length, 3);
    assert.equal(h.average('cpu'), 3);
    assert.equal(h.average('temp'), null);
    assert.equal(nextInterval({visible: false, recording: false}), null);
    assert.equal(nextInterval({visible: false, recording: true, onBattery: true}), 60000);
    assert.equal(nextInterval({visible: true, load: 0.9}), 1000);
    assert.equal(nextInterval({visible: true, load: 0.1, onBattery: true}), 4000);
    const report = exportDiagnostics(h, {now: () => 'T', appVersion: '1'});
    assert.ok(report.unavailable.includes('temp') && !('temp' in report.latest));
    assert.equal(report.latest.cpu, 4);
    const procs = topProcesses([{name: 'a', pid: 1, cpu: 1, mem: 1, cmdline: 'x --token=abc'}, {name: 'b', pid: 2, cpu: 9, mem: 1}], 1);
    assert.deepEqual(procs, [{name: 'b', pid: 2, cpu: 9, mem: 1}]);
    assert.ok(!JSON.stringify(topProcesses([{name: 'a', pid: 1, cpu: 1, mem: 1, cmdline: 'x --token=abc'}])).includes('token'));
});

test('extension conflicts are reported with a reason and confidence, can be ignored, and nothing is changed', () => {
    const installed = [
        {uuid: 'niro-dock@niro', enabled: true}, {uuid: 'dash-to-dock@micxgx.gmail.com', enabled: true},
        {uuid: 'niro-tile@niro', enabled: true}, {uuid: 'forge@jmmaranan.com', enabled: false},
        {uuid: 'old@x', enabled: true, shellVersions: ['44']},
    ];
    const r = analyze(installed, 51);
    assert.deepEqual(r.conflicts.map(c => c.id), ['dock-overlap']);
    assert.equal(r.conflicts[0].confidence, 'high');
    assert.match(r.conflicts[0].reason, /same screen edge/);
    assert.deepEqual(r.incompatible.map(e => e.uuid), ['old@x']);
    assert.deepEqual(analyze(installed, 51, ['dock-overlap']).conflicts, []);
    assert.deepEqual(shortcutClashes([{owner: 'a', accel: '<Super>t'}, {owner: 'b', accel: '<Super>t'}, {owner: 'a', accel: '<Super>x'}]), [{accel: '<Super>t', owners: ['a', 'b']}]);
});
