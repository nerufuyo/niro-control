// Window rules as declarative data (vNext S2). Pure: no shell, no timers, no listeners, so there is nothing to clean up on disable.
//
// A rule: {id, enabled, priority, stop, conditions, actions}
//   conditions (all given ones must hold): appId (exact, any case), title (substring, or /regex/flags), workspace (1..36),
//                                          monitor (0..), type ('normal'|'dialog'|'utility'|...), time {from:'HH:MM', to:'HH:MM'}, profile
//   actions: workspace (1..36), monitor (0..), tile ('float'|'tile'), above (bool), opacity (0.1..1), fullscreen (bool)
// Higher priority runs first; `stop` ends the walk after that rule matched. Nothing here touches a window: `evaluate` returns
// what would be done, and the shell applies it (or only shows it, for a dry run).

export const SCHEMA_VERSION = 1;
export const ACTION_KEYS = ['workspace', 'monitor', 'tile', 'above', 'opacity', 'fullscreen'];
export const CONDITION_KEYS = ['appId', 'title', 'workspace', 'monitor', 'type', 'time', 'profile'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_REGEX_LENGTH = 200;

const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

// True when a repeated group itself holds a group, an alternation or a quantifier: (a+)+, ((a))+, (a|aa)+. These can backtrack exponentially.
// shortcut: adjacent repeats (a*a*a*b) and backreferences still pass; use a linear-time matcher if that ever bites.
function backtracks(source) {
    // Blank out escapes and character classes, and the "?" of (?: (?= (?<name>, so only structural characters are left.
    const s = source.replace(/\\.|\[(?:\\.|[^\\\]])*\]/g, '_').replace(/\(\?(?:[:=!]|<[=!]|<[^>]*>)/g, '(');
    const groups = [];   // per open group: does it hold a group, alternation or quantifier?
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ')') {
            // "Repeated" = *, + or {n} above 1; a group that is only optional runs at most once.
            if (groups.pop() && /^(?:[*+]|\{(?!(?:0,)?[01]\})\d)/.test(s.slice(i + 1)))
                return true;
        } else {
            if (groups.length && '(|*+?{'.includes(s[i]))
                groups[groups.length - 1] = true;
            if (s[i] === '(')
                groups.push(false);
        }
    }
    return false;
}

function titleMatcher(pattern) {
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
    if (!m)
        return t => t.toLowerCase().includes(pattern.toLowerCase());
    // A regex typed by the user must not hang the shell: bounded length, no repeated complex groups.
    if (m[1].length > MAX_REGEX_LENGTH || backtracks(m[1]))
        return null;
    try {
        const re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
        return t => re.test(t);
    } catch (_e) {
        return null;
    }
}

/** Problems with one raw rule, in words; an empty list means it is valid. */
export function checkRule(r, index = 0) {
    const where = `rule ${index + 1}`;
    const problems = [];
    if (!r || typeof r !== 'object' || Array.isArray(r))
        return [`${where}: not an object`];
    if (typeof r.id !== 'string' || !/^[\w.-]{1,64}$/.test(r.id))
        problems.push(`${where}: "id" must be 1 to 64 letters, digits, dot, dash or underscore`);
    if (r.priority !== undefined && !Number.isInteger(r.priority))
        problems.push(`${where}: priority must be a whole number`);
    const c = r.conditions ?? {};
    const a = r.actions ?? {};
    for (const k of Object.keys(c))
        if (!CONDITION_KEYS.includes(k))
            problems.push(`${where}: unknown condition "${k}"`);
    for (const k of Object.keys(a))
        if (!ACTION_KEYS.includes(k))
            problems.push(`${where}: unknown action "${k}"`);
    if (Object.keys(c).filter(k => c[k] !== undefined).length === 0)
        problems.push(`${where}: it has no condition, so it would match every window`);
    if (Object.keys(a).filter(k => a[k] !== undefined).length === 0)
        problems.push(`${where}: it does nothing (no action)`);
    if (c.appId !== undefined && (typeof c.appId !== 'string' || c.appId.trim() === ''))
        problems.push(`${where}: appId must be text`);
    if (c.title !== undefined && (typeof c.title !== 'string' || c.title === '' || titleMatcher(c.title) === null))
        problems.push(`${where}: title must be text or a safe /regex/`);
    for (const k of ['workspace']) {
        for (const o of [c, a])
            if (o[k] !== undefined && !(Number.isInteger(o[k]) && o[k] >= 1 && o[k] <= 36))
                problems.push(`${where}: ${k} must be a number from 1 to 36`);
    }
    for (const o of [c, a])
        if (o.monitor !== undefined && !(Number.isInteger(o.monitor) && o.monitor >= 0 && o.monitor <= 15))
            problems.push(`${where}: monitor must be a number from 0 to 15`);
    if (c.time !== undefined && !(c.time && HHMM.test(c.time.from ?? '') && HHMM.test(c.time.to ?? '')))
        problems.push(`${where}: time needs "from" and "to" as HH:MM`);
    if (a.tile !== undefined && !['float', 'tile'].includes(a.tile))
        problems.push(`${where}: tile must be float or tile`);
    if (a.above !== undefined && typeof a.above !== 'boolean')
        problems.push(`${where}: above must be true or false`);
    if (a.fullscreen !== undefined && typeof a.fullscreen !== 'boolean')
        problems.push(`${where}: fullscreen must be true or false`);
    if (a.opacity !== undefined && !(typeof a.opacity === 'number' && a.opacity >= 0.1 && a.opacity <= 1))
        problems.push(`${where}: opacity must be from 0.1 to 1`);
    return problems;
}

