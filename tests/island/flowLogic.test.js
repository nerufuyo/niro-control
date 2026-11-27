// Niro Flow's panel logic (no screen, no daemon): reading answers, the form, the checks before saving, previews, and the controller's states
// against a fake backend. The daemon's own rules are tested in Rust; this checks what the panel does with its answers.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    classifyError, createFlow, emptyForm, FlowError, formProblems, formToWorkflow, newAction, parseActions, parseHistory, parseList, parseTemplates,
    previewLines, redactArgs, summarizeRun, triggerSentence, TRIGGERS, uniqueId, workflowToForm,
} from '../../control/build/flowLogic.js';

const ACTIONS = [
    {id: 'profile.apply', title: 'Apply a profile', permission: 'none', available: true, reason: null, params: [{name: 'id', type: 'string', required: true, maxLength: 80}], capability: 'settings', flow_can_run: true},
    {id: 'layout.restore', title: 'Restore a layout', permission: 'none', available: true, reason: null, params: [{name: 'name', type: 'string', required: true, maxLength: 24}], capability: 'window', flow_can_run: true},
    {id: 'process.kill', title: 'Quit a process', permission: 'confirm', available: true, reason: null, params: [{name: 'pid', type: 'number', required: true, min: 2}], capability: null, flow_can_run: false},
    {id: 'shell.exec', title: 'Run a command', permission: 'none', available: true, reason: null, params: [{name: 'cmd', type: 'string', required: true}], capability: 'launch', flow_can_run: true},
];
const known = () => parseActions(JSON.stringify({ok: true, actions: ACTIONS})).actions;
const TEMPLATE = {version: 1, id: 'coding-focus', name: 'Coding focus', enabled: false, allow: ['settings'], trigger: {type: 'app_focused', app: 'code'}, steps: [{kind: 'action', id: 'profile', name: 'profile.apply', args: {id: 'deep-work'}, next: null}]};

/** A fake daemon: keeps workflows in memory, validates like a stand-in, and can be told to fail. */
function fake(init = {}) {
    const f = {
        api: 1, enabled: false, workflows: [], problems: [], runs: {}, calls: [], fail: null, gate: null, nextRun: 1, saveRefuse: null,
        async _do(name, fn) {
            f.calls.push(name);
            if (f.gate) await f.gate;
            if (f.fail && (f.fail.on === name || f.fail.on === '*')) throw f.fail.error;
            return fn();
        },
        status() { return f._do('status', () => ({apiVersion: f.api, enabled: f.enabled})); },
        list() { return f._do('list', () => ({api: f.api, enabled: f.enabled, workflows: structuredClone(f.workflows), problems: f.problems})); },
        templates() { return f._do('templates', () => [{id: 'coding-focus', title: 'Coding focus', workflow: TEMPLATE}]); },
        knownActions() { return f._do('knownActions', () => ({ok: true, error: '', actions: known()})); },
        save(wf) { return f._do('save', () => {
            if (f.saveRefuse) return {ok: false, problems: f.saveRefuse};
            const i = f.workflows.findIndex(w => w.id === wf.id);
            if (i >= 0) f.workflows[i] = structuredClone(wf); else f.workflows.push(structuredClone(wf));
            return {ok: true, problems: []};
        }); },
        remove(id) { return f._do('remove', () => { f.workflows = f.workflows.filter(w => w.id !== id); }); },
        setEnabled(id, on) { return f._do('setEnabled', () => { f.workflows.find(w => w.id === id).enabled = on; }); },
        setGlobalEnabled(on) { return f._do('setGlobalEnabled', () => { f.enabled = on; }); },
        dryRun(id) { return f._do('dryRun', () => ({ok: true, problems: [], registry: 'ok', flow_enabled: f.enabled, workflow: id,
            steps: [{kind: 'action', step: 'profile', action: 'profile.apply', args: {id: 'deep-work', api_token: 'abc'}, permission: 'allowed', available: true}]})); },
        runNow(id) { return f._do('runNow', () => { const run = String(f.nextRun++); (f.runs[id] ??= []).push({id: Number(run), workflow_id: id, started_ms: Date.now(), status: 'ok', error: null, steps: []}); return run; }); },
        cancel() { return f._do('cancel', () => {}); },
        history(id) { return f._do('history', () => structuredClone(f.runs[id] ?? [])); },
        clearHistory() { return f._do('clearHistory', () => { f.runs = {}; }); },
        ...init,
    };
    return f;
}
const ready = async (init, workflows = []) => { const b = fake(init); b.workflows = workflows; b.enabled = init?.enabled ?? true; const flow = createFlow(b); await flow.refresh(); return {b, flow, s: flow.state}; };
const formFor = (over = {}) => ({...emptyForm(), id: 'night', name: 'Night', trigger: {type: 'schedule', app: '', percent: '20', at: '22:30'}, actions: [{name: 'profile.apply', args: {id: 'everyday'}}], ...over});

