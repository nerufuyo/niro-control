// Notification Hub core (vNext S20). Pure: decides what to do with a notification from its metadata. Content (body) is never read
// or kept by default: rules match the application and the urgency, and history keeps app + time only unless the person opts into more.

export const VERDICTS = ['show', 'silent', 'hide', 'snoozed'];

const mins = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

export function inQuietHours(q, now) {
    if (!q || !hhmm.test(q.from ?? '') || !hhmm.test(q.to ?? ''))
        return false;
    const t = now.getHours() * 60 + now.getMinutes(), f = mins(q.from), e = mins(q.to);
    return f <= e ? t >= f && t < e : t >= f || t < e;
}

/**
 * `n`: {appId, urgency: 'low'|'normal'|'high'|'critical'}. `cfg`: {rules: [{app, verdict}], quiet: {from,to,allow: urgency[]}, snoozed: {appId: untilMs},
 * profileRules: {profile: [{app, verdict}]}}. `ctx`: {now: Date, profile}. Critical notifications are never hidden. Returns {verdict, reason}.
 */
export function decide(n, cfg = {}, ctx = {}) {
    const now = ctx.now ?? new Date();
    const critical = n.urgency === 'critical';
    const until = cfg.snoozed?.[n.appId];
    if (until && until > now.getTime() && !critical)
        return {verdict: 'snoozed', reason: 'snoozed'};
    const mine = [...(cfg.profileRules?.[ctx.profile] ?? []), ...(cfg.rules ?? [])].find(r => r.app === n.appId || r.app === '*');
    if (mine && VERDICTS.includes(mine.verdict) && !(critical && mine.verdict !== 'show'))
        return {verdict: mine.verdict, reason: `rule for ${mine.app}`};
    if (cfg.quiet && inQuietHours(cfg.quiet, now) && !(cfg.quiet.allow ?? ['critical']).includes(n.urgency))
        return {verdict: 'silent', reason: 'quiet hours'};
    return {verdict: 'show', reason: 'no rule'};
}

/** Groups by app for the summary: [{appId, count}] biggest first. */
export function summarize(items) {
    const m = new Map();
    for (const i of items)
        m.set(i.appId, (m.get(i.appId) ?? 0) + 1);
    return [...m].map(([appId, count]) => ({appId, count})).sort((a, b) => b.count - a.count || a.appId.localeCompare(b.appId));
}

/** What history keeps: metadata only, unless `keepText`. The same notification seen twice within `dedupMs` is one entry. */
export function remember(history, n, nowMs, {keepText = false, max = 200, dedupMs = 2000} = {}) {
    const last = history[history.length - 1];
    if (last && last.appId === n.appId && last.title === (keepText ? n.title : undefined) && nowMs - last.at < dedupMs)
        return history;
    const next = [...history, {at: nowMs, appId: n.appId, urgency: n.urgency, ...(keepText ? {title: n.title} : {})}];
    return next.slice(-max);
}
