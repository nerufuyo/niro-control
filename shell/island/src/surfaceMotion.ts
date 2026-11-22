// @ts-nocheck: imports the plain-JS shared engine, copied next to this file by the build (shared/motionEngine.js)
// SPDX-License-Identifier: GPL-3.0-or-later

// The island as ONE surface: which state it is in, how a move between states is choreographed, and how bursts of
// events (volume keys) are coalesced. Pure, with no Clutter or GLib, so tests run it under node (tests/island/).
// island.ts owns the one actor and the four springs (width, height, radius, shoulder); this decides only the targets'
// timing and the springs' character. Nothing here creates or replaces an actor.

import {Machine, criticallyDamped, springFor, staggerDelay} from './shared/motionEngine.js';

/** The island's own size spring (see spring.ts): ~3.5% overshoot, the "elastic" part of its personality. */
export const SURFACE_SPRING = {stiffness: 155, damping: 18, mass: 1};
/** Radii and shoulders never overshoot. */
export const RADIUS_SPRING = {stiffness: 155, damping: 25, mass: 1};

/** How long the second axis waits for the first, ms. Short enough to read as one gesture, long enough to see the order. */
export const AXIS_LAG_MS = 70;

/** Surface states. `split` has no runtime trigger yet (see docs/motion/island.md); the machine supports it. */
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
