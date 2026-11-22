import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Registry} from '../../shell/search/build/registry.js';
import {ACTION_CAPABILITY, capabilityFor, createGate, subjectOf} from '../../shell/search/build/capabilities.js';
import {registerRuntimeActions} from '../../shell/search/build/runtime.js';
import {BUILT_IN_RULES, buildEngine, evaluateNow, parseUserRules} from '../../shell/search/build/adaptive.js';
import {CAPABILITIES} from '../../shell/shared/permissions.js';
import {analyze} from '../../shell/shared/extensionConflicts.js';

const src = f => readFileSync(new URL(`../../shell/search/${f}`, import.meta.url), 'utf8');

// ---- Extension Compatibility
test('extension conflicts: tiling-assistant next to niro Tile is reported (real uuids), and only when both are enabled', () => {
    const both = [{uuid: 'tile@niro.local', enabled: true}, {uuid: 'tiling-assistant@ubuntu.com', enabled: true}];
    const r = analyze(both, 51);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'tiling-overlap');
    assert.deepEqual(r.conflicts[0].theirs, ['tiling-assistant@ubuntu.com']);
    assert.deepEqual(r.conflicts[0].ours, ['tile@niro.local']);
    assert.match(r.conflicts[0].reason, /edge drag.*shortcuts/);
    assert.equal(analyze([{uuid: 'tile@niro.local', enabled: true}, {uuid: 'tiling-assistant@ubuntu.com', enabled: false}], 51).conflicts.length, 0);
    assert.equal(analyze([{uuid: 'tile@niro.local', enabled: false}, {uuid: 'tiling-assistant@ubuntu.com', enabled: true}], 51).conflicts.length, 0);
    assert.equal(analyze(both, 51, ['tiling-overlap']).conflicts.length, 0);                       // a false positive can be ignored
    // the other Niro extensions are matched by their real uuids too (before, only `niro-*` ids matched, which no installed extension has)
    assert.equal(analyze([{uuid: 'dock@niro.local', enabled: true}, {uuid: 'dash-to-dock@micxgx.gmail.com', enabled: true}], 51).conflicts[0].id, 'dock-overlap');
    assert.equal(analyze([{uuid: 'island@niro.local', enabled: true}, {uuid: 'notification-banner-reloaded@marcinjakubowski.github.com', enabled: true}], 51).conflicts[0].id, 'notification-overlap');
    // the old prefix form still works
    assert.equal(analyze([{uuid: 'niro-tile@niro', enabled: true}, {uuid: 'forge@jmmaranan.com', enabled: true}], 51).conflicts.length, 1);
});