test('answers are parsed, and a garbled answer is an error, not a crash', () => {
    const l = parseList(JSON.stringify({api: 1, flow_enabled: true, workflows: [TEMPLATE, {nonsense: 1}], problems: [{file: 'x.json', error: 'bad'}]}));
    assert.equal(l.enabled, true); assert.equal(l.workflows.length, 1); assert.deepEqual(l.problems, [{file: 'x.json', error: 'bad'}]);
    assert.throws(() => parseList('{{'), e => e instanceof FlowError && e.kind === 'error');
    assert.equal(parseTemplates('[{"id":"a","title":"A","workflow":{}},{"x":1}]').length, 1);
    assert.deepEqual(parseHistory('{"not":"a list"}'), []);
    assert.equal(parseActions('{"ok":false,"error":"Search is not running","actions":[]}').ok, false);
});

test('errors are told apart: daemon missing, refused, too old, anything else', () => {
    assert.equal(classifyError(new Error('GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable')).kind, 'unavailable');
    assert.equal(classifyError(new Error('org.freedesktop.DBus.Error.NameHasNoOwner: x')).kind, 'unavailable');
    assert.equal(classifyError(new Error('org.freedesktop.DBus.Error.AccessDenied: Rejected send message')).kind, 'permission');
    assert.equal(classifyError(new Error('org.freedesktop.DBus.Error.UnknownMethod: No such method')).kind, 'unsupported');
    const other = classifyError(new Error('GDBus.Error:org.freedesktop.DBus.Error.Failed: no workflow "x"'));
    assert.equal(other.kind, 'error'); assert.equal(other.message, 'no workflow "x"');
    const same = new FlowError('permission', 'p'); assert.equal(classifyError(same), same);
});

test('secrets are masked wherever arguments are shown', () => {
    assert.deepEqual(redactArgs({id: 'a', api_token: 'x', Password: 'y', secretWord: 'z', apikey: 'k'}), {id: 'a', api_token: '***', Password: '***', secretWord: '***', apikey: '***'});
    const p = previewLines({ok: true, steps: [{kind: 'action', step: 's', action: 'profile.apply', args: {id: 'a', api_token: 'hunter2'}, permission: 'allowed', available: true}]});
    assert.ok(!p.lines.join('\n').includes('hunter2')); assert.match(p.lines[0], /would run/);
});

test('the form makes the workflow the daemon wants, and reading it back is lossless', () => {
  const f = formFor({condition: {...emptyForm().condition, kind: 'cmp', var: 'battery', cmp: 'lt', value: '30'}, actions: [{name: 'profile.apply', args: {id: 'everyday'}}, {name: 'layout.restore', args: {name: 'Work'}}]});
    const wf = formToWorkflow(f, known());
    assert.deepEqual(wf.trigger, {type: 'schedule', at: '22:30'});
    assert.deepEqual(wf.steps.map(s => s.id), ['if', 'a1', 'a2']);
    assert.deepEqual(wf.steps[0], {kind: 'condition', id: 'if', expr: {op: 'cmp', var: 'battery', cmp: 'lt', value: 30}, then: 'a1', else: null});
    assert.equal(wf.steps[1].next, 'a2'); assert.equal(wf.steps[2].next, null);
    assert.deepEqual(wf.allow, ['settings', 'window'], 'the allow list is exactly what the actions need');
    assert.equal(wf.enabled, false);
    const back = workflowToForm(wf, known());
    assert.deepEqual(back.lossy, []);
    assert.deepEqual(formToWorkflow(back.form, known()), wf);
    // a trigger with a field, a time condition, a text condition
    const t = formToWorkflow(formFor({trigger: {...emptyForm().trigger, type: 'battery_below', percent: '15'}, condition: {...emptyForm().condition, kind: 'time', from: '22:00', to: '06:00'}}), known());
    assert.deepEqual(t.trigger, {type: 'battery_below', percent: 15}); assert.deepEqual(t.steps[0].expr, {op: 'time_range', from: '22:00', to: '06:00'});
    const e = formToWorkflow(formFor({condition: {...emptyForm().condition, kind: 'eq', var: 'ac', value: 'true'}}), known());
    assert.deepEqual(e.steps[0].expr, {op: 'eq', var: 'ac', value: true});
});

