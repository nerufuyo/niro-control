// Niro Flow in the panel, the logic without a screen: reading what the daemon (org.niro.Flow1) answers, the form that makes a workflow,
// the checks before saving, the preview of a dry run, and one controller that holds every state the page can be in.
// Nothing here imports GTK or GLib, so node can test it with a fake backend. The page (flowPage.ts) only draws this state.
// Flow runs only what Search's registry offers and the workflow's own allow list lets through: this file adds no way to run a command.

export const API_VERSION = 1;

export type FlowErrorKind = 'unavailable' | 'permission' | 'unsupported' | 'error';

/** What the backend throws: `kind` says which screen the page shows; `message` is a sentence for the user. */
export class FlowError extends Error {
    kind: FlowErrorKind;
    constructor(kind: FlowErrorKind, message: string) {
        super(message);
        this.name = 'FlowError';
        this.kind = kind;
    }
}

/** Maps a D-Bus failure (its error name and text) to the kind of screen it needs. */
export function classifyError(e: any): FlowError {
    if (e instanceof FlowError) return e;
    const text = String(e?.message ?? e ?? '');
    if (/ServiceUnknown|NameHasNoOwner|not provided by any|no owner|Could not connect|Connection refused|NoReply|Timeout|timed out/i.test(text))
        return new FlowError('unavailable', 'The Niro daemon is not running, so Flow cannot be reached. Start niro-island-daemon (or log out and in) and try again.');
    if (/AccessDenied|PermissionDenied|not allowed|Rejected send message/i.test(text))
        return new FlowError('permission', 'The session bus refused this panel access to Flow. Check the daemon\'s D-Bus policy or the sandbox this panel runs in.');
    if (/UnknownMethod|UnknownInterface|UnknownObject|No such (interface|method)|No such object/i.test(text))
        return new FlowError('unsupported', 'The running daemon has no Flow interface. Update the daemon to the same version as this panel.');
    return new FlowError('error', text.replace(/^GDBus\.Error:[\w.]+:\s*/, '') || 'Flow answered with an error.');
}

// ---- Reading answers

const parse = (text: any, what: string) => {
    try {
        return JSON.parse(String(text));
    } catch (_e) {
        throw new FlowError('error', `Flow sent an unreadable ${what}.`);
    }
};

export function parseList(text: string) {
    const v = parse(text, 'workflow list');
    if (!v || typeof v !== 'object') throw new FlowError('error', 'Flow sent an unreadable workflow list.');
    return {
        api: Number(v.api ?? API_VERSION),
        enabled: v.flow_enabled === true,
        workflows: (Array.isArray(v.workflows) ? v.workflows : []).filter(w => w && typeof w.id === 'string'),
        problems: (Array.isArray(v.problems) ? v.problems : []).map(p => ({file: String(p?.file ?? ''), error: String(p?.error ?? '')})),
    };
}

export function parseTemplates(text: string) {
    const v = parse(text, 'template list');
    return (Array.isArray(v) ? v : []).filter(t => t && t.workflow && typeof t.id === 'string').map(t => ({id: t.id, title: String(t.title ?? t.id), workflow: t.workflow}));
}

export interface ActionParam { name: string; type: string; required?: boolean; maxLength?: number; min?: number; max?: number; enum?: string[]; }
export interface KnownAction { id: string; title: string; available: boolean; reason: string | null; params: ActionParam[]; capability: string | null; canRun: boolean; }

/** Ids that would run a program or script: never offered, whatever the registry lists. */
const SHELL_LIKE = /(^|\.)(shell|exec|spawn|command|cmd|terminal|script|run-command)(\.|$)/i;

export function parseActions(text: string): {ok: boolean; error: string; actions: KnownAction[]} {
    const v = parse(text, 'action list');
    if (!v || v.ok === false) return {ok: false, error: String(v?.error ?? 'the action list is not available'), actions: []};
    const actions = (Array.isArray(v.actions) ? v.actions : []).filter(a => a && typeof a.id === 'string').map(a => ({
        id: a.id, title: String(a.title ?? a.id), available: a.available !== false, reason: a.reason ?? null,
        params: Array.isArray(a.params) ? a.params : [], capability: a.capability ?? null,
        canRun: a.flow_can_run === true && !SHELL_LIKE.test(a.id),
    }));
    return {ok: true, error: '', actions};
}

