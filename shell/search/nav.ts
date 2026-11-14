// Keyboard behaviour of the palette, kept free of the shell so it can be tested with node.

// X11 keysyms (what Clutter hands over)
const K = {Escape: 0xff1b, Down: 0xff54, Up: 0xff52, Tab: 0xff09, BackTab: 0xfe20, Return: 0xff0d, KPEnter: 0xff8d, n: 0x6e, p: 0x70, one: 0x31, nine: 0x39};

export type Intent = {type: 'close'} | {type: 'next'} | {type: 'previous'} | {type: 'activate'} | {type: 'quick'; index: number} | null;

/** What a key press means in the palette (null: not ours, let it through to the text field). */
export function keyIntent(key: number, ctrl: boolean): Intent {
    if (key === K.Escape) return {type: 'close'};
    if (key === K.Down || key === K.Tab || (ctrl && key === K.n)) return {type: 'next'};
    if (key === K.Up || key === K.BackTab || (ctrl && key === K.p)) return {type: 'previous'};
    if (ctrl && key >= K.one && key <= K.nine) return {type: 'quick', index: key - K.one};
    if (key === K.Return || key === K.KPEnter) return {type: 'activate'};
    return null;
}

/** The row that is selected after moving by `delta`, wrapping at both ends; -1 when there is nothing to select. */
export function move(current: number, delta: number, count: number): number {
    if (count <= 0) return -1;
    return (((current < 0 ? (delta > 0 ? -1 : 0) : current) + delta) % count + count) % count;
}

/** The line under the results: what Enter will do for the selected one, and the keys. */
export function hint(selected: {permission?: string; title: string} | undefined): string {
    const keys = '↑↓ move  ·  Esc close';
    if (!selected) return keys;
    return selected.permission && selected.permission !== 'none' ? `Enter asks to confirm  ·  ${keys}` : `Enter opens  ·  ${keys}`;
}

/** One at a time: a second activation while the first still runs (key repeat, a double click) is refused. */
export class Once {
    private busy = false;
    begin(): boolean { if (this.busy) return false; this.busy = true; return true; }
    end(): void { this.busy = false; }
}
