// Command planner core (vNext initiative 14). Pure: no GNOME imports, no timers, no listeners, nothing is executed here.
// A plan is {steps: [{action, args}]} over action ids from a catalog [{id, params, permission}] (the registry's ListActions shape).
// Nothing outside the catalog can ever be planned. A local rule-based parser works without any provider; anything bound for an
// external provider goes through redactForProvider first and carries only the catalog and the user's text (plus explicit context).

export const MAX_STEPS = 8;
const MAX_TEXT = 500;
const MAX_CONTEXT = 2000;
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;

/** Same rules as the registry's validateArgs (shell/search/registry.ts), re-implemented here so this core imports nothing. */
export function validateArgs(params = [], args = {}) {
    if (args === null || typeof args !== 'object' || Array.isArray(args))
        return 'arguments must be an object';
    for (const key of Object.keys(args))
        if (!params.some(p => p.name === key))
            return `unknown argument "${key}"`;
    for (const p of params) {
        const v = args[p.name];
        if (v === undefined || v === null) {
            if (p.required)
                return `"${p.name}" is required`;
            continue;
        }
        switch (p.type) {
        case 'string':
            if (typeof v !== 'string') return `"${p.name}" must be text`;
            if (v.length > (p.maxLength ?? 2000)) return `"${p.name}" is too long`;
            break;
        case 'number':
            if (typeof v !== 'number' || !Number.isFinite(v)) return `"${p.name}" must be a number`;
            if (p.min !== undefined && v < p.min) return `"${p.name}" must be at least ${p.min}`;
            if (p.max !== undefined && v > p.max) return `"${p.name}" must be at most ${p.max}`;
            break;
        case 'boolean':
            if (typeof v !== 'boolean') return `"${p.name}" must be true or false`;
            break;
        case 'enum':
            if (typeof v !== 'string' || !(p.enum ?? []).includes(v)) return `"${p.name}" must be one of ${(p.enum ?? []).join(', ')}`;
            break;
        default:
            return `"${p.name}" has an unknown type`;
        }
    }
    return null;
}

// ---- credentials -------------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|kata\s*sandi|sandi)\s*[:=]\s*\S+/gi,
    /\b(?:password|passwd|kata\s*sandi|sandi)\s+(?:is|adalah)\s+\S+/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S+/gi,
    /\b(?:\d[ -]?){13,19}\b/g,
    /\b[A-Fa-f0-9]{32,}\b/g,
    /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
];

/** True when the text looks like a credential, key, token or card number. */
export function looksSensitive(text) {
    if (typeof text !== 'string' || text === '')
        return false;
    return SECRET_PATTERNS.some(re => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; });
}

/** Replaces anything that looks like a credential with [redacted]. Always returns text; never throws. */
export function redactForProvider(text) {
    let out = typeof text === 'string' ? text : String(text ?? '');
    for (const re of SECRET_PATTERNS)
        out = out.replace(re, '[redacted]');
    return out;
}

// ---- plans -------------------------------------------------------------------------------------------------------------

const byId = catalog => new Map((Array.isArray(catalog) ? catalog : []).map(a => [a.id, a]));

/** {ok, errors: [{step, error}]}. An `unknown` plan, an unknown action, bad arguments or too many steps are all refused. */
export function validatePlan(plan, catalog, {maxSteps = MAX_STEPS} = {}) {
    const errors = [];
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan))
        return {ok: false, errors: [{step: -1, error: 'a plan must be an object'}]};
    if (plan.unknown)
        return {ok: false, errors: [{step: -1, error: 'the request was not understood; nothing to run'}]};
    if (!Array.isArray(plan.steps) || plan.steps.length === 0)
        return {ok: false, errors: [{step: -1, error: 'a plan needs at least one step'}]};
    if (plan.steps.length > maxSteps)
        errors.push({step: -1, error: `a plan may have at most ${maxSteps} steps`});
    const actions = byId(catalog);
    plan.steps.slice(0, maxSteps).forEach((s, i) => {
        if (s === null || typeof s !== 'object' || typeof s.action !== 'string' || !ID_RE.test(s.action))
            return errors.push({step: i, error: 'a step needs an action id'});
        const a = actions.get(s.action);
        if (!a)
            return errors.push({step: i, error: `no action "${s.action}"`});
        const bad = validateArgs(a.params ?? [], s.args ?? {});
        if (bad)
            errors.push({step: i, error: bad});
    });
    return {ok: errors.length === 0, errors};
}