// ---- capabilities
test('every registered action has an explicit capability, and each is a known one', () => {
    const ids = new Set();
    for (const f of ['actions.ts', 'sharedActions.ts', 'runtime.ts', 'systemHub.ts'])
        for (const m of src(f).matchAll(/r\.register\(\{id: '([a-z0-9.-]+)'/g)) ids.add(m[1]);
    assert.ok(ids.size >= 75, `found ${ids.size} actions`);
    for (const id of ids) assert.ok(Object.prototype.hasOwnProperty.call(ACTION_CAPABILITY, id), `${id} has no capability entry`);
    for (const id of Object.keys(ACTION_CAPABILITY)) assert.ok(ids.has(id), `${id} is in the table but not registered`);
    for (const c of Object.values(ACTION_CAPABILITY)) assert.ok(c === null || CAPABILITIES.includes(c), c);
    assert.equal(capabilityFor('app.launch'), 'launch');
    assert.equal(capabilityFor('file.open'), 'file');
    assert.equal(capabilityFor('clipboard.copy'), 'clipboard');
    assert.equal(capabilityFor('window.activate'), 'window');
    assert.equal(capabilityFor('system.wifi.toggle'), 'automation');
    assert.equal(capabilityFor('url.clean'), null);
    assert.equal(capabilityFor('some.new-action'), 'automation');          // never silently free
    assert.equal(subjectOf('my prog/1'), 'my_prog_1');
    assert.equal(subjectOf(undefined), 'unknown');
});

// ---- the gate
const gateWith = (answers, store = {}) => {
    const asked = [];
    const gate = createGate({read: () => store.text ?? null, write: t => { store.text = t; }, ask: async (s, c) => { asked.push([s, c]); return answers.shift() ?? 'deny'; }});
    return {gate, asked, store};
};

test('gate: ask, allow once is spent by the call, always is kept on disk, deny is final', async () => {
    const {gate, asked, store} = gateWith(['once', 'once', 'always']);
    assert.equal((await gate.check('assistant', 'text.transform')).allowed, true);            // no capability: nothing asked
    assert.equal(asked.length, 0);
    assert.equal((await gate.check('assistant', 'app.launch')).allowed, true);
    assert.equal(asked.length, 1);
    assert.equal(store.text, undefined);                                                       // 'once' is never stored
    assert.equal((await gate.check('assistant', 'app.launch')).allowed, true);                 // asks again
    assert.equal(asked.length, 2);
    assert.equal((await gate.check('assistant', 'app.launch')).allowed, true);                 // 'always'
    assert.equal((await gate.check('assistant', 'app.launch')).allowed, true);                 // no question this time
    assert.equal(asked.length, 3);
    assert.deepEqual(JSON.parse(store.text).grants, [{subject: 'assistant', capability: 'launch', scope: 'always'}]);
    // a different program or capability is a different question
    gate.perms.grant('assistant', 'file', 'session');
    assert.equal((await gate.check('assistant', 'note.add')).allowed, true);
    assert.equal(JSON.parse(store.text).grants.length, 1);                                     // session grants are not on disk
});

test('gate: a denial, a revoke is enforced on the next call, grants survive a restart', async () => {
    const store = {};
    const a = gateWith(['deny', 'always'], store);
    const denied = await a.gate.check('script', 'clipboard.copy');
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /script was not allowed to use the clipboard/);
    assert.equal((await a.gate.check('script', 'clipboard.copy')).allowed, true);             // second answer: always
    a.gate.grant('script', 'window', 'deny');
    const b = gateWith([], store);                                                             // "restart": the same file
    assert.equal((await b.gate.check('script', 'clipboard.copy')).allowed, true);
    const w = await b.gate.check('script', 'window.activate');
    assert.equal(w.allowed, false);
    assert.match(w.reason, /not allowed/);
    assert.equal(b.asked.length, 0);
    b.gate.revoke('script', 'clipboard');
    assert.equal(b.gate.list().length, 1);                                                     // only the clipboard grant went; the window denial stays
    b.gate.revoke('script', null);
    assert.equal(b.gate.list().length, 0);
    assert.equal(JSON.parse(store.text).grants.length, 0);
    assert.equal((await b.gate.check('script', 'clipboard.copy')).allowed, false);             // next call: asked again (nobody answers: denied)
    assert.equal(b.asked.length, 1);
});

test('gate: history records who, what and the verdict, never arguments; it can be cleared', async () => {
    const {gate} = gateWith(['once']);
    await gate.check('assistant', 'file.open');
    const h = gate.history();
    assert.deepEqual(h.map(e => e.verdict), ['ask', 'allow']);
    assert.deepEqual(Object.keys(h[0]).sort(), ['at', 'capability', 'subject', 'verdict']);
    gate.clearHistory();
    assert.equal(gate.history().length, 0);
    assert.throws(() => gate.grant('x y', 'file', 'always'), /invalid subject/);
    assert.throws(() => gate.grant('x', 'teleport', 'always'), /unknown capability/);
    assert.throws(() => gate.validate('x', 'file', 'forever'), /unknown scope/);
    assert.doesNotThrow(() => gate.validate('x', 'file', 'always'));
    assert.equal(gate.list().length, 0);                                                       // validating grants nothing
    const bad = createGate({read: () => '{"grants":[{"subject":"a","capability":"file","scope":"once"},{"subject":"b","capability":"nope","scope":"always"}]}'});
    assert.equal(bad.list().length, 0);                                                        // a hand-edited file cannot grant 'once' or unknown things
});

// ---- planner and macros
function world(opts = {}) {
    const r = new Registry();
    const ran = [];
    const act = (id, extra = {}) => r.register({id, title: id, description: id, category: 'T', keywords: [], permission: 'none', run: async args => { ran.push([id, args]); if (opts.fail === id) throw new Error('boom'); return `${id} ok`; }, ...extra});
    act('system.mute.toggle');
    act('system.dnd.toggle');
    act('app.launch', {params: [{name: 'id', type: 'string', required: true}]});
    act('system.restart', {permission: 'confirm', confirm: 'Restart?'});
    act('note.add', {params: [{name: 'text', type: 'string', required: true}]});
    const files = {};
    const asks = [];
    const slept = [];
    const services = {
        runStep: (id, args, ctx) => r.run(id, args, ctx ?? {}, 'external', async a => { asks.push(a.id); return opts.decline !== a.id; }),
        readMacros: () => files.macros ?? null, writeMacros: t => { files.macros = t; },
        sleep: async ms => { slept.push(ms); await opts.onSleep?.(); },
        adaptive: {dismiss: () => 'd', history: () => 'h', lock: on => String(on)},
    };
    registerRuntimeActions(r, services);
    const go = (id, args) => r.run(id, args, {}, 'external', async a => { asks.push(a.id); return opts.decline !== a.id; });
    return {r, ran, files, asks, slept, go};
}

test('plan.preview shows readable steps and runs nothing', async () => {
    const w = world();
    const o = await w.go('plan.preview', {text: 'open firefox then mute'});
    assert.equal(o.ok, true);
    assert.match(o.message, /1\. app\.launch id="firefox"/);
    assert.match(o.message, /2\. system\.mute\.toggle/);
    assert.match(o.message, /Nothing was run/);
    assert.equal(w.ran.length, 0);
    const nu = (await w.go('plan.preview', {text: 'make me a sandwich'})).message;
    assert.match(nu, /Not understood/);
    assert.match(nu, /copy hello to clipboard/);
    assert.equal((await w.go('plan.preview', {text: 'x'.repeat(501)})).code, 'invalid');
    assert.equal(w.ran.length, 0);
});

test('plan.run asks first, runs each step through the registry, and stops at the first failure with a report', async () => {
    const w = world();
    const ok = await w.go('plan.run', {text: 'mute then turn on do not disturb'});
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.message, 'All 2 steps done.');
    assert.deepEqual(w.ran.map(x => x[0]), ['system.mute.toggle', 'system.dnd.toggle']);
    assert.equal(w.asks[0], 'plan.run');

    const f = world({fail: 'system.dnd.toggle'});
    const bad = await f.go('plan.run', {text: 'mute then turn on do not disturb then open firefox'});
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'failed');
    assert.match(bad.error, /1 of 3 done; step 2 failed \(boom\); 1 not run/);
    assert.match(bad.error, /To undo: system\.mute\.toggle/);
    assert.deepEqual(f.ran.map(x => x[0]), ['system.mute.toggle', 'system.dnd.toggle']);      // the third step never ran

    const no = world({decline: 'plan.run'});
    assert.equal((await no.go('plan.run', {text: 'mute'})).code, 'declined');
    assert.equal(no.ran.length, 0);
    const un = world();
    const u = await un.go('plan.run', {text: 'do something strange'});
    assert.equal(u.ok, false);
    assert.equal(un.ran.length, 0);
});

