// @ts-nocheck: imports the plain-JS shared engine, copied next to this file by the build (shared/motionEngine.js)
// SPDX-License-Identifier: GPL-3.0-or-later

// The island as ONE surface: which state it is in, how a move between states is choreographed, and how bursts of
// events (volume keys) are coalesced. Pure, with no Clutter or GLib, so tests run it under node (tests/island/).
// island.ts owns the one actor and the four springs (width, height, radius, shoulder); this decides only the targets'
// timing and the springs' character. Nothing here creates or replaces an actor.

import {MOTION_TOKENS, Machine, criticallyDamped, springFor, staggerDelay} from './shared/motionEngine.js';

/** The island's own size spring (see spring.ts): ~3.5% overshoot, the "elastic" part of its personality. */
export const SURFACE_SPRING = {stiffness: 155, damping: 18, mass: 1};
/** Radii and shoulders never overshoot. */
export const RADIUS_SPRING = {stiffness: 155, damping: 25, mass: 1};

/** How long the second axis waits for the first, ms. Short enough to read as one gesture, long enough to see the order. */
export const AXIS_LAG_MS = 70;

/** Surface states. `split` is the closed island holding two live activities at once (see SurfacePresenter). */
export const SURFACE_STATES = ['idle', 'compact', 'expanded', 'immersive', 'split', 'dismissing'];

// Any live state may be interrupted into any other (that is the point of springs).
const LIVE = {compact: 'compact', expand: 'expanded', immerse: 'immersive', split: 'split', dismiss: 'dismissing'};
const SURFACE_TABLE = {
    idle: {compact: 'compact', expand: 'expanded', immerse: 'immersive', split: 'split'},
    compact: {...LIVE, rest: 'idle'},
    expanded: {...LIVE, rest: 'idle'},
    immersive: {...LIVE, rest: 'idle'},
    split: {...LIVE, rest: 'idle'},
    // Dismissing is reversible until it lands: a new context during the exit retargets from where it is.
    dismissing: {compact: 'compact', expand: 'expanded', immerse: 'immersive', split: 'split', settled: 'idle', rest: 'idle'},
};

/** The finite-state machine for the surface. */
export function createSurface(initial = 'idle') {
    return new Machine(SURFACE_TABLE, initial);
}

/** The event that takes the surface to `state`. */
export function eventFor(state) {
    switch (state) {
    case 'expanded': return 'expand';
    case 'immersive': return 'immerse';
    case 'split': return 'split';
    case 'dismissing': return 'dismiss';
    case 'idle': return 'rest';
    default: return 'compact';
    }
}

/**
 * The controller's presentation ('compact', 'peek', 'expanded', 'voice') as a surface state. A peek (an alert) is the
 * compact surface showing something else, so it stays `compact`; the assistant is the immersive one. `hidden` (nothing to
 * show, or auto-hidden) is `idle`.
 */
export function surfaceStateFor(presentation, {hidden = false} = {}) {
    if (hidden)
        return 'idle';
    switch (presentation) {
    case 'expanded': return 'expanded';
    case 'voice': return 'immersive';
    default: return 'compact';
    }
}

/**
 * How much motion the user wants: `off` (preset "off", or GNOME's animations switched off: the whole shell is instant, so
 * is the island), `reduced` (the "minimal" preset: everything still moves, but never overshoots, no axis order, no
 * stagger) or `full`. The same gate as shared/tokens.js `motionAllowed` for `off`.
 */
export function motionModeFor({preset = '', reduced = false} = {}) {
    if (preset === 'off' || reduced === true)
        return 'off';
    return preset === 'minimal' ? 'reduced' : 'full';
}

/** The closed island shows two activities side by side (music with a timer, a call or a recording) from this many. */
export const SPLIT_MIN_ACTIVITIES = 2;

/** Which surface state the inputs ask for. Voice > the open island > an alert (still the compact surface) > split > compact. */
export function wantedState({voice = false, expanded = false, alert = false, activities = 0} = {}) {
    if (voice)
        return 'immersive';
    if (expanded)
        return 'expanded';
    if (alert)
        return 'compact';
    return activities >= SPLIT_MIN_ACTIVITIES ? 'split' : 'compact';
}

