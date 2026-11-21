// @ts-nocheck: converted from JavaScript; types are added file by file
// Recurring reminders: a reminder whose text ends in /daily or /weekly (/harian, /mingguan) comes back after it was shown.
// Kept apart from GJS so tests run it anywhere (tests/).

const DAY_MS = 86400000;
const RULES = [
    {re: /\s*\/(?:daily|harian|setiap hari)\s*$/i, period: DAY_MS, label: 'every day'},
    {re: /\s*\/(?:weekly|mingguan|setiap minggu)\s*$/i, period: 7 * DAY_MS, label: 'every week'},
];

/** The reminder as it is shown (without the marker) and how it repeats, or null when it does not. */
export function recurrence(text) {
    for (const rule of RULES) {
        if (rule.re.test(text))
            return {text: text.replace(rule.re, '').trim(), period: rule.period, label: rule.label, marked: text.trim()};
    }
    return null;
}

/** The next time after `now` at the same hour: a reminder missed for days comes once, not once per missed day. */
export function nextDue(due, now, period) {
    if (due > now)
        return due;
    return due + Math.ceil((now - due + 1) / period) * period;
}
