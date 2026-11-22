// @ts-nocheck: the shared motion engine is plain JS copied into build/shared by the build
// Search overlay motion, kept free of Clutter and GLib so node can test it. The shell code (extension.ts) only draws what
// this says and feeds it a frame clock. Springs come from the shared engine (personality "search": precise, no overshoot).
import {Animator, Machine, Spring, springFor, staggerDelay, MOTION_TOKENS} from './shared/motionEngine.js';

export type SearchState = 'Closed' | 'Opening' | 'Ready' | 'ResultsExpanded' | 'Executing' | 'Dismissing';
export type SearchEvent = 'open' | 'settled' | 'results' | 'execute' | 'dismiss' | 'close';

/** Unknown events keep the state, so a stray key or a late timer cannot wedge the overlay. */
const hasResults = (ctx?: {count?: number}) => (ctx?.count ?? 0) > 0;
export const SEARCH_TABLE = {
    Closed: {open: 'Opening'},
    Opening: {
        settled: (ctx?: {count?: number}) => (hasResults(ctx) ? 'ResultsExpanded' : 'Ready'),
        results: (ctx?: {count?: number}) => (hasResults(ctx) ? 'ResultsExpanded' : 'Opening'),
        execute: 'Executing', close: 'Dismissing',
    },
    Ready: {results: (ctx?: {count?: number}) => (hasResults(ctx) ? 'ResultsExpanded' : 'Ready'), execute: 'Executing', close: 'Dismissing'},
    ResultsExpanded: {results: (ctx?: {count?: number}) => (hasResults(ctx) ? 'ResultsExpanded' : 'Ready'), execute: 'Executing', close: 'Dismissing'},
    Executing: {dismiss: 'Dismissing', close: 'Dismissing', open: 'Opening'},
    Dismissing: {settled: 'Closed', open: 'Opening'},
};

export const createSearchMachine = () => new Machine(SEARCH_TABLE, 'Closed');

/** Visible (drawn) in every state but Closed; the keyboard grab is held only while the user can still type. */
export const isShown = (s: SearchState) => s !== 'Closed';
export const isLive = (s: SearchState) => s === 'Opening' || s === 'Ready' || s === 'ResultsExpanded';

const REVEAL_ROWS = 8;       // only the first rows animate; the rest are simply there
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Panel pose for open progress 0..1: appears a little above its anchor, slightly smaller, and settles. Never overshoots. */
export function panelPose(progress: number) {
    const p = clamp01(progress);
    return {opacity: Math.round(255 * p), scale: 0.97 + 0.03 * p, dy: -MOTION_TOKENS.distance.reveal * (1 - p)};
}

/** Row `index` of a staggered reveal at `reveal` 0..1: starts later the further down it is (delay capped), then eases in. */
export function rowReveal(reveal: number, index: number) {
    if (index >= REVEAL_ROWS) return {opacity: 255, dy: 0};
    const start = 0.5 * staggerDelay(index) / MOTION_TOKENS.stagger.max;       // 0 .. 0.5 of the way through
    const p = clamp01((reveal - start) / 0.5);
    return {opacity: Math.round(255 * p), dy: MOTION_TOKENS.distance.reveal * (1 - p) * 0.5};
}

/** Identity of a result across refreshes: what it does, not where it sits. */
export const resultKey = (r: {action?: string; args?: unknown; title?: string; section?: string}) =>
    `${r.section ?? ''}|${r.action ?? ''}|${JSON.stringify(r.args ?? null)}|${r.title ?? ''}`;

/**
 * After the list is rebuilt: which row is selected, and which rows may play the reveal.
 * A new query starts at the top and reveals the list. A late arrival for the same query (rates, files, network) keeps
 * the selection on the same result, keeps rows that were already there still, and reveals nothing (no jump, no replay).
 */
export function planUpdate(prev: {keys: string[]; selected: number}, nextKeys: string[], queryChanged: boolean) {
    if (queryChanged || !prev.keys.length) return {selected: nextKeys.length ? 0 : -1, animate: nextKeys.map(() => true), keepScroll: false};
    const kept = prev.keys[prev.selected];
    const at = kept === undefined ? -1 : nextKeys.indexOf(kept);
    const selected = nextKeys.length === 0 ? -1 : at >= 0 ? at : Math.min(Math.max(prev.selected, 0), nextKeys.length - 1);
    const had = new Set(prev.keys);
    return {selected, animate: nextKeys.map(k => !had.has(k)), keepScroll: true};
}

/** Where the scroll offset should be after a late update: unchanged, but never past the end. */
export const keepScrollValue = (value: number, upper: number, page: number) => Math.min(Math.max(value, 0), Math.max(0, upper - page));

