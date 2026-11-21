// Small tools typed into Search: dates ("30 days from now", "selisih 1 jan ke 17 agu"), passwords and ids ("pass 20", "uuid"),
// and encodings ("b64 text", "sha256 text"). Pure: what needs the system (randomness, hashing, base64) comes in through `Env`.

export interface Env {
    now: number;
    uuid(): string;
    /** n random bytes, from the system's source (never Math.random). */
    randomBytes(n: number): Uint8Array;
    hash(kind: 'md5' | 'sha1' | 'sha256', text: string): string;
    base64(text: string, decode: boolean): string;
}
export interface ToolAnswer {title: string; subtitle: string; copy: string}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mei|may', 'jun', 'jul', 'agu|aug', 'sep', 'okt|oct', 'nov', 'des|dec'];
const monthOf = (w: string): number => MONTHS.findIndex(m => new RegExp(`^(?:${m})`, 'i').test(w));
const DAY_MS = 86400000;
const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** "17 agu", "17 aug 2027", "2026-08-17", "today", "hari ini", "besok": midnight UTC of that day, or null. */
export function parseDate(text: string, now: number): number | null {
    const t = text.trim().toLowerCase();
    const today = dayStart(now);
    if (/^(?:today|hari ini|sekarang)$/.test(t)) return today;
    if (/^(?:tomorrow|besok)$/.test(t)) return today + DAY_MS;
    if (/^(?:yesterday|kemarin)$/.test(t)) return today - DAY_MS;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (m) return valid(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/.exec(t);
    if (m && monthOf(m[2]) >= 0) return valid(m[3] ? +m[3] : new Date(now).getUTCFullYear(), monthOf(m[2]), +m[1]);
    return null;
}
function valid(y: number, mo: number, d: number): number | null {
    const ms = Date.UTC(y, mo, d);
    const back = new Date(ms);
    return back.getUTCFullYear() === y && back.getUTCMonth() === mo && back.getUTCDate() === d ? ms : null;
}

const UNIT_DAYS: Record<string, number> = {hari: 1, day: 1, days: 1, minggu: 7, week: 7, weeks: 7};
function addMonths(ms: number, n: number): number {
    const d = new Date(ms);
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last));
}

function dateTool(q: string, now: number): ToolAnswer | null {
    const rel = /^(\d{1,5})\s*(hari|days?|minggu|weeks?|bulan|months?|tahun|years?)\s+(dari sekarang|dari hari ini|lagi|from now|from today|lalu|yang lalu|ago)$/i.exec(q);
    if (rel) {
        const n = parseInt(rel[1], 10) * (/(lalu|ago)$/i.test(rel[3]) ? -1 : 1);
        const unit = rel[2].toLowerCase();
        const today = dayStart(now);
        const at = /^(bulan|month)/.test(unit) ? addMonths(today, n) : /^(tahun|year)/.test(unit) ? addMonths(today, n * 12) : today + n * UNIT_DAYS[unit] * DAY_MS;
        return {title: dateText(at), subtitle: `${q}  ·  Enter copies`, copy: dateText(at)};
    }
    const diff = /^(?:selisih|diff|between|days between|berapa hari)\s+(.+?)\s+(?:ke|to|dan|and|sampai|until)\s+(.+)$/i.exec(q);
    if (diff) {
        const a = parseDate(diff[1], now), b = parseDate(diff[2], now);
        if (a === null || b === null) return null;
        const days = Math.round((b - a) / DAY_MS);
        const text = `${Math.abs(days).toLocaleString('en-US')} day${Math.abs(days) === 1 ? '' : 's'}${days < 0 ? ' earlier' : ''}`;
        return {title: text, subtitle: `${dateText(a)} → ${dateText(b)}  ·  Enter copies`, copy: String(Math.abs(days))};
    }
    const until = /^(?:hari sampai|days? (?:until|to|till)|berapa hari lagi ke)\s+(.+)$/i.exec(q);
    if (until) {
        const b = parseDate(until[1], now);
        if (b === null) return null;
        const days = Math.round((b - dayStart(now)) / DAY_MS);
        return {title: `${days.toLocaleString('en-US')} day${Math.abs(days) === 1 ? '' : 's'}${days < 0 ? ' ago' : ''}`, subtitle: `Until ${dateText(b)}  ·  Enter copies`, copy: String(Math.abs(days))};
    }
    return null;
}

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@^_';
/** A random password with no modulo bias (bytes that would skew it are skipped). */
export function password(env: Env, length: number): string {
    const limit = 256 - (256 % ALPHABET.length);
    let out = '';
    while (out.length < length) for (const b of env.randomBytes(length * 2)) { if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length]; }
    return out;
}

/** `null` unless the query is one of these tools. */
export function toolQuery(query: string, env: Env): ToolAnswer | null {
    const q = query.trim();
    if (!q || q.length > 400) return null;
    const date = dateTool(q, env.now);
    if (date) return date;
    if (/^uuid(?:\s*v?4)?$/i.test(q)) { const u = env.uuid(); return {title: u, subtitle: 'A random UUID  ·  Enter copies', copy: u}; }
    const pw = /^(?:pass(?:word)?|sandi|kata sandi)(?:\s+(\d{1,3}))?$/i.exec(q);
    if (pw) {
        const n = Math.min(Math.max(pw[1] ? parseInt(pw[1], 10) : 16, 8), 64);
        const p = password(env, n);
        return {title: p, subtitle: `A random ${n}-character password  ·  Enter copies  ·  type again for another`, copy: p};
    }
    const enc = /^(b64|base64|unb64|b64d|base64d|decode64)\s+(.+)$/is.exec(q);
    if (enc) {
        const decode = /^(unb64|b64d|base64d|decode64)$/i.test(enc[1]);
        try {
            const out = env.base64(enc[2], decode);
            return {title: out.length > 90 ? `${out.slice(0, 90)}…` : out, subtitle: `${decode ? 'Decoded' : 'Encoded'} base64  ·  Enter copies`, copy: out};
        } catch (_e) { return null; }
    }
    const h = /^(md5|sha1|sha256)\s+(.+)$/is.exec(q);
    if (h) {
        const out = env.hash(h[1].toLowerCase() as 'md5' | 'sha1' | 'sha256', h[2]);
        return {title: out.length > 40 ? `${out.slice(0, 40)}…` : out, subtitle: `${h[1].toUpperCase()} of the text  ·  Enter copies`, copy: out};
    }
    return null;
}
