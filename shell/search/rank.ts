// How search results are ordered. Pure (tested with node). A result scores by how well its title (or a keyword) matches what was
// typed plus a small bonus for its kind; sections are shown in the order of their best result, so the top hit leads and a
// section never splits in two.

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** 0 to 100: the whole text 100, its start 85, the start of one of its words 65, somewhere inside 40, nothing 0. */
export function scoreText(query: string, text: string): number {
    const q = norm(query), t = norm(text);
    if (!q || !t) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 85;
    if (t.split(/[\s\-_/]+/).some(w => w.startsWith(q))) return 65;
    const words = q.split(' ').filter(Boolean);
    if (words.length > 1 && words.every(w => t.includes(w))) return 60;
    return t.includes(q) ? 40 : 0;
}

/** The best score of `query` against any of `texts` (a title, then keywords: a keyword counts a little less). */
export function bestScore(query: string, texts: string[]): number {
    return texts.reduce((best, text, i) => Math.max(best, Math.round(scoreText(query, text) * (i === 0 ? 1 : 0.85))), 0);
}

/** A bonus for the kind of result: what a person typing most likely wants when the match is equal. */
export const KIND_BONUS: Record<string, number> = {Calculator: 200, Conversion: 200, Clipboard: 60, Applications: 12, Actions: 10, Profiles: 8, Windows: 6, Settings: 0};

export interface Scored {section: string; score: number}

/** Results in the order they are shown: sections by their best score (ties: the kind's bonus), inside a section by score. */
export function arrange<T extends Scored>(results: T[]): T[] {
    const order = new Map<string, number>();
    results.forEach(r => order.set(r.section, Math.max(order.get(r.section) ?? -1, r.score + (KIND_BONUS[r.section] ?? 0))));
    const sections = [...order.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const index = new Map(results.map((r, i) => [r, i]));
    return [...results].sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section) || b.score - a.score || index.get(a)! - index.get(b)!);
}
