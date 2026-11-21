// "next" in Search: the coming events of Island's calendar (the daemon's own events), with the time left. Pure: the clock comes in.

export function agendaQuery(query: string): boolean {
    return /^(?:next|agenda|jadwal|rapat|meeting|meetings|acara)$/i.test(query.trim());
}

export interface AgendaEvent {title: string; date: string; start: string | null; end: string | null}

export function parseEvents(json: string): AgendaEvent[] {
    try {
        const list = JSON.parse(json);
        return Array.isArray(list) ? list.filter(e => typeof e?.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? ''))
            .map(e => ({title: e.title, date: e.date, start: /^\d{2}:\d{2}$/.test(e.start ?? '') ? e.start : null, end: /^\d{2}:\d{2}$/.test(e.end ?? '') ? e.end : null})) : [];
    } catch (_e) { return []; }
}

const dayNumber = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const minutesOf = (t: string): number => +t.slice(0, 2) * 60 + +t.slice(3, 5);

export interface Coming extends AgendaEvent {inMinutes: number; text: string}

/** Events from now on, soonest first: timed ones not yet started, and today's all-day ones. `today` is "YYYY-MM-DD", `minute` minutes since midnight. */
export function upcoming(events: AgendaEvent[], today: string, minute: number, limit = 5): Coming[] {
    const out: Coming[] = [];
    for (const e of events) {
        const days = dayNumber(e.date) - dayNumber(today);
        if (days < 0) continue;
        const startMin = e.start ? minutesOf(e.start) : 0;
        const inMinutes = days * 1440 + startMin - minute;
        if (e.start && inMinutes < 0) continue;                 // already started
        if (!e.start && days > 0) { out.push({...e, inMinutes, text: `${days === 1 ? 'tomorrow' : e.date}, all day`}); continue; }
        out.push({...e, inMinutes: Math.max(0, inMinutes), text: untilText(Math.max(0, inMinutes), e.start, days)});
    }
    return out.sort((a, b) => a.inMinutes - b.inMinutes).slice(0, limit);
}

function untilText(minutes: number, start: string | null, days: number): string {
    if (!start) return 'today, all day';
    if (days >= 2) return `${days} days, at ${start}`;
    if (minutes < 1) return 'now';
    if (minutes < 60) return `in ${minutes} min, at ${start}`;
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return `in ${h} h${m ? ` ${m} min` : ''}, at ${start}`;
}
