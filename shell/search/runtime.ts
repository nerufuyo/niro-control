// @ts-nocheck: the shared cores are plain JS copied into build/shared by the build
// The planner, the macros and the adaptive controls as Search actions. Pure: no GNOME imports; the shell passes in `services` (how to run a
// step through the same registry, where the macros live, how to wait), so node tests it. Every step goes back through the registry, so each
// action's own confirmation, argument check and (for outside callers) permission still apply to it.
import {validateArgs} from './registry.js';
import {capabilityFor} from './capabilities.js';
import {EXAMPLES, localParse, NOT_UNDERSTOOD, validatePlan, describePlan, buildReport, undoPlan} from './shared/commandPlanner.js';
import {importMacro, playbackPlan, createPlayer, MAX_LOOPS} from './shared/macro.js';

const MACRO_NAME = /^[\w][\w .-]{0,59}$/;
const MAX_MACROS = 50;
const NESTED = /^(plan|macro)\./;            // a plan or a macro may not start another one: no loops, no hidden depth

export function registerRuntimeActions(r, services) {
    const catalog = () => r.manifest().filter(a => !NESTED.test(a.id))
        .map(a => ({id: a.id, title: a.title, params: a.params, permission: a.permission, capability: capabilityFor(a.id)}));
    const parse = text => { const plan = localParse(String(text ?? ''), catalog()); return {plan, check: validatePlan(plan, catalog())}; };

    // ---- macros: one JSON file {version, macros: {name: {steps}}}
    const loadMacros = () => {
        try {
            const d = JSON.parse(services.readMacros() ?? '');
            return d && d.version === 1 && d.macros && typeof d.macros === 'object' ? d.macros : {};
        } catch (_e) { return {}; }
    };
    const saveMacros = macros => services.writeMacros(JSON.stringify({version: 1, macros}));
    /** Steps of a macro checked against the registry: no nesting, known actions, valid arguments. */
    const checkSteps = steps => {
        for (let i = 0; i < steps.length; i++) {
            const a = r.get(steps[i].action);
            if (NESTED.test(steps[i].action)) return `step ${i + 1}: a macro cannot run ${steps[i].action}`;
            if (!a) return `step ${i + 1}: no action "${steps[i].action}"`;
            const bad = validateArgs(a.params, steps[i].args);
            if (bad) return `step ${i + 1}: ${bad}`;
        }
        return null;
    };
    /** A stored macro, validated again (the file is untrusted): sensitive steps, unknown actions and bad arguments are refused. */
    const openMacro = name => {
        const m = loadMacros()[name];
        if (!m) return {error: `no macro called "${name}"`};
        const imp = importMacro(JSON.stringify({version: 1, name, steps: m.steps}));
        if (!imp.ok) return {error: imp.error};
        const error = checkSteps(imp.macro.steps());
        return error ? {error} : {macro: imp.macro};
    };

    let player = null;       // the macro that is playing now

    r.register({id: 'plan.preview', title: 'Preview a plan', description: 'Turns a sentence ("open firefox then mute") into steps and shows them; nothing is run', category: 'Planner', keywords: ['plan', 'preview', 'command', 'rencana'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 500}], permission: 'none',
        run: async ({text}) => {
            const {plan, check} = parse(text);
            if (plan.unknown) return NOT_UNDERSTOOD;
            if (!check.ok) return `Not valid: ${check.errors.map(e => e.error).join('; ')}`;
            return `${describePlan(plan, catalog()).join('\n')}\nNothing was run.`;
        }});
    r.register({id: 'plan.run', title: 'Run a plan', description: 'Turns a sentence into steps, shows them, and runs them one by one through the same actions (it stops at the first that fails)', category: 'Planner', keywords: ['plan', 'run', 'command', 'jalankan'],
        params: [{name: 'text', type: 'string', required: true, maxLength: 500}], permission: 'confirm', confirm: 'Run this plan?',
        ask: ({text}) => {
            const {plan, check} = parse(text);
            return plan.unknown || !check.ok ? `${NOT_UNDERSTOOD.replace('nothing would run', 'nothing will run')}` : `Run these steps, in order?\n${describePlan(plan, catalog()).join('\n')}`;
        },
        run: async ({text}, env) => {
            const {plan, check} = parse(text);
            if (plan.unknown) throw new Error(`the request was not understood; nothing ran. Try, for example: ${EXAMPLES.map(e => `"${e}"`).join(', ')}`);
            if (!check.ok) throw new Error(check.errors.map(e => e.error).join('; '));
            const results = [];
            for (const step of plan.steps) {
                const o = await services.runStep(step.action, step.args, env);
                results.push({ok: o.ok, error: o.error});
                if (!o.ok) break;
            }
            const report = buildReport(plan, results, catalog());
            if (report.ok) return report.summary;
            const undo = undoPlan({steps: report.completed.map(i => plan.steps[i])}, catalog());
            throw new Error(`${report.summary}${undo.steps.length ? ` To undo: ${undo.steps.map(s => s.action).join(', ')}.` : ''}`);
        }});

    r.register({id: 'macro.list', title: 'List macros', description: 'The macros you have saved and how many steps each has', category: 'Planner', keywords: ['macro', 'list'], permission: 'none',
        run: async () => {
            const names = Object.keys(loadMacros()).sort();
            return names.length ? names.map(n => `${n}: ${(loadMacros()[n].steps ?? []).length} steps`).join('\n') : 'No macros saved yet';
        }});
    r.register({id: 'macro.save', title: 'Save a macro', description: 'Keeps a list of steps ([{"action":"system.mute.toggle","args":{},"delayMs":0}]) under a name; passwords and other sensitive steps are refused', category: 'Planner', keywords: ['macro', 'save', 'record'],
        params: [{name: 'name', type: 'string', required: true, maxLength: 60}, {name: 'steps', type: 'string', required: true, maxLength: 20000}], permission: 'none',
        run: async ({name, steps}) => {
            if (!MACRO_NAME.test(name)) throw new Error('a macro name is letters, digits, spaces, dots and dashes (up to 60)');
            let list;
            try { list = JSON.parse(steps); } catch (_e) { throw new Error('steps are not valid JSON'); }
            const macros = loadMacros();
            if (!macros[name] && Object.keys(macros).length >= MAX_MACROS) throw new Error(`at most ${MAX_MACROS} macros`);
            const imp = importMacro(JSON.stringify({version: 1, name, steps: list}));
            if (!imp.ok) throw new Error(imp.error);
            const bad = checkSteps(imp.macro.steps());        // the same checks as playing it: do not keep what could not run
            if (bad) throw new Error(bad);
            macros[name] = {steps: imp.macro.steps()};
            saveMacros(macros);
            return `Macro "${name}" saved (${imp.macro.length()} steps)`;
        }});
    r.register({id: 'macro.play', title: 'Play a macro', description: 'Runs a saved macro, step by step through the same actions; it stops at the first failure and can be stopped with macro.stop', category: 'Planner', keywords: ['macro', 'play', 'run'],
        params: [{name: 'name', type: 'string', required: true, maxLength: 60}, {name: 'loops', type: 'number', min: 1, max: MAX_LOOPS}], permission: 'confirm', confirm: 'Play this macro?',
        ask: ({name, loops}) => {
            const m = openMacro(name);
            return m.error ? `Macro "${name}" cannot run: ${m.error}` : `Play macro "${name}" (${m.macro.length()} steps${loops > 1 ? `, ${loops} times` : ''})?`;
        },
        run: async ({name, loops = 1}, env) => {
            if (player && !player.done()) throw new Error('a macro is already playing; stop it first');
            if (!Number.isInteger(loops)) throw new Error('loops must be a whole number');
            const m = openMacro(name);
            if (m.error) throw new Error(m.error);
            const plan = playbackPlan(m.macro, {loops});
            if (!plan.ok) throw new Error(plan.error);
            const mine = player = createPlayer(plan);
            const asPlan = {steps: plan.steps.map(s => ({action: s.action, args: s.args}))};
            const results = [];
            let at = 0, step;
            try {
                while ((step = mine.next())) {
                    for (let wait = step.at - at; wait > 0 && !mine.stopped(); wait -= 250) await services.sleep(Math.min(wait, 250));
                    at = step.at;
                    if (mine.stopped()) break;
                    const o = await services.runStep(step.action, step.args, env);
                    results.push({ok: o.ok, error: o.error});
                    if (!o.ok) break;
                }
            } finally { if (player === mine) player = null; }
            const report = buildReport(asPlan, results, catalog());
            if (mine.stopped()) return `Macro "${name}" stopped after ${report.completed.length} of ${asPlan.steps.length} steps`;
            if (!report.ok) throw new Error(`Macro "${name}": ${report.summary}`);
            return `Macro "${name}": ${report.summary}`;
        }});
    r.register({id: 'macro.stop', title: 'Stop the macro', description: 'Stops the macro that is playing; the step running now finishes first', category: 'Planner', keywords: ['macro', 'stop', 'cancel'], permission: 'none',
        run: async () => {
            if (!player || player.done()) return 'No macro is playing';
            player.stop();
            return 'Stopping the macro';
        }});

    r.register({id: 'adaptive.dismiss', title: 'Dismiss the suggestion', description: 'Says no to the profile Search suggested; it stays quiet for a while', category: 'Niro', keywords: ['adaptive', 'suggestion', 'dismiss'], permission: 'none',
        run: async () => services.adaptive.dismiss()});
    r.register({id: 'adaptive.history', title: 'Suggestion history', description: 'What Search suggested, and whether you accepted or dismissed it (rule and profile names only)', category: 'Niro', keywords: ['adaptive', 'suggestion', 'history'], permission: 'none',
        run: async () => services.adaptive.history()});
    r.register({id: 'adaptive.lock', title: 'Lock or unlock suggestions', description: 'Locked: Search makes no suggestion at all until you unlock it', category: 'Niro', keywords: ['adaptive', 'suggestion', 'lock', 'pause'],
        params: [{name: 'state', type: 'enum', required: true, enum: ['lock', 'unlock']}], permission: 'none',
        run: async ({state}) => services.adaptive.lock(state === 'lock')});
    return r;
}
