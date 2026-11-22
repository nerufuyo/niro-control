// Notification Hub in the panel, logic only: input checks, reading Search's answers and its rules file, and every state of the controller.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {checkQuiet, checkRule, checkSnooze, classifyHubError, createHub, MAX_RULES, parseOutcome, parseRules, parseSummary} from '../../control/build/hubLogic.js';

const ok = message => ({ok: true, message, error: '', code: ''});
const refuse = (code, error) => ({ok: false, message: '', error, code});

function fake({hub = true, apply = false, rules = null, quietSummary = '', seen = 0} = {}) {
    const f = {
        hub, apply, files: rules, calls: [], fail: null, outcome: null, gate: null,
        settings: {hubOn: () => f.hub, applyOn: () => f.apply, setHub: v => { f.calls.push(['setHub', v]); f.hub = v; }, setApply: v => { f.calls.push(['setApply', v]); f.apply = v; }},
        backend: {
            async run(id, args) {
                f.calls.push([id, args]);
                if (f.gate) await f.gate;
                if (f.fail) throw f.fail;
                if (f.outcome) return f.outcome;
                if (id === 'notifications.summary') return ok(`${seen} notification${seen === 1 ? '' : 's'} seen; ${(f.files?.rules ?? []).length} rules${quietSummary}; rules are only counted`);
                return ok('done');
            },
            async readRules() { return f.files === null ? null : JSON.stringify(f.files); },
        },
    };
    return f;
}

