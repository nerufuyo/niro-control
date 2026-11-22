// @ts-nocheck: bridges the plain-JS shared motion engine, installed next to dist as <extension>/shared/motionEngine.js
// (packaging/build.sh and tests/shell/stage.sh). From dist/lib/ that is ../shared/motionEngine.js.
import St from "gi://St";
import {
  Animator as EngineAnimator,
  Spring as EngineSpring,
  criticallyDamped as engineCritical,
  gaussianScale as engineGaussian,
  edgeHysteresis as engineHysteresis,
  springFor as engineSpringFor,
} from "../shared/motionEngine.js";

export const Spring = EngineSpring;
export const Animator = EngineAnimator;
export const gaussianScale: (d: number, amplitude: number, sigma: number) => number =
  engineGaussian;
export const edgeHysteresis: (
  visible: boolean,
  dist: number,
  enter: number,
  leave: number,
) => boolean = engineHysteresis;
export const criticallyDamped = engineCritical;

/** The desktop's own switch (Settings > Accessibility > Reduce animation, or enable-animations). */
export function animationsEnabled(): boolean {
  try {
    return St.Settings.get().enable_animations !== false;
  } catch {
    return true;
  }
}

/** Spring for a dock transition: dock personality, critically damped when `calm`, null (jump) with animations off. */
export function dockSpring(opts: { calm?: boolean; timeScale?: number } = {}) {
  const base = engineSpringFor("dock", { reduced: !!opts.calm, off: !animationsEnabled() });
  if (!base) return null;
  const f = opts.timeScale ?? 1;
  // Scaling time by f: k*f^2, c*f keeps the damping ratio and makes the whole motion f times quicker.
  return { stiffness: base.stiffness * f * f, damping: base.damping * f, mass: base.mass };
}
