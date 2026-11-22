import assert from 'node:assert/strict';
import {test} from 'node:test';

import {EXAMPLES, NOT_UNDERSTOOD, buildProviderPrompt, buildReport, describePlan, localParse, looksSensitive, needsConfirmation, parseProviderPlan, redactForProvider, undoPlan, validateArgs, validatePlan} from '../../shell/shared/commandPlanner.js';
import {createPermissions} from '../../shell/shared/permissions.js';

const CAT = [
    {id: 'app.launch', title: 'Open application', params: [{name: 'id', type: 'string', required: true, maxLength: 200}], permission: 'none'},
    {id: 'profile.apply', title: 'Apply profile', params: [{name: 'id', type: 'string', required: true, maxLength: 60}], permission: 'none'},
    {id: 'profile.undo', title: 'Undo profile', params: [], permission: 'none'},
    {id: 'system.wifi.toggle', title: 'Toggle Wi-Fi', params: [], permission: 'none', capability: 'device'},
    {id: 'system.clean.trash', title: 'Empty the trash', params: [], permission: 'confirm'},
    {id: 'window.move-to-workspace', title: 'Move window', params: [{name: 'app', type: 'string', required: true}, {name: 'workspace', type: 'number', required: true, min: 1, max: 10}], permission: 'none'},
];
const CAT3 = [...CAT,
    {id: 'clipboard.copy', title: 'Copy text', params: [{name: 'text', type: 'string', required: true, maxLength: 10000}], permission: 'none'},
    {id: 'system.lock', title: 'Lock screen', params: [], permission: 'none'},
    {id: 'system.mute.toggle', title: 'Mute', params: [], permission: 'none'},
    {id: 'system.screenshot', title: 'Screenshot', params: [], permission: 'none'}];
const cat2 = CAT.filter(a => a.id !== 'window.move-to-workspace');

test('validateArgs matches the registry rules', () => {
    const p = [{name: 'n', type: 'number', min: 1, max: 3}, {name: 'e', type: 'enum', enum: ['a']}];
    assert.equal(validateArgs(p, {n: 2, e: 'a'}), null);
    assert.match(validateArgs(p, {n: 9}), /at most 3/);
    assert.match(validateArgs(p, {e: 'b'}), /one of/);
    assert.match(validateArgs(p, {x: 1}), /unknown argument/);
    assert.match(validateArgs(p, {n: NaN}), /number/);
});

test('validatePlan accepts catalog actions and refuses everything else', () => {
    assert.equal(validatePlan({steps: [{action: 'app.launch', args: {id: 'firefox'}}]}, CAT).ok, true);
    assert.match(validatePlan({steps: [{action: 'rm.rf', args: {}}]}, CAT).errors[0].error, /no action/);
    assert.match(validatePlan({steps: [{action: 'app.launch', args: {}}]}, CAT).errors[0].error, /required/);
    assert.match(validatePlan({steps: [{action: 'app.launch', args: {id: 'x', extra: 1}}]}, CAT).errors[0].error, /unknown argument/);
    assert.equal(validatePlan({unknown: true}, CAT).ok, false);
    assert.equal(validatePlan({steps: []}, CAT).ok, false);
    assert.equal(validatePlan(null, CAT).ok, false);
    const many = {steps: Array.from({length: 9}, () => ({action: 'profile.undo', args: {}}))};
    assert.equal(validatePlan(many, CAT).ok, false);
    assert.equal(validatePlan(many, CAT, {maxSteps: 9}).ok, true);
});

test('localParse maps Indonesian and English onto catalog actions only', () => {
    assert.deepEqual(localParse('buka firefox', CAT).steps, [{action: 'app.launch', args: {id: 'firefox'}}]);
    assert.deepEqual(localParse('Open Firefox', CAT).steps[0].args, {id: 'firefox'});
    assert.deepEqual(localParse('aktifkan focus mode', CAT).steps, [{action: 'profile.apply', args: {id: 'focus'}}]);
    assert.deepEqual(localParse('pindahkan browser ke workspace 2', CAT).steps, [{action: 'window.move-to-workspace', args: {app: 'browser', workspace: 2}}]);
    assert.deepEqual(localParse('matikan wifi', CAT).steps, [{action: 'system.wifi.toggle', args: {}}]);
    assert.equal(localParse('buka firefox lalu aktifkan focus mode', CAT).steps.length, 2);
});

