// Where Search sits relative to other top-of-screen chrome (the Niro Island). Pure (no Clutter, no GLib): node tests it.
// All values are logical (stage) pixels, the unit GNOME's layout uses at any display scale, so nothing here multiplies by a scale factor.

/** Space kept between the bottom of the island and the top of Search when they would otherwise touch. Not a GSettings key: Search has no
 *  schema of its own (it reads the shared org.niro.control one, which this change does not touch), so the knob is this constant. */
export const SAFE_GAP = 12;

export type Rect = {x: number; y: number; width: number; height: number};

export type PlacementInput = {
    /** The part of the monitor Search is on that is usable (below the top bar, above any dock strut). */
    work: Rect;
    /** Search's left edge and width on the stage, and the y it normally opens at (16% of the monitor). */
    panelX: number;
    panelWidth: number;
    defaultY: number;
    /** Height of everything in the panel that is not the results list (entry, status line, hint, padding), and the height the results
     *  would like (their content, already capped at the normal maximum). */
    fixedHeight: number;
    wantedResults: number;
    /** Visible bounds of the island on the stage, or null when it is no obstacle (not found, hidden, not mapped, other monitor). */
    island: Rect | null;
    gap?: number;
};

export type Placement = {
    /** Extra vertical offset from the default anchor (>= 0); 0 means Search sits where it always has. */
    offset: number;
    /** Maximum height the results list may take now; below `wantedResults` only when the full list would not fit under the island. */
    maxResults: number;
    /** True when the island was in the way. */
    collides: boolean;
};

const overlap1d = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * Search moves only when it would overlap the island (both axes), and then just far enough that its top is `gap` below the island's bottom.
 * It never leaves the usable area: if the panel with its results cannot fit below the island, the results list shrinks first, so the entry
 * stays visible and in reach; only when even the bare entry does not fit is the panel pushed up (never above the work area).
 * The island's rect is grown by the gap below it, so "touching" and "closer than the gap" both count as in the way (no 3 px sliver).
 */
export function placeSearch(p: PlacementInput): Placement {
    const gap = p.gap ?? SAFE_GAP;
    const wanted = Math.max(0, Math.floor(p.wantedResults));
    const isl = p.island;
    const total = p.fixedHeight + wanted;
    const hit = Boolean(isl) && isl!.width > 0 && isl!.height > 0
        && overlap1d(p.panelX, p.panelX + p.panelWidth, isl!.x, isl!.x + isl!.width)
        && overlap1d(p.defaultY, p.defaultY + total, isl!.y, isl!.y + isl!.height + gap);
    if (!hit) return {offset: 0, maxResults: wanted, collides: false};

    const bottomLimit = p.work.y + p.work.height;
    let y = Math.max(p.defaultY, Math.ceil(isl!.y + isl!.height + gap));
    let results = wanted;
    if (y + p.fixedHeight + results > bottomLimit) {
        const room = bottomLimit - y - p.fixedHeight;
        if (room >= 0) results = Math.min(wanted, room);                       // shrink the list; the entry stays where the island wants it
        else {                                                                    // the bare entry does not fit below the island: keep it visible
            results = 0;
            y = Math.max(p.work.y, bottomLimit - p.fixedHeight);
        }
    }
    return {offset: Math.max(0, y - p.defaultY), maxResults: Math.floor(results), collides: true};
}

/** The island's rect if it counts as an obstacle on this monitor (visible, non-empty, centred on it), else null. */
export function obstacle(island: Rect | null | undefined, visible: boolean, monitor: Rect): Rect | null {
    if (!island || !visible || island.width <= 0 || island.height <= 0) return null;
    const cx = island.x + island.width / 2, cy = island.y + island.height / 2;
    return cx >= monitor.x && cx < monitor.x + monitor.width && cy >= monitor.y && cy < monitor.y + monitor.height ? island : null;
}