test('plan.run: a step that asks (restart) still asks, and a declined step is reported', async () => {
    const w = world({decline: 'system.restart'});
    const mod = world();
    assert.equal(mod.r.get('system.restart').permission, 'confirm');
    // restart is not in the local parser's rules, so a plan cannot reach it by words; steps with confirmation go through macros:
    await w.go('macro.save', {name: 'm', steps: JSON.stringify([{action: 'system.mute.toggle'}, {action: 'system.restart'}])});
    const o = await w.go('macro.play', {name: 'm'});
    assert.equal(o.ok, false);
    assert.match(o.error, /1 of 2 done; step 2 failed \(cancelled\)/);
    assert.deepEqual(w.ran.map(x => x[0]), ['system.mute.toggle']);
    assert.deepEqual(w.asks, ['macro.play', 'system.restart']);
});

test('macros: save, list, play with loops (capped), delays, stop, and the checks on what is stored', async () => {
    const w = world();
    assert.equal((await w.go('macro.list', {})).message, 'No macros saved yet');
    const s = await w.go('macro.save', {name: 'focus', steps: JSON.stringify([{action: 'system.dnd.toggle'}, {action: 'app.launch', args: {id: 'code'}, delayMs: 1000}])});
    assert.equal(s.ok, true, s.error);
    assert.equal((await w.go('macro.list', {})).message, 'focus: 2 steps');
    const p = await w.go('macro.play', {name: 'focus', loops: 2});
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(w.ran.map(x => x[0]), ['system.dnd.toggle', 'app.launch', 'system.dnd.toggle', 'app.launch']);
    assert.ok(w.slept.length >= 4 && w.slept.every(ms => ms <= 250));                       // waits in short slices so a stop is felt soon
    assert.equal((await w.go('macro.play', {name: 'focus', loops: 21})).code, 'invalid');   // the loop cap
    assert.equal((await w.go('macro.play', {name: 'focus', loops: 1.5})).ok, false);
    assert.equal((await w.go('macro.play', {name: 'missing'})).ok, false);
    // refused on save: sensitive, nested, unknown action, bad arguments, bad JSON
    const refused = async steps => (await w.go('macro.save', {name: 'x', steps: typeof steps === 'string' ? steps : JSON.stringify(steps)}));
    assert.match((await refused([{action: 'app.launch', args: {id: 'x', password: 'hunter2'}}])).error, /sensitive|password/);
    assert.match((await refused([{action: 'note.add', args: {text: 'password: hunter2hunter2'}}])).error, /credential/);
    assert.match((await refused([{action: 'macro.play', args: {name: 'focus'}}])).error, /cannot run macro\.play/);
    assert.match((await refused([{action: 'plan.run', args: {text: 'mute'}}])).error, /cannot run plan\.run/);
    assert.match((await refused([{action: 'no.such'}])).error, /no action/);
    assert.match((await refused([{action: 'app.launch', args: {}}])).error, /required/);
    assert.match((await refused('{')).error, /not valid JSON/);
    assert.match((await w.go('macro.save', {name: '../x', steps: '[]'})).error, /macro name/);
    assert.deepEqual(Object.keys(JSON.parse(w.files.macros).macros), ['focus']);              // nothing refused was kept
    // a file edited by hand is checked again when played
    const edited = JSON.parse(w.files.macros);
    edited.macros.focus.steps.push({action: 'app.launch', args: {id: 'x', token: 'abc'}});
    w.files.macros = JSON.stringify(edited);
    assert.match((await w.go('macro.play', {name: 'focus'})).error, /sensitive|token/);
    w.files.macros = 'not json';
    assert.equal((await w.go('macro.list', {})).message, 'No macros saved yet');
});

