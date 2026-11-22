// Notification Hub in the panel, the logic without a screen: checking what the user typed before it is sent, reading what Search answers
// (org.niro.Search RunAction) and the rules file Search keeps, and one controller that holds every state the page can be in.
// Nothing here imports GTK or GLib, so node can test it with a fake backend. The page (hubPage.ts) only draws this state.
// The hub keeps application ids and counts, never a title or a text; nothing here reads, stores or logs a notification's words.

export const RULE_VERDICTS = ['show', 'silent', 'hide'] as const;
export const MAX_RULES = 50, MAX_APP = 80, MAX_SNOOZE = 1440;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type HubView = 'loading' | 'unavailable' | 'permission' | 'error' | 'disabled' | 'empty' | 'ready';
export interface Rule {app: string; verdict: string}
export interface Quiet {from: string; to: string}
export interface Outcome {ok: boolean; message: string; error: string; code: string}
export interface HubBackend {
    /** One Search action by id; resolves its outcome (a refusal is an outcome, not a throw). Throws only when Search cannot be reached. */
    run(id: string, args: Record<string, unknown>): Promise<Outcome>;
    /** The text of Search's notification-rules.json, or null when there is no such file. */
    readRules(): Promise<string | null>;
}
export interface HubSettings {hubOn(): boolean; applyOn(): boolean; setHub(on: boolean): void; setApply(on: boolean): void}

// ---- Checking input (the same limits Search enforces, so the answer comes before the call)

/** The problem with a rule, in a sentence, or null. `rules` are the existing ones (an existing app is replaced, so it never hits the limit). */
export function checkRule(app: string, verdict: string, rules: Rule[] = []): string | null {
    const a = String(app ?? '').trim();
    if (!a) return 'Write the application\'s id (for example org.gnome.Evolution), or * for every application.';
    if (a.length > MAX_APP) return `The application id is too long (at most ${MAX_APP} characters).`;
    if (/[\u0000-\u001f\u007f]/.test(a)) return 'The application id has characters that are not allowed.';
    if (!(RULE_VERDICTS as readonly string[]).includes(verdict)) return 'Choose what happens: show, silent (no banner) or hide.';
    if (!rules.some(r => r.app === a) && rules.length >= MAX_RULES) return `At most ${MAX_RULES} rules: remove one first.`;
    return null;
}

export function checkQuiet(from: string, to: string): string | null {
    const f = String(from ?? '').trim(), t = String(to ?? '').trim();
    if (!HHMM.test(f) || !HHMM.test(t)) return 'Write both times as HH:MM in 24 hours, for example 22:00 and 07:00.';
    if (f === t) return 'The two times are the same, so quiet hours would cover nothing or everything. Choose two different times.';
    return null;
}

export function checkSnooze(app: string, minutes: unknown): string | null {
    const a = String(app ?? '').trim();
    if (!a) return 'Write the application\'s id to snooze.';
    if (a.length > MAX_APP) return `The application id is too long (at most ${MAX_APP} characters).`;
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1 || m > MAX_SNOOZE) return `Snooze for 1 to ${MAX_SNOOZE} minutes (a day at most).`;
    return null;
}

// ---- Reading answers

export function parseOutcome(text: any): Outcome {
    let v: any;
    try { v = JSON.parse(String(text)); } catch (_e) { return {ok: false, message: '', error: 'Search sent an unreadable answer.', code: 'failed'}; }
    return {ok: v?.ok === true, message: String(v?.message ?? ''), error: String(v?.error ?? ''), code: String(v?.code ?? '')};
}

