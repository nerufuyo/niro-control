import Clutter from "gi://Clutter";
import type St from "gi://St";
import { SignalManager } from "./signalManager.js";
const MIN_SCALE = 1.0;
type Profile = { x: number; w: number; h: number };
const SPRING_K = 170; // stiffness: higher = snappier
const SPRING_C = 17; // damping: below 2*sqrt(K) ~ 26 leaves a small, natural overshoot
const POINTER_RATE = 22; // 1/s: how fast the magnified bump follows the pointer
export class Magnification {
    _signals: SignalManager;
    _container: InstanceType<typeof St.BoxLayout>;
    _enabled: boolean;
    _maxScale: number;
    _falloffDistance: number;
    _timeline: Clutter.Timeline | null = null;
    _lastMs = 0;
    _velocity: number[] = [];
    _smoothX: number | null = null;
    _currentScales: number[] = [];
    _pivotX = 0.5;
    _pivotY = 1.0;
    _paused = false;
    _onExtent: ((width: number, height: number, profile: Profile[]) => void) | null = null;
    constructor(container: InstanceType<typeof St.BoxLayout>, enabled: boolean, maxScale: number, falloffDistance = 100, _framerate = 60) {
        this._signals = new SignalManager();
        this._container = container;
        this._enabled = enabled;
        this._maxScale = maxScale;
        this._falloffDistance = falloffDistance;
    }
    setEnabled(enabled: boolean) {
        this._enabled = enabled;
        if (!enabled)
            this._snapAllToMin();
    }
    setMaxScale(scale: number) {
        this._maxScale = scale;
    }
    setFalloffDistance(distance: number) {
        this._falloffDistance = distance;
    }
    setOnExtent(cb: (width: number, height: number, profile: Profile[]) => void) {
        this._onExtent = cb;
    }
    setFramerate(_fps: number) { /* animation now follows the compositor's frame clock */ }
    setPivotPoint(x: number, y: number) {
        this._pivotX = x;
        this._pivotY = y;
    }
    pause() {
        if (this._paused)
            return;
        this._paused = true;
        this._stopTimeline();
        this._snapAllToMin();
    }
    resume() {
        if (!this._paused)
            return;
        this._paused = false;
        this._currentScales = [];
        this._velocity = [];
        this._smoothX = null;
    }
    start() {
        // The animation loop only runs while the pointer is over the dock or icons are still settling.
        for (const sig of ["enter-event", "motion-event", "leave-event"])
            this._signals.connect(this._container, sig, () => {
                this._kick();
                return Clutter.EVENT_PROPAGATE;
            });
    }
    stop() {
        this._signals.disconnectAll();
        this._stopTimeline();
        this._paused = false;
        this._snapAllToMin();
    }
    _kick() {
        if (!this._enabled || this._paused || this._timeline)
            return;
        // Frame-synced timeline (runs on the actor's frame clock, so no timer jitter).
        const tl = new Clutter.Timeline({ actor: this._container, duration: 3600000 });
        tl.set_repeat_count(-1);
        this._lastMs = 0;
        tl.connect("new-frame", (_t: Clutter.Timeline, ms: number) => {
            const dt = this._lastMs ? Math.min(0.05, (ms - this._lastMs) / 1000) : 1 / 60;
            this._lastMs = ms;
            this._tick(dt);
        });
        this._timeline = tl;
        tl.start();
    }
    _stopTimeline() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
    }
    _tick(dt: number) {
        if (!this._enabled || this._paused || !this._container.visible) {
            this._stopTimeline();
            return;
        }
        const children = (this._container.get_children() as InstanceType<typeof St.BoxLayout>[]);
        if (children.length === 0) {
            this._stopTimeline();
            return;
        }
        const [px, py] = global.get_pointer();
        const [dx, dy] = this._container.get_position();
        const [, dh] = this._container.get_size();
        const rawX = px - dx;
        // The bump trails the pointer a little, so scaling glides instead of snapping from icon to icon.
        this._smoothX = this._smoothX === null ? rawX : this._smoothX + (rawX - this._smoothX) * (1 - Math.exp(-POINTER_RATE * dt));
        const localX = this._smoothX;
        const localY = py - dy;
        let pointerNear = localY >= -40 && localY <= dh + 20;
        const widths: number[] = [];
        const centers: number[] = [];
        let nearest = Infinity;
        for (const child of children) {
            // Pivot on the icon's own bottom edge so every baseline stays level.
            let pivotY = this._pivotY;
            if (pivotY === 1.0) {
                const first = child.get_first_child?.() as InstanceType<typeof St.Widget> | null;
                const h = child.get_height();
                if (first && h > 0)
                    pivotY = Math.min(1.0, first.get_height() / h);
            }
            const pp = child.get_pivot_point();
            if (pp[0] !== this._pivotX || Math.abs(pp[1] - pivotY) > 0.001)
                child.set_pivot_point(this._pivotX, pivotY);
            const [cx] = child.get_position();
            const [cw] = child.get_size();
            widths.push(cw);
            centers.push(cx + cw / 2);
            nearest = Math.min(nearest, Math.abs(localX - (cx + cw / 2)));
        }
        if (nearest > this._falloffDistance * 1.5)
            pointerNear = false;
        while (this._currentScales.length < children.length)
            this._currentScales.push(MIN_SCALE);
        // Each icon's scale is a damped spring toward its target (frame-rate independent sub-steps).
        while (this._velocity.length < children.length) this._velocity.push(0);
        const sigma = this._falloffDistance * 0.62;
        let settled = true;
        const steps = Math.max(1, Math.ceil(dt / 0.008));
        const h = dt / steps;
        for (let i = 0; i < children.length; i++) {
            let target = MIN_SCALE;
            if (pointerNear) {
                const d = Math.abs(centers[i] - localX);
                target = MIN_SCALE + (this._maxScale - MIN_SCALE) * Math.exp(-(d * d) / (2 * sigma * sigma));
            }
            let x = this._currentScales[i];
            let v = this._velocity[i];
            for (let k = 0; k < steps; k++) {
                v += (SPRING_K * (target - x) - SPRING_C * v) * h;
                x += v * h;
            }
            this._currentScales[i] = x;
            this._velocity[i] = v;
            if (Math.abs(x - MIN_SCALE) > 0.002 || Math.abs(v) > 0.01 || Math.abs(x - target) > 0.002) settled = false;
        }
        if (!pointerNear && settled) {
            this._snapAllToMin();
            this._stopTimeline();
            return;
        }
        this._apply(children, widths);
    }
    // Apply scales and push neighbours apart so enlarged icons never overlap; row stays centred.
    _apply(children: InstanceType<typeof St.BoxLayout>[], widths: number[]) {
        let total = 0;
        for (let i = 0; i < children.length; i++)
            total += (this._currentScales[i] - MIN_SCALE) * widths[i];
        let left = 0;
        for (let i = 0; i < children.length; i++) {
            const s = this._currentScales[i];
            const extra = (s - MIN_SCALE) * widths[i];
            children[i].scale_x = s;
            children[i].scale_y = s;
            children[i].translation_x = left + extra / 2 - total / 2;
            left += extra;
        }
        // Tell the dock how much its background must grow (width: total extra, height: tallest icon's growth).
        // Measure the real rendered top of every icon (scale, pivot and translation included),
        // so the hump always sits just above the enlarged icons whatever their padding is.
        const [, barTop] = this._container.get_transformed_position();
        let peak = 0;
        const profile: Profile[] = [];
        for (let i = 0; i < children.length; i++) {
            const [, top] = children[i].get_transformed_position();
            const h = Math.max(0, barTop - top);
            peak = Math.max(peak, h);
            profile.push({
                x: children[i].get_position()[0] + widths[i] / 2 + children[i].translation_x,
                w: widths[i] * this._currentScales[i],
                h,
            });
        }
        this._onExtent?.(total, peak, profile);
    }
    _snapAllToMin() {
        for (const child of (this._container.get_children() as InstanceType<typeof St.BoxLayout>[])) {
            child.scale_x = MIN_SCALE;
            child.scale_y = MIN_SCALE;
            child.translation_x = 0;
        }
        this._currentScales = [];
        this._velocity = [];
        this._smoothX = null;
        this._onExtent?.(0, 0, []);
    }
}
