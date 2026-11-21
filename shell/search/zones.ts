// Time zones: "time in tokyo", "jam di london", "10:00 jakarta to new york". Pure (Intl only), so it runs under node and GJS alike.

const ZONES: Record<string, string> = {
    wib: 'Asia/Jakarta', wita: 'Asia/Makassar', wit: 'Asia/Jayapura', utc: 'UTC', gmt: 'UTC', jst: 'Asia/Tokyo', kst: 'Asia/Seoul',
    sgt: 'Asia/Singapore', cet: 'Europe/Paris', ist: 'Asia/Kolkata', pst: 'America/Los_Angeles', pt: 'America/Los_Angeles',
    est: 'America/New_York', et: 'America/New_York',
    jakarta: 'Asia/Jakarta', bandung: 'Asia/Jakarta', surabaya: 'Asia/Jakarta', medan: 'Asia/Jakarta', yogyakarta: 'Asia/Jakarta',
    makassar: 'Asia/Makassar', bali: 'Asia/Makassar', denpasar: 'Asia/Makassar', jayapura: 'Asia/Jayapura',
    singapore: 'Asia/Singapore', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
    'hong kong': 'Asia/Hong_Kong', bangkok: 'Asia/Bangkok', 'kuala lumpur': 'Asia/Kuala_Lumpur', manila: 'Asia/Manila',
    delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', dubai: 'Asia/Dubai', mecca: 'Asia/Riyadh', makkah: 'Asia/Riyadh', riyadh: 'Asia/Riyadh',
    istanbul: 'Europe/Istanbul', moscow: 'Europe/Moscow', cairo: 'Africa/Cairo', london: 'Europe/London', paris: 'Europe/Paris',
    berlin: 'Europe/Berlin', amsterdam: 'Europe/Amsterdam', madrid: 'Europe/Madrid', rome: 'Europe/Rome',
    'new york': 'America/New_York', chicago: 'America/Chicago', denver: 'America/Denver', 'los angeles': 'America/Los_Angeles',
    'san francisco': 'America/Los_Angeles', toronto: 'America/Toronto', 'mexico city': 'America/Mexico_City',
    'sao paulo': 'America/Sao_Paulo', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland',
    johannesburg: 'Africa/Johannesburg', nairobi: 'Africa/Nairobi', lagos: 'Africa/Lagos',
};

const zoneOf = (word: string): string | null => ZONES[word.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;
const label = (word: string): string => word.trim().replace(/\s+/g, ' ').replace(/\b\w+/g, w => (w.length <= 4 && ZONES[w.toLowerCase()] && !/[aeiou]/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));

const parts = (zone: string, ms: number) => {
    const f = new Intl.DateTimeFormat('en-GB', {timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
    const o: Record<string, number> = {};
    for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
    return o;
};
/** Minutes the zone is ahead of UTC at that instant. */
const offset = (zone: string, ms: number): number => {
    const p = parts(zone, ms);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
};
const clock = (zone: string, ms: number): string => {
    const p = parts(zone, ms);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};
const dayNumber = (zone: string, ms: number): number => {
    const p = parts(zone, ms);
    return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
};

export interface ZoneAnswer {title: string; subtitle: string; copy: string}

/** `null` unless the query names a place or zone we know. `local` is the computer's own zone (the one a bare time is read in). */
export function zoneQuery(query: string, now: number, local = Intl.DateTimeFormat().resolvedOptions().timeZone): ZoneAnswer | null {
    const q = query.trim();
    // "time in tokyo", "jam di tokyo", "waktu london"
    const t = /^(?:what(?:'s| is) the )?(?:time|jam|waktu)(?:\s+(?:in|di|at))?\s+([a-z ]+?)\s*\??$/i.exec(q);
    if (t) {
        const zone = zoneOf(t[1]);
        if (!zone) return null;
        const day = dayNumber(zone, now) - dayNumber(local, now);
        const text = `${clock(zone, now)}${day ? (day > 0 ? '  ·  tomorrow' : '  ·  yesterday') : ''}`;
        return {title: `${label(t[1])}: ${text}`, subtitle: 'Time there now  ·  Enter copies', copy: clock(zone, now)};
    }
    // "10:00 jakarta to london", "9am wib in jst", "14:30 to tokyo" (from this computer's zone)
    const c = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*([a-z ]*?)\s+(?:to|in|ke|->|=)\s+([a-z ]+?)\s*$/i.exec(q);
    if (!c) return null;
    let h = parseInt(c[1], 10);
    const mi = c[2] ? parseInt(c[2], 10) : 0;
    if (c[3]) {
        if (h < 1 || h > 12) return null;
        h = (h % 12) + (c[3].toLowerCase() === 'pm' ? 12 : 0);
    }
    if (h > 23 || mi > 59) return null;
    const from = c[4].trim() ? zoneOf(c[4]) : local, to = zoneOf(c[5]);
    if (!from || !to) return null;
    const p = parts(from, now);
    const guess = Date.UTC(p.year, p.month - 1, p.day, h, mi);
    let instant = guess - offset(from, guess) * 60000;
    instant = guess - offset(from, instant) * 60000; // once more: the offset can differ across a clock change
    const day = dayNumber(to, instant) - dayNumber(from, instant);
    const there = `${clock(to, instant)}${day ? (day > 0 ? ' (next day)' : ' (previous day)') : ''}`;
    const here = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} ${c[4].trim() ? label(c[4]) : 'here'}`;
    return {title: `${label(c[5])}: ${there}`, subtitle: `${here}  ·  Enter copies`, copy: clock(to, instant)};
}