test('checkRule: what the user typed is checked before Search is asked', () => {
    assert.equal(checkRule('org.gnome.Evolution', 'silent', []), null);
    assert.equal(checkRule('*', 'hide', []), null);
    assert.match(checkRule('', 'hide'), /application's id/);
    assert.match(checkRule('   ', 'hide'), /application's id/);
    assert.match(checkRule('x'.repeat(81), 'hide'), /too long/);
    assert.match(checkRule('a\nb', 'hide'), /not allowed/);
    assert.match(checkRule('app', 'explode'), /show, silent/);
    const full = Array.from({length: MAX_RULES}, (_, i) => ({app: `a${i}`, verdict: 'show'}));
    assert.match(checkRule('new', 'hide', full), /At most/);
    assert.equal(checkRule('a3', 'hide', full), null);          // replacing one is not a new rule
});

test('checkQuiet and checkSnooze', () => {
    assert.equal(checkQuiet('22:00', '07:00'), null);
    assert.match(checkQuiet('25:00', '07:00'), /HH:MM/);
    assert.match(checkQuiet('22:00', '7:00'), /HH:MM/);
    assert.match(checkQuiet('22:00', '22:00'), /same/);
    assert.equal(checkSnooze('org.x', 30), null);
    assert.match(checkSnooze('', 30), /id/);
    assert.match(checkSnooze('org.x', 0), /1 to 1440/);
    assert.match(checkSnooze('org.x', 1441), /1 to 1440/);
    assert.match(checkSnooze('org.x', 'abc'), /1 to 1440/);
});

test('parsers: outcome, summary, rules file; unknown wording is null, not invented', () => {
    assert.deepEqual(parseOutcome('{"ok":true,"message":"hi"}'), {ok: true, message: 'hi', error: '', code: ''});
    assert.equal(parseOutcome('garbage').ok, false);
    const s = parseSummary('12 notifications seen; 2 rules, quiet 22:00 to 07:00; rules are applied\norg.a: 7\norg.b: 5');
    assert.deepEqual(s, {seen: 12, ruleCount: 2, quiet: {from: '22:00', to: '07:00'}, applied: true, apps: [{app: 'org.a', count: 7}, {app: 'org.b', count: 5}]});
    assert.equal(parseSummary('hello').seen, null);
    assert.deepEqual(parseRules('{"rules":[{"app":"a","verdict":"hide"},{"app":"","verdict":"hide"},{"app":"b","verdict":"nope"}],"quiet":{"from":"22:00","to":"07:00"}}'),
        {rules: [{app: 'a', verdict: 'hide'}], quiet: {from: '22:00', to: '07:00'}});
    assert.equal(parseRules(null), null);
    assert.equal(parseRules('{broken'), null);
});

test('classifyHubError: unreachable, refused, other', () => {
    assert.equal(classifyHubError(new Error('org.freedesktop.DBus.Error.ServiceUnknown: not provided')).kind, 'unavailable');
    assert.equal(classifyHubError(new Error('AccessDenied')).kind, 'permission');
    assert.equal(classifyHubError(new Error('GDBus.Error:org.x.Y: boom')).message, 'boom');
});

test('states: disabled when the hub setting is off, without calling Search', async () => {
    const f = fake({hub: false});
    const h = createHub(f.backend, f.settings);
    assert.equal(h.state.view, 'loading');
    await h.refresh();
    assert.equal(h.state.view, 'disabled');
    assert.equal(f.calls.length, 0);
});

test('states: disabled when Search itself says the action is unavailable', async () => {
    const f = fake(); f.outcome = refuse('unavailable', 'turn on Notification Hub');
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    assert.equal(h.state.view, 'disabled');
    assert.match(h.state.message, /Notification Hub/);
});

test('states: empty, then ready with rules, quiet hours and counts', async () => {
    const f = fake();
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    assert.equal(h.state.view, 'empty');
    f.files = {rules: [{app: 'org.a', verdict: 'silent'}], quiet: {from: '22:00', to: '07:00'}};
    await h.refresh();
    assert.equal(h.state.view, 'ready');
    assert.deepEqual(h.state.rules, [{app: 'org.a', verdict: 'silent'}]);
    assert.deepEqual(h.state.quiet, {from: '22:00', to: '07:00'});
});

test('states: unavailable, permission and error on first load; an error later is a notice, not a lost page', async () => {
    for (const [err, view] of [['org.freedesktop.DBus.Error.ServiceUnknown', 'unavailable'], ['AccessDenied', 'permission'], ['weird failure', 'error']]) {
        const f = fake(); f.fail = new Error(err);
        const h = createHub(f.backend, f.settings);
        await h.refresh();
        assert.equal(h.state.view, view, err);
    }
    const f = fake({rules: {rules: [{app: 'org.a', verdict: 'hide'}]}});
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    f.fail = new Error('weird failure');
    await h.refresh();
    assert.equal(h.state.view, 'ready');
    assert.equal(h.state.notice.kind, 'error');
});

test('rules file missing: the list is "unknown", the count from the summary still shows', async () => {
    const f = fake({rules: null});
    f.files = null;
    const h = createHub({run: f.backend.run, readRules: async () => null}, f.settings);
    await h.refresh();
    assert.equal(h.state.rulesKnown, false);
});

test('addRule: invalid input never reaches Search; valid goes through "applying" to success', async () => {
    const f = fake();
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    f.calls.length = 0;
    assert.match(await h.addRule('', 'hide'), /id/);
    assert.equal(f.calls.length, 0);
    let release; f.gate = new Promise(r => { release = r; });
    const seen = [];
    h.subscribe(() => seen.push(h.state.busy));
    const p = h.addRule('org.a', 'hide');
    await Promise.resolve();
    assert.equal(h.state.busy, 'applying');
    assert.equal(await h.addRule('org.b', 'hide'), null);       // a second call while one is out is skipped, not queued
    release(); await p;
    assert.equal(h.state.busy, null);
    assert.deepEqual(f.calls, [['notifications.rule', {app: 'org.a', verdict: 'hide'}]]);
    assert.equal(h.state.notice.kind, 'success');
    assert.deepEqual(h.state.rules, [{app: 'org.a', verdict: 'hide'}]);
    assert.ok(seen.includes('applying'));
});

test('removeRule, quiet hours, snooze and clear send the right action', async () => {
    const f = fake({rules: {rules: [{app: 'org.a', verdict: 'hide'}]}, seen: 4});
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    f.calls.length = 0;
    await h.removeRule('org.a');
    assert.deepEqual(h.state.rules, []);
    assert.match(await h.setQuiet('9:00', '07:00'), /HH:MM/);
    assert.equal(await h.setQuiet('22:00', '07:00'), null);
    assert.deepEqual(h.state.quiet, {from: '22:00', to: '07:00'});
    await h.clearQuiet();
    assert.equal(h.state.quiet, null);
    assert.match(await h.snooze('org.a', 5000), /1 to 1440/);
    await h.snooze('org.a', 30.4);
    await h.clearHistory();
    assert.deepEqual(f.calls, [
        ['notifications.rule', {app: 'org.a', verdict: 'remove'}],
        ['notifications.quiet', {from: '22:00', to: '07:00'}],
        ['notifications.quiet', {from: 'off', to: 'off'}],
        ['notifications.snooze', {app: 'org.a', minutes: 30}],
        ['notifications.clear', {}],
    ]);
});

test('a refusal from Search is shown in its own words; a duplicate is not an error', async () => {
    const f = fake();
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    f.outcome = refuse('failed', 'at most 50 rules');
    await h.addRule('org.a', 'hide');
    assert.equal(h.state.notice.kind, 'error');
    assert.equal(h.state.notice.text, 'at most 50 rules');
    assert.deepEqual(h.state.rules, []);
    f.outcome = refuse('duplicate', 'the same request is already running');
    await h.addRule('org.a', 'hide');
    assert.equal(h.state.notice.kind, 'info');
});

test('switches: the hub switch writes the setting and reloads; the apply switch writes only its own setting', async () => {
    const f = fake({hub: false});
    const h = createHub(f.backend, f.settings);
    await h.refresh();
    await h.setHub(true);
    assert.deepEqual(f.calls[0], ['setHub', true]);
    assert.equal(h.state.view, 'empty');
    await h.setApply(true);
    assert.equal(h.state.applyOn, true);
    f.settings.setHub = () => { throw new Error('read-only'); };
    await h.setHub(false);
    assert.match(h.state.notice.text, /read-only/);
});

test('no notification text can be in state: only application ids and counts are parsed', () => {
    const s = parseSummary('3 notifications seen; 0 rules; rules are only counted\norg.a: 3\nHello, this is a message body: 9');
    assert.deepEqual(Object.keys(s).sort(), ['apps', 'applied', 'quiet', 'ruleCount', 'seen'].sort());
});
