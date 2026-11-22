// Context engine core (vNext initiatives 11 and 15). Pure: signals in, a suggestion (or none) with an explanation out.
// No timers, no listeners, no GNOME imports; the clock is injected. It NEVER applies anything: the output is always a suggestion
// ({autoApply: false}) that the user accepts. Stability comes from hysteresis (N consecutive evaluations and a dwell time before a rule
// may speak, a different release threshold for numbers such as battery), a cooldown, and a manual override / mode lock that silence it.
// State is bounded: per-rule counters plus a metadata-only history (rule id, profile, outcome; never window titles or content).

export const SOURCES = ['app', 'workspace', 'display', 'power', 'time', 'network', 'calendar'];
export const HISTORY_MAX = 100;
export const DEFAULT_MIN_CONFIDENCE = 0.5;
const CONDITION_KEYS = ['apps', 'workspaces', 'monitorsAtLeast', 'monitorsAtMost', 'batteryBelow', 'batteryAbove', 'onAc', 'between', 'online', 'busy', 'mode'];
const ID = /^[\w.:-]{1,64}$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = v => (typeof v === 'boolean' ? v : null);
const str = v => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);

/** Which source supplies each snapshot field. A disabled source makes its fields unknown (null), and a condition on an unknown field fails. */
const FIELD_SOURCE = {app: 'app', workspace: 'workspace', monitors: 'display', battery: 'power', onAc: 'power', minute: 'time', online: 'network', busy: 'calendar'};

/** Raw signals -> ContextSnapshot. Bad or missing values become null; the user-selected mode is always kept. */
export function buildSnapshot(raw = {}, enabled = SOURCES) {
    const on = f => enabled.includes(FIELD_SOURCE[f]);
    const battery = num(raw.battery);
    let minute = num(raw.minute);
    if (minute === null && raw.time instanceof Date && !Number.isNaN(raw.time.getTime()))
        minute = raw.time.getHours() * 60 + raw.time.getMinutes();
    return {
        app: on('app') ? (str(raw.app)?.toLowerCase() ?? null) : null,
        workspace: on('workspace') ? num(raw.workspace) : null,
        monitors: on('monitors') ? num(raw.monitors) : null,
        battery: on('battery') && battery !== null ? Math.min(100, Math.max(0, battery)) : null,
        onAc: on('onAc') ? bool(raw.onAc) : null,
        minute: on('minute') && minute !== null ? ((Math.floor(minute) % 1440) + 1440) % 1440 : null,
        online: on('online') ? bool(raw.online) : null,
        busy: on('busy') ? bool(raw.busy) : null,
        mode: str(raw.mode),
    };
}

const inRange = (m, [from, to]) => (from <= to ? m >= from && m < to : m >= from || m < to);

/**
 * Does a rule's condition set hold for a snapshot? `held` switches the numeric thresholds to their release values:
 * a rule that is already active stays active until battery climbs `release` points past the entry threshold, so a battery
 * hovering around 20% cannot flip the suggestion on and off.
 */
export function matches(conditions, s, {held = false, release = 5} = {}) {
    const c = conditions ?? {};
    const margin = held ? release : 0;
    if (c.apps && !(s.app && c.apps.some(a => s.app.includes(String(a).toLowerCase()))))
        return false;
    if (c.workspaces && !(s.workspace !== null && c.workspaces.includes(s.workspace)))
        return false;
    if (c.monitorsAtLeast !== undefined && !(s.monitors !== null && s.monitors >= c.monitorsAtLeast))
        return false;
    if (c.monitorsAtMost !== undefined && !(s.monitors !== null && s.monitors <= c.monitorsAtMost))
        return false;
    if (c.batteryBelow !== undefined && !(s.battery !== null && s.battery < c.batteryBelow + margin))
        return false;
    if (c.batteryAbove !== undefined && !(s.battery !== null && s.battery > c.batteryAbove - margin))
        return false;
    if (c.onAc !== undefined && s.onAc !== c.onAc)
        return false;
    if (c.between && !(s.minute !== null && inRange(s.minute, c.between)))
        return false;
    if (c.online !== undefined && s.online !== c.online)
        return false;
    if (c.busy !== undefined && s.busy !== c.busy)
        return false;
    if (c.mode !== undefined && s.mode !== c.mode)
        return false;
    return true;
}