test('a workflow the form cannot show is marked lossy, so it is never saved over', () => {
    const delay = {...TEMPLATE, steps: [{kind: 'delay', id: 'w', seconds: 5, next: 'profile'}, ...TEMPLATE.steps]};
    assert.match(workflowToForm(delay, known()).lossy.join(), /delay/);
    const branch = {...TEMPLATE, steps: [{kind: 'condition', id: 'c', expr: {op: 'eq', var: 'ac', value: true}, then: 'profile', else: 'profile'}, ...TEMPLATE.steps]};
    assert.match(workflowToForm(branch, known()).lossy.join(), /otherwise/);
    const odd = {...TEMPLATE, trigger: {type: 'from_the_future'}};
    assert.match(workflowToForm(odd, known()).lossy.join(), /from_the_future/);
    assert.deepEqual(workflowToForm(TEMPLATE, known()).lossy, []);
});

test('a condition or allow list that Save would rewrite makes the workflow read-only', () => {
    const lossy = (expr, allow = ['settings']) => workflowToForm({...TEMPLATE, allow, steps: [{kind: 'condition', id: 'c', expr, then: 'profile', else: null}, ...TEMPLATE.steps]}, known()).lossy.length > 0;
    assert.equal(lossy({op: 'cmp', var: 'workspace', cmp: 'gt', value: 2}), true);
    assert.equal(lossy({op: 'eq', var: 'workspace', value: 2}), true);
    assert.equal(lossy({op: 'eq', var: 'app', value: 2}), true);
    assert.equal(lossy({op: 'eq', var: 'battery', value: 50}), false);
    assert.equal(lossy({op: 'cmp', var: 'battery', cmp: 'lt', value: 30}), false);
    assert.equal(lossy({op: 'eq', var: 'ac', value: true}, ['profile.apply']), true);
    assert.equal(lossy({op: 'eq', var: 'ac', value: true}, []), true);
});

test('the form is checked before it is sent, in words', () => {
    const k = known();
    assert.deepEqual(formProblems(formFor(), k), []);
    assert.match(formProblems(formFor({name: ' '}), k)[0], /name/);
    assert.match(formProblems(formFor({id: 'bad id!'}), k)[0], /id must be/);
    assert.match(formProblems(formFor({id: 'taken'}), k, ['taken'])[0], /already a workflow/);
    assert.match(formProblems(formFor({actions: []}), k)[0], /at least one action/);
    assert.match(formProblems(formFor({trigger: {...emptyForm().trigger, type: 'schedule', at: '25:00'}}), k)[0], /HH:MM/);
    assert.match(formProblems(formFor({trigger: {...emptyForm().trigger, type: 'battery_below', percent: '0'}}), k)[0], /1 to 100/);
    assert.match(formProblems(formFor({trigger: {...emptyForm().trigger, type: 'app_focused', app: ' '}}), k)[0], /app/);
    assert.match(formProblems(formFor({actions: [{name: 'profile.apply', args: {}}]}), k)[0], /"id" is required/);
    assert.match(formProblems(formFor({actions: [{name: 'nope', args: {}}]}), k)[0], /not an action Flow knows/);
    assert.match(formProblems(formFor({actions: [{name: 'process.kill', args: {pid: 5}}]}), k)[0], /cannot run/, 'an action that needs a confirmation is refused');
    assert.match(formProblems(formFor({actions: [{name: 'profile.apply', args: {id: 'x'.repeat(81)}}]}), k)[0], /longer than 80/);
});

test('no action that runs a program is ever offered', () => {
    const offered = known().filter(a => a.canRun).map(a => a.id);
    assert.deepEqual(offered, ['profile.apply', 'layout.restore']);
    assert.match(formProblems(formFor({actions: [{name: 'shell.exec', args: {cmd: 'ls'}}]}), known())[0], /cannot run/);
});

test('ids are made unique and templates make a new action with its first choice', () => {
    assert.equal(uniqueId('Coding focus!', []), 'coding-focus');
    assert.equal(uniqueId('Coding focus', ['coding-focus', 'coding-focus-2']), 'coding-focus-3');
    assert.equal(uniqueId('???', []), 'workflow');
    assert.deepEqual(newAction({id: 'x', params: [{name: 'mode', type: 'enum', required: true, enum: ['a', 'b']}, {name: 'free', type: 'string'}]}), {name: 'x', args: {mode: 'a'}});
    assert.equal(triggerSentence({type: 'battery_below', percent: 20}), 'The battery runs low: 20%');
    assert.equal(TRIGGERS.length, 10);
});

