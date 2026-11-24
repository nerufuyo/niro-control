// Unified motion engine. Pure: no Clutter, no GLib, no timers, so island, dock and search can each carry a copy and
// the physics can be unit-tested under node. A host (a Clutter frame clock) calls Animator.tick(timeMs) once per frame.
//
// Every value follows   m*x'' + c*x' + k*(x - target) = 0   (a damped spring). Retargeting keeps the velocity, so an
// interrupted transition never jolts, and nothing here restarts a fixed-duration easing.

/** Tuning baselines (stiffness k, damping c, mass m). Not hard limits. */
export const SPRINGS = {
    snappy:   {stiffness: 500, damping: 38, mass: 1},
    standard: {stiffness: 340, damping: 30, mass: 1},
    fluid:    {stiffness: 260, damping: 25, mass: 1},
    gentle:   {stiffness: 200, damping: 27, mass: 1},
};

/** Shared tokens. Each component keeps its own personality (which spring, how far, how fast to stagger). */
export const MOTION_TOKENS = {
    radius: {surface: 22, island: 17, search: 18, dock: 20},
    stagger: {step: 28, max: 160},      // ms between content reveals, capped so long lists do not drag
    distance: {reveal: 8, slide: 14},   // px a revealed item travels
    personality: {
        island: {spring: 'fluid', overshoot: true},
        search: {spring: 'standard', overshoot: false},
        dock:   {spring: 'snappy', overshoot: true},
    },
};

const MAX_SUBSTEP = 1 / 240;   // s: integration stays stable and 60/120/144 Hz give the same path
const MAX_FRAME = 0.1;         // s: after a stall (suspend, GC) do not simulate the whole gap

/** Resolves a preset name or {stiffness, damping, mass} object into a full config. */
export function resolveSpring(spec = 'standard') {
    const base = typeof spec === 'string' ? SPRINGS[spec] ?? SPRINGS.standard : spec;
    return {stiffness: base.stiffness, damping: base.damping, mass: base.mass ?? 1};
}

/** Damping ratio: <1 overshoots, 1 is critical, >1 is sluggish. */
export const dampingRatio = ({stiffness, damping, mass = 1}) => damping / (2 * Math.sqrt(stiffness * mass));

/** Same stiffness, damping raised to critical: the reduced-motion version of a spring (settles, never overshoots). */
export function criticallyDamped(spec) {
    const c = resolveSpring(spec);
    return {...c, damping: 2 * Math.sqrt(c.stiffness * c.mass)};
}

/** One value pulled toward `target` by a damped spring. */
export class Spring {
    constructor(value = 0, spec = 'standard', {restDistance = 0.01, restSpeed = 0.05} = {}) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.config = resolveSpring(spec);
        this.restDistance = restDistance;
        this.restSpeed = restSpeed;
    }

    /** Aims at a new target and optionally a new spring; the current velocity is kept. */
    setTarget(target, spec) {
        this.target = target;
        if (spec)
            this.config = resolveSpring(spec);
        return this;
    }

    /** Adds velocity (units/s): a flick, or handing a gesture's release speed to the spring. */
    impulse(v) {
        this.velocity += v;
        return this;
    }

    /** Jumps with no motion. */
    reset(value, target = value) {
        this.value = value;
        this.target = target;
        this.velocity = 0;
        return this;
    }

    get settled() {
        return Math.abs(this.value - this.target) <= this.restDistance && Math.abs(this.velocity) <= this.restSpeed;
    }

    /** Advances `dt` seconds with fixed sub-steps; returns true once at rest (and then snaps exactly to the target). */
    step(dt) {
        let left = Math.min(Math.max(dt, 0), MAX_FRAME);
        const {stiffness, damping, mass} = this.config;
        while (left > 0 && !this.settled) {
            const h = Math.min(left, MAX_SUBSTEP);
            // Semi-implicit Euler: stable for the stiffness range used here at h <= 1/240 s.
            const a = (-stiffness * (this.value - this.target) - damping * this.velocity) / mass;
            this.velocity += a * h;
            this.value += this.velocity * h;
            left -= h;
        }
        if (this.settled) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}

/**
 * Steps a set of springs from a frame clock. The host calls `tick(timeMs)` each frame while `active`; when everything
 * rests it calls `onSettled` once and `active` turns false, so an idle surface costs no frames. `wake()` restarts it.
 */
export class Animator {
    constructor(springs, {onFrame = () => {}, onSettled = () => {}, onWake = () => {}} = {}) {
        this.springs = springs;
        this.onFrame = onFrame;
        this.onSettled = onSettled;
        this.onWake = onWake;
        this.active = false;
        this._last = null;
    }