/** Which sources a rule needs; disabling any of them silences the rule. */
export function sourcesOf(rule) {
    const c = rule.conditions ?? {};
    const out = new Set();
    if (c.apps) out.add('app');
    if (c.workspaces) out.add('workspace');
    if (c.monitorsAtLeast !== undefined || c.monitorsAtMost !== undefined) out.add('display');
    if (c.batteryBelow !== undefined || c.batteryAbove !== undefined || c.onAc !== undefined) out.add('power');
    if (c.between) out.add('time');
    if (c.online !== undefined) out.add('network');
    if (c.busy !== undefined) out.add('calendar');
    return [...out];
}

/** Problems with a rule (empty = valid). Unknown condition keys and any action other than profile.apply are rejected. */
export function validateRule(r) {
    const p = [];
    if (!r || typeof r !== 'object') return ['not a rule'];
    if (typeof r.id !== 'string' || !ID.test(r.id)) p.push('invalid id');
    if (!Number.isFinite(r.priority ?? 0)) p.push('invalid priority');
    if (!r.action || r.action.type !== 'profile.apply' || typeof r.action.profile !== 'string' || !r.action.profile)
        p.push('action must be {type: "profile.apply", profile}');
    if (r.confidence !== undefined && !(r.confidence >= 0 && r.confidence <= 1)) p.push('confidence must be 0..1');
    if (r.minConfidence !== undefined && !(r.minConfidence >= 0 && r.minConfidence <= 1)) p.push('minConfidence must be 0..1');
    for (const k of ['cooldownMs', 'dwellMs', 'minEvaluations', 'release'])
        if (r[k] !== undefined && !(Number.isFinite(r[k]) && r[k] >= 0)) p.push(`${k} must be a number >= 0`);
    if (!r.conditions || typeof r.conditions !== 'object' || Object.keys(r.conditions).length === 0)
        p.push('a rule needs at least one condition');
    else
        for (const k of Object.keys(r.conditions))
            if (!CONDITION_KEYS.includes(k)) p.push(`unknown condition "${k}"`);
    if (r.conditions?.between && !(Array.isArray(r.conditions.between) && r.conditions.between.length === 2 && r.conditions.between.every(Number.isFinite)))
        p.push('between must be [fromMinute, toMinute]');
    return p;
}

function explain(rule, s, since) {
    const bits = [];
    const c = rule.conditions;
    if (c.apps && s.app) bits.push(`${s.app} is in front`);
    if (c.workspaces) bits.push(`workspace ${s.workspace + 1}`);
    if (c.monitorsAtLeast !== undefined || c.monitorsAtMost !== undefined) bits.push(`${s.monitors} monitor${s.monitors === 1 ? '' : 's'} connected`);
    if (c.batteryBelow !== undefined || c.batteryAbove !== undefined) bits.push(`battery at ${Math.round(s.battery)}%`);
    if (c.onAc !== undefined) bits.push(s.onAc ? 'on mains power' : 'on battery');
    if (c.between) bits.push('this time of day');
    if (c.online !== undefined) bits.push(s.online ? 'online' : 'offline');
    if (c.busy !== undefined) bits.push(s.busy ? 'calendar busy' : 'calendar free');
    if (c.mode !== undefined) bits.push(`mode ${s.mode}`);
    return `${bits.join(', ')}; held for ${Math.round(since / 1000)}s. Suggested only, nothing was applied.`;
}

/**
 * @param {{rules?: object[], now?: () => number, enabledSources?: string[], minConfidence?: number}} opts
 * Rule: {id, priority, conditions, action: {type:'profile.apply', profile}, cooldownMs, confidence, minConfidence,
 *        minEvaluations, dwellMs, release, enabled}
 */
