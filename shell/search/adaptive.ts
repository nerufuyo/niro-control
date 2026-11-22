// Adaptive suggestions, suggestion-first: when Search opens, the application in front can suggest a profile ("Gaming" for a game launcher,
// "Deep Work" for a code editor). Nothing is applied by itself: the suggestion is one row, Enter applies it, and the same rule stays quiet for a while.
// Pure: the signals come in, a suggestion (or null) comes out, so tests run it anywhere (tests/).
// The evaluation is shared/contextEngine.js (hysteresis, cooldown, manual override, lock, metadata-only history); this file holds the built-in
// rules, the user's rules file, and the old `suggest()` / `matches()` API on top of it. Nothing here listens to anything.
// @ts-nocheck: the shared cores are plain JS copied into build/shared by the build
import {buildSnapshot, createContextEngine, matches as engineMatches, validateRule} from './shared/contextEngine.js';

export interface Signals {
    /** The focused application's desktop id or window class, lower-cased; null when no window has the focus. */
    app: string | null;
    /** Minutes after midnight, local time. */
    minute: number;
    monitors: number;
    /** Optional signals for the user's own rules: the workspace index, the battery level (0..100) and whether the mains is plugged in. */
    workspace?: number | null;
    battery?: number | null;
    onAc?: boolean | null;
}

export interface Rule {
    id: string;
    /** The profile id it suggests (control/profiles). */
    profile: string;
    /** Higher wins when several rules match. */
    priority: number;
    when: {
        /** Any of these appears in the application's id or class. */
        apps?: string[];
        /** Only between these minutes (over midnight if `to` < `from`). */
        between?: [number, number];
        monitorsAtLeast?: number;
    };
    reason: (signals: Signals) => string;
}

const nice = (app: string | null) => (app ?? 'An application').replace(/\.desktop$/, '').split('.').pop()!.replace(/[-_]/g, ' ');

export const BUILT_IN_RULES: Rule[] = [
    {id: 'game', profile: 'gaming', priority: 30, when: {apps: ['steam', 'lutris', 'heroic', 'retroarch', 'gamescope', 'minecraft', 'valvesoftware']},
        reason: s => `${nice(s.app)} is in front`},
    {id: 'code', profile: 'deep-work', priority: 20, when: {apps: ['code', 'codium', 'jetbrains', 'idea', 'pycharm', 'webstorm', 'clion', 'zed', 'sublime', 'emacs', 'nvim', 'cursor']},
        reason: s => `${nice(s.app)} is in front`},
    {id: 'make', profile: 'creative', priority: 20, when: {apps: ['gimp', 'krita', 'inkscape', 'blender', 'darktable', 'kdenlive', 'davinci', 'obs', 'audacity', 'ardour', 'lmms']},
        reason: s => `${nice(s.app)} is in front`},
];

/** A built-in rule as the context engine's rule: one evaluation is enough (Search looks once per opening), quiet for QUIET_MS afterwards. */
export function toEngineRule(r: Rule) {
    return {id: r.id, priority: r.priority, conditions: {...r.when}, action: {type: 'profile.apply', profile: r.profile},
        minEvaluations: 1, cooldownMs: QUIET_MS, confidence: 1};
}

const hasCondition = (w: Rule['when']) => Boolean(w.apps || w.between || w.monitorsAtLeast !== undefined);

export function matches(rule: Rule, s: Signals): boolean {
    if (!hasCondition(rule.when)) return false;                  // a rule with no condition never matches
    return engineMatches(rule.when, buildSnapshot({app: s.app, minute: s.minute, monitors: s.monitors}));
}

export interface Suggestion {rule: Rule; profile: string; reason: string}

/** The rule to suggest now, or null: skipped when its profile is already active, or when it was suggested within its quiet time.
 * `quietUntil` maps rule ids to the time (ms) before which they stay silent; the caller records the new quiet time. */
export function suggest(rules: Rule[], signals: Signals, activeProfile: string | null, quietUntil: ReadonlyMap<string, number>, nowMs: number): Suggestion | null {
    const live = rules.filter(r => (quietUntil.get(r.id) ?? 0) <= nowMs && hasCondition(r.when));
    const engine = createContextEngine({rules: live.map(toEngineRule), now: () => nowMs, enabledSources: ['app', 'time', 'display']});
    const {decision} = engine.evaluate({app: signals.app, minute: signals.minute, monitors: signals.monitors}, {current: activeProfile});
    const best = decision && live.find(r => r.id === decision.ruleId);
    return best ? {rule: best, profile: best.profile, reason: best.reason(signals)} : null;
}

/** How long a rule stays quiet after it was suggested, whether or not it was accepted. */
export const QUIET_MS = 30 * 60 * 1000;

// ---- The running engine: built-in rules plus the user's rules file (~/.config/niro-control/adaptive-rules.json)

/** The file is a JSON array of rules (or {rules: [...]}): {id, priority, conditions: {apps, between, monitorsAtLeast, batteryBelow, ...}, action: {type: 'profile.apply', profile},
 * cooldownMs, confidence, enabled}. A rule with a built-in's id replaces it (`enabled: false` turns that one off). Bad rules are listed in `problems`, never half-used. */
export function parseUserRules(text: string | null): {rules: any[]; problems: string[]} {
    if (text === null || text === undefined || String(text).trim() === '') return {rules: [], problems: []};
    let d;
    try { d = JSON.parse(String(text).slice(0, 200000)); } catch (_e) { return {rules: [], problems: ['adaptive-rules.json is not valid JSON']}; }
    const list = Array.isArray(d) ? d : Array.isArray(d?.rules) ? d.rules : null;
    if (!list) return {rules: [], problems: ['adaptive-rules.json must be a list of rules']};
    const rules = [], problems: string[] = [];
    for (const r of list.slice(0, 50)) {
        const rule = r && typeof r === 'object' ? {minEvaluations: 1, ...r} : r;     // Search looks once per opening: waiting for two evaluations would never end
        const bad = validateRule(rule);
        if (bad.length) problems.push(`${r?.id ?? '?'}: ${bad.join('; ')}`);
        else rules.push(rule);
    }
    return {rules, problems};
}

export const RUNTIME_SOURCES = ['app', 'workspace', 'display', 'power', 'time'];

export function buildEngine(userText: string | null, now: () => number = () => Date.now()) {
    const user = parseUserRules(userText);
    const engine = createContextEngine({rules: [...user.rules, ...BUILT_IN_RULES.map(toEngineRule)], now, enabledSources: RUNTIME_SOURCES});
    return {engine, problems: [...user.problems, ...engine.rejected.map((r: any) => `${r.id}: ${r.problems.join('; ')}`)]};
}

/** One evaluation of the running engine: {ruleId, profile, reason} or null. `known(profileId)` says whether that profile is installed. */
export function evaluateNow(engine: any, signals: Signals, current: string | null, known: (id: string) => boolean = () => true) {
    const {decision} = engine.evaluate({app: signals.app, minute: signals.minute, monitors: signals.monitors, workspace: signals.workspace ?? null,
        battery: signals.battery ?? null, onAc: signals.onAc ?? null}, {current});
    if (!decision || !known(decision.action.profile)) return null;
    const builtIn = BUILT_IN_RULES.find(r => r.id === decision.ruleId);
    return {ruleId: decision.ruleId, profile: decision.action.profile, reason: builtIn ? builtIn.reason(signals) : decision.explanation};
}