    /** Call after any setTarget/impulse; asks the host for frames if it is not already running. */
    wake() {
        if (this.active)
            return;
        this.active = true;
        this._last = null;
        this.onWake();
    }

    /** Stops without settling (the actor is going away). */
    cancel() {
        this.active = false;
        this._last = null;
    }

    /** Returns whether another frame is wanted. `timeMs` is any monotonic clock. */
    tick(timeMs) {
        if (!this.active)
            return false;
        const dt = this._last === null ? 1 / 60 : (timeMs - this._last) / 1000;
        this._last = timeMs;
        let allSettled = true;
        for (const s of this.springs)
            allSettled = s.step(dt) && allSettled;
        this.onFrame(dt);
        if (allSettled) {
            this.active = false;
            this._last = null;
            this.onSettled();
            return false;
        }
        return true;
    }
}

/** Gaussian magnification: 1 + amplitude * exp(-d^2 / (2 sigma^2)). `distance` and `sigma` share a unit. */
export function gaussianScale(distance, amplitude, sigma) {
    if (!(sigma > 0))
        return 1;
    return 1 + amplitude * Math.exp(-(distance * distance) / (2 * sigma * sigma));
}

/**
 * Layout for a row of icons magnified around the pointer. `centers` are the resting centre x of each icon,
 * `sizes` their resting size. Returns [{scale, offset}] where `offset` is the shift that keeps neighbours from
 * overlapping: each icon is pushed out by half the growth of everything between it and the pointer's icon.
 */
export function magnifyRow(centers, sizes, pointerX, amplitude, sigma) {
    const scales = centers.map((c, i) => gaussianScale(Math.abs(c - pointerX), amplitude, sigma));
    // Growth of each icon beyond its resting size.
    const growth = scales.map((s, i) => (s - 1) * sizes[i]);
    // The icon nearest the pointer stays put; the rest shift outward by the accumulated growth between them.
    let anchor = 0;
    for (let i = 1; i < centers.length; i++) {
        if (Math.abs(centers[i] - pointerX) < Math.abs(centers[anchor] - pointerX))
            anchor = i;
    }
    const offsets = new Array(centers.length).fill(0);
    for (let i = anchor + 1; i < centers.length; i++)
        offsets[i] = offsets[i - 1] + (growth[i - 1] + growth[i]) / 2;
    for (let i = anchor - 1; i >= 0; i--)
        offsets[i] = offsets[i + 1] - (growth[i + 1] + growth[i]) / 2;
    return scales.map((scale, i) => ({scale, offset: offsets[i]}));
}

/** A small pull toward the pointer, fading to nothing at `radius`: `strength` is the pull at the centre (px per px). */
export function magneticPull(dx, dy, radius, strength) {
    const d = Math.hypot(dx, dy);
    if (d >= radius || d === 0 || radius <= 0)
        return {x: 0, y: 0};
    const fall = 1 - d / radius;
    return {x: dx * strength * fall, y: dy * strength * fall};
}

/** Delay in ms for item `index` of a staggered reveal, capped so a long list still finishes quickly. */
export function staggerDelay(index, step = MOTION_TOKENS.stagger.step, max = MOTION_TOKENS.stagger.max) {
    return Math.min(Math.max(index, 0) * step, max);
}

/**
 * Hysteresis for edge activation: show when the pointer is within `enter` px of the edge, keep showing until it is
 * more than `leave` px away (leave > enter), so hovering on the boundary does not flicker.
 */
export function edgeHysteresis(visible, distanceToEdge, enter, leave) {
    return visible ? distanceToEdge <= leave : distanceToEdge <= enter;
}

/**
 * Generic finite state machine: states are strings, `table[state][event]` is the next state (or a function of the
 * context returning it). Unknown events keep the state, so a stray event during any transition cannot wedge it.
 */
export class Machine {
    constructor(table, initial) {
        this.table = table;
        this.state = initial;
        this.listeners = new Set();
    }

    send(event, ctx) {
        let next = this.table[this.state]?.[event];
        if (typeof next === 'function')
            next = next(ctx);
        if (!next || next === this.state)
            return this.state;
        const prev = this.state;
        this.state = next;
        for (const l of this.listeners)
            l(next, prev, event);
        return next;
    }

    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

/**
 * Picks the spring for a transition: honours reduced motion (critically damped, never overshoots; `off` returns null
 * meaning "jump, do not animate") and the component's no-overshoot personality.
 */
export function springFor(component, {reduced = false, off = false, spring} = {}) {
    if (off)
        return null;
    const personality = MOTION_TOKENS.personality[component] ?? MOTION_TOKENS.personality.search;
    const base = resolveSpring(spring ?? personality.spring);
    return reduced || !personality.overshoot ? criticallyDamped(base) : base;
}