const fmtValue = v => typeof v === 'string' ? `"${v.length > 60 ? `${v.slice(0, 57)}...` : v}"` : String(v);

/** Human-readable preview, one line per step. Sensitive-looking argument values are hidden. */
export function describePlan(plan, catalog) {
    if (!plan || plan.unknown || !Array.isArray(plan.steps))
        return ['Not understood: nothing will run.'];
    const actions = byId(catalog);
    return plan.steps.map((s, i) => {
        const a = actions.get(s?.action);
        const title = a?.title ?? s?.action ?? '?';
        const args = Object.entries(s?.args ?? {}).map(([k, v]) => `${k}=${typeof v === 'string' && looksSensitive(v) ? '[hidden]' : fmtValue(v)}`);
        const ask = a && a.permission !== 'none' ? ' (asks first)' : '';
        return `${i + 1}. ${title}${args.length ? ` ${args.join(', ')}` : ''}${ask}`;
    });
}

/** Granted without asking: 'always' or 'session' for subject `planner` (read from permissions.list(); nothing is consumed). */
function granted(permissions, capability) {
    if (!permissions?.list || !capability)
        return false;
    return permissions.list().some(g => g.subject === 'planner' && g.capability === capability && (g.scope === 'always' || g.scope === 'session'));
}

/** True when the user must confirm before running: any action whose permission is not 'none', an action whose capability is not
 * already granted, or any step that failed validation (a plan that cannot be validated is never run silently). */
export function needsConfirmation(plan, catalog, permissions = null) {
    if (!validatePlan(plan, catalog).ok)
        return true;
    const actions = byId(catalog);
    return plan.steps.some(s => {
        const a = actions.get(s.action);
        if (a.permission !== 'none')
            return true;
        return Boolean(a.capability) && !granted(permissions, a.capability);
    });
}

// ---- undo ---------------------------------------------------------------------------------------------------------------

/** What would undo one step: a catalog `undo: {action, args?}`, a toggle (the same call again), or profile.apply -> profile.undo. */
export function undoFor(step, catalog) {
    const a = byId(catalog).get(step?.action);
    if (!a)
        return null;
    if (a.undo && typeof a.undo.action === 'string')
        return {action: a.undo.action, args: a.undo.args ?? {}};
    if (/\.toggle$/.test(a.id))
        return {action: a.id, args: step.args ?? {}};
    if (a.id === 'profile.apply' && byId(catalog).has('profile.undo'))
        return {action: 'profile.undo', args: {}};
    return null;
}

/** Undo steps in reverse order for the steps that have one; the others are listed as irreversible. */
export function undoPlan(plan, catalog) {
    const steps = [];
    const irreversible = [];
    (plan?.steps ?? []).forEach((s, i) => {
        const u = undoFor(s, catalog);
        if (u) steps.unshift(u); else irreversible.push(i);
    });
    return {steps, irreversible};
}

// ---- partial failure ----------------------------------------------------------------------------------------------------

/** `results[i]` is {ok, error?, message?} for a step that ran. Running stops at the first failure; the rest are skipped. */
export function buildReport(plan, results, catalog = []) {
    const steps = plan?.steps ?? [];
    const done = [];
    let failed = null;
    for (let i = 0; i < steps.length; i++) {
        const r = results?.[i];
        if (!r)
            break;
        if (r.ok)
            done.push(i);
        else {
            failed = {step: i, action: steps[i].action, error: String(r.error ?? 'failed')};
            break;
        }
    }
    const skipped = steps.map((_s, i) => i).filter(i => !done.includes(i) && i !== failed?.step);
    const undo = undoPlan({steps: done.map(i => steps[i])}, catalog);
    let summary;
    if (!failed && skipped.length === 0)
        summary = `All ${steps.length} step${steps.length === 1 ? '' : 's'} done.`;
    else if (failed)
        summary = `${done.length} of ${steps.length} done; step ${failed.step + 1} failed (${failed.error}); ${skipped.length} not run.`;
    else
        summary = `${done.length} of ${steps.length} done; ${skipped.length} not run.`;
    return {ok: !failed && skipped.length === 0, completed: done, failed, skipped, summary, undo};
}

// ---- local parser -------------------------------------------------------------------------------------------------------

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const cleanName = s => s.replace(/^(aplikasi|app|the|si)\s+/, '').replace(/[.!?]+$/, '').trim();