export function parseHistory(text: string) {
    const v = parse(text, 'history');
    return (Array.isArray(v) ? v : []).filter(r => r && typeof r === 'object');
}

// ---- Showing what Flow reports without showing secrets

const SECRET = /token|password|passphrase|secret|key|credential/i;
/** The same masking the daemon applies, kept here too so a value never reaches a label unmasked. */
export function redactArgs(args: Record<string, any> | null | undefined) {
    return Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, SECRET.test(k) ? '***' : v]));
}
export const argsText = (args: Record<string, any>) => Object.entries(redactArgs(args)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');

// ---- Triggers, conditions, actions: what the form offers

export interface TriggerDef { type: string; label: string; hint: string; field?: {name: 'app' | 'percent' | 'at'; label: string; kind: 'text' | 'percent' | 'time'; default: string}; }
export const TRIGGERS: TriggerDef[] = [
    {type: 'manual', label: 'Only when I run it', hint: 'Never starts by itself.'},
    {type: 'app_focused', label: 'An app gets focus', hint: 'Checked about once a minute.', field: {name: 'app', label: 'App (its name or id)', kind: 'text', default: ''}},
    {type: 'app_launched', label: 'An app starts', hint: '', field: {name: 'app', label: 'App (its name or id)', kind: 'text', default: ''}},
    {type: 'workspace_changed', label: 'The workspace changes', hint: ''},
    {type: 'monitor_connected', label: 'A monitor is connected', hint: ''},
    {type: 'battery_below', label: 'The battery runs low', hint: '', field: {name: 'percent', label: 'Below (percent)', kind: 'percent', default: '20'}},
    {type: 'ac_changed', label: 'The charger is plugged or unplugged', hint: ''},
    {type: 'schedule', label: 'At a time of day', hint: '', field: {name: 'at', label: 'Time (HH:MM, 24 hours)', kind: 'time', default: '22:00'}},
    {type: 'network_changed', label: 'The network goes on or off', hint: ''},
    {type: 'profile_changed', label: 'A profile is applied', hint: ''},
];
export const triggerDef = (type: string) => TRIGGERS.find(t => t.type === type) ?? TRIGGERS[0];

/** Variables a condition can look at (what the daemon keeps of the desktop's state). */
export const CONDITION_VARS = [
    {name: 'app', label: 'Focused app', kind: 'text'}, {name: 'battery', label: 'Battery percent', kind: 'number'},
    {name: 'ac', label: 'On the charger', kind: 'bool'}, {name: 'network', label: 'Network connected', kind: 'bool'},
];
export const CONDITION_KINDS = [['none', 'Always'], ['eq', 'A value is'], ['cmp', 'A number is above or below'], ['time', 'Between two times']] as const;
export const COMPARISONS = [['lt', 'is below'], ['le', 'is at most'], ['gt', 'is above'], ['ge', 'is at least']] as const;

export const triggerSentence = (t: any) => {
    const d = triggerDef(t?.type);
    const f = d.field;
    return f ? `${d.label}: ${t[f.name]}${f.kind === 'percent' ? '%' : ''}` : d.label;
};

// ---- The form

export interface Form {
    id: string; name: string; enabled: boolean;
    trigger: {type: string; app: string; percent: string; at: string};
    condition: {kind: 'none' | 'eq' | 'cmp' | 'time'; var: string; value: string; cmp: string; from: string; to: string};
    actions: {name: string; args: Record<string, any>}[];
}

export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const emptyForm = (): Form => ({
    id: '', name: '', enabled: false,
    trigger: {type: 'manual', app: '', percent: '20', at: '22:00'},
    condition: {kind: 'none', var: 'battery', value: '', cmp: 'lt', from: '09:00', to: '17:00'},
    actions: [],
});

/** A name made into an id that is free: "Coding focus" becomes coding-focus, then coding-focus-2 when taken. */
export function uniqueId(base: string, taken: string[]) {
    const slug = (base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56)) || 'workflow';
    if (!taken.includes(slug)) return slug;
    for (let n = 2; ; n++)
        if (!taken.includes(`${slug}-${n}`)) return `${slug}-${n}`;
}

const scalar = (kind: string, text: string) => {
    if (kind === 'bool') return /^(true|yes|on|1)$/i.test(text.trim());
    if (kind === 'number') return Number(text);
    return text;
};