test('runs are summarised in words', () => {
    const now = 1_000_000;
    assert.equal(summarizeRun({status: 'ok', started_ms: now - 5 * 60_000, steps: []}, now).text, 'Succeeded 5 min ago');
    assert.equal(summarizeRun({status: 'error', started_ms: now, error: 'boom', steps: []}, now).text, 'Failed just now: boom');
    assert.match(summarizeRun({status: 'error', started_ms: now, error: null, steps: [{name: 'profile.apply', error: 'no such profile'}]}, now).text, /profile.apply \(no such profile\)/);
    assert.equal(summarizeRun({status: 'running'}, now).running, true);
    assert.equal(summarizeRun(null).word, 'Unknown');
});

test('loading, then empty / disabled / ready, depending on what the daemon says', async () => {
    const b = fake(); const flow = createFlow(b);
    assert.equal(flow.state.view, 'loading');
    await flow.refresh();
    assert.equal(flow.state.view, 'disabled', 'Flow is off by default, even with nothing to show');
    assert.equal(flow.state.templates.length, 1, 'templates are offered while it is off');
    b.enabled = true; await flow.refresh();
    assert.equal(flow.state.view, 'empty');
    b.workflows = [TEMPLATE]; await flow.refresh();
    assert.equal(flow.state.view, 'ready');
    b.enabled = false; await flow.refresh();
    assert.equal(flow.state.view, 'disabled'); assert.equal(flow.state.workflows.length, 1, 'a disabled Flow still lists its workflows');
});

test('the error screens: not running, refused, too old, unreadable, and a version mismatch', async () => {
    for (const [error, view] of [[new Error('org.freedesktop.DBus.Error.ServiceUnknown'), 'unavailable'], [new FlowError('permission', 'access was refused'), 'permission'], [new FlowError('unsupported', 'daemon is too old'), 'unsupported'], [new FlowError('error', 'answer was garbled'), 'error']]) {
        const b = fake(); b.fail = {on: 'status', error}; const flow = createFlow(b);
        await flow.refresh();
        assert.equal(flow.state.view, view, view);
        assert.ok(flow.state.message.length > 5);
        b.fail = null; await flow.refresh();
        assert.notEqual(flow.state.view, view, 'try again recovers');
    }
    const b = fake(); b.api = 2; const flow = createFlow(b); await flow.refresh();
    assert.equal(flow.state.view, 'unsupported'); assert.match(flow.state.message, /version 2/);
});

test('Search being down does not hide the workflows, it only stops new actions', async () => {
    const b = fake(); b.enabled = true; b.workflows = [TEMPLATE]; b.knownActions = () => b._do('knownActions', () => ({ok: false, error: 'Search is not running', actions: []}));
    const flow = createFlow(b); await flow.refresh();
    assert.equal(flow.state.view, 'ready'); assert.equal(flow.state.actionsError, 'Search is not running');
    const saved = await flow.save(formFor(), {isNew: true});
    assert.equal(saved, false, 'the form cannot be saved without the action list'); assert.match(flow.state.saveProblems.join(), /not an action Flow knows/);
});

test('turning Flow on and off, and a workflow on and off, reads back the daemon\'s answer', async () => {
    const {b, flow, s} = await ready({enabled: false}, [{...TEMPLATE, enabled: false}]);
    await flow.setGlobal(true);
    assert.equal(b.enabled, true); assert.equal(s.view, 'ready'); assert.match(s.notice.text, /Flow is on/); assert.equal(s.notice.kind, 'success');
    await flow.setWorkflowEnabled('coding-focus', true);
    assert.equal(s.workflows[0].enabled, true);
    await flow.setGlobal(false);
    assert.equal(s.view, 'disabled'); assert.match(s.notice.text, /Flow is off/);
});

test('applying: a second change while one is out is ignored, and the state says so', async () => {
    const {b, flow, s} = await ready({enabled: false});
    let release; b.gate = new Promise(r => (release = r));
    const seen = [];
    flow.subscribe(() => seen.push(s.busy));
    const first = flow.setGlobal(true);
    assert.equal(s.busy, 'applying');
    const second = await flow.setGlobal(false);
    void second;
    release(); b.gate = null; await first;
    assert.equal(b.enabled, true, 'the second change did not run');
    assert.equal(s.busy, null); assert.ok(seen.includes('applying'));
});

