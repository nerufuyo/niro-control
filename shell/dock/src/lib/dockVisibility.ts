import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  type DockContext,
  type DockEvent,
  type DockState,
  edgeDistance,
  edgeThresholds,
  isDockActive,
  nextDockState,
  pointerNearDock,
  pointerOnMonitor,
  springTimeScale,
} from "./dockLogic.js";
import type { Intellihide, OverlapStatus } from "./intellihide.js";
import { dockSpring, edgeHysteresis, Spring } from "./motion.js";
import { SignalManager } from "./signalManager.js";
import type { WindowPreviewPopup } from "./windowPreview.js";

type Container = InstanceType<typeof St.BoxLayout>;

/**
 * Reveals the dock through a reactive screen-edge actor and hides it after a
 * debounced pointer check. While shown, the dock stays visible under the
 * pointer and while its preview or context menu is active.
 *
 * Intellihide overlap changes are routed through the pointer-position check
 * so that a maximized window behind the dock does not cause a show/hide
 * feedback loop.
 *
 * Animations use translation_x/translation_y instead of modifying the
 * container's layout-owned position, avoiding conflicts with
 * DockManager._updatePosition(). One spring (0 = off the edge, 1 = resting) is stepped from the
 * actor's frame clock, so a dismissal that is cancelled mid-slide keeps its velocity, and nothing
 * runs once the dock is at rest.
 *
 * States (dockLogic.ts): hidden, revealing, visible, magnifying, launching, dismissing.
 */
export class DockVisibility {
  private _signals: SignalManager;
  private _container: Container;
  private _intellihide: Intellihide;
  private _monitor: { x: number; y: number; width: number; height: number } | null = null;
  private _animationDuration: number;
  private _showThreshold: number;
  private _dockHeight: number;
  private _magnificationScale: number;
  private _edge: number;
  private _dockBounds: { x: number; y: number; width: number; height: number } | null = null;
  private _previewPopup: WindowPreviewPopup | null = null;
  private _contextMenuActor: InstanceType<typeof St.Widget> | null = null;
  private _edgeActivator: InstanceType<typeof St.Widget> | null = null;

  private _pointerX = 0;
  private _pointerY = 0;
  private _dragActive = false;

  private _shown = false;
  /** The Overview is open: the dock stays out of it, whatever the pointer or a window does. */
  private _overviewHidden = false;
  /** Over a full-screen app the whole screen edge brings the dock, not only the stretch in front of it. */
  private _fullEdge = false;
  /** Auto-hide proper: the dock goes away whenever the pointer leaves it. Not: only while a maximized or full-screen window covers it. */
  private _alwaysHide = true;
  /** Told when the dock starts or stops being on screen (shown, or still sliding): the manager holds back a full-screen window's
   * direct scanout meanwhile, which would otherwise carry it past the dock drawn over it. */
  private _onActiveChanged: ((active: boolean) => void) | null = null;
  private _active = false;
  /** What intellihide last said, to come back right when the Overview closes. */
  private _overlap: OverlapStatus = true;
  private _restingTranslationX = 0;
  private _restingTranslationY = 0;

  private _hideSourceId: number | null = null;
  private _pollSourceId: number | null = null;
  private _state: DockState = "hidden";
  private _magnifying = false;
  /** Slide progress: 0 = off the edge, 1 = resting. Overshoots a little on the way in. */
  private _slide = new Spring(0, "snappy", { restDistance: 0.005, restSpeed: 0.05 });
  private _slideTimeline: Clutter.Timeline | null = null;
  private _slideLastMs = 0;
  private _hiddenOffset: [number, number] = [0, 20];
  /** Whether the pointer is in the edge zone, with hysteresis (see edgeThresholds). */
  private _edgeLatched = false;

  constructor(
    container: Container,
    intellihide: Intellihide,
    dockHeight: number,
    animationDuration: number = 200,
    showThreshold: number = 25,
    edge: number = 0,
    magnificationScale: number = 1.0,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._intellihide = intellihide;
    this._animationDuration = animationDuration;
    this._showThreshold = showThreshold;
    this._dockHeight = dockHeight;
    this._magnificationScale = magnificationScale;
    this._edge = edge;
  }

  setPreviewPopup(popup: WindowPreviewPopup): void {
    this._previewPopup = popup;
  }

  setContextMenuActor(actor: InstanceType<typeof St.Widget> | null): void {
    this._contextMenuActor = actor;
  }