/** The workflow JSON the daemon takes. The allow list is what the chosen actions need, no more. */
export function formToWorkflow(form: Form, known: KnownAction[]) {
    const t = form.trigger;
    const def = triggerDef(t.type);
    const trigger: any = {type: t.type};
    if (def.field) trigger[def.field.name] = def.field.kind === 'percent' ? Number(t[def.field.name]) : t[def.field.name].trim();
    const steps: any[] = [];
    const c = form.condition;
    const first = form.actions.length ? 'a1' : null;
    if (c.kind !== 'none') {
        let expr: any;
        if (c.kind === 'eq') {
            const v = CONDITION_VARS.find(x => x.name === c.var);
            expr = {op: 'eq', var: c.var, value: scalar(v?.kind ?? 'text', c.value)};
        } else if (c.kind === 'cmp') expr = {op: 'cmp', var: c.var, cmp: c.cmp, value: Number(c.value)};
        else expr = {op: 'time_range', from: c.from, to: c.to};
        steps.push({kind: 'condition', id: 'if', expr, then: first, else: null});
    }
    form.actions.forEach((a, i) => steps.push({kind: 'action', id: `a${i + 1}`, name: a.name, args: a.args, next: i + 1 < form.actions.length ? `a${i + 2}` : null}));
    const allow = [...new Set(form.actions.map(a => known.find(k => k.id === a.name)?.capability).filter(Boolean))].sort();
    return {version: 1, id: form.id.trim(), name: form.name.trim(), enabled: form.enabled, trigger, steps, allow};
}

/**
 * Reads a saved workflow back into the form. A workflow the form cannot show without losing something (delays, variables,
 * several conditions, branches, an allow list wider than its actions need) comes back with `lossy` reasons: the page then
 * shows it read-only and never saves the form over it.
 */
export function workflowToForm(wf: any): {form: Form; lossy: string[]} {
    const form = emptyForm();
    const lossy: string[] = [];
    form.id = wf.id; form.name = wf.name ?? ''; form.enabled = wf.enabled !== false;
    const tr = wf.trigger ?? {type: 'manual'};
    if (!TRIGGERS.some(t => t.type === tr.type)) lossy.push(`trigger "${tr.type}"`);
    form.trigger = {type: TRIGGERS.some(t => t.type === tr.type) ? tr.type : 'manual', app: String(tr.app ?? ''), percent: String(tr.percent ?? '20'), at: String(tr.at ?? '22:00')};
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    const conds = steps.filter(s => s.kind === 'condition');
    if (steps.some(s => s.kind === 'delay')) lossy.push('a delay step');
    if (steps.some(s => s.kind === 'set')) lossy.push('a variable step');
    if (conds.length > 1) lossy.push('more than one condition');
    if (conds[0]) {
        const e = conds[0].expr ?? {};
        if (e.op === 'eq') form.condition = {...form.condition, kind: 'eq', var: e.var, value: String(e.value)};
        else if (e.op === 'cmp') form.condition = {...form.condition, kind: 'cmp', var: e.var, cmp: e.cmp, value: String(e.value)};
        else if (e.op === 'time_range') form.condition = {...form.condition, kind: 'time', from: e.from, to: e.to};
        else lossy.push(`condition "${e.op}"`);
        if (conds[0].else) lossy.push('an "otherwise" branch');
    }
    const actions = steps.filter(s => s.kind === 'action');
    form.actions = actions.map(a => ({name: a.name, args: {...(a.args ?? {})}}));
    // the form always lays steps out in one chain; anything else would be rewritten by Save
    const rebuilt = formToWorkflow(form, []);
    const shape = (list: any[]) => list.map(s => [s.kind, list.findIndex(x => x.id === (s.next ?? s.then ?? null)), s.else ? 1 : 0]);
    const sameShape = JSON.stringify(shape(rebuilt.steps)) === JSON.stringify(shape(steps));
    if (!lossy.length && !sameShape) lossy.push('steps in an order the form does not make');
    return {form, lossy};
}

