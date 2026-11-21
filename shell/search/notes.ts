// Notes, to-dos and habits typed into Search: plain Markdown and tab-separated files in Documents/Niro, so they open in any editor.
// Pure: dates come in as "YYYY-MM-DD" strings, file contents as text.

/** "note buy milk" → the text. */
export function noteText(query: string): string | null {
    const m = /^(?:note|catat)\s+(\S.*)$/i.exec(query.trim());
    return m ? m[1].trim().slice(0, 500) : null;
}
export const noteLine = (stamp: string, text: string): string => `- ${stamp} ${text.replace(/\s+/g, ' ').trim()}\n`;
/** The newest notes, newest first. */
export function recentNotes(text: string, limit = 6): string[] {
    return text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)).reverse().slice(0, limit);
}

/** "todo call the bank" adds; "todo" or "todos" alone lists. */
export function todoQuery(query: string): {add: string} | {list: true} | null {
    const q = query.trim();
    if (/^(?:todos?|tugas)$/i.test(q)) return {list: true};
    const m = /^(?:todo|tugas)\s+(\S.*)$/i.exec(q);
    return m ? {add: m[1].trim().slice(0, 300)} : null;
}
export const todoLine = (text: string): string => `- [ ] ${text.replace(/\s+/g, ' ').trim()}\n`;
export function openTodos(text: string, limit = 8): string[] {
    return text.split('\n').filter(l => /^- \[ \] /.test(l)).map(l => l.slice(6)).slice(0, limit);
}
/** The file with the first open item that reads `item` ticked, or null when it is not there. */
export function markDone(text: string, item: string): string | null {
    const lines = text.split('\n');
    const i = lines.findIndex(l => l === `- [ ] ${item}`);
    if (i < 0) return null;
    lines[i] = `- [x] ${item}`;
    return lines.join('\n');
}

/** "habit water" logs; "habits" lists. */
export function habitQuery(query: string): {log: string} | {list: true} | null {
    const q = query.trim();
    if (/^(?:habits?|kebiasaan)$/i.test(q)) return {list: true};
    const m = /^(?:habit|kebiasaan)\s+([\p{L}\p{N} _-]{1,30})$/iu.exec(q);
    return m ? {log: m[1].trim().toLowerCase()} : null;
}

const dayNumber = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;

export interface Habit {name: string; streak: number; doneToday: boolean; total: number}

/** From lines "YYYY-MM-DD\tname": each habit's run of days ending today (or yesterday, if today is still to do). */
export function habitStats(text: string, today: string): Habit[] {
    const days = new Map<string, Set<string>>();
    for (const line of text.split('\n')) {
        const m = /^(\d{4}-\d{2}-\d{2})\t(.+)$/.exec(line.trim());
        if (m) (days.get(m[2]) ?? days.set(m[2], new Set()).get(m[2])!).add(m[1]);
    }
    const t = dayNumber(today);
    return [...days.entries()].map(([name, set]) => {
        const nums = new Set([...set].map(dayNumber));
        const doneToday = nums.has(t);
        let streak = 0;
        for (let d = doneToday ? t : t - 1; nums.has(d); d--) streak++;
        return {name, streak, doneToday, total: set.size};
    }).sort((a, b) => a.name.localeCompare(b.name));
}
/** The line to add, or null when the habit is already logged for that day. */
export function habitLog(text: string, today: string, name: string): string | null {
    return text.split('\n').some(l => l.trim() === `${today}\t${name}`) ? null : `${today}\t${name}\n`;
}