test('localParse never invents: missing action, bad args, gibberish all give unknown', () => {
    assert.deepEqual(localParse('pindahkan browser ke workspace 2', cat2), {unknown: true});
    assert.deepEqual(localParse('pindahkan browser ke workspace 99', CAT), {unknown: true});
    assert.deepEqual(localParse('hapus semua file saya', CAT), {unknown: true});
    assert.deepEqual(localParse('buka firefox lalu hapus semuanya', CAT), {unknown: true});
    assert.deepEqual(localParse('', CAT), {unknown: true});
    assert.deepEqual(localParse(42, CAT), {unknown: true});
    assert.deepEqual(localParse('buka firefox', []), {unknown: true});
});

test('describePlan and needsConfirmation', () => {
    const plan = {steps: [{action: 'app.launch', args: {id: 'firefox'}}, {action: 'system.clean.trash', args: {}}]};
    const d = describePlan(plan, CAT);
    assert.match(d[0], /1\. Open application id="firefox"/);
    assert.match(d[1], /asks first/);
    assert.deepEqual(describePlan({unknown: true}, CAT), ['Not understood: nothing will run.']);
    assert.equal(needsConfirmation(plan, CAT), true);
    const safe = {steps: [{action: 'app.launch', args: {id: 'firefox'}}]};
    assert.equal(needsConfirmation(safe, CAT), false);
    assert.equal(needsConfirmation({steps: [{action: 'nope.x', args: {}}]}, CAT), true);
});

test('a capability needs a standing grant to skip confirmation', () => {
    const wifi = {steps: [{action: 'system.wifi.toggle', args: {}}]};
    const perms = createPermissions();
    assert.equal(needsConfirmation(wifi, CAT, perms), true);
    perms.grant('planner', 'device', 'once');
    assert.equal(needsConfirmation(wifi, CAT, perms), true);   // once is not a standing grant
    perms.grant('planner', 'device', 'always');
    assert.equal(needsConfirmation(wifi, CAT, perms), false);
});

test('hidden values in the preview', () => {
    const d = describePlan({steps: [{action: 'app.launch', args: {id: 'password=hunter22'}}]}, CAT);
    assert.match(d[0], /\[hidden\]/);
    assert.doesNotMatch(d[0], /hunter22/);
});

test('undo descriptors and partial failure report', () => {
    const plan = {steps: [{action: 'system.wifi.toggle', args: {}}, {action: 'profile.apply', args: {id: 'focus'}}, {action: 'app.launch', args: {id: 'x'}}]};
    const u = undoPlan(plan, CAT);
    assert.deepEqual(u.steps, [{action: 'profile.undo', args: {}}, {action: 'system.wifi.toggle', args: {}}]);
    assert.deepEqual(u.irreversible, [2]);
    const r = buildReport(plan, [{ok: true}, {ok: false, error: 'no such profile'}], CAT);
    assert.equal(r.ok, false);
    assert.deepEqual(r.completed, [0]);
    assert.equal(r.failed.step, 1);
    assert.deepEqual(r.skipped, [2]);
    assert.match(r.summary, /1 of 3 done; step 2 failed/);
    assert.deepEqual(r.undo.steps, [{action: 'system.wifi.toggle', args: {}}]);
    assert.equal(buildReport(plan, [{ok: true}, {ok: true}, {ok: true}], CAT).ok, true);
});

