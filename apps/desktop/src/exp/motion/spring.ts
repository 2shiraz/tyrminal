// Afterglow's gesture springs (experimental UI, branch only). A spring from the shared table
// (springs.json → springs.ts) played as a Web Animation on `transform`, so it runs on the
// compositor while the main thread is busy, and that can start with the velocity a drag left off
// with (apple-design §5: no seam between the finger and the animation).
//
// Motion's physics, the same as the CSS curves: stiffness = (2π / (1.2 · visualDuration))²,
// damping = 2 · clamp(0.05, 1, 1 − bounce) · √stiffness, mass 1. The curve is simulated from the
// current position and velocity, sampled into keyframes, and cut at the table's duration (main's
// motion rules cap a running animation at 220 ms); the last frame is the target.
import { motionMs } from "../../lib/inputModality";
import { SPRINGS } from "./springs";

export type SpringName = keyof typeof SPRINGS;

/** Positions (px) along the spring from `from` to `to`, one per frame at 120 Hz. */
export function springPath(name: SpringName, from: number, to: number, velocity = 0): number[] {
  const spec = SPRINGS[name];
  const stiffness = ((2 * Math.PI) / (spec.visualDuration * 1.2)) ** 2;
  const damping = 2 * Math.min(1, Math.max(0.05, 1 - spec.bounce)) * Math.sqrt(stiffness);
  const frames = Math.max(2, Math.round((spec.duration / 1000) * 120));
  const dt = 1 / 120;
  const sub = 8;
  let x = from - to;
  let v = velocity * 1000; // px/ms → px/s
  const out = [from];
  for (let f = 1; f < frames; f += 1) {
    for (let i = 0; i < sub; i += 1) {
      const a = -stiffness * x - damping * v;
      v += (a * dt) / sub;
      x += (v * dt) / sub;
    }
    out.push(to + x);
  }
  out.push(to);
  return out;
}

/**
 * Springs `el`'s translateX from `from` to `to` (px), starting at `velocity` px/ms. Resolves when
 * it lands. Under reduced motion it simply arrives. The final transform is written to the element,
 * so nothing snaps when the animation is removed.
 */
export function springX(el: HTMLElement, name: SpringName, from: number, to: number, velocity = 0): Promise<void> {
  const ms = motionMs(`--spring-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-duration`);
  el.style.transform = to === 0 ? "" : `translateX(${to}px)`;
  if (ms <= 0 || typeof el.animate !== "function") return Promise.resolve();
  const path = springPath(name, from, to, velocity);
  const animation = el.animate(
    path.map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: SPRINGS[name].duration, easing: "linear" },
  );
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** Apple's momentum projection: where a flick at `velocity` px/ms comes to rest (d = 0.998). */
export function project(velocity: number, deceleration = 0.998): number {
  return ((velocity * 1000) / 1000) * (deceleration / (1 - deceleration));
}

/** Rubber band past a boundary: the further past, the less the element follows (constant 0.55). */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
