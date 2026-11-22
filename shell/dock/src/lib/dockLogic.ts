// Pure dock logic: no Clutter, no GLib, no imports, so `node --test` can load it as it is (tests/island/dock*.test.js).

export type DockState =
  | "hidden"
  | "revealing"
  | "visible"
  | "magnifying"
  | "launching"
  | "dismissing";

export type DockEvent =
  | "reveal" // pointer at the edge, a window freed the dock, a drag began
  | "dismiss" // the hide delay ran out with the pointer gone
  | "settled" // the reveal/dismiss spring came to rest
  | "magnify" // the pointer is over the icons
  | "relax" // the pointer left the icons and they settled
  | "launch" // an icon was clicked and its app is starting
  | "launched"; // the app's window is up (or the bounce timed out)

export interface DockContext {
  magnifying?: boolean;
}

/**
 * state -> event -> next state. Events a state does not list keep it, so a stray event during a slide cannot wedge
 * the dock. `reveal` from `dismissing` is the cancelable dismissal: the spring is retargeted with its velocity.
 */
export const DOCK_TABLE: Record<
  DockState,
  Partial<Record<DockEvent, DockState | ((ctx: DockContext) => DockState)>>
> = {
  hidden: { reveal: "revealing" },
  revealing: { settled: "visible", dismiss: "dismissing", magnify: "magnifying" },
  visible: { magnify: "magnifying", launch: "launching", dismiss: "dismissing" },
  magnifying: { relax: "visible", launch: "launching", dismiss: "dismissing" },
  launching: {
    launched: (ctx) => (ctx.magnifying ? "magnifying" : "visible"),
    magnify: "launching",
    dismiss: "dismissing",
  },
  dismissing: { settled: "hidden", reveal: "revealing" },
};

export function nextDockState(
  state: DockState,
  event: DockEvent,
  ctx: DockContext = {},
): DockState {
  const next = DOCK_TABLE[state][event];
  if (!next) return state;
  return typeof next === "function" ? next(ctx) : next;
}

/** True while the dock is on screen or on its way there or back (what scanout holding cares about). */
export const isDockActive = (state: DockState): boolean => state !== "hidden";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Distance in px from the pointer to the monitor edge the dock lives on (0 bottom, 1 left, 2 right, 3 top). */
export function edgeDistance(monitor: Rect, edge: number, px: number, py: number): number {
  switch (edge) {
    case 1:
      return px - monitor.x;
    case 2:
      return monitor.x + monitor.width - px;
    case 3:
      return py - monitor.y;
    default:
      return monitor.y + monitor.height - py;
  }
}

/** Whether the pointer is on this monitor at all, so a neighbouring monitor never counts as "at the edge". */
export function pointerOnMonitor(monitor: Rect, px: number, py: number): boolean {
  return (
    px >= monitor.x &&
    px < monitor.x + monitor.width &&
    py >= monitor.y &&
    py < monitor.y + monitor.height
  );
}

/** Distances at which the edge brings the dock (enter) and lets go of it (leave > enter, so the boundary never flickers). */
export function edgeThresholds(showThreshold: number): { enter: number; leave: number } {
  const enter = Math.max(1, showThreshold);
  return { enter, leave: enter + Math.max(6, Math.round(enter * 0.5)) };
}

/** Maps the `animation-duration` setting (ms, what a 200 ms slide used to take) to a time-scale factor for a spring. */
export function springTimeScale(durationMs: number, referenceMs = 200): number {
  return durationMs > 0 ? referenceMs / durationMs : 1;
}

/**
 * Rise of an icon's rendered top above the dock's top edge. `restingTop` is the icon's top within the dock,
 * `pivotY` the fraction of its height it scales about. Positive when the icon pokes out above the bar.
 */
export function riseAbove(
  restingTop: number,
  translationY: number,
  height: number,
  pivotY: number,
  scale: number,
): number {
  return -(restingTop + translationY - (scale - 1) * pivotY * height);
}

/** Whether the pointer is worth an actor pick: only near the dock, where an icon can be under it. */
export function pointerNearDock(bounds: Rect, reach: number, px: number, py: number): boolean {
  return (
    px >= bounds.x - reach &&
    px <= bounds.x + bounds.width + reach &&
    py >= bounds.y - reach &&
    py <= bounds.y + bounds.height + reach
  );
}