/** Offset that puts a row at `rowY` back where it was in the viewport (`anchor` = its old y minus the old offset), within the fresh extent. */
export const anchoredScroll = (rowY: number, anchor: number, upper: number, page: number) => keepScrollValue(rowY - anchor, upper, page);

export type MotionHost = {
    onWake?: () => void;
    onFrame?: () => void;
    /** Called when the panel has fully faded out after a dismiss. */
    onClosed?: () => void;
    /** Called when the panel has finished opening (also on any later settle while it is open; the machine ignores repeats). */
    onOpened?: () => void;
    reduced?: () => boolean;      // user asked for reduced motion
    off?: () => boolean;          // animations disabled: jump instead
};

/**
 * Owns the springs: panel progress, list reveal, and one highlight spring per row. One Animator drives them, and it
 * stops asking for frames when all are at rest. Retargeting keeps velocity, so open/close/open mid-flight is smooth.
 */
export class SearchMotion {
    panel = new Spring(0, 'standard');
    reveal = new Spring(1, 'standard');
    /** Extra vertical offset (px) that keeps the panel clear of the island; the entry moves with the panel, never inside it. */
    dodge = new Spring(0, 'standard');
    highlight = new Map<string, Spring>();
    animator: Animator;
    private closing = false;

    constructor(private host: MotionHost = {}) {
        this.animator = new Animator(this.springs(), {
            onWake: () => host.onWake?.(),
            onFrame: () => host.onFrame?.(),
            onSettled: () => this.settle(),
        });
    }

    private springs() { return [this.panel, this.reveal, this.dodge, ...this.highlight.values()]; }

    private spec() { return springFor('search', {reduced: this.host.reduced?.() ?? false, off: this.host.off?.() ?? false}); }

    private aim(spring: Spring, target: number) {
        const spec = this.spec();
        if (!spec) spring.reset(target);            // animations off: jump, no frame loop
        else spring.setTarget(target, spec);
    }

    private settle() {
        for (const [k, s] of this.highlight) if (s.settled && s.target === 0) this.highlight.delete(k);
        this.animator.springs = this.springs();
        if (this.closing && this.panel.settled && this.panel.target === 0) { this.closing = false; this.host.onClosed?.(); }
        else if (!this.closing && this.panel.settled && this.panel.target === 1) this.host.onOpened?.();
    }

    private go() {
        this.animator.springs = this.springs();
        if (this.animator.springs.every(s => s.settled)) this.settle();        // everything jumped: finish now, no frames
        else this.animator.wake();
    }

    open() {
        this.closing = false;
        this.aim(this.panel, 1);
        this.go();
    }

    /** Fades out. Safe at any moment, including mid-open: the spring keeps its velocity and reverses. */
    close() {
        this.closing = true;
        this.aim(this.panel, 0);
        this.go();
    }

    /**
     * Moves the panel to `offset` px below its anchor (island in the way) or back to 0.
     * Going back (offset smaller than now) is the search spring: no overshoot, velocity kept when retargeted mid-flight.
     * Going down further follows the island: it is the island that is animating (its own spring), and a spring chasing it would lag
     * behind and let it paint over the panel for a few frames, so the offset takes the island's edge as it moves (the panel never overlaps it).
     * `instant`, reduced motion and disabled animations jump either way.
     */
    place(offset: number, instant = false) {
        const spec = this.spec();
        if (instant || this.host.reduced?.() || !spec) this.dodge.reset(offset);
        else if (offset > this.dodge.value) this.dodge.reset(offset);
        else this.dodge.setTarget(offset, spec);
        this.go();
    }

    /** Plays the list reveal again (a new query's results). */
    revealList() {
        const spec = this.spec();
        if (!spec) return this.reveal.reset(1);
        this.reveal.reset(0, 1);
        this.reveal.config = spec;
        this.go();
    }

    /** Moves the highlight from `from` to `to` (row keys); the old one fades while the new one grows. */
    select(from: string | null, to: string | null, instant = false) {
        if (from !== null && from !== to) this.aim(this.spring(from), 0);
        if (to !== null) { if (instant) this.spring(to).reset(1); else this.aim(this.spring(to), 1); }
        this.go();
    }

    private spring(key: string) {
        let s = this.highlight.get(key);
        if (!s) { s = new Spring(0, 'snappy'); this.highlight.set(key, s); }
        return s;
    }

    dropHighlights() { this.highlight.clear(); this.go(); }
    alpha(key: string) { return this.highlight.get(key)?.value ?? 0; }
    pose() { return panelPose(this.panel.value); }
    tick(timeMs: number) { return this.animator.tick(timeMs); }
    /** Stops all frames (disable). */
    cancel() { this.closing = false; this.animator.cancel(); }
}