test('macro.stop ends a playing macro between steps; a second play meanwhile is refused', async () => {
    let stopper = null;
    const w = world({onSleep: async () => { if (stopper) { const s = stopper; stopper = null; await s(); } }});
    await w.go('macro.save', {name: 'slow', steps: JSON.stringify([{action: 'system.mute.toggle'}, {action: 'system.dnd.toggle', delayMs: 5000}, {action: 'app.launch', args: {id: 'a'}}])});
    assert.equal((await w.go('macro.stop', {})).message, 'No macro is playing');
    stopper = async () => {
        assert.match((await w.go('macro.play', {name: 'slow'})).error, /already playing/);
        assert.equal((await w.go('macro.stop', {})).message, 'Stopping the macro');
    };
    const o = await w.go('macro.play', {name: 'slow'});
    assert.equal(o.ok, true);
    assert.match(o.message, /stopped after 1 of 3 steps/);
    assert.deepEqual(w.ran.map(x => x[0]), ['system.mute.toggle']);
    assert.equal((await w.go('macro.stop', {})).message, 'No macro is playing');
});

// ---- adaptive on the shared context engine
const sig = (app, extra = {}) => ({app, minute: 600, monitors: 1, ...extra});

test('adaptive runtime: suggestion-first, accept and dismiss are recorded as metadata, override and lock silence it', () => {
    let t = 1_000_000;
    const {engine, problems} = buildEngine(null, () => t);
    assert.deepEqual(problems, []);
    const s = evaluateNow(engine, sig('code.desktop code'), null);
    assert.equal(s.profile, 'deep-work');
    assert.equal(s.reason, 'desktop code is in front');                                       // the built-in wording is kept
    assert.equal(evaluateNow(engine, sig('code.desktop code'), null), null);                   // quiet: it was just suggested
    engine.recordOutcome('code', 'accepted');
    t += 31 * 60 * 1000;
    // the engine speaks once per episode: while the editor stays in front it does not nag again, even after the quiet time...
    assert.equal(evaluateNow(engine, sig('code.desktop code'), null), null);
    // ...but once Search has seen something else in front, the same rule can speak again
    assert.equal(evaluateNow(engine, sig('org.gnome.nautilus.desktop'), null), null);
    assert.ok(evaluateNow(engine, sig('code.desktop code'), null));
    engine.recordOutcome('code', 'dismissed');
    t += 31 * 60 * 1000;
    evaluateNow(engine, sig('org.gnome.nautilus.desktop'), null);
    // a manual choice silences for the override time, then it speaks again
    engine.setOverride('gaming', 3600000);
    assert.equal(evaluateNow(engine, sig('code.desktop code'), null), null);
    t += 3600001;
    evaluateNow(engine, sig('org.gnome.nautilus.desktop'), null);
    assert.ok(evaluateNow(engine, sig('code.desktop code'), null));
    t += 31 * 60 * 1000;
    engine.lock();
    assert.equal(evaluateNow(engine, sig('steam.desktop steam'), null), null);
    engine.unlock();
    assert.equal(evaluateNow(engine, sig('steam.desktop steam'), null).profile, 'gaming');
    assert.equal(evaluateNow(engine, sig('steam.desktop steam'), 'gaming'), null);             // already active
    const outcomes = engine.history().map(h => h.outcome);
    assert.deepEqual(outcomes, ['suggested', 'accepted', 'suggested', 'dismissed', 'override', 'suggested', 'suggested']);
    for (const h of engine.history()) assert.deepEqual(Object.keys(h).sort(), ['at', 'outcome', 'profile', 'ruleId']);   // no titles, no content
    // a profile that is not installed is not offered
    t += 31 * 60 * 1000;
    assert.equal(evaluateNow(engine, sig('code.desktop'), null, () => false), null);
});