/** Problems with a whole rule list (including duplicate ids). */
export function checkRules(text) {
    let data;
    try {
        data = typeof text === 'string' ? JSON.parse(text || '[]') : text;
    } catch (e) {
        return [`not JSON: ${e.message}`];
    }
    if (!Array.isArray(data))
        return ['not a list'];
    const problems = data.flatMap((r, i) => checkRule(r, i));
    const seen = new Set();
    data.forEach((r, i) => {
        if (r && typeof r.id === 'string') {
            if (seen.has(r.id))
                problems.push(`rule ${i + 1}: id "${r.id}" is used twice`);
            seen.add(r.id);
        }
    });
    return problems;
}

/** The valid rules, normalised and sorted (priority high to low; ties keep list order). Invalid ones are dropped, never guessed at. */
export function parseRules(text) {
    let data;
    try {
        data = typeof text === 'string' ? JSON.parse(text || '[]') : text;
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(data))
        return [];
    const seen = new Set();
    return data
        .map((r, i) => ({r, i}))
        .filter(({r, i}) => checkRule(r, i).length === 0 && !seen.has(r.id) && seen.add(r.id))
        .map(({r, i}) => ({
            id: r.id, enabled: r.enabled !== false, priority: r.priority ?? 0, stop: r.stop === true,
            conditions: {...r.conditions}, actions: {...r.actions}, order: i,
        }))
        .sort((x, y) => y.priority - x.priority || x.order - y.order);
}

/** A v1.5 rule `{match, action?, workspace?}` as a vNext rule, so the old setting keeps working. */
export function fromLegacy(rules) {
    return rules.map((r, i) => ({
        id: `legacy-${i + 1}`, enabled: true, priority: 0, stop: false,
        conditions: {appId: r.match},
        actions: {...(r.action ? {tile: r.action} : {}), ...(r.workspace ? {workspace: r.workspace} : {})},
    }));
}

function inTimeRange(range, now) {
    const t = now.getHours() * 60 + now.getMinutes(), from = minutes(range.from), to = minutes(range.to);
    return from <= to ? t >= from && t < to : t >= from || t < to;   // 22:00-06:00 crosses midnight
}

/** Why a rule does or does not match a window: [{key, ok}] for each condition it has. `win` = {appIds[], title, workspace, monitor, type}. */
export function explainMatch(rule, win, ctx = {}) {
    const c = rule.conditions, out = [];
    if (c.appId !== undefined)
        out.push({key: 'appId', ok: (win.appIds ?? []).filter(Boolean).some(a => a.toLowerCase() === c.appId.toLowerCase())});
    if (c.title !== undefined) {
        const m = titleMatcher(c.title);
        out.push({key: 'title', ok: m !== null && m(win.title ?? '')});
    }
    if (c.workspace !== undefined)
        out.push({key: 'workspace', ok: win.workspace === c.workspace});
    if (c.monitor !== undefined)
        out.push({key: 'monitor', ok: win.monitor === c.monitor});
    if (c.type !== undefined)
        out.push({key: 'type', ok: (win.type ?? 'normal') === c.type});
    if (c.time !== undefined)
        out.push({key: 'time', ok: inTimeRange(c.time, ctx.now ?? new Date())});
    if (c.profile !== undefined)
        out.push({key: 'profile', ok: ctx.profile === c.profile});
    return out;
}

/**
 * What the rules would do to `win`. Walks in priority order; the first rule to set an action key wins that key (a later rule cannot
 * override it). `trace` lists every enabled rule with its verdict, for the dry-run view. Nothing is applied here.
 */
export function evaluate(rules, win, ctx = {}) {
    const actions = {}, from = {}, trace = [];
    let stopped = false;
    for (const rule of rules) {
        if (!rule.enabled)
            continue;
        if (stopped) {
            trace.push({id: rule.id, matched: false, skipped: 'an earlier rule stopped processing'});
            continue;
        }
        const why = explainMatch(rule, win, ctx);
        const matched = why.length > 0 && why.every(w => w.ok);
        trace.push({id: rule.id, matched, why});
        if (!matched)
            continue;
        for (const [k, v] of Object.entries(rule.actions))
            if (!(k in actions)) {
                actions[k] = v;
                from[k] = rule.id;
            }
        if (rule.stop)
            stopped = true;
    }
    return {actions, from, trace};
}

/** The actions that would change something: drops those the window already satisfies, so a re-run is a no-op. */
export function pending(actions, win) {
    const out = {};
    for (const [k, v] of Object.entries(actions)) {
        const now = {workspace: win.workspace, monitor: win.monitor, tile: win.floating ? 'float' : 'tile', above: win.above, opacity: win.opacity, fullscreen: win.fullscreen}[k];
        if (now !== v)
            out[k] = v;
    }
    return out;
}