/**
 * The surface machine as the controller's source of truth for what is presented. `resolve` takes what the controller
 * knows (assistant open, pages wanted, an alert, how many activities) and sends the event the machine needs; the
 * presentation name the views know ('compact', 'peek', 'expanded', 'voice') is derived from the state, never kept apart.
 * Auto-hide is the same surface leaving: `autoHide(true)` dismisses it, `settled()` rests it, and `autoHide(false)` (or
 * a render wanting something else) retargets it from wherever it is.
 */
export class SurfacePresenter {
    constructor(initial = 'idle') {
        this.machine = createSurface(initial);
        this.alert = false;
        this.hidden = false;
        this.want = 'compact';
    }

    get state() {
        return this.machine.state;
    }

    /** What the views call it. A peek is the compact surface showing an alert; `idle` and `dismissing` still hold their view. */
    get presentation() {
        switch (this.state) {
        case 'immersive': return 'voice';
        case 'expanded': return 'expanded';
        default: return this.alert ? 'peek' : 'compact';
        }
    }

    /** Whether two activities share the closed island now. */
    get split() {
        return this.state === 'split';
    }

    onChange(listener) {
        return this.machine.onChange(listener);
    }

    /** Takes the inputs, moves the machine; returns {from, to, changed}. While auto-hidden the compact states wait (the surface is leaving). */
    resolve(inputs) {
        this.alert = Boolean(inputs.alert);
        this.want = wantedState(inputs);
        const from = this.state;
        const waits = this.hidden && (this.want === 'compact' || this.want === 'split');
        if (!waits)
            this.machine.send(eventFor(this.want));
        return {from, to: this.state, changed: from !== this.state};
    }

    /** Auto-hide drew the island away (`true`) or back. */
    autoHide(hidden) {
        if (hidden === this.hidden)
            return;
        this.hidden = hidden;
        if (hidden && (this.state === 'compact' || this.state === 'split'))
            this.machine.send('dismiss');
        else if (!hidden)
            this.machine.send(eventFor(this.want));
    }

    /** The auto-hide slide ended: the surface rests. */
    settled() {
        this.machine.send('settled');
    }
}

/**
 * When the second zone of a split reveals, ms after the shape starts moving: after the shape has made room for it (the
 * axis lag), not before. Reduced motion and off: at once.
 */
export function splitRevealDelay({mode = 'full'} = {}) {
    return mode === 'full' ? AXIS_LAG_MS + staggerDelay(1) : 0;
}

/**
 * Which axis leads. Growing in both: width first (the surface widens, then drops), so the content has room before the
 * height reveals it. Shrinking in both: height first, the reverse of the same path, from wherever the springs are now.
 * Mixed or unchanged: together. `from` is the current visual size, `to` the new target ({width, height}).
 */
export function axisOrder(from, to, epsilon = 1) {
    const dw = to.width - from.width;
    const dh = to.height - from.height;
    if (dw > epsilon && dh > epsilon)
        return 'width-first';
    if (dw < -epsilon && dh < -epsilon)
        return 'height-first';
    return 'together';
}

/**
 * How to move to `to` from `from`: the spring for each channel and the delay of the lagging axis. `off` (motion off) gives
 * `instant`; `reduced` keeps the path but critically damped, no overshoot, no axis lag.
 */
export function morphPlan(from, to, {reduced = false, off = false} = {}) {
    const size = springFor('island', {off, reduced, spring: SURFACE_SPRING});
    if (!size)
        return {instant: true, order: 'together', widthDelay: 0, heightDelay: 0, size: null, radius: null};
    const radius = reduced ? criticallyDamped(RADIUS_SPRING) : RADIUS_SPRING;
    const order = reduced ? 'together' : axisOrder(from, to);
    return {
        instant: false,
        order,
        widthDelay: order === 'height-first' ? AXIS_LAG_MS : 0,
        heightDelay: order === 'width-first' ? AXIS_LAG_MS : 0,
        size,
        radius,
    };
}

/**
 * Delays for revealing `count` pieces of content in order (artwork, then metadata, then progress and controls). Reduced
 * motion reveals all at once. Delays are the engine's staggerDelay (capped), so a long list still finishes quickly.
 */
export function revealDelays(count, {reduced = false} = {}) {
    return Array.from({length: count}, (_, i) => reduced ? 0 : staggerDelay(i));
}