/** What is wrong with the form before it is sent. The daemon checks again and its words are shown too. */
export function formProblems(form: Form, known: KnownAction[], takenIds: string[] = []): string[] {
    const p: string[] = [];
    if (!form.name.trim()) p.push('Give the workflow a name.');
    if (!ID_PATTERN.test(form.id.trim())) p.push('The id must be 1 to 64 letters, digits, dots, dashes or underscores.');
    else if (takenIds.includes(form.id.trim())) p.push(`There is already a workflow with the id "${form.id.trim()}".`);
    const def = triggerDef(form.trigger.type);
    if (def.field?.kind === 'text' && !form.trigger.app.trim()) p.push('Name the app the trigger waits for.');
    if (def.field?.kind === 'percent') {
        const n = Number(form.trigger.percent);
        if (!Number.isInteger(n) || n < 1 || n > 100) p.push('The battery percent must be a whole number from 1 to 100.');
    }
    if (def.field?.kind === 'time' && !TIME.test(form.trigger.at)) p.push('The time must be HH:MM, for example 22:00.');
    const c = form.condition;
    if (c.kind === 'eq' && !c.value.trim()) p.push('The condition needs a value to compare with.');
    if (c.kind === 'cmp' && (c.value.trim() === '' || !Number.isFinite(Number(c.value)))) p.push('The condition needs a number.');
    if (c.kind === 'time' && !(TIME.test(c.from) && TIME.test(c.to))) p.push('The condition times must be HH:MM.');
    if (!form.actions.length) p.push('Add at least one action.');
    if (form.actions.length > 20) p.push('A workflow can have at most 20 actions.');
    form.actions.forEach((a, i) => {
        const k = known.find(x => x.id === a.name);
        const at = `Action ${i + 1}`;
        if (!k) { p.push(`${at}: "${a.name}" is not an action Flow knows.`); return; }
        if (!k.canRun) p.push(`${at}: Flow cannot run "${k.title}" without asking you, so it is not allowed in a workflow.`);
        for (const prm of k.params) {
            const v = a.args[prm.name];
            const empty = v === undefined || v === null || v === '';
            if (empty) { if (prm.required) p.push(`${at}: "${prm.name}" is required.`); continue; }
            if (prm.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) p.push(`${at}: "${prm.name}" must be a number.`);
            else if (prm.type === 'number' && ((prm.min !== undefined && v < prm.min) || (prm.max !== undefined && v > prm.max))) p.push(`${at}: "${prm.name}" is out of range.`);
            if (prm.type === 'string' && prm.maxLength && String(v).length > prm.maxLength) p.push(`${at}: "${prm.name}" is longer than ${prm.maxLength} characters.`);
            if (prm.type === 'enum' && prm.enum && !prm.enum.includes(v)) p.push(`${at}: "${prm.name}" is not one of the choices.`);
        }
    });
    return p;
}

/** A fresh action with its required arguments empty. Optional ones are left out until the user fills them. */
export const newAction = (k: KnownAction) => ({name: k.id, args: Object.fromEntries(k.params.filter(p => p.type === 'enum' && p.required && p.enum?.length).map(p => [p.name, p.enum![0]]))});

// ---- Runs and previews

const ago = (ms: number, now: number) => {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
};

export function summarizeRun(r: any, now = Date.now()) {
    const when = r?.started_ms ? ago(Number(r.started_ms), now) : '';
    const status = String(r?.status ?? '').toLowerCase();
    const word = status === 'ok' ? 'Succeeded' : status === 'error' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : status === 'running' ? 'Running' : 'Unknown';
    const steps = Array.isArray(r?.steps) ? r.steps : [];
    const bad = steps.find(s => s?.error);
    const detail = r?.error ? `: ${r.error}` : bad ? `: ${bad.name} (${bad.error})` : '';
    return {status, word, text: `${word}${when ? ` ${when}` : ''}${detail}`, ok: status === 'ok', running: status === 'running'};
}

export const lastRun = (runs: any[]) => (runs.length ? runs[runs.length - 1] : null);

/** The dry run as lines a person can read. Arguments are masked again here. */
export function previewLines(d: any): {ok: boolean; lines: string[]; problems: string[]} {
    const lines = (Array.isArray(d?.steps) ? d.steps : []).map((s: any, i: number) => {
        const n = `${i + 1}.`;
        if (s.kind === 'wait') return `${n} Wait ${s.seconds} s`;
        if (s.kind === 'branch') return `${n} Condition "${s.step}" is ${s.taken ? 'true: continue' : 'false: stop here'}`;
        const verdict = String(s.permission ?? '');
        const state = verdict === 'allowed' ? (s.available === false ? 'allowed, but not available now' : 'would run') : verdict.replace(/^denied: ?/, 'blocked: ') || 'unknown';
        const args = argsText(s.args ?? {});
        return `${n} ${s.action}${args ? ` (${args})` : ''}: ${state}`;
    });
    const problems = (Array.isArray(d?.problems) ? d.problems : []).map(String);
    if (typeof d?.registry === 'string' && d.registry !== 'ok') problems.push(`Search's action list is ${d.registry}.`);
    if (d?.flow_enabled === false) problems.push('Flow is off, so nothing would run now.');
    return {ok: d?.ok === true && problems.length === 0, lines, problems};
}

