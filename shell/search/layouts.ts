// Window layouts by name from Search: "layout save work", "layout work", "layouts". Pure parts: the query and the plan for putting windows back.

export function layoutQuery(query: string): {save: string} | {restore: string} | {list: true} | null {
    const q = query.trim();
    if (/^layouts?$/i.test(q)) return {list: true};
    let m = /^layout\s+save\s+([\p{L}\p{N} _-]{1,24})$/iu.exec(q);
    if (m) return {save: m[1].trim().toLowerCase()};
    m = /^layout\s+([\p{L}\p{N} _-]{1,24})$/iu.exec(q);
    return m && m[1].trim().toLowerCase() !== 'save' ? {restore: m[1].trim().toLowerCase()} : null;
}

export interface SavedWindow {cls: string; x: number; y: number; w: number; h: number; ws: number; max: boolean}
export interface Move {index: number; saved: SavedWindow}

/** Pairs each saved window with a distinct open window of the same application class (first come, first served). */
export function planMoves(saved: SavedWindow[], open: {cls: string}[]): Move[] {
    const used = new Set<number>();
    const moves: Move[] = [];
    for (const s of saved) {
        const index = open.findIndex((w, i) => !used.has(i) && w.cls === s.cls);
        if (index >= 0) { used.add(index); moves.push({index, saved: s}); }
    }
    return moves;
}
