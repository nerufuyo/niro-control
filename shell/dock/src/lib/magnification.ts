import Clutter from "gi://Clutter";
import type St from "gi://St";
import { riseAbove } from "./dockLogic.js";
import { animationsEnabled, gaussianScale, Spring } from "./motion.js";
import { SignalManager } from "./signalManager.js";

const MIN_SCALE = 1.0;
type Profile = { x: number; w: number; h: number };
// Per-icon scale spring: damping below 2*sqrt(K) ~ 26 leaves a small, natural overshoot (the playful part of the dock).
const ICON_SPRING = { stiffness: 170, damping: 17, mass: 1 };
const HUMP_SHARE = 2 / 3;
const POINTER_RATE = 22; // 1/s: how fast the magnified bump follows the pointer
export class Magnification {
  _signals: SignalManager;
  _container: InstanceType<typeof St.BoxLayout>;
  _enabled: boolean;
  _maxScale: number;
  _falloffDistance: number;
  _timeline: Clutter.Timeline | null = null;
  _lastMs = 0;
  _pivotsNow: number[] = [];
  _springs: InstanceType<typeof Spring>[] = [];
  _active = false;
  _onActivity: ((active: boolean) => void) | null = null;
  _smoothX: number | null = null;
  _currentScales: number[] = [];
  _pivotX = 0.5;
  _pivotY = 1.0;
  _paused = false;
  _onExtent: ((width: number, height: number, profile: Profile[]) => void) | null = null;
  constructor(
    container: InstanceType<typeof St.BoxLayout>,
    enabled: boolean,
    maxScale: number,
    falloffDistance = 100,
    _framerate = 60,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._enabled = enabled;
    this._maxScale = maxScale;
    this._falloffDistance = falloffDistance;
  }
  setEnabled(enabled: boolean) {
    this._enabled = enabled;
    if (!enabled) this._snapAllToMin();
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
  /** Told when the pointer starts or stops being over the icons (the dock's Magnifying state). */
  setOnActivity(cb: (active: boolean) => void) {
    this._onActivity = cb;
  }
  _setActive(active: boolean) {
    if (active === this._active) return;
    this._active = active;
    this._onActivity?.(active);
  }
  setFramerate(_fps: number) {
    /* animation now follows the compositor's frame clock */
  }
  setPivotPoint(x: number, y: number) {
    this._pivotX = x;
    this._pivotY = y;
  }
  pause() {
    if (this._paused) return;
    this._paused = true;
    this._stopTimeline();
    this._snapAllToMin();
  }
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._springs = [];
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
    if (!this._enabled || this._paused || this._timeline) return;
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
    const children = this._container.get_children() as InstanceType<typeof St.BoxLayout>[];
    if (children.length === 0) {
      this._stopTimeline();
      return;
    }
    const [px, py] = global.get_pointer();
    const [dx, dy] = this._container.get_position();
    const [, dh] = this._container.get_size();
    const rawX = px - dx;
    // The bump trails the pointer a little, so scaling glides instead of snapping from icon to icon.
    this._smoothX =
      this._smoothX === null
        ? rawX
        : this._smoothX + (rawX - this._smoothX) * (1 - Math.exp(-POINTER_RATE * dt));
    const localX = this._smoothX;
    const localY = py - dy;
    let pointerNear = localY >= -40 && localY <= dh + 20;
    const widths: number[] = [];
    const centers: number[] = [];
    const pivots: number[] = [];
    let nearest = Infinity;
    for (const child of children) {
      // Pivot on the icon's own bottom edge so every baseline stays level.
      let pivotY = this._pivotY;
      if (pivotY === 1.0) {
        const first = child.get_first_child?.() as InstanceType<typeof St.Widget> | null;
        const h = child.get_height();
        if (first && h > 0) pivotY = Math.min(1.0, first.get_height() / h);
      }
      const pp = child.get_pivot_point();
      if (pp[0] !== this._pivotX || Math.abs(pp[1] - pivotY) > 0.001)
        child.set_pivot_point(this._pivotX, pivotY);
      pivots.push(pivotY);
      const [cx] = child.get_position();
      const [cw] = child.get_size();
      widths.push(cw);
      centers.push(cx + cw / 2);
      nearest = Math.min(nearest, Math.abs(localX - (cx + cw / 2)));
    }
    if (nearest > this._falloffDistance * 1.5) pointerNear = false;
    this._pivotsNow = pivots;
    this._setActive(pointerNear);
    // Each icon's scale is a damped spring toward its Gaussian target. With animations off the scale jumps; with
    // the desktop's reduce-animation switch the scales follow the pointer without a spring.
    const animate = animationsEnabled();
    const spec = ICON_SPRING;
    while (this._springs.length < children.length) this._springs.push(new Spring(MIN_SCALE, spec));
    this._springs.length = children.length;
    const sigma = this._falloffDistance * 0.62;
    let settled = true;
    for (let i = 0; i < children.length; i++) {
      const spring = this._springs[i];
      const target = pointerNear
        ? gaussianScale(Math.abs(centers[i] - localX), this._maxScale - MIN_SCALE, sigma)
        : MIN_SCALE;
      spring.setTarget(target, spec);
      if (animate) spring.step(dt);
      else spring.reset(target);
      this._currentScales[i] = spring.value;
      if (!spring.settled || Math.abs(spring.value - MIN_SCALE) > 0.002) settled = false;
    }
    if (!pointerNear && settled) {
      this._snapAllToMin();
      this._stopTimeline();
      return;
    }
    // The bar's growth is the same wherever the pointer is: what the bell would add in the middle of the row.
    // Where fewer neighbours are magnified (the ends), the slack is spread evenly over the gaps instead.
    const mid = Math.floor(children.length / 2);
    let ideal = 0;
    for (let i = 0; i < children.length; i++) {
      const d = centers[i] - centers[mid];
      ideal += (this._maxScale - MIN_SCALE) * widths[i] * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    let peakScale = MIN_SCALE;
    for (const sc of this._currentScales) peakScale = Math.max(peakScale, sc);
    const progress = Math.max(
      0,
      Math.min(1, (peakScale - MIN_SCALE) / (this._maxScale - MIN_SCALE)),
    );
    this._apply(children, widths, ideal * progress);
  }
  // Apply scales and push neighbours apart so enlarged icons never overlap; row stays centred.
  _apply(children: InstanceType<typeof St.BoxLayout>[], widths: number[], growth = 0) {
    let total = 0;
    for (let i = 0; i < children.length; i++)
      total += (this._currentScales[i] - MIN_SCALE) * widths[i];
    const barGrowth = Math.max(growth, total);
    const slack = barGrowth - total;
    let left = 0;
    for (let i = 0; i < children.length; i++) {
      const s = this._currentScales[i];
      const extra = (s - MIN_SCALE) * widths[i];
      children[i].scale_x = s;
      children[i].scale_y = s;
      const stretch = slack * ((i + 0.5) / children.length - 0.5);
      children[i].translation_x = left + extra / 2 - total / 2 + stretch;
      left += extra;
    }
    // Tell the dock how much its background must grow (width: total extra, height: tallest icon's growth).
    // Measure the real rendered top of every icon (scale, pivot and translation included),
    // so the hump always sits just above the enlarged icons whatever their padding is.
    // Plain geometry (each icon's position, height, pivot and scale) rather than get_transformed_position, which
    // walks the whole actor tree for every icon on every frame.
    let peak = 0;
    const profile: Profile[] = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const rise = riseAbove(
        child.get_position()[1],
        child.translation_y,
        child.get_height(),
        this._pivotsNow[i] ?? this._pivotY,
        this._currentScales[i],
      );
      // The hump reaches 2/3 of the way up what pokes out above the bar: the icon's top third stands free.
      const h = HUMP_SHARE * Math.max(0, rise);
      peak = Math.max(peak, h);
      profile.push({
        x: children[i].get_position()[0] + widths[i] / 2 + children[i].translation_x,
        w: widths[i] * this._currentScales[i],
        h,
      });
    }
    this._onExtent?.(barGrowth, peak, profile);
  }
  _snapAllToMin() {
    for (const child of this._container.get_children() as InstanceType<typeof St.BoxLayout>[]) {
      child.scale_x = MIN_SCALE;
      child.scale_y = MIN_SCALE;
      child.translation_x = 0;
    }
    this._currentScales = [];
    this._springs = [];
    this._smoothX = null;
    this._setActive(false);
    this._onExtent?.(0, 0, []);
  }
}