/** Reveal order for a track starting: the shape first (see morphPlan), then these. */
export const MUSIC_REVEAL = ['artwork', 'metadata', 'progress', 'controls'];
/** How far (CSS px) a revealed piece rises into place. */
export const REVEAL_RISE_PX = MOTION_TOKENS.distance.reveal;

/**
 * Content that follows the surface (the geometry of the island's edge, as opposed to its interpolation): a view is laid out at the width
 * it will have at rest and centred on the display, so while the surface is still narrower (or wider) than that, its edge content would
 * sit at its final place at once: past the surface's clip when widening, or teleported inward when narrowing. These functions
 * give where the content should be instead. Pure (CSS px or stage px alike, as long as both edges are in one unit).
 *
 * `surface` is the animated body's {left, right}, `rest` the same where it will settle. The shift of each edge is how far the content
 * pinned to it is from its resting place. `signed` follows the edge both ways (the same view in a new size: a sign beside the
 * island's end moves in with it); unsigned only moves content in from past the edge's inner side (a view coming in on a surface that
 * is narrower than it will be): a surface wider than the view leaves it where it rests, as the view just fades in there.
 */
export function edgeShifts(surface, rest, signed) {
    const left = surface.left - rest.left;
    const right = surface.right - rest.right;
    return signed ? {left, right} : {left: Math.max(0, left), right: Math.min(0, right)};
}

const clamp01 = value => Math.max(0, Math.min(1, value));
const smooth = value => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

/** How much of a travel from `from` to `to` has been made, 0 to 1 (1 when there is no travel). */
export function travelProgress(size, from, to) {
    const span = to - from;
    return Math.abs(span) < 1 ? 1 : clamp01((size - from) / span);
}

/**
 * How revealed a piece of content that arrives with the surface growing from `from` to `to` should be at `size`: nothing until the
 * surface has covered `start` of the way, all of it from `end`; in between a smooth ramp. It reads the size, not the time, so an
 * interruption (a retarget, a collapse) turns it round with the surface. Content that arrives on a surface not growing shows at once.
 */
export function arrivalGate(size, from, to, {start = 0.5, end = 0.95} = {}) {
    if (to - from < 1)
        return 1;
    return smooth((travelProgress(size, from, to) - start) / (end - start));
}

/**
 * How revealed the content of a view that is `full` wide (tall) at rest should be on a surface `size` wide (tall): none while the
 * surface is `ramp` or more short of holding the content (the view less `edge` of padding on each side), all once it holds it. For the
 * content of a view that is wider than the surface while it grows, or while it narrows: it is shown only inside the edge's clip.
 */
export function roomGate(size, full, {edge = 0, ramp = 0} = {}) {
    const need = full - 2 * edge;
    if (ramp <= 0)
        return size >= need ? 1 : 0;
    return smooth((size - (need - ramp)) / ramp);
}

/**
 * How a notification moves, by priority: an `instant` (critical, call) alert is quick and may overshoot; a routine
 * one is calm (critically damped, no stagger). Transient ones (volume) never bounce the surface.
 */
export function alertMotion(alert, {reduced = false} = {}) {
    const urgent = alert?.priority === 'instant' && !alert?.transient;
    const spring = springFor('island', {reduced, spring: urgent ? 'snappy' : SURFACE_SPRING});
    return {urgent, spring: urgent || !spring ? spring : criticallyDamped(spring), reveal: urgent && !reduced};
}

/**
 * Coalesces a burst (volume key repeat) to at most one apply per `interval` ms: the first applies at once (immediate
 * response), later ones within the interval are held and only the newest is applied when it ends. Time is passed in.
 */
export class Coalescer {
    constructor(interval = 33) {
        this.interval = interval;
        this._last = -Infinity;
        this._pending = false;
    }

    /** `{apply: true}` to apply now, else `{apply: false, wait, schedule}`: `schedule` is true for the first held event only. */
    offer(now) {
        const since = now - this._last;
        if (since >= this.interval) {
            this._last = now;
            this._pending = false;
            return {apply: true, wait: 0, schedule: false};
        }
        const schedule = !this._pending;
        this._pending = true;
        return {apply: false, wait: this.interval - since, schedule};
    }

    /** Marks the held event as applied (call from the flush). */
    flush(now) {
        this._last = now;
        this._pending = false;
    }

    reset() {
        this._last = -Infinity;
        this._pending = false;
    }
}
