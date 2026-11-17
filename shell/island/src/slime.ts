// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// Niro, a little slime: the mascot's body, moods and manners, with no GNOME in it so tests run it anywhere (tests/). It is the same
// character as the device's (firmware/niro-device/main/face.c): a pose per mood, a body that is a spring (it squashes, stretches
// and wobbles), blinks, glances, and now and then an act of its own. The drawing is in slimeDraw.js.
//
// It is made to cost nothing while it is calm: `needsFrames()` says when it must be drawn often (something is moving), and
// `nextWakeMs()` how long until anything will change, so whoever drives it can sleep in between.

export const MOODS = ['idle', 'happy', 'listening', 'thinking', 'speaking', 'alert', 'waking', 'searching', 'curious', 'sleepy', 'sad', 'love'];
export const ACTS = ['yawn', 'wink-left', 'wink-right', 'look-around', 'grin', 'bubble', 'sway'];

/** The body's size when it is neither squashed nor stretched, in the 240-pixel space it is drawn in. */
export const BODY = {rx: 82, ry: 58, ground: 208};

/** A pose: everything a mood is. Fields are numbers, so they ease. */
const base = () => ({
    sq: 0, tip: 0.75, tipDx: 0, eyeGap: 30, eyeDy: -4, eyeRx: 9.5, eyeRy: 13.5, arch: 0, shut: 0, lid: 0, tilt: 0, browL: 0, browR: 0,
    mouthHw: 8, mouthDy: 24, curve: 0.55, open: 0, blush: 0, warm: 0, dim: 0,
});

const POSES = {
    idle: {},
    happy: {sq: 0.05, arch: 1, eyeRx: 11, mouthHw: 19, curve: 1.1, blush: 1, mouthDy: 23, tip: 1},
    listening: {sq: -0.1, eyeRx: 11.5, eyeRy: 17, eyeDy: -6, mouthHw: 6, curve: 0, open: 0.45, mouthDy: 26, tip: 1},
    thinking: {eyeRy: 12, lid: 0.1, mouthHw: 7, curve: -0.1, browL: 0.8, tipDx: 9, mouthDy: 25},
    speaking: {mouthHw: 13, curve: 0.3, open: 0.3, eyeRx: 10, tip: 0.85},
    alert: {sq: -0.16, eyeRx: 12, eyeRy: 18, eyeDy: -8, tilt: -0.4, mouthHw: 11, curve: -0.7, open: 0.25, mouthDy: 28, warm: 1, tip: 1},
    waking: {sq: 0.3, shut: 1, curve: 0.1, tip: 0.2, dim: 0.3, mouthHw: 6},
    searching: {eyeRy: 12.5, mouthHw: 6, curve: -0.15, tip: 0.6, mouthDy: 25, dim: 0.1},
    curious: {tipDx: -10, browR: 0.9, tilt: -0.1, mouthHw: 7, curve: 0.5, eyeRy: 14.5, tip: 1},
    sleepy: {sq: 0.27, shut: 1, mouthHw: 5, curve: 0, tip: 0.3, dim: 0.35, eyeDy: 2},
    sad: {sq: 0.2, eyeRy: 12, tilt: -0.85, mouthHw: 9, curve: -0.6, mouthDy: 27, tip: 0.35, dim: 0.28, eyeDy: 2},
    love: {sq: 0.03, blush: 1, mouthHw: 15, curve: 1, mouthDy: 23, tip: 1},
};

export const poseFor = mood => ({...base(), ...(POSES[mood] ?? {})});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The longest step taken at once: a longer one is made of several, so a slept-through minute cannot make the spring blow up. */
const MAX_STEP = 1 / 30;
/** Seconds in a mood left alone before a calm slime dozes off. */
export const DOZE_AFTER = 90;

