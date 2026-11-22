// Semantic macro recorder core (vNext initiative 16). Pure: it records action ids and arguments, never keystrokes, pointer
// positions or window contents. No timers: playback is a plan with delays that the caller schedules. Bounded everywhere.

import {looksSensitive} from './commandPlanner.js';

export const MAX_STEPS = 100;
export const MAX_LOOPS = 20;
export const MAX_DELAY_MS = 60000;
export const MAX_TOTAL_MS = 600000;
const MAX_IMPORT = 200000;
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
const SENSITIVE_NAME = /pass(word|wd|phrase)?|sandi|secret|token|credential|api[_-]?key|private[_-]?key|otp|pin\b|cvv|keyring|vault|auth/i;

/** Why a step may not be recorded, or null. Flagged steps, password-like action ids or argument names, and values that look
 * like credentials are all refused (a macro file must be safe to share). */
export function sensitiveReason(step) {
    if (step === null || typeof step !== 'object')
        return 'a step must be an object';
    if (step.sensitive === true)
        return 'the action is flagged sensitive';
    if (typeof step.action === 'string' && SENSITIVE_NAME.test(step.action))
        return 'the action id looks sensitive';
    const walk = (v, depth) => {
        if (depth > 3)
            return 'arguments are nested too deeply';
        if (typeof v === 'string')
            return looksSensitive(v) ? 'an argument value looks like a credential' : null;
        if (v && typeof v === 'object')
            for (const [k, x] of Object.entries(v)) {
                if (SENSITIVE_NAME.test(k))
                    return `argument "${k}" looks sensitive`;
                const r = walk(x, depth + 1);
                if (r)
                    return r;
            }
        return null;
    };
    return walk(step.args ?? {}, 0);
}

function checkStep(step) {
    if (!step || typeof step.action !== 'string' || !ID_RE.test(step.action))
        return 'a step needs an action id';
    if (step.args !== undefined && (step.args === null || typeof step.args !== 'object' || Array.isArray(step.args)))
        return 'arguments must be an object';
    const d = step.delayMs ?? 0;
    if (!Number.isFinite(d) || d < 0 || d > MAX_DELAY_MS)
        return `delay must be between 0 and ${MAX_DELAY_MS} ms`;
    return sensitiveReason(step);
}

const clean = step => ({action: step.action, args: JSON.parse(JSON.stringify(step.args ?? {})), delayMs: Math.round(step.delayMs ?? 0)});

/** {ok, error?} everywhere: nothing here throws on bad input. */
export function createMacro({name = 'Macro', maxSteps = MAX_STEPS} = {}) {
    let steps = [];
    let macroName = String(name).slice(0, 60);
    const fail = error => ({ok: false, error});
    const room = () => steps.length >= maxSteps ? fail(`a macro may have at most ${maxSteps} steps`) : null;
    return {
        record(step) {
            const bad = checkStep(step) ?? (room()?.error ?? null);
            if (bad)
                return fail(bad);
            steps.push(clean(step));
            return {ok: true, count: steps.length};
        },
        insert(index, step) {
            const bad = checkStep(step) ?? (room()?.error ?? null);
            if (bad)
                return fail(bad);
            if (!Number.isInteger(index) || index < 0 || index > steps.length)
                return fail('index out of range');
            steps.splice(index, 0, clean(step));
            return {ok: true, count: steps.length};
        },
        remove(index) {
            if (!Number.isInteger(index) || index < 0 || index >= steps.length)
                return fail('index out of range');
            steps.splice(index, 1);
            return {ok: true, count: steps.length};
        },
        move(from, to) {
            if (![from, to].every(i => Number.isInteger(i) && i >= 0 && i < steps.length))
                return fail('index out of range');
            const [s] = steps.splice(from, 1);
            steps.splice(to, 0, s);
            return {ok: true};
        },
        setDelay(index, ms) {
            if (!Number.isInteger(index) || index < 0 || index >= steps.length)
                return fail('index out of range');
            if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DELAY_MS)
                return fail(`delay must be between 0 and ${MAX_DELAY_MS} ms`);
            steps[index].delayMs = Math.round(ms);
            return {ok: true};
        },
        clear() { steps = []; },
        rename(n) { macroName = String(n).slice(0, 60); },
        name: () => macroName,
        steps: () => steps.map(s => ({...s, args: {...s.args}})),
        length: () => steps.length,
    };
}

/** The flat list of steps to run, each with an `at` offset (ms from the start). Refuses loops above MAX_LOOPS and a total
 * duration above `maxTotalMs`. The caller schedules it; this only computes. */