/** The summary text Search returns: counts and application ids only. Unknown wording gives null fields, never an invented number. */
export function parseSummary(text: string) {
    const [head = '', ...rest] = String(text ?? '').split('\n');
    const seen = /^(\d+) notifications? seen/.exec(head);
    const quiet = /quiet (\d\d:\d\d) to (\d\d:\d\d)/.exec(head);
    const rules = /(\d+) rules?/.exec(head);
    return {
        seen: seen ? Number(seen[1]) : null,
        ruleCount: rules ? Number(rules[1]) : null,
        quiet: quiet ? {from: quiet[1], to: quiet[2]} : null,
        applied: /rules are applied/.test(head),
        apps: rest.map(l => /^(.*): (\d+)$/.exec(l)).filter(Boolean).map(m => ({app: m![1], count: Number(m![2])})),
    };
}

export function parseRules(text: string | null): {rules: Rule[]; quiet: Quiet | null} | null {
    if (text === null) return null;
    try {
        const d = JSON.parse(text);
        return {
            rules: (Array.isArray(d.rules) ? d.rules : []).filter((r: any) => typeof r?.app === 'string' && r.app && (RULE_VERDICTS as readonly string[]).includes(r.verdict)).slice(0, MAX_RULES).map((r: any) => ({app: r.app, verdict: r.verdict})),
            quiet: d.quiet && HHMM.test(d.quiet.from ?? '') && HHMM.test(d.quiet.to ?? '') ? {from: d.quiet.from, to: d.quiet.to} : null,
        };
    } catch (_e) {
        return null;
    }
}

/** A failure to reach Search: which screen it needs and what to tell the user. */
export function classifyHubError(e: any): {kind: 'unavailable' | 'permission' | 'error'; message: string} {
    const text = String(e?.message ?? e ?? '');
    if (/ServiceUnknown|NameHasNoOwner|not provided by any|no owner|Could not connect|Connection refused|NoReply|Timeout|timed out|UnknownMethod|UnknownObject|UnknownInterface/i.test(text))
        return {kind: 'unavailable', message: 'Search is not running, so the hub cannot be reached. Turn Search on in the Search page, or log out and in.'};
    if (/AccessDenied|PermissionDenied|Rejected send message/i.test(text))
        return {kind: 'permission', message: 'The session bus refused this panel access to Search.'};
    return {kind: 'error', message: text.replace(/^GDBus\.Error:[\w.]+:\s*/, '') || 'Search answered with an error.'};
}

// ---- The controller

export interface Notice {kind: 'success' | 'error' | 'info'; text: string}

