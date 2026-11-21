// Moving around the window switcher's grid, kept apart from the shell so tests run it anywhere (tests/).

export type Dir = 'left' | 'right' | 'up' | 'down' | 'next' | 'prev';

/** Columns for `n` windows: one row while they fit, then four or five across. */
export function columnsFor(n: number): number {
    return n <= 4 ? Math.max(1, n) : n <= 8 ? 4 : 5;
}

/** The index after a move: left, right, Tab and Shift+Tab wrap round the whole list; up and down keep the column and wrap to the other end of it. */
export function move(index: number, n: number, cols: number, dir: Dir): number {
    if (n <= 0) return 0;
    switch (dir) {
    case 'left': case 'prev': return (index - 1 + n) % n;
    case 'right': case 'next': return (index + 1) % n;
    case 'down': {
        const to = index + cols;
        if (to < n) return to;
        return index % cols;                                       // from the last row: back to the top of the column
    }
    case 'up': {
        const to = index - cols;
        if (to >= 0) return to;
        const col = index % cols;
        let last = col;
        while (last + cols < n) last += cols;                     // from the first row: to the bottom of the column
        return last;
    }
    }
}