export function createContextEngine({rules = [], now = () => Date.now(), enabledSources = SOURCES, minConfidence = DEFAULT_MIN_CONFIDENCE} = {}) {
    const sources = new Set(enabledSources.filter(s => SOURCES.includes(s)));
    const list = [];
    const state = new Map();     // rule id -> {streak, since, active, emitted, lastAt}
    let history = [];
    let locked = false;
    let override = null;         // {profile, until}
    let mode = null;

    const rejected = [];
    for (const r of rules) {
        const problems = validateRule(r);
        if (problems.length) rejected.push({id: r?.id ?? null, problems});
        else if (!list.some(x => x.id === r.id)) list.push(r);
    }

    const log = (ruleId, profile, outcome) => {
        history.push({at: now(), ruleId, profile, outcome});
        if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    };
    const st = id => {
        if (!state.has(id)) state.set(id, {streak: 0, since: 0, active: false, emitted: false, lastAt: -Infinity});
        return state.get(id);
    };
    const overrideActive = t => override && (override.until === null || t < override.until);

    return {
        rejected,
        setSourceEnabled(source, on) {
            if (!SOURCES.includes(source)) throw new Error(`unknown source "${source}"`);
            on ? sources.add(source) : sources.delete(source);
        },
        enabledSources: () => [...sources],
        /** The user-selected mode. A locked mode produces no suggestions at all until unlocked. */
        setMode(m, {lock = false} = {}) { mode = m ?? null; locked = Boolean(lock) && mode !== null; },
        lock() { locked = true; },
        unlock() { locked = false; },
        isLocked: () => locked,
        /** The user chose a profile by hand: silence suggestions for ttlMs (null = until cleared). Logged as metadata. */
        setOverride(profile, ttlMs = 3600000) {
            override = {profile, until: ttlMs === null ? null : now() + ttlMs};
            log(null, profile, 'override');
        },
        clearOverride() { override = null; },
        /** The user's answer to a suggestion; a dismissal also starts the cooldown from now. */
        recordOutcome(ruleId, outcome) {
            if (!['accepted', 'dismissed'].includes(outcome)) throw new Error('outcome must be accepted or dismissed');
            const r = list.find(x => x.id === ruleId);
            if (!r) return;
            st(ruleId).lastAt = now();
            log(ruleId, r.action.profile, outcome);
        },
        history: () => history.map(h => ({...h})),
        clearHistory() { history = []; },
        /** Forget counters (not rules, not history), e.g. after a long suspend when old streaks mean nothing. */
        resetState() { state.clear(); },

        /**
         * One evaluation. `raw` signals, optional `current` = the profile already active (never suggested again).
         * Returns {snapshot, decision: suggestion|null, suggestions: [...], suppressed: [{ruleId, reason}]}.
         */
        evaluate(raw = {}, {current = null} = {}) {
            const t = now();
            const snapshot = buildSnapshot({...raw, mode: raw.mode ?? mode}, [...sources]);
            const suggestions = [], suppressed = [];
            if (override && !overrideActive(t)) override = null;

            for (const r of list) {
                const s = st(r.id);
                if (r.enabled === false) { suppressed.push({ruleId: r.id, reason: 'rule disabled'}); continue; }
                const missing = sourcesOf(r).find(x => !sources.has(x));
                if (missing) { suppressed.push({ruleId: r.id, reason: `source "${missing}" is off`}); s.streak = 0; s.active = false; continue; }

                const holds = matches(r.conditions, snapshot, {held: s.active, release: r.release ?? 5});
                if (!holds) {
                    s.streak = 0; s.active = false; s.emitted = false;
                    continue;
                }
                if (s.streak === 0) s.since = t;
                s.streak += 1;
                s.active = true;

                const need = r.minEvaluations ?? 2;
                const dwell = r.dwellMs ?? 0;
                const conf = r.confidence ?? 0.7;
                let why = null;
                if (locked) why = 'mode is locked';
                else if (overrideActive(t)) why = 'manual override is active';
                else if (r.action.profile === current) why = 'profile already active';
                else if (s.streak < need) why = `waiting (${s.streak}/${need} evaluations)`;
                else if (t - s.since < dwell) why = `waiting (held ${t - s.since}ms of ${dwell}ms)`;
                else if (conf < (r.minConfidence ?? minConfidence)) why = 'confidence below minimum';
                else if (t - s.lastAt < (r.cooldownMs ?? 600000)) why = 'cooldown';
                else if (s.emitted) why = 'already suggested';
                if (why) { suppressed.push({ruleId: r.id, reason: why}); continue; }

                suggestions.push({
                    ruleId: r.id, priority: r.priority ?? 0, confidence: conf, action: {...r.action},
                    explanation: explain(r, snapshot, t - s.since), autoApply: false,
                });
            }
            suggestions.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || a.ruleId.localeCompare(b.ruleId));
            const decision = suggestions[0] ?? null;
            if (decision) {
                // Only the winner is spent: it starts its cooldown. The others stay eligible for the next evaluation.
                const s = st(decision.ruleId);
                s.emitted = true;
                s.lastAt = t;
                log(decision.ruleId, decision.action.profile, 'suggested');
            }
            return {snapshot, decision, suggestions, suppressed};
        },
    };
}