test('redactForProvider strips credentials', () => {
    const samples = [
        'my key is sk-abcdefghijklmnopqrstuvwx',
        'token ghp_abcdefghijklmnopqrstuvwxyz0123',
        'AKIAABCDEFGHIJKLMNOP',
        'password: hunter2',
        'kata sandi adalah rahasia123',
        'Authorization: Bearer abcdefghijklmnop1234',
        'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdEFGH1234',
        'https://user:pass@example.com/x',
        'card 4111 1111 1111 1111',
        'mail me at someone@example.com',
        '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
        'a'.repeat(40),
    ];
    for (const s of samples) {
        assert.equal(looksSensitive(s), true, s);
        assert.match(redactForProvider(s), /\[redacted\]/, s);
    }
    assert.equal(redactForProvider('buka firefox'), 'buka firefox');
    assert.doesNotMatch(redactForProvider('password: hunter2'), /hunter2/);
    assert.doesNotMatch(redactForProvider('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'), /MIIabc/);
});

test('buildProviderPrompt sends only the catalog and the text unless context is explicit', () => {
    const p = buildProviderPrompt({catalog: CAT, text: 'buka firefox, password: hunter2'});
    assert.deepEqual(p.included, ['catalog', 'text']);
    assert.doesNotMatch(p.user, /hunter2/);
    assert.equal(p.context, undefined);
    assert.match(p.system, /app\.launch/);
    assert.doesNotMatch(p.system, /Open application|Toggle Wi-Fi/);   // no titles leave the machine
    const c = buildProviderPrompt({catalog: CAT, text: 'x', context: 'clip: sk-abcdefghijklmnopqrstuvwx'});
    assert.deepEqual(c.included, ['catalog', 'text', 'context']);
    assert.doesNotMatch(c.context, /sk-abc/);
});

test('provider replies are untrusted', () => {
    const good = JSON.stringify({steps: [{action: 'app.launch', args: {id: 'firefox'}}]});
    assert.equal(parseProviderPlan(good, CAT).steps.length, 1);
    assert.deepEqual(parseProviderPlan('not json', CAT), {unknown: true});
    assert.deepEqual(parseProviderPlan(JSON.stringify({steps: [{action: 'shell.exec', args: {cmd: 'rm -rf /'}}]}), CAT), {unknown: true});
    assert.deepEqual(parseProviderPlan(JSON.stringify({unknown: true}), CAT), {unknown: true});
});

test('"copy X to clipboard" and the other clear forms map to real actions, keeping the text as typed', () => {
    const copy = t => localParse(t, CAT3).steps;
    assert.deepEqual(copy('copy hello to clipboard'), [{action: 'clipboard.copy', args: {text: 'hello'}}]);
    assert.deepEqual(copy('Copy Hello World to the clipboard'), [{action: 'clipboard.copy', args: {text: 'Hello World'}}]);
    assert.deepEqual(copy('copy "Hi, then bye" to clipboard'), [{action: 'clipboard.copy', args: {text: 'Hi, then bye'}}]);
    assert.deepEqual(copy('salin Halo ke clipboard'), [{action: 'clipboard.copy', args: {text: 'Halo'}}]);
    assert.deepEqual(copy('copy to clipboard: Some Text'), [{action: 'clipboard.copy', args: {text: 'Some Text'}}]);
    assert.deepEqual(copy('lock screen'), [{action: 'system.lock', args: {}}]);
    assert.deepEqual(copy('lock my screen'), [{action: 'system.lock', args: {}}]);
    assert.deepEqual(copy('take screenshot'), [{action: 'system.screenshot', args: {}}]);
    assert.deepEqual(copy('copy Hi to clipboard then lock screen'), [{action: 'clipboard.copy', args: {text: 'Hi'}}, {action: 'system.lock', args: {}}]);
});

test('a copy step with a credential-looking text is hidden in the preview, and without the action in the catalog nothing is guessed', () => {
    const plan = localParse('copy password: hunter2 to clipboard', CAT3);
    assert.match(describePlan(plan, CAT3)[0], /\[hidden\]/);
    assert.deepEqual(localParse('copy hello to clipboard', CAT), {unknown: true});
    assert.deepEqual(localParse('copy to clipboard', CAT3), {unknown: true});
});

test('the not-understood message lists phrasings that really parse', () => {
    assert.equal(EXAMPLES.length, 3);
    assert.match(NOT_UNDERSTOOD, /copy hello to clipboard/);
    for (const e of EXAMPLES) assert.ok(localParse(e, CAT3).steps, e);
});
