// Permissions in the panel, the logic without a screen: reading what Search (org.niro.Search) says about the grants and the permission
// history, the rules for changing a grant, and one controller holding every state the page can be in. No GTK or GLib here, so node tests
// it with a fake backend. Rules: a scope that gives MORE access (once, session, always) needs a confirmation the page obtains on screen
// (Search asks again on its own screen); "deny" and revoking give less access and go straight through; the history holds who asked for
// what and the verdict, never arguments or content, and this file drops any other field it is sent.

// Same lists as shell/shared/permissions.js (a node test compares them, so they cannot drift).
export const CAPABILITIES = ['file', 'clipboard', 'window', 'launch', 'network', 'device', 'automation', 'ai-external', 'notifications', 'plugin'];
export const SCOPES = ['once', 'session', 'always', 'deny'];
export const SUBJECT = /^[\w.:-]{1,80}$/;
export const HISTORY_LIMIT = 100;

export const CAPABILITY_TEXT: Record<string, string> = {
    file: 'read or write your files', clipboard: 'use the clipboard', window: 'move or switch your windows', launch: 'start applications',
    network: 'use the network or read its state', device: 'read device information', automation: 'change settings and run system actions',
    'ai-external': 'send text to an outside AI service', notifications: 'show notifications', plugin: 'act as a plugin',
};
export const SCOPE_TEXT: Record<string, string> = {
    once: 'Allow once', session: 'Allow for this session', always: 'Always allow', deny: 'Never allow',
};

/** How much access a scope gives: more is a bigger number. No grant at all means Search asks each time (rank 0). */
const RANK: Record<string, number> = {deny: -1, none: 0, once: 1, session: 2, always: 3};
export const givesMoreAccess = (from: string | null, to: string) => (RANK[to] ?? 0) > (RANK[from ?? 'none'] ?? 0);
/** Only a scope that allows something needs a confirmation; "deny" never does. */
export const needsConfirmation = (scope: string) => scope !== 'deny';

export type PermErrorKind = 'unavailable' | 'permission' | 'unsupported' | 'error';
export class PermError extends Error {
    kind: PermErrorKind;
    constructor(kind: PermErrorKind, message: string) { super(message); this.name = 'PermError'; this.kind = kind; }
}

/** Maps a D-Bus failure to the screen it needs. Search is a part of the shell: "not running" is its own answer. */
export function classifyError(e: any): PermError {
    if (e instanceof PermError) return e;
    const text = String(e?.message ?? e ?? '');
    if (/ServiceUnknown|NameHasNoOwner|not provided by any|no owner|Could not connect|Connection refused|NoReply|Timeout|timed out/i.test(text))
        return new PermError('unavailable', 'Niro Search is not running, so permissions cannot be read. Enable the Search extension (log out and in after an update) and try again.');
    if (/AccessDenied|PermissionDenied|Rejected send message/i.test(text))
        return new PermError('permission', 'The session bus refused this panel access to Search.');
    if (/UnknownMethod|UnknownInterface|UnknownObject|No such (interface|method)|No such object/i.test(text))
        return new PermError('unsupported', 'The running Search extension is older than this panel and has no permission methods. Log out and in to load the new one.');
    return new PermError('error', text.replace(/^GDBus\.Error:[\w.]+:\s*/, '') || 'Search answered with an error.');
}

const parse = (text: any, what: string) => {
    try { return JSON.parse(String(text)); } catch (_e) { throw new PermError('error', `Search sent an unreadable ${what}.`); }
};

export interface Grant { subject: string; capability: string; scope: string; }
export interface HistoryEntry { at: number; subject: string; capability: string; verdict: string; }

/** `{enforced, grants}`. An entry that is not a valid subject, capability and scope is dropped, never shown. */
export function parseGrants(text: any): {enforced: boolean; grants: Grant[]} {
    const v = parse(text, 'grant list');
    if (!v || typeof v !== 'object') throw new PermError('error', 'Search sent an unreadable grant list.');
    const grants = (Array.isArray(v.grants) ? v.grants : []).filter(g => g && SUBJECT.test(String(g.subject ?? '')) && CAPABILITIES.includes(g.capability) && SCOPES.includes(g.scope))
        .map(g => ({subject: String(g.subject), capability: String(g.capability), scope: String(g.scope)}));
    grants.sort((a, b) => a.subject.localeCompare(b.subject) || a.capability.localeCompare(b.capability));
    return {enforced: v.enforced === true, grants};
}