// ---- The controller: every state in one place

export type FlowView = 'loading' | 'ready' | 'empty' | 'disabled' | 'unavailable' | 'permission' | 'unsupported' | 'error';

/** What the backend must offer. The real one speaks D-Bus; tests pass a fake. All calls may be async and may throw FlowError. */
export interface FlowBackend {
    status(): Promise<{apiVersion: number; enabled: boolean}>;
    list(): Promise<ReturnType<typeof parseList>>;
    templates(): Promise<ReturnType<typeof parseTemplates>>;
    knownActions(): Promise<ReturnType<typeof parseActions>>;
    save(workflow: any): Promise<{ok: boolean; problems: string[]}>;
    remove(id: string): Promise<void>;
    setEnabled(id: string, on: boolean): Promise<void>;
    setGlobalEnabled(on: boolean): Promise<void>;
    dryRun(id: string): Promise<any>;
    runNow(id: string): Promise<string>;
    cancel(runId: string): Promise<void>;
    history(id: string): Promise<any[]>;
    clearHistory(): Promise<void>;
}

export interface Notice { kind: 'success' | 'error'; text: string; }

export function createFlow(backend: FlowBackend) {
    const listeners = new Set<() => void>();
    const s = {
        view: 'loading' as FlowView, message: '', enabled: false, workflows: [] as any[], fileProblems: [] as {file: string; error: string}[],
        templates: [] as any[], actions: [] as KnownAction[], actionsError: '',
        busy: null as string | null,                       // 'applying' while a call is out: the page disables what would double-fire
        notice: null as Notice | null, saveProblems: [] as string[],
        history: {} as Record<string, any[]>, previews: {} as Record<string, any>, running: {} as Record<string, string>,
    };
    const emit = () => listeners.forEach(fn => fn());
    const fail = (e: any) => { const f = classifyError(e); return f; };
    const toView = (e: any) => {
        const f = fail(e);
        if (f.kind === 'error') { s.notice = {kind: 'error', text: f.message}; return f; }
        s.view = f.kind; s.message = f.message; s.notice = null;
        return f;
    };
    /** Runs one change with the page in "applying" and reports the outcome as a notice. */
    const apply = async <T>(label: string, fn: () => Promise<T>, success: string | ((r: T) => string)): Promise<{ok: boolean; value?: T; skipped?: boolean}> => {
        if (s.busy) return {ok: false, skipped: true};
        s.busy = 'applying'; s.notice = null; emit();
        try {
            const value = await fn();
            s.notice = {kind: 'success', text: typeof success === 'function' ? success(value) : success};
            return {ok: true, value};
        } catch (e) {
            const f = toView(e);
            if (f.kind === 'error') s.notice = {kind: 'error', text: `${label}: ${f.message}`};
            return {ok: false};
        } finally {
            s.busy = null; emit();
        }
    };
    const settle = () => {
        s.view = !s.enabled ? 'disabled' : s.workflows.length ? 'ready' : 'empty';
        s.message = '';
    };

    const self = {
        get state() { return s; },
        subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
        byId: (id: string) => s.workflows.find(w => w.id === id) ?? null,

        /** Asks the daemon for everything the page shows. Idempotent: the page calls it on show and after a change. */
        async refresh() {
            const mine = s.busy === null && s.view !== 'loading';
            if (mine) s.busy = 'applying';
            emit();
            try {
                const st = await backend.status();
                if (st.apiVersion !== API_VERSION) throw new FlowError('unsupported', `The daemon speaks Flow version ${st.apiVersion}, this panel version ${API_VERSION}. Update both to the same release.`);
                const [list, templates, known] = await Promise.all([backend.list(), backend.templates().catch(() => []), backend.knownActions().catch(e => ({ok: false, error: fail(e).message, actions: []}))]);
                if (list.api !== API_VERSION) throw new FlowError('unsupported', `The daemon's workflow list is version ${list.api}, this panel reads version ${API_VERSION}.`);
                s.enabled = list.enabled; s.workflows = list.workflows; s.fileProblems = list.problems; s.templates = templates;
                s.actions = known.actions; s.actionsError = known.ok ? '' : known.error;
                settle();
            } catch (e) {
                toView(e);
                if (s.view === 'loading') { s.view = 'error'; s.message = fail(e).message; }
            } finally {
                if (mine) s.busy = null;
                emit();
            }
        },

        async setGlobal(on: boolean) {
            const r = await apply('Flow switch', () => backend.setGlobalEnabled(on), on ? 'Flow is on. Workflows that are switched on can run.' : 'Flow is off. Nothing runs and no events are watched.');
            if (!r.skipped) await self.refresh();
        },

        async setWorkflowEnabled(id: string, on: boolean) {
            const w = self.byId(id);
            const r = await apply(w?.name || id, () => backend.setEnabled(id, on), on ? 'Switched on.' : 'Switched off.');
            if (!r.skipped) await self.refresh();
        },

        /** Saves a form. The daemon's own problems are kept in `saveProblems`, in its words. Returns true when saved. */
        async save(form: Form, {isNew}: {isNew: boolean}) {
            s.saveProblems = [];
            const taken = isNew ? s.workflows.map(w => w.id) : [];
            const local = formProblems(form, s.actions, taken);
            if (local.length) { s.saveProblems = local; s.notice = {kind: 'error', text: 'Not saved: fix the problems listed.'}; emit(); return false; }
            const wf = formToWorkflow(form, s.actions);
            const {ok, value: r} = await apply('Save', () => backend.save(wf), res => (res.ok ? `Saved "${wf.name}".` : 'Not saved.'));
            if (!ok) return false;
            if (!r.ok) { s.saveProblems = r.problems.length ? r.problems : ['The daemon refused the workflow without saying why.']; s.notice = {kind: 'error', text: 'The daemon did not save it: see the problems listed.'}; emit(); return false; }
            await self.refresh();
            return true;
        },

        /** Saves a template as a new, switched-off workflow with a free id. Returns its id, or null. */
        async fromTemplate(templateId: string) {
            const t = s.templates.find(x => x.id === templateId);
            if (!t) { s.notice = {kind: 'error', text: 'That template is not offered by the daemon.'}; emit(); return null; }
            const id = uniqueId(t.workflow.id ?? t.id, s.workflows.map(w => w.id));
            const wf = {...t.workflow, id, enabled: false};
            const {ok, value: r} = await apply('Create from template', () => backend.save(wf), res => (res.ok ? `Created "${wf.name}", switched off. Check it, then switch it on.` : 'Not created.'));
            if (!ok) return null;
            if (!r.ok) { s.notice = {kind: 'error', text: `The template was refused: ${r.problems.join(' ')}`}; emit(); return null; }
            await self.refresh();
            return id;
        },

        async remove(id: string) {
            const w = self.byId(id);
            const {ok, skipped} = await apply('Delete', () => backend.remove(id), `Deleted "${w?.name || id}".`);
            if (ok) { delete s.history[id]; delete s.previews[id]; }
            if (!skipped) await self.refresh();
        },

        async dryRun(id: string) {
            const {ok, value} = await apply('Preview', () => backend.dryRun(id), 'Preview ready. Nothing was run.');
            if (ok) { s.previews[id] = value; emit(); }
            return ok ? value : undefined;
        },

        async runNow(id: string) {
            if (!s.enabled) { s.notice = {kind: 'error', text: 'Flow is off. Switch it on to run workflows.'}; emit(); return undefined; }
            const {ok, value} = await apply('Run', () => backend.runNow(id), 'Started. The result shows under the workflow.');
            if (ok) { s.running[id] = String(value); await self.loadHistory(id); }
            return ok ? String(value) : undefined;
        },

        async cancel(id: string) {
            const run = s.running[id];
            if (!run) return;
            await apply('Cancel', () => backend.cancel(run), 'Cancelled.');
            delete s.running[id];
            await self.loadHistory(id);
        },

        async loadHistory(id: string) {
            try {
                s.history[id] = await backend.history(id);
                const last = lastRun(s.history[id]);
                if (last && !summarizeRun(last).running) delete s.running[id];
            } catch (e) {
                toView(e);
            }
            emit();
        },

        async clearHistory() {
            await apply('Clear history', () => backend.clearHistory(), 'History cleared.');
            s.history = {}; emit();
        },

        dismissNotice() { s.notice = null; emit(); },
    };
    return self;
}

export type Flow = ReturnType<typeof createFlow>;