export function createHub(backend: HubBackend, settings: HubSettings) {
    const listeners = new Set<() => void>();
    const s = {
        view: 'loading' as HubView, message: '',
        hubOn: false, applyOn: false,
        seen: null as number | null, apps: [] as {app: string; count: number}[],
        rules: [] as Rule[], rulesKnown: true, ruleCount: null as number | null, quiet: null as Quiet | null,
        busy: null as string | null, notice: null as Notice | null,
    };
    const emit = () => listeners.forEach(fn => fn());
    const settle = () => {
        s.view = !s.hubOn ? 'disabled' : (s.rules.length || s.quiet || s.seen || s.ruleCount) ? 'ready' : 'empty';
        s.message = '';
    };
    const toView = (e: any) => {
        const f = classifyHubError(e);
        if (f.kind === 'error') { s.notice = {kind: 'error', text: f.message}; return f; }
        s.view = f.kind; s.message = f.message; s.notice = null;
        return f;
    };

    /** Runs one change with the page in "applying" and tells the outcome. A refusal of Search is shown in its own words. */
    async function act(id: string, args: Record<string, unknown>, success: string, then: () => void = () => {}) {
        if (s.busy) return false;
        s.busy = 'applying'; s.notice = null; emit();
        try {
            const o = await backend.run(id, args);
            if (o.ok) { then(); s.notice = {kind: 'success', text: success}; }
            else if (o.code === 'duplicate') s.notice = {kind: 'info', text: 'That was just sent. Give it a moment.'};
            else if (o.code === 'unavailable') { s.view = 'disabled'; s.message = o.error; }
            else s.notice = {kind: 'error', text: o.error || 'Search refused it.'};
            return o.ok;
        } catch (e) {
            toView(e);
            return false;
        } finally {
            s.busy = null; emit();
        }
    }

    const self = {
        get state() { return s; },
        subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

        /** Reads the two settings, then (when the hub is on) the summary and the rules file. Idempotent. */
        async refresh() {
            const first = s.view === 'loading';
            if (!first && !s.busy) s.busy = 'applying';
            emit();
            try {
                s.hubOn = settings.hubOn(); s.applyOn = settings.applyOn();
                if (!s.hubOn) { s.seen = null; s.apps = []; settle(); return; }
                const o = await backend.run('notifications.summary', {});
                if (!o.ok) {
                    if (o.code === 'unavailable') { s.view = 'disabled'; s.message = o.error; return; }
                    throw new Error(o.error || 'Search refused the summary.');
                }
                const sum = parseSummary(o.message);
                s.seen = sum.seen; s.apps = sum.apps; s.ruleCount = sum.ruleCount; s.quiet = sum.quiet;
                const file = parseRules(await backend.readRules().catch(() => null));
                s.rulesKnown = file !== null;
                if (file) { s.rules = file.rules; s.quiet = file.quiet ?? sum.quiet; }
                else s.rules = [];
                settle();
            } catch (e) {
                const f = toView(e);
                if (f.kind === 'error' && s.view === 'loading') { s.view = 'error'; s.message = f.message; }
            } finally {
                if (s.busy === 'applying' && !first) s.busy = null;
                emit();
            }
        },

        async setHub(on: boolean) {
            try { settings.setHub(on); } catch (e: any) { s.notice = {kind: 'error', text: `Could not change the setting: ${e?.message ?? e}`}; emit(); return; }
            s.notice = {kind: 'success', text: on ? 'Notification rules are on.' : 'Notification rules are off.'};
            await self.refresh();
        },
        async setApply(on: boolean) {
            try { settings.setApply(on); } catch (e: any) { s.notice = {kind: 'error', text: `Could not change the setting: ${e?.message ?? e}`}; emit(); return; }
            s.applyOn = settings.applyOn();
            s.notice = {kind: 'success', text: on ? 'Rules now hide or silence notifications.' : 'Rules are only counted now.'};
            emit();
        },

        /** Adds a rule, or replaces the one for the same application. Returns a problem sentence without calling Search when the input is wrong. */
        async addRule(app: string, verdict: string): Promise<string | null> {
            const bad = checkRule(app, verdict, s.rules);
            if (bad) return bad;
            const a = app.trim();
            await act('notifications.rule', {app: a, verdict}, `${a}: ${verdict}.`, () => { s.rules = [...s.rules.filter(r => r.app !== a), {app: a, verdict}]; settle(); });
            return null;
        },
        async removeRule(app: string) {
            await act('notifications.rule', {app, verdict: 'remove'}, `Rule for ${app} removed.`, () => { s.rules = s.rules.filter(r => r.app !== app); settle(); });
        },
        async setQuiet(from: string, to: string): Promise<string | null> {
            const bad = checkQuiet(from, to);
            if (bad) return bad;
            await act('notifications.quiet', {from: from.trim(), to: to.trim()}, `Quiet hours ${from.trim()} to ${to.trim()}.`, () => { s.quiet = {from: from.trim(), to: to.trim()}; settle(); });
            return null;
        },
        async clearQuiet() {
            await act('notifications.quiet', {from: 'off', to: 'off'}, 'Quiet hours are off.', () => { s.quiet = null; settle(); });
        },
        async snooze(app: string, minutes: number): Promise<string | null> {
            const bad = checkSnooze(app, minutes);
            if (bad) return bad;
            await act('notifications.snooze', {app: app.trim(), minutes: Math.round(Number(minutes))}, `${app.trim()} snoozed for ${Math.round(Number(minutes))} min.`);
            return null;
        },
        async clearHistory() {
            await act('notifications.clear', {}, 'The count and the snoozes are cleared.', () => { s.seen = 0; s.apps = []; });
        },
        dismissNotice() { s.notice = null; emit(); },
    };
    return self;
}
