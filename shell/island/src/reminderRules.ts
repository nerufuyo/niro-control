// @ts-nocheck: converted from JavaScript; types are added file by file
// Recurring reminders: a reminder whose text ends in /daily, /weekdays, /weekly or /monthly (/harian, /harikerja, /mingguan, /bulanan)
// comes back after it was shown. Kept apart from GJS so tests run it anywhere (tests/).

const DAY_MS = 86400000;
const plusDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const plusMonth = (ms) => {
    const d = new Date(ms), day = d.getDate();
    const t = new Date(d.getFullYear(), d.getMonth() + 1, 1, d.getHours(), d.getMinutes(), d.getSeconds());
    t.setDate(Math.min(day, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));      // a short month keeps its last day
    return t.getTime();
};
const nextWeekday = (ms) => { let t = plusDays(ms, 1); while ([0, 6].includes(new Date(t).getDay())) t = plusDays(t, 1); return t; };

const RULES = [
    {re: /\s*\/(?:daily|harian|setiap hari)\s*$/i, period: DAY_MS, label: 'every day', step: ms => plusDays(ms, 1)},
    {re: /\s*\/(?:weekdays|hari ?kerja)\s*$/i, period: null, label: 'every weekday', step: nextWeekday},
    {re: /\s*\/(?:weekly|mingguan|setiap minggu)\s*$/i, period: 7 * DAY_MS, label: 'every week', step: ms => plusDays(ms, 7)},
    {re: /\s*\/(?:monthly|bulanan|setiap bulan)\s*$/i, period: null, label: 'every month', step: plusMonth},
];

/** The reminder as it is shown (without the marker) and how it repeats, or null when it does not. `next(due, now)` is its next time after `now`. */
export function recurrence(text) {
    for (const rule of RULES) {
        if (rule.re.test(text)) {
            return {
                text: text.replace(rule.re, '').trim(), period: rule.period, label: rule.label, marked: text.trim(),
                // the same local hour on the next day that fits: one reminder for several missed days, not one per day
                next: (due, now) => { let t = due; while (t <= now) t = rule.step(t); return t; },
            };
        }
    }
    return null;
}

/** The next time after `now` at the same hour for a fixed period: kept for callers that count in plain milliseconds. */
export function nextDue(due, now, period) {
    if (due > now)
        return due;
    return due + Math.ceil((now - due + 1) / period) * period;
}