export function playbackPlan(stepsOrMacro, {loops = 1, loopDelayMs = 0, maxTotalMs = MAX_TOTAL_MS} = {}) {
    const steps = typeof stepsOrMacro?.steps === 'function' ? stepsOrMacro.steps() : stepsOrMacro;
    if (!Array.isArray(steps) || steps.length === 0)
        return {ok: false, error: 'nothing to play'};
    if (!Number.isInteger(loops) || loops < 1)
        return {ok: false, error: 'loops must be a whole number of at least 1'};
    if (loops > MAX_LOOPS)
        return {ok: false, error: `loops may not exceed ${MAX_LOOPS}`};
    if (!Number.isFinite(loopDelayMs) || loopDelayMs < 0 || loopDelayMs > MAX_DELAY_MS)
        return {ok: false, error: 'loop delay out of range'};
    const cap = Math.min(maxTotalMs, MAX_TOTAL_MS);
    const out = [];
    let at = 0;
    for (let l = 0; l < loops; l++) {
        for (const s of steps) {
            at += s.delayMs ?? 0;
            out.push({action: s.action, args: s.args ?? {}, at, loop: l});
        }
        if (l < loops - 1)
            at += loopDelayMs;
        if (at > cap)
            return {ok: false, error: `total duration would exceed ${Math.round(cap / 1000)} s`};
    }
    return {ok: true, steps: out, totalMs: at, loops};
}

/** A cursor over a playback plan with a stop flag. After stop() nothing more is handed out. */
export function createPlayer(plan) {
    let i = 0;
    let stopped = false;
    return {
        next() {
            if (stopped || !plan?.ok || i >= plan.steps.length)
                return null;
            return plan.steps[i++];
        },
        stop() { stopped = true; },
        stopped: () => stopped,
        done: () => stopped || !plan?.ok || i >= plan.steps.length,
        position: () => i,
    };
}

export function exportMacro(macro) {
    return JSON.stringify({version: 1, name: macro.name(), steps: macro.steps()});
}

/** Parses and validates every step again (an imported file is untrusted). Returns {ok, macro} or {ok:false, error}. */
export function importMacro(text, {maxSteps = MAX_STEPS} = {}) {
    if (typeof text !== 'string' || text.length > MAX_IMPORT)
        return {ok: false, error: 'file missing or too large'};
    let d;
    try { d = JSON.parse(text); } catch (_e) { return {ok: false, error: 'not valid JSON'}; }
    if (!d || d.version !== 1 || !Array.isArray(d.steps))
        return {ok: false, error: 'unsupported macro file'};
    if (d.steps.length > maxSteps)
        return {ok: false, error: `a macro may have at most ${maxSteps} steps`};
    const macro = createMacro({name: typeof d.name === 'string' ? d.name : 'Imported', maxSteps});
    for (let i = 0; i < d.steps.length; i++) {
        const r = macro.record(d.steps[i]);
        if (!r.ok)
            return {ok: false, error: `step ${i + 1}: ${r.error}`};
    }
    return {ok: true, macro};
}

// ---- shortcuts ---------------------------------------------------------------------------------------------------------

export const RESERVED_ACCELERATORS = ['Super', 'Super+L', 'Super+D', 'Super+Tab', 'Alt+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Alt+T',
    'Ctrl+Alt+Left', 'Ctrl+Alt+Right', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down', 'Alt+F2', 'Print', 'Ctrl+Alt+L', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Q'];

const MODS = {ctrl: 'Ctrl', control: 'Ctrl', primary: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super', mod4: 'Super', meta: 'Super'};

/** 'Ctrl+Alt+K' or '<Control><Alt>k' -> 'Alt+Ctrl+K' (modifiers sorted, one key), or null when it is not an accelerator. */
export function normalizeAccelerator(accel) {
    if (typeof accel !== 'string' || accel.length > 60)
        return null;
    const parts = accel.replace(/<([^>]+)>/g, '$1+').split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0)
        return null;
    const mods = new Set();
    let key = null;
    for (const p of parts) {
        const m = MODS[p.toLowerCase()];
        if (m)
            mods.add(m);
        else if (key === null && /^[A-Za-z0-9]$|^F([1-9]|1[0-2])$|^(Print|Escape|Return|space|Tab|Delete|Left|Right|Up|Down)$/i.test(p))
            key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
        else
            return null;
    }
    if (key === null)
        return mods.size === 1 && mods.has('Super') ? 'Super' : null;
    return [...[...mods].sort(), key].join('+');
}

/** {ok, accelerator?, error?}. A shortcut needs a modifier, must not be reserved, and must not already be taken. */
export function validateShortcut(accel, {reserved = RESERVED_ACCELERATORS, taken = []} = {}) {
    const n = normalizeAccelerator(accel);
    if (!n)
        return {ok: false, error: 'not a valid shortcut'};
    if (!n.includes('+') && n !== 'Super')
        return {ok: false, error: 'a shortcut needs a modifier key'};
    const set = list => new Set(list.map(normalizeAccelerator).filter(Boolean));
    if (set(reserved).has(n))
        return {ok: false, error: `${n} is reserved by the system`};
    if (set(taken).has(n))
        return {ok: false, error: `${n} is already used`};
    return {ok: true, accelerator: n};
}