/** Only who, what, when and the verdict are kept, whatever else was sent (so an argument can never reach the screen). Newest first. */
export function parseHistory(text: any): HistoryEntry[] {
    const v = parse(text, 'history');
    return (Array.isArray(v) ? v : []).filter(h => h && typeof h === 'object' && SUBJECT.test(String(h.subject ?? '')) && typeof h.capability === 'string' && ['allow', 'deny', 'ask'].includes(h.verdict))
        .map(h => ({at: Number(h.at) || 0, subject: String(h.subject), capability: String(h.capability), verdict: String(h.verdict)}))
        .sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

/** `{ok, error?, declined?}`: Search's answer to Grant / Revoke / ClearPermissionHistory. */
export function parseOutcome(text: any): {ok: boolean; declined: boolean; error: string} {
    const v = parse(text, 'answer');
    return {ok: v?.ok === true, declined: v?.code === 'declined', error: String(v?.error ?? '')};
}

/** Why a grant cannot be made, or null. Checked here first so a typo never reaches Search. */
export function validateGrant(subject: string, capability: string, scope: string): string | null {
    if (!SUBJECT.test(String(subject ?? ''))) return 'The program name may only have letters, digits and . _ : - (at most 80).';
    if (!CAPABILITIES.includes(capability)) return `Unknown capability "${capability}".`;
    if (!SCOPES.includes(scope)) return `Unknown scope "${scope}".`;
    return null;
}

export const sentence = (g: Grant) => `${g.subject}: ${CAPABILITY_TEXT[g.capability] ?? g.capability}`;

export function whenText(at: number, now = Date.now()): string {
    if (!at) return 'unknown time';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

export interface PermBackend {
    list(): Promise<{enforced: boolean; grants: Grant[]}>;
    grant(subject: string, capability: string, scope: string): Promise<{ok: boolean; declined: boolean; error: string}>;
    revoke(subject: string, capability: string): Promise<{ok: boolean; declined: boolean; error: string}>;
    history(limit: number): Promise<HistoryEntry[]>;
    clearHistory(): Promise<{ok: boolean; declined: boolean; error: string}>;
}

export type PermView = 'loading' | 'ready' | 'unavailable' | 'error';
export interface PermStatus { kind: 'success' | 'error' | 'info'; text: string; }

/** The state of the Permissions page. `grant` refuses an allowing scope unless `confirmed` is true: the page sets it only after its dialog. */
export function createPermissionsFlow(backend: PermBackend) {
    const listeners = new Set<() => void>();
    const s: {view: PermView; message: string; busy: string | null; status: PermStatus | null; enforced: boolean; grants: Grant[]; history: HistoryEntry[]} =
        {view: 'loading', message: '', busy: null, status: null, enforced: false, grants: [], history: []};
    const emit = () => listeners.forEach(f => f());
    const fail = (e: any) => { const p = classifyError(e); s.view = p.kind === 'error' ? 'error' : 'unavailable'; s.message = p.message; };

    async function refresh() {
        s.view = 'loading'; s.message = ''; emit();
        try {
            const l = await backend.list();
            s.enforced = l.enforced; s.grants = l.grants;
            s.history = await backend.history(HISTORY_LIMIT);
            s.view = 'ready';
        } catch (e) { fail(e); }
        emit();
    }

    async function change(label: string, run: () => Promise<{ok: boolean; declined: boolean; error: string}>, done: string) {
        if (s.busy) return false;
        s.busy = label; s.status = null; emit();
        let ok = false;
        try {
            const r = await run();
            if (r.ok) { s.status = {kind: 'success', text: done}; ok = true; }
            else if (r.declined) s.status = {kind: 'info', text: 'Cancelled on the screen: nothing was changed.'};
            else s.status = {kind: 'error', text: r.error || 'Search refused the change.'};
            const l = await backend.list(); s.grants = l.grants; s.enforced = l.enforced;
            s.history = await backend.history(HISTORY_LIMIT);
        } catch (e) { s.status = {kind: 'error', text: classifyError(e).message}; }
        s.busy = null; emit();
        return ok;
    }

    async function grant(subject: string, capability: string, scope: string, confirmed = false) {
        const bad = validateGrant(subject, capability, scope);
        if (bad) { s.status = {kind: 'error', text: bad}; emit(); return false; }
        if (needsConfirmation(scope) && !confirmed) {
            s.status = {kind: 'error', text: 'Giving access needs your confirmation first. Nothing was changed.'}; emit(); return false;
        }
        return change('granting', () => backend.grant(subject, capability, scope),
            scope === 'deny' ? `${subject} can no longer ${CAPABILITY_TEXT[capability]}.` : `${subject} may now ${CAPABILITY_TEXT[capability]} (${SCOPE_TEXT[scope].toLowerCase()}).`);
    }
    const revoke = (subject: string, capability: string) => {
        if (!SUBJECT.test(subject) || !CAPABILITIES.includes(capability)) { s.status = {kind: 'error', text: 'That grant is not valid.'}; emit(); return Promise.resolve(false); }
        return change('revoking', () => backend.revoke(subject, capability), `Removed the setting for ${subject}; it will be asked about again.`);
    };
    const clearHistory = () => change('clearing', () => backend.clearHistory(), 'The permission history was cleared.');

    return {
        state: s, refresh, grant, revoke, clearHistory,
        dismiss() { s.status = null; emit(); },
        subscribe(f: () => void) { listeners.add(f); return () => listeners.delete(f); },
    };
}