export class Slime {
    constructor(seed = 1) {
        this._rng = (seed >>> 0) || 2463534242;
        this.mood = 'waking';
        this.target = poseFor('waking');
        this.pose = {...this.target};
        this.t = 0;
        this.moodAge = 0;
        this.idleAge = 0;
        this.sq = this.pose.sq;
        this.sqv = 0;
        this.hy = 0;
        this.hv = 0;
        this.hopWait = 0.2;
        this.shear = 0;
        this.blink = 0;
        this.blinkPhase = -1;
        this.nextBlink = 2.5;
        this.doubleBlink = false;
        this.gx = 0; this.gy = 0; this.gtx = 0; this.gty = 0;
        this.nextLook = 2.5;
        this.talk = 0;
        this.act = null;
        this.actT = 0;
        this.actLen = 0;
        this.nextAct = 12;
        this.bubble = 0;
        this.shiver = 0;
    }

    _rand() {
        let x = this._rng;
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        this._rng = x;
        return (x & 0xffffff) / 0x1000000;
    }

    _between(a, b) {
        return a + (b - a) * this._rand();
    }

    /** The body is knocked: the spring is struck (negative squashes, positive stretches... as a velocity of the squash). */
    jolt(velocity) {
        this.sqv += velocity;
    }

    /** A hop, if it is on the ground. */
    hop(speed = 240) {
        if (this.hy <= 0.5)
            this.hv = speed;
    }

    setMood(mood) {
        if (!POSES[mood])
            return;
        if (mood !== this.mood) {
            this.moodAge = 0;
            this.jolt(mood === 'alert' ? -7 : mood === 'happy' ? 5 : 3);
        }
        this.mood = mood;
        this.target = poseFor(mood);
        this.idleAge = 0;
        this.act = null;
        this.hopWait = 0.2;
    }

    /** Something happened: a sleepy one wakes. */
    poke() {
        this.idleAge = 0;
        if (this.mood === 'sleepy')
            this.setMood('idle');
    }

    /** Starts an idle act now (calm only). Returns its length in seconds, or 0. */
    startAct(act) {
        if (this.mood !== 'idle' || !ACTS.includes(act))
            return 0;
        this.act = act;
        this.actT = 0;
        this.actLen = {yawn: 2.8, 'look-around': 2.6, grin: 1.8, bubble: 3.2, sway: 2.4}[act] ?? 1.1;
        if (act === 'grin')
            this.hop(210);
        return this.actLen;
    }

    /** Whether it must be drawn often now: something is moving. */
    needsFrames() {
        if (this.hy > 0.5 || Math.abs(this.hv) > 1 || Math.abs(this.sqv) > 0.05)
            return true;
        if (this.blinkPhase >= 0 || this.act)
            return true;
        const rest = this.pose.sq;
        if (Math.abs(this.sq - rest) > 0.004)
            return true;
        for (const key of Object.keys(this.target))
            if (Math.abs(this.pose[key] - this.target[key]) > 0.01)
                return true;
        if (Math.abs(this.gx - this.gtx) > 0.4 || Math.abs(this.gy - this.gty) > 0.4 || Math.abs(this.shear) > 0.2)
            return true;
        return this.animatesAlways();
    }

    /** The moods with something that moves all the time: a voice meter, dots, a pulse, a tear, a Z... */
    animatesAlways() {
        return ['happy', 'listening', 'thinking', 'speaking', 'alert', 'searching', 'curious', 'sleepy', 'sad', 'love'].includes(this.mood);
    }

    /** How often to draw while it moves, in ms: smooth while it hops, blinks or acts and in the lively moods; lighter for the slow
     * ones (a Z drifting, a tear, a dot bouncing), which need no more. */
    frameIntervalMs() {
        const fast = this.hy > 0.5 || Math.abs(this.sqv) > 0.3 || this.act !== null || this.blinkPhase >= 0
            || ['alert', 'speaking', 'listening'].includes(this.mood);
        return fast ? 33 : 66;
    }