test('save: a good form is saved; the daemon\'s refusal is shown in its words and nothing is closed', async () => {
    const {b, flow, s} = await ready({}, []);
    assert.equal(await flow.save(formFor(), {isNew: true}), true);
    assert.equal(b.workflows.length, 1); assert.equal(s.view, 'ready'); assert.equal(s.saveProblems.length, 0);
    assert.deepEqual(b.workflows[0].allow, ['settings']);
    // the same id again as a new workflow is refused before any call
    const calls = b.calls.length;
    assert.equal(await flow.save(formFor(), {isNew: true}), false);
    assert.match(s.saveProblems[0], /already a workflow/); assert.equal(b.calls.length, calls, 'no call was made');
    // editing keeps the id
    assert.equal(await flow.save(formFor({name: 'Night two'}), {isNew: false}), true);
    assert.equal(b.workflows[0].name, 'Night two');
    // the daemon says no
    b.saveRefuse = ['step "a1": "id" is required', 'workflow id is reserved'];
    assert.equal(await flow.save(formFor({id: 'other'}), {isNew: true}), false);
    assert.deepEqual(s.saveProblems, b.saveRefuse); assert.equal(s.notice.kind, 'error');
    // the daemon goes away mid-save: the screen changes, the error is not swallowed
    b.saveRefuse = null; b.fail = {on: 'save', error: new Error('org.freedesktop.DBus.Error.ServiceUnknown')};
    assert.equal(await flow.save(formFor({id: 'third'}), {isNew: true}), false);
    assert.equal(s.view, 'unavailable');
});

test('a template becomes a new, switched-off workflow with a free id', async () => {
    const {b, flow, s} = await ready({}, [TEMPLATE]);
    const id = await flow.fromTemplate('coding-focus');
    assert.equal(id, 'coding-focus-2'); assert.equal(b.workflows.length, 2);
    assert.equal(b.workflows.find(w => w.id === id).enabled, false);
    assert.equal(await flow.fromTemplate('nope'), null); assert.match(s.notice.text, /not offered/);
    b.saveRefuse = ['no'];
    assert.equal(await flow.fromTemplate('coding-focus'), null); assert.match(s.notice.text, /refused/);
});

test('preview does not run anything; run now needs Flow on and shows the result; delete removes', async () => {
    const {b, flow, s} = await ready({enabled: true}, [{...TEMPLATE}]);
    const d = await flow.dryRun('coding-focus');
    assert.equal(d.steps.length, 1); assert.ok(s.previews['coding-focus']); assert.ok(!b.calls.includes('runNow'));
    assert.ok(!JSON.stringify(previewLines(d)).includes('abc'), 'the preview masks the token');
    const run = await flow.runNow('coding-focus');
    assert.equal(run, '1'); assert.equal(summarizeRun(s.history['coding-focus'][0]).ok, true);
    assert.equal(s.running['coding-focus'], undefined, 'a finished run is not "running"');
    await flow.clearHistory(); assert.deepEqual(s.history, {});
    await flow.remove('coding-focus');
    assert.equal(b.workflows.length, 0); assert.equal(s.view, 'empty'); assert.equal(s.previews['coding-focus'], undefined);
    // Flow off: run now is refused here, before the daemon is asked
    await flow.setGlobal(false); const n = b.calls.length;
    b.workflows = [TEMPLATE]; await flow.refresh();
    assert.equal(await flow.runNow('coding-focus'), undefined); assert.match(s.notice.text, /Flow is off/);
    assert.ok(!b.calls.slice(n).includes('runNow'));
});

test('a failing call keeps the page where it was and says what failed', async () => {
    const {b, flow, s} = await ready({}, [TEMPLATE]);
    b.fail = {on: 'remove', error: new FlowError('error', 'no workflow "coding-focus"')};
    await flow.remove('coding-focus');
    assert.equal(s.view, 'ready'); assert.equal(s.notice.kind, 'error'); assert.match(s.notice.text, /^Delete: no workflow/);
    flow.dismissNotice(); assert.equal(s.notice, null);
});

test('history load failure for permission shows the permission screen', async () => {
    const {b, flow, s} = await ready({}, [TEMPLATE]);
    b.fail = {on: 'history', error: new FlowError('permission', 'denied')};
    await flow.loadHistory('coding-focus');
    assert.equal(s.view, 'permission');
});

test('files the daemon could not read are kept in the state', async () => {
    const {s} = await ready({problems: [{file: 'broken.json', error: 'not a valid workflow'}]}, [TEMPLATE]);
    assert.deepEqual(s.fileProblems, [{file: 'broken.json', error: 'not a valid workflow'}]);
});