  /**
   * Hold the dock in its shown state while a drag-reorder is in progress so
   * the delayed auto-hide check cannot slide the dock away underneath the pointer.
   */
  setDragActive(active: boolean): void {
    if (active === this._dragActive) return;
    this._dragActive = active;
    if (active) {
      this._show();
    } else {
      this._updatePointerState();
    }
  }

  setOnActiveChanged(callback: (active: boolean) => void): void {
    this._onActiveChanged = callback;
  }

  /** Whether the dock is on screen or on its way: shown, or a slide is not finished. */
  private _notifyActive(): void {
    const active = this._shown || this._slideTimeline !== null || isDockActive(this._state);
    if (active === this._active) return;
    this._active = active;
    this._onActiveChanged?.(active);
  }

  setAlwaysHide(always: boolean): void {
    this._alwaysHide = always;
  }

  setFullEdge(full: boolean): void {
    if (full === this._fullEdge) return;
    this._fullEdge = full;
    this._updateEdgeActivatorBounds();
  }

  setEdge(edge: number): void {
    this._edge = edge;
    this._updateEdgeActivatorBounds();
  }

  updateDockBounds(x: number, y: number, width: number, height: number): void {
    this._monitor = Main.layoutManager.primaryMonitor;
    this._dockBounds = { x, y, width, height };
    this._updateEdgeActivatorBounds();
  }

  /** Slides the dock off its edge (and back) with the Overview: it is not shown by the edge zone or the pointer meanwhile. */
  setOverviewHidden(hidden: boolean): void {
    if (hidden === this._overviewHidden) return;
    this._overviewHidden = hidden;
    this._cancelHide();
    if (hidden) {
      this._shown = false;
      this._stopPointerPoll();
      this._animateVisibility(false, this._overviewDistance());
    } else if (!this._overlap) {
      this._show();
    } else {
      this._updatePointerState();
    }
  }

  isShown(): boolean {
    return this._shown;
  }

  isAnimating(): boolean {
    return this._slideTimeline !== null;
  }

  getState(): DockState {
    return this._state;
  }

  private _dispatch(event: DockEvent): void {
    const ctx: DockContext = { magnifying: this._magnifying };
    this._state = nextDockState(this._state, event, ctx);
  }

  /** The pointer is (or is no longer) over the magnified icons. */
  setMagnifying(on: boolean): void {
    this._magnifying = on;
    this._dispatch(on ? "magnify" : "relax");
  }

  /** An icon was clicked and its app is starting (true), or its window arrived / the wait ended (false). */
  setLaunching(on: boolean): void {
    this._dispatch(on ? "launch" : "launched");
  }

  isHidden(): boolean {
    return !this._shown;
  }

  updateShownY(_y: number): void {}

  updateAnimationDuration(duration: number): void {
    this._animationDuration = Math.max(0, Math.min(1000, duration));
  }

  start(): void {
    this._cancelHide();
    this._cancelAnimation();
    this._state = "hidden";
    this._magnifying = false;
    this._edgeLatched = false;
    this._slide.reset(0);

    this._monitor = Main.layoutManager.primaryMonitor;
    if (!this._monitor) {
      console.error("[dock] No primary monitor available");
      return;
    }

    this._container.visible = false;
    this._container.opacity = 0;
    this._shown = false;
    this._dragActive = false;

    this._restingTranslationX = 0;
    this._restingTranslationY = 0;
    const [offsetX, offsetY] = this._getSlideOffset();
    this._hiddenOffset = [offsetX, offsetY];
    this._container.translation_x = offsetX;
    this._container.translation_y = offsetY;

    this._edgeActivator = new St.Widget({
      name: "dock-edge-activator",
      reactive: true,
      track_hover: true,
      opacity: 0,
    });
    Main.layoutManager.addChrome(this._edgeActivator, {
      affectsStruts: false,
      trackFullscreen: false,
    });
    this._updateEdgeActivatorBounds();
    this._signals.connect(this._edgeActivator, "enter-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._show();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(
      this._edgeActivator,
      "motion-event",
      (_actor: unknown, event: unknown) => {
        const [x, y] = (event as Clutter.Event).get_coords();
        this._pointerX = x;
        this._pointerY = y;
        this._show();
        return Clutter.EVENT_PROPAGATE;
      },
    );
    this._signals.connect(this._container, "enter-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(this._container, "motion-event", (_actor: unknown, event: unknown) => {
      const [x, y] = (event as Clutter.Event).get_coords();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });
    this._signals.connect(this._container, "leave-event", () => {
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });

    this._intellihide.start((overlap: OverlapStatus) => {
      this._onIntellihideChanged(overlap);
    });

    this._signals.connect(global.stage, "motion-event", (_actor: unknown, event: unknown) => {
      const [px, py] = (event as Clutter.Event).get_coords();
      this._pointerX = px;
      this._pointerY = py;
      this._updatePointerState();
      return Clutter.EVENT_PROPAGATE;
    });

    const [x, y] = global.get_pointer();
    this._pointerX = x;
    this._pointerY = y;
    this._overlap = this._intellihide.isOverlapping();
    // Hiding only under a covering window: the dock is up until one covers it.
    if (!this._alwaysHide && !this._overlap) this._show();
    else this._updatePointerState();
  }

  stop(): void {
    this._cancelHide();
    this._stopPointerPoll();
    this._signals.disconnectAll();

    if (this._edgeActivator) {
      Main.layoutManager.removeChrome(this._edgeActivator);
      this._edgeActivator.destroy();
      this._edgeActivator = null;
    }

    this._cancelAnimation();
    this._dragActive = false;
    this._shown = false;
    this._state = "hidden";
    this._edgeLatched = false;
    this._notifyActive();

    this._container.translation_x = 0;
    this._container.translation_y = 0;
    this._container.visible = true;
    this._container.opacity = 255;
  }

  private _updatePointerState(): void {
    if (!this._monitor || this._overviewHidden) return;

    // The dock stays up for the whole duration of a drag-reorder; hiding it
    // mid-drag would pull the drop target out from under the pointer.
    if (this._dragActive) {
      this._cancelHide();
      return;
    }

    if (this._isPointerInPopupOrMenu()) {
      this._cancelHide();
      return;
    }

    if (this._isPointerInEdgeZone()) {
      this._show();
      return;
    }

    if (this._shown && this._isPointerInDockRegion()) {
      this._cancelHide();
      return;
    }

    if (this._shown && (this._alwaysHide || this._overlap)) this._scheduleHide();
  }

  private _isPointerInPopupOrMenu(): boolean {
    if (this._previewPopup?.isVisible()) {
      const bounds = this._previewPopup.getBounds();
      if (
        bounds &&
        this._pointerX >= bounds.x &&
        this._pointerX <= bounds.x + bounds.width &&
        this._pointerY >= bounds.y &&
        this._pointerY <= bounds.y + bounds.height
      ) {
        return true;
      }
    }

    if (this._contextMenuActor?.mapped) {
      const [x, y] = this._contextMenuActor.get_transformed_position();
      const [width, height] = this._contextMenuActor.get_size();
      return (
        this._pointerX >= x &&
        this._pointerX <= x + width &&
        this._pointerY >= y &&
        this._pointerY <= y + height
      );
    }

    return false;
  }

  private _isPointerInDockRegion(): boolean {
    return this._isPointerInDockBounds() || this._isPointerOverDockActor();
  }

  private _scheduleHide(): void {
    if (this._hideSourceId !== null) return;

    this._hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
      this._hideSourceId = null;
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;

      if (
        this._shown &&
        !this._dragActive &&
        !this._isPointerInPopupOrMenu() &&
        !this._isPointerInEdgeZone() &&
        !this._isPointerInDockRegion()
      ) {
        this._hide();
      }

      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelHide(): void {
    if (this._hideSourceId === null) return;

    GLib.Source.remove(this._hideSourceId);
    this._hideSourceId = null;
  }

  /**
   * Whether the pointer is inside the screen-edge activation zone.
   * The dock only shows when the pointer enters this narrow zone.
   */
  private _isPointerInEdgeZone(): boolean {
    const monitor = this._monitor;
    if (!monitor) return false;
    // Bounded to the monitor on both axes: a pointer on a neighbouring monitor, or past the end of this one, is not "at the edge".
    if (!pointerOnMonitor(monitor, this._pointerX, this._pointerY)) {
      this._edgeLatched = false;
      return false;
    }
    const { enter, leave } = edgeThresholds(this._showThreshold);
    const distance = edgeDistance(monitor, this._edge, this._pointerX, this._pointerY);
    // Hysteresis: once the dock is up the zone is a little deeper, so a pointer resting on the boundary does not flicker it.
    this._edgeLatched = edgeHysteresis(this._shown && this._edgeLatched, distance, enter, leave);
    return this._edgeLatched;
  }

  /**
   * Whether the pointer is over the dock's resting bounds extended by the
   * magnification envelope. Used to keep the dock visible while the pointer
   * is on the dock itself.
   */
  private _isPointerInDockBounds(): boolean {
    const bounds = this._dockBounds;
    if (!bounds) return false;

    const magnificationExtra = Math.max(0, this._dockHeight * (this._magnificationScale - 1));
    const alongDockExtra = magnificationExtra / 2;

    switch (this._edge) {
      case 0: {
        return (
          this._pointerX >= bounds.x - alongDockExtra &&
          this._pointerX <= bounds.x + bounds.width + alongDockExtra &&
          this._pointerY >= bounds.y - magnificationExtra &&
          this._pointerY <= bounds.y + bounds.height
        );
      }
      case 1: {
        return (
          this._pointerX >= bounds.x &&
          this._pointerX <= bounds.x + bounds.width + magnificationExtra &&
          this._pointerY >= bounds.y - alongDockExtra &&
          this._pointerY <= bounds.y + bounds.height + alongDockExtra
        );
      }
      case 2: {
        return (
          this._pointerX >= bounds.x - magnificationExtra &&
          this._pointerX <= bounds.x + bounds.width &&
          this._pointerY >= bounds.y - alongDockExtra &&
          this._pointerY <= bounds.y + bounds.height + alongDockExtra
        );
      }
      case 3: {
        return (
          this._pointerX >= bounds.x - alongDockExtra &&
          this._pointerX <= bounds.x + bounds.width + alongDockExtra &&
          this._pointerY >= bounds.y &&
          this._pointerY <= bounds.y + bounds.height + magnificationExtra
        );
      }
    }

    return false;
  }

  private _isPointerOverDockActor(): boolean {
    // An actor pick is costly and this runs on every pointer motion: only near the dock can an icon be under the pointer.
    const bounds = this._dockBounds;
    if (!bounds) return false;
    const reach = Math.max(8, this._dockHeight * Math.max(0, this._magnificationScale - 1) * 2);
    if (!pointerNearDock(bounds, reach, this._pointerX, this._pointerY)) return false;
    const actor = global.stage.get_actor_at_pos(
      Clutter.PickMode.REACTIVE,
      this._pointerX,
      this._pointerY,
    );
    return actor === this._container || (actor !== null && this._container.contains(actor));
  }

  private _updateEdgeActivatorBounds(): void {
    const monitor = this._monitor;
    const bounds = this._dockBounds;
    const activator = this._edgeActivator;
    if (!monitor || !bounds || !activator) return;

    const thickness = Math.max(2, this._showThreshold);
    // Along the edge: in front of the dock, or all of it over a full-screen app.
    const spanX = this._fullEdge ? monitor.x : bounds.x;
    const spanW = this._fullEdge ? monitor.width : bounds.width;
    const spanY = this._fullEdge ? monitor.y : bounds.y;
    const spanH = this._fullEdge ? monitor.height : bounds.height;
    switch (this._edge) {
      case 0:
        activator.set_position(spanX, monitor.y + monitor.height - thickness);
        activator.set_size(spanW, thickness);
        break;
      case 1:
        activator.set_position(monitor.x, spanY);
        activator.set_size(thickness, spanH);
        break;
      case 2:
        activator.set_position(monitor.x + monitor.width - thickness, spanY);
        activator.set_size(thickness, spanH);
        break;
      case 3:
        activator.set_position(spanX, monitor.y);
        activator.set_size(spanW, thickness);
        break;
    }
  }

  /**
   * Whether the pointer is anywhere in the interaction region (edge zone or
   * dock bounds). Used by the intellihide callback to keep the dock visible
   * while the pointer is near it.
   */
  private _isPointerInInteractionRegion(): boolean {
    return (
      this._isPointerInPopupOrMenu() || this._isPointerInEdgeZone() || this._isPointerInDockRegion()
    );
  }

  private _show(): void {
    this._cancelHide();
    if (this._shown || this._overviewHidden) return;

    this._shown = true;
    this._animateVisibility(true);
    this._notifyActive();
    this._startPointerPoll();
  }

  /**
   * While the dock is up, the pointer is read now and then: over a full-screen app's window no motion event reaches the stage, so the dock
   * would never see the pointer leave.
   */
  private _startPointerPoll(): void {
    if (this._pollSourceId !== null) return;
    this._pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      if (!this._shown) {
        this._pollSourceId = null;
        return GLib.SOURCE_REMOVE;
      }
      const [x, y] = global.get_pointer();
      this._pointerX = x;
      this._pointerY = y;
      this._updatePointerState();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _stopPointerPoll(): void {
    if (this._pollSourceId === null) return;
    GLib.Source.remove(this._pollSourceId);
    this._pollSourceId = null;
  }

  private _hide(): void {
    if (!this._shown) return;

    this._shown = false;
    this._stopPointerPoll();
    this._animateVisibility(false);
    this._notifyActive();
  }

  private _animateVisibility(show: boolean, distance?: number): void {
    this._container.visible = true;
    this._hiddenOffset = this._getSlideOffset(distance);
    this._dispatch(show ? "reveal" : "dismiss");

    // The slide time follows the animation-duration setting; with the desktop's animations off, or a zero duration, the dock jumps.
    // Coming in the spring may overshoot a little; going out it is critically damped, so a dismissal never bounces.
    const spec =
      this._animationDuration === 0
        ? null
        : dockSpring({ calm: !show, timeScale: springTimeScale(this._animationDuration) });
    if (!spec) {
      this._stopSlideTimeline();
      this._slide.reset(show ? 1 : 0);
      this._applySlide();
      this._finishVisibilityAnimation(show);
      return;
    }
    // Retargeting keeps the velocity: a dismissal cancelled halfway turns around smoothly.
    this._slide.setTarget(show ? 1 : 0, spec);
    this._startSlideTimeline();
  }

  private _startSlideTimeline(): void {
    if (this._slideTimeline) return;
    const tl = new Clutter.Timeline({ actor: this._container, duration: 3600000 });
    tl.set_repeat_count(-1);
    this._slideLastMs = 0;
    tl.connect("new-frame", (_t: Clutter.Timeline, ms: number) => {
      const dt = this._slideLastMs ? (ms - this._slideLastMs) / 1000 : 1 / 60;
      this._slideLastMs = ms;
      const rest = this._slide.step(dt);
      this._applySlide();
      if (rest) {
        this._stopSlideTimeline();
        this._finishVisibilityAnimation(this._slide.target === 1);
      }
    });
    this._slideTimeline = tl;
    tl.start();
  }

  private _stopSlideTimeline(): void {
    if (!this._slideTimeline) return;
    this._slideTimeline.stop();
    this._slideTimeline = null;
  }

  private _applySlide(): void {
    const p = this._slide.value;
    const away = 1 - p;
    this._container.translation_x = this._restingTranslationX + this._hiddenOffset[0] * away;
    this._container.translation_y = this._restingTranslationY + this._hiddenOffset[1] * away;
    this._container.opacity = Math.round(255 * Math.max(0, Math.min(1, p)));
  }

  private _finishVisibilityAnimation(show: boolean): void {
    this._container.translation_x = this._restingTranslationX + (show ? 0 : this._hiddenOffset[0]);
    this._container.translation_y = this._restingTranslationY + (show ? 0 : this._hiddenOffset[1]);
    this._container.opacity = show ? 255 : 0;
    this._container.visible = show;
    this._dispatch("settled");
    this._notifyActive();
  }

  private _cancelAnimation(): void {
    this._stopSlideTimeline();
  }

  /** How far the dock goes to be fully off its edge: its own thickness and a little more. */
  private _overviewDistance(): number {
    const along =
      this._edge === 1 || this._edge === 2 ? this._container.width : this._container.height;
    return Math.max(60, Math.ceil(along * this._magnificationScale) + 24);
  }

  private _getSlideOffset(slideDistance = 20): [number, number] {
    switch (this._edge) {
      case 0:
        return [0, slideDistance];
      case 1:
        return [-slideDistance, 0];
      case 2:
        return [slideDistance, 0];
      case 3:
        return [0, -slideDistance];
    }
    return [0, slideDistance];
  }

  private _onIntellihideChanged(overlap: OverlapStatus): void {
    this._overlap = overlap;
    if (this._dragActive || this._overviewHidden) return;

    if (!overlap) {
      this._show();
      return;
    }

    if (this._shown && !this._isPointerInInteractionRegion()) {
      this._scheduleHide();
    }
  }
}