    /** Seconds until anything changes by itself while it is still (a blink, a glance, an act, dozing off); Infinity for nothing. */
    nextWakeMs() {
        let s = Math.min(this.nextBlink > 0 && this.blinkPhase < 0 ? this.nextBlink : Infinity, this.nextLook,
            this.mood === 'idle' && !this.act ? this.nextAct : Infinity,
            this.mood === 'idle' ? DOZE_AFTER - this.idleAge : Infinity);
        return Number.isFinite(s) ? Math.max(1, s * 1000) : Infinity;
    }

    _steerGaze(dt) {
        this.nextLook -= dt;
        switch (this.mood) {
        case 'thinking': this.gtx = -5; this.gty = -9; break;
        case 'listening': case 'alert': case 'sleepy': case 'waking': this.gtx = 0; this.gty = 0; break;
        case 'searching': this.gtx = 12 * Math.sin(this.moodAge * 1.9); this.gty = -1; break;
        case 'sad': this.gtx = 0; this.gty = 4; break;
        default:
            if (this.nextLook <= 0) {
                const r = this._rand();
                if (r < 0.3) { this.gtx = 0; this.gty = 0; } else if (r < 0.8) { this.gtx = this._between(-11, 11); this.gty = this._between(-2, 3); } else { this.gtx = this._between(-6, 6); this.gty = this._between(-8, -3); }
                this.nextLook = this._between(1.6, 5);
            }
        }
    }

    /** Moves everything on by `seconds`. */
    step(seconds) {
        let left = Math.max(0, seconds);
        while (left > 1e-9) {
            const dt = Math.min(left, MAX_STEP);
            this._step(dt);
            left -= dt;
        }
    }

    _step(dt) {
        this.t += dt; this.moodAge += dt; this.idleAge += dt;
        const k = 1 - Math.exp(-dt * 8);
        for (const key of Object.keys(this.target))
            this.pose[key] += (this.target[key] - this.pose[key]) * k;
        this._steerGaze(dt);
        this.gx += (this.gtx - this.gx) * (1 - Math.exp(-dt * (this.mood === 'searching' ? 16 : 10)));
        this.gy += (this.gty - this.gy) * (1 - Math.exp(-dt * 10));

        // Hops: a happy slime keeps bouncing, a loving one bobs.
        if (this.mood === 'happy' || this.mood === 'love') {
            this.hopWait -= dt;
            if (this.hopWait <= 0 && this.hy <= 0.5) {
                this.hop(this.mood === 'happy' ? 270 : 170);
                this.hopWait = this.mood === 'happy' ? 1.05 : 1.4;
            }
        }
        const launched = this.hv;
        this.hv -= 900 * dt;
        this.hy += this.hv * dt;
        if (this.hy <= 0) {
            if (launched < -40)
                this.jolt(-Math.min(7.5, -launched / 60));   // landing: squash flat
            this.hy = 0;
            if (this.hv < 0)
                this.hv = 0;
        }

        // The body's spring: it rests on the pose's squash, stretches going up and wobbles after a knock.
        let rest = this.pose.sq - 0.15 * clamp(Math.abs(this.hv) / 300, 0, 1) * (this.hy > 0.5 ? 1 : 0);
        if (this.mood === 'speaking')
            rest += 0.035 * Math.sin(this.talk);
        this.sqv += (-140 * (this.sq - rest) - 9 * this.sqv) * dt;
        this.sq = clamp(this.sq + this.sqv * dt, -0.35, 0.32);
        this.shiver = this.mood === 'alert' ? Math.sin(this.t * 38) * 1.8 : 0;

        // Blinks.
        if (this.blinkPhase < 0) {
            this.nextBlink -= dt;
            if (this.nextBlink <= 0 && this.pose.shut < 0.5 && this.mood !== 'love')
                this.blinkPhase = 0;
        } else {
            this.blinkPhase += dt / 0.15;
            this.blink = this.blinkPhase < 0.5 ? this.blinkPhase * 2 : Math.max(0, 2 - this.blinkPhase * 2);
            if (this.blinkPhase >= 1) {
                this.blink = 0; this.blinkPhase = -1;
                if (this.doubleBlink) { this.doubleBlink = false; this.nextBlink = this._between(1.8, 5); } else {
                    this.doubleBlink = this._rand() < 0.2;
                    this.nextBlink = this.doubleBlink ? 0.08 : this._between(1.6, 5.2);
                }
            }
        }
        if (this.mood === 'speaking')
            this.talk += dt * 11;

        // Idle acts, and dozing off.
        if (this.mood === 'idle') {
            if (!this.act) {
                this.nextAct -= dt;
                if (this.nextAct <= 0) {
                    const r = this._rand();
                    this.startAct(r < 0.2 ? 'yawn' : r < 0.35 ? 'wink-left' : r < 0.45 ? 'wink-right' : r < 0.6 ? 'look-around' : r < 0.72 ? 'grin' : r < 0.84 ? 'bubble' : 'sway');
                    this.nextAct = this._between(8, 20);
                }
            } else {
                this.actT += dt;
                if (this.actT >= this.actLen) { this.act = null; this.bubble = 0; }
            }
            if (this.idleAge > DOZE_AFTER)
                this.setMood('sleepy');
        } else {
            this.act = null; this.bubble = 0;
        }
        let sway = 0;
        if (this.act === 'sway')
            sway = 15 * Math.sin(this.actT / this.actLen * Math.PI * 4) * Math.sin(this.actT / this.actLen * Math.PI);
        if (this.mood === 'curious')
            sway = 5 * Math.sin(this.t * 1.6);
        if (this.mood === 'searching')
            sway = 4 * Math.sin(this.moodAge * 1.9);
        this.shear += (sway - this.shear) * (1 - Math.exp(-dt * 12));
        if (this.mood === 'sleepy')
            this.bubble = 0.5 + 0.5 * Math.sin(this.t * 0.9);
        else if (this.act === 'bubble') {
            const u = this.actT / this.actLen;
            this.bubble = u < 0.8 ? u / 0.8 : 0;
        }
    }