const mayOverlap = (a, b) => {
    // Two conditions sets can match one window unless some key they both give cannot hold together.
    for (const k of CONDITION_KEYS) {
        if (a[k] === undefined || b[k] === undefined)
            continue;
        if (k === 'appId' && a.appId.toLowerCase() !== b.appId.toLowerCase())
            return false;
        if (['workspace', 'monitor', 'type', 'profile'].includes(k) && a[k] !== b[k])
            return false;
    }
    return true;   // titles and time ranges are only "possible": two different substrings can sit in one title
};

const subsumes = (broad, narrow) => CONDITION_KEYS.every(k => broad[k] === undefined
    || (narrow[k] !== undefined && JSON.stringify(broad[k]).toLowerCase() === JSON.stringify(narrow[k]).toLowerCase()));

/** Pairs of enabled rules that disagree, and rules that can never run. [{kind, a, b, key?, certain}] */
export function findConflicts(rules) {
    const on = rules.filter(r => r.enabled), out = [];
    for (let i = 0; i < on.length; i++)
        for (let j = i + 1; j < on.length; j++) {
            const hi = on[i], lo = on[j];   // `rules` is sorted, so hi runs first
            if (!mayOverlap(hi.conditions, lo.conditions))
                continue;
            const certain = subsumes(lo.conditions, hi.conditions) || subsumes(hi.conditions, lo.conditions);
            if (hi.stop && subsumes(hi.conditions, lo.conditions))
                out.push({kind: 'shadowed', a: hi.id, b: lo.id, certain: true});
            for (const k of ACTION_KEYS)
                if (k in hi.actions && k in lo.actions && hi.actions[k] !== lo.actions[k])
                    out.push({kind: 'override', a: hi.id, b: lo.id, key: k, certain});
        }
    return out;
}

/**
 * Stops a rule from re-applying forever: a rule may act on one window at most `max` times in `windowMs`, and not again for the same
 * outcome. State is a plain Map the caller owns, so dropping it frees everything.
 */
export function createGuard({max = 3, windowMs = 10000} = {}) {
    const seen = new Map();   // `${windowId}|${ruleId}` -> [timestamps]
    return {
        allow(windowId, ruleId, nowMs) {
            const key = `${windowId}|${ruleId}`;
            const recent = (seen.get(key) ?? []).filter(t => nowMs - t < windowMs);
            if (recent.length >= max) {
                seen.set(key, recent);
                return false;
            }
            recent.push(nowMs);
            seen.set(key, recent);
            return true;
        },
        forget(windowId) {
            for (const k of [...seen.keys()])
                if (k.startsWith(`${windowId}|`))
                    seen.delete(k);
        },
        clear: () => seen.clear(),
        size: () => seen.size,
    };
}

/** The active profile id from Niro Control's state file (`{"active": "id"}`), or null: the same file the Search extension and the panel read. */
export function activeProfileId(text) {
    try {
        const id = JSON.parse(text || '{}')?.active;
        return typeof id === 'string' && id ? id : null;
    } catch (_e) {
        return null;
    }
}

/** True when any rule needs to know the active profile (so the state file is only watched then). */
export const usesProfile = rules => rules.some(r => r.enabled && r.conditions.profile !== undefined);
/** True when any rule sets opacity, or reads something that changes while a window lives (its title), so windows are looked at again. */
export const setsOpacity = rules => rules.some(r => r.enabled && r.actions.opacity !== undefined);

/**
 * Window opacity set by rules, and put back. The window's own opacity is remembered the first time a rule changes it and restored when no rule
 * matches any more, and on `restoreAll` (disable). `actorOf(win)` returns the compositor actor (or null once the window is gone).
 * Values are bounded to 0.1..1; an actor's opacity is 0..255.
 */
export function createOpacityControl(actorOf) {
    const saved = new Map();   // window -> opacity the actor had before a rule touched it
    const put = (win, value) => {
        let actor = null;
        try { actor = actorOf(win); } catch (_e) { /* gone */ }
        if (!actor)
            return false;
        try { actor.opacity = value; } catch (_e) { return false; }
        return true;
    };
    return {
        /** `wanted`: the rule's opacity for this window, or undefined when no rule sets one. */
        apply(win, wanted) {
            if (typeof wanted === 'number' && wanted >= 0.1 && wanted <= 1) {
                let actor = null;
                try { actor = actorOf(win); } catch (_e) { /* gone */ }
                if (!actor)
                    return;
                if (!saved.has(win))
                    saved.set(win, actor.opacity);
                const v = Math.round(wanted * 255);
                if (actor.opacity !== v)
                    put(win, v);
            } else if (saved.has(win)) {
                put(win, saved.get(win));
                saved.delete(win);
            }
        },
        forget: win => saved.delete(win),
        restoreAll() {
            for (const [win, v] of saved)
                put(win, v);
            saved.clear();
        },
        size: () => saved.size,
    };
}