test('adaptive rules file: configurable, validated, a built-in can be replaced or switched off, bad rules reported', () => {
    const text = JSON.stringify([
        {id: 'night-battery', priority: 50, conditions: {batteryBelow: 20, onAc: false}, action: {type: 'profile.apply', profile: 'battery-saver'}},
        {id: 'game', enabled: false, priority: 1, conditions: {apps: ['steam']}, action: {type: 'profile.apply', profile: 'gaming'}},
        {id: 'bad', conditions: {nonsense: 1}, action: {type: 'profile.apply', profile: 'x'}},
        {id: 'bad2', conditions: {apps: ['a']}, action: {type: 'run.shell', profile: 'x'}},
    ]);
    const parsed = parseUserRules(text);
    assert.equal(parsed.rules.length, 2);
    assert.equal(parsed.problems.length, 2);
    assert.match(parsed.problems.join(' '), /unknown condition "nonsense"/);
    assert.match(parsed.problems.join(' '), /action must be/);
    assert.deepEqual(parseUserRules('{').problems, ['adaptive-rules.json is not valid JSON']);
    assert.deepEqual(parseUserRules(null), {rules: [], problems: []});
    const {engine, problems} = buildEngine(text, () => 5_000_000);
    assert.equal(problems.length, 2);
    const low = evaluateNow(engine, sig('org.gnome.nautilus', {battery: 12, onAc: false}), null);
    assert.equal(low.profile, 'battery-saver');
    assert.match(low.reason, /battery at 12%/);
    assert.equal(low.reason.includes('Suggested only'), true);
    assert.equal(evaluateNow(engine, sig('steam.desktop steam'), null), null);                // the user switched the built-in 'game' rule off
    assert.equal(BUILT_IN_RULES.length, 3);
});

test('a permission dialog nobody answers closes by itself and counts as no', async () => {
    const {readFileSync} = await import('node:fs');
    const actions = readFileSync(new URL('../../shell/search/actions.ts', import.meta.url), 'utf8');
    const ext = readFileSync(new URL('../../shell/search/extension.ts', import.meta.url), 'utf8');
    assert.match(actions, /function askPermission\([^)]*timeoutSeconds = 60\)/);
    assert.match(actions, /answerByDefault<'deny' \| 'once' \| 'always'>\(dialog, timeoutSeconds, 'deny'/);
    // a session-ending confirm still waits for ever unless a caller asks for a limit
    assert.match(actions, /function confirm\([^)]*timeoutSeconds = 0\)/);
    // the D-Bus Grant asks with a limit
    assert.match(ext, /'Allow', 60\)/);
});