    /** What to draw now: the body, the face with the act's changes on it, and the clock the overlays move by. */
    frame() {
        const p = this.pose;
        let {shut, arch, curve, open} = p;
        let lidL = p.lid, lidR = p.lid, gx = this.gx, gy = this.gy;
        const u = this.act ? clamp(this.actT / this.actLen, 0, 1) : 0;
        const act = this.act ? Math.sin(u * Math.PI) : 0;
        switch (this.act) {
        case 'yawn': shut = Math.max(shut, act); open = Math.max(open, 0.9 * act); curve = 0; break;
        case 'wink-left': lidL = act; arch = Math.max(arch, 0.8 * act); curve = Math.max(curve, 0.9 * act); break;
        case 'wink-right': lidR = act; arch = Math.max(arch, 0.8 * act); curve = Math.max(curve, 0.9 * act); break;
        case 'look-around': gx = 12 * Math.sin(u * Math.PI * 2); gy = -1; break;
        case 'grin': curve = 1.2; arch = Math.max(arch, 0.85 * act); break;
        default: break;
        }
        if (this.mood === 'speaking')
            open = p.open + 0.6 * Math.abs(Math.sin(this.talk)) * (0.6 + 0.4 * Math.sin(this.talk * 0.37));
        const rx = BODY.rx * (1 + this.sq), ry = BODY.ry / (1 + this.sq * 0.85);
        return {
            mood: this.mood, t: this.t, pose: p, act: this.act, actT: this.actT, actLen: this.actLen,
            rx, ry, ground: BODY.ground - this.hy, lift: this.hy, cx: 120 + this.shiver, shear: this.shear,
            shut, arch, curve, open, lidL, lidR, gx, gy, blink: this.blink, bubble: this.bubble,
        };
    }
}