// Each rule maps a phrase to ONE catalog action id. A rule is dropped when the catalog lacks the action or the args do not validate.
// Rules that carry the person's own text keep its case and spelling: they are matched against the raw part (case-insensitive), not the normalised one.
const RAW_RULES = [
    {action: 'clipboard.copy', re: /^(?:please |tolong )?(?:copy|salin|copykan)\s+(?:["'“”‘’]?)(.+?)(?:["'“”‘’]?)\s+(?:to|onto|into|ke|di)\s+(?:the |my )?(?:clipboard|papan klip)$/i, args: m => ({text: m[1]})},
    {action: 'clipboard.copy', re: /^(?:please |tolong )?(?:copy|salin)\s+(?:to|ke)\s+(?:the )?clipboard\s*[:,]?\s+(.+)$/i, args: m => ({text: m[1].replace(/^["'“”‘’]|["'“”‘’]$/g, '')})},
];
/** Phrasings that work, for the "not understood" message. */
export const EXAMPLES = ['copy hello to clipboard', 'open firefox then mute', 'lock screen'];
export const NOT_UNDERSTOOD = `Not understood: nothing would run. Try, for example: ${EXAMPLES.map(e => `"${e}"`).join(', ')}.`;

// `raw`: matched against the part as typed, so the note or task keeps its case and accents.
const RULES = [
    {action: 'app.launch', re: /^(?:tolong |please )?(?:buka|bukakan|jalankan|open|launch|start|run)\s+(?!file\b|pengaturan\b|settings\b)(.+)$/, args: m => ({id: cleanName(m[1])})},
    {action: 'profile.apply', re: /^(?:aktifkan|nyalakan|pakai|terapkan|enable|activate|turn on|apply|use|switch to)\s+(?:mode |profil |profile )?(.+?)(?: mode| profile| profil)?$/, args: m => ({id: cleanName(m[1]).replace(/\s+/g, '-')}), when: m => !/^(wifi|wi-fi|bluetooth|vpn|dnd|mute|night ?light)/.test(m[1])},
    {action: 'window.move-to-workspace', re: /^(?:pindahkan|pindah|geser|move|send)\s+(.+?)\s+(?:ke|to)\s+(?:workspace|ruang kerja|desktop)\s+(\d{1,2})$/, args: m => ({app: cleanName(m[1]), workspace: Number(m[2])})},
    {action: 'system.wifi.toggle', re: /^(?:matikan|nyalakan|aktifkan|turn (?:on|off)|toggle|switch)\s+(?:the )?wi-?fi$/, args: () => ({})},
    {action: 'system.bluetooth.toggle', re: /^(?:matikan|nyalakan|aktifkan|turn (?:on|off)|toggle|switch)\s+(?:the )?bluetooth$/, args: () => ({})},
    {action: 'system.vpn.toggle', re: /^(?:matikan|nyalakan|aktifkan|turn (?:on|off)|toggle|switch)\s+(?:the )?vpn$/, args: () => ({})},
    {action: 'system.mute.toggle', re: /^(?:bisukan|mute|unmute|matikan suara|nyalakan suara|toggle mute)(?: sound| audio| suara)?$/, args: () => ({})},
    {action: 'system.dnd.toggle', re: /^(?:aktifkan|matikan|nyalakan|turn (?:on|off)|toggle)\s+(?:do not disturb|jangan ganggu|dnd)$/, args: () => ({})},
    {action: 'system.nightlight.toggle', re: /^(?:aktifkan|matikan|nyalakan|turn (?:on|off)|toggle)\s+(?:night ?light|mode malam|cahaya malam)$/, args: () => ({})},
    {action: 'system.lock', re: /^(?:kunci(?: layar)?|lock(?: (?:the|my))?(?: screen| computer| session)?)$/, args: () => ({})},
    {action: 'system.screenshot', re: /^(?:ambil )?(?:screenshot|tangkapan layar|take a screenshot|take screenshot)$/, args: () => ({})},
    {action: 'note.add', raw: true, re: /^(?:catat|note|add (?:a )?note)\s+(.+)$/i, args: m => ({text: m[1].trim()})},
    {action: 'todo.add', raw: true, re: /^(?:tambah(?:kan)? tugas|add (?:a )?(?:todo|to-do|task))\s+(.+)$/i, args: m => ({text: m[1].trim()})},
];

function ruleArgsFit(params, args) {
    // Rules name arguments generically; map to the catalog's own parameter names when they differ and there is one candidate.
    const names = params.map(p => p.name);
    const keys = Object.keys(args);
    if (keys.every(k => names.includes(k)))
        return args;
    if (keys.length === 1 && names.length === 1)
        return {[names[0]]: args[keys[0]]};
    return null;
}

/** Local-only, rule-based. Splits on "lalu/kemudian/then/and then/dan lalu" for up to MAX_STEPS steps. Everything it returns is
 * validated against the catalog; if any part is not understood the result is {unknown: true} (never a guess). */
export function localParse(text, catalog) {
    if (typeof text !== 'string')
        return {unknown: true};
    const actions = byId(catalog);
    const raw = text.slice(0, MAX_TEXT).replace(/\s+/g, ' ').trim();
    // "copy a, b to clipboard" is one request: the text may hold commas and "then"
    const rawStep = part => {
        for (const r of RAW_RULES) {
            const a = actions.get(r.action);
            const m = a && part.match(r.re);
            if (!m)
                continue;
            const args = ruleArgsFit(a.params ?? [], r.args(m));
            if (args && validateArgs(a.params ?? [], args) === null)
                return {action: r.action, args};
        }
        return null;
    };
    const whole = rawStep(raw);
    if (whole) {
        const plan = {steps: [whole], source: 'local'};
        return validatePlan(plan, catalog).ok ? plan : {unknown: true};
    }
    const parts = raw.split(/\s*(?:,|;|\blalu\b|\bkemudian\b|\bsetelah itu\b|\bthen\b|\band then\b|\bdan lalu\b)\s*/i).filter(Boolean);
    if (parts.length === 0 || parts.length > MAX_STEPS)
        return {unknown: true};
    const steps = [];
    for (const rawPart of parts) {
        const part = norm(rawPart);
        let step = rawStep(rawPart);
        if (step) {
            steps.push(step);
            continue;
        }
        for (const r of RULES) {
            const a = actions.get(r.action);
            if (!a)
                continue;
            const m = (r.raw ? rawPart : part).match(r.re);
            if (!m || (r.when && !r.when(m)))
                continue;
            const args = ruleArgsFit(a.params ?? [], r.args(m));
            if (args && validateArgs(a.params ?? [], args) === null) {
                step = {action: r.action, args};
                break;
            }
        }
        if (!step)
            return {unknown: true};
        steps.push(step);
    }
    const plan = {steps, source: 'local'};
    return validatePlan(plan, catalog).ok ? plan : {unknown: true};
}

// ---- external providers --------------------------------------------------------------------------------------------------

/** The catalog as a provider may see it: ids, parameter shapes and permission only. No titles, descriptions, handlers or state. */
export function catalogForProvider(catalog) {
    return (Array.isArray(catalog) ? catalog : []).map(a => ({
        id: a.id,
        permission: a.permission,
        params: (a.params ?? []).map(p => ({name: p.name, type: p.type, required: !!p.required, ...(p.enum ? {enum: p.enum} : {}),
            ...(p.min !== undefined ? {min: p.min} : {}), ...(p.max !== undefined ? {max: p.max} : {})})),
    }));
}

/** The prompt for an external provider: the catalog and the redacted user text; `context` only when passed explicitly (also
 * redacted and bounded). Returns {system, user, included} where `included` lists exactly what leaves the machine. */
export function buildProviderPrompt({catalog, text, context = null}) {
    const user = redactForProvider(String(text ?? '').slice(0, MAX_TEXT));
    const included = ['catalog', 'text'];
    const system = ['Turn the request into a JSON plan: {"steps":[{"action":"<id>","args":{}}]}.',
        `Use only action ids from the catalog; at most ${MAX_STEPS} steps; if nothing fits answer {"unknown":true}.`,
        `Catalog: ${JSON.stringify(catalogForProvider(catalog))}`].join('\n');
    const out = {system, user, included};
    if (context !== null && context !== undefined && context !== '') {
        out.context = redactForProvider(typeof context === 'string' ? context : JSON.stringify(context)).slice(0, MAX_CONTEXT);
        included.push('context');
    }
    return out;
}

/** A provider's answer is untrusted: parse, then validate against the catalog; anything else becomes {unknown: true}. */
export function parseProviderPlan(reply, catalog) {
    let d;
    try { d = JSON.parse(String(reply).slice(0, 20000)); } catch (_e) { return {unknown: true}; }
    if (!d || typeof d !== 'object' || !Array.isArray(d.steps))
        return {unknown: true};
    const plan = {steps: d.steps.map(s => ({action: s?.action, args: s?.args ?? {}})), source: 'provider'};
    return validatePlan(plan, catalog).ok ? plan : {unknown: true};
}
