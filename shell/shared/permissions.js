// PermissionService core (vNext S3). Pure: a grant store with allow once / session / always / deny, revoke and a bounded history.
// Default is minimal privilege: with no grant the answer is 'ask'. Only 'always' and 'deny' are persisted; 'once' and 'session' never are.
// History records who asked for what and the verdict, never arguments or content, so it cannot hold a credential.

export const CAPABILITIES = ['file', 'clipboard', 'window', 'launch', 'network', 'device', 'automation', 'ai-external', 'notifications', 'plugin'];
export const SCOPES = ['once', 'session', 'always', 'deny'];
const SUBJECT = /^[\w.:-]{1,80}$/;
const HISTORY_MAX = 200;

export function createPermissions({now = () => Date.now()} = {}) {
    const grants = new Map();   // `${subject}|${cap}` -> scope
    let history = [];

    const key = (s, c) => `${s}|${c}`;
    const check = (s, c) => {
        if (typeof s !== 'string' || !SUBJECT.test(s))
            throw new Error('invalid subject');
        if (!CAPABILITIES.includes(c))
            throw new Error(`unknown capability "${c}"`);
    };
    const log = (subject, capability, verdict) => {
        history.push({at: now(), subject, capability, verdict});
        if (history.length > HISTORY_MAX)
            history = history.slice(-HISTORY_MAX);
    };

    return {
        /** 'allow', 'deny' or 'ask'. An 'allow once' is spent by this call; revoking takes effect on the next call. */
        decide(subject, capability) {
            check(subject, capability);
            const scope = grants.get(key(subject, capability));
            let verdict = 'ask';
            if (scope === 'deny')
                verdict = 'deny';
            else if (scope === 'always' || scope === 'session')
                verdict = 'allow';
            else if (scope === 'once') {
                grants.delete(key(subject, capability));
                verdict = 'allow';
            }
            log(subject, capability, verdict);
            return verdict;
        },
        grant(subject, capability, scope) {
            check(subject, capability);
            if (!SCOPES.includes(scope))
                throw new Error(`unknown scope "${scope}"`);
            grants.set(key(subject, capability), scope);
        },
        revoke(subject, capability = null) {
            for (const k of [...grants.keys()])
                if (k.startsWith(`${subject}|`) && (capability === null || k === key(subject, capability)))
                    grants.delete(k);
        },
        endSession() {
            for (const [k, v] of [...grants])
                if (v === 'session' || v === 'once')
                    grants.delete(k);
        },
        list: () => [...grants].map(([k, scope]) => ({subject: k.split('|')[0], capability: k.split('|')[1], scope})),
        history: () => history.slice(),
        clearHistory() { history = []; },
        /** Only what must survive a restart. */
        serialize: () => JSON.stringify({version: 1, grants: [...grants].filter(([, v]) => v === 'always' || v === 'deny').map(([k, scope]) => {
            const [subject, capability] = k.split('|');
            return {subject, capability, scope};
        })}),
        /** Invalid entries are skipped, never trusted. */
        load(text) {
            let d;
            try { d = JSON.parse(text); } catch (_e) { return 0; }
            let n = 0;
            for (const g of Array.isArray(d?.grants) ? d.grants : [])
                if (g && SUBJECT.test(g.subject ?? '') && CAPABILITIES.includes(g.capability) && (g.scope === 'always' || g.scope === 'deny')) {
                    grants.set(key(g.subject, g.capability), g.scope);
                    n++;
                }
            return n;
        },
    };
}
