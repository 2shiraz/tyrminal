// Motion helpers: short,
// transform and opacity only, and nothing at all under reduced motion (the OS setting or the
// in-app switch). CSS handles what it can (styles/global.css); these cover what CSS cannot see:
// an element about to be removed, and an element that moved.
import { type RefObject, useLayoutEffect, useRef } from "react";

import { motionMs, openedBy } from "./inputModality";

export const EXIT_MS = 100;
const MAX_FLIP_ITEMS = 300;
/** How many rows may come or go before a change just snaps. */
const MAX_CHANGED = 2;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
/** Rows of an arriving list that come in one after another; later rows arrive with the last of them. */
const MAX_STAGGERED = 6;

export function motionAllowed(): boolean {
  if (document.documentElement.dataset.reduceMotion === "true") return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Plays a short exit (fade and shrink) on `element`, then calls `done`. Without motion, or when
 * the element is gone, `done` runs at once. Used for pointer-initiated removals only: keyboard
 * actions never wait on an animation.
 */
export function animateOut(element: HTMLElement | null | undefined, done: () => void, transform = "scale(0.92)"): void {
  if (!element || !motionAllowed() || typeof element.animate !== "function") {
    done();
    return;
  }
  const animation = element.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform }], { duration: EXIT_MS, easing: EASE_OUT, fill: "forwards" });
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    done();
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
}

/** A one-time 400 ms tint over `element`, for a row that was just saved. */
export function flashSaved(element: HTMLElement | null | undefined): void {
  if (!element || !motionAllowed()) return;
  element.removeAttribute("data-saved-flash");
  // Restart the animation even when the same row saves twice in a row.
  void element.offsetWidth;
  element.setAttribute("data-saved-flash", "");
  window.setTimeout(() => element.removeAttribute("data-saved-flash"), 450);
}

/**
 * FLIP for the children of `container` that carry `data-flip-key`:
 * - a child that moved slides from where it was on screen to its new place (--duration-glide);
 *   a move that interrupts a slide starts from where the row is now, so nothing jumps;
 * - a child that is new rises in (--duration-fast);
 * - arriving at a list by pointer, its first rows come in one after another (--stagger apart,
 *   --duration-base each, opacity and --distance-sm only); rows past the sixth arrive with it, so
 *   a long list is never a long wait, and a row can be used while it arrives;
 * Nothing moves after keyboard input (typing in a search field re-orders rows at once), under
 * reduced motion, or for very long lists. Removals are instant (exits are lib/exitGhost.ts).
 */
export function useFlip(container: RefObject<HTMLElement | null>, { stagger = true, enter = true, evenFromKeyboard = false }: { stagger?: boolean; enter?: boolean; evenFromKeyboard?: boolean } = {}): void {
  const previous = useRef<Map<string, { left: number; top: number }> | null>(null);
  const previousRoot = useRef<HTMLElement | null>(null);
  const running = useRef(new WeakMap<HTMLElement, Animation>());
  // Whether this list element has had its arrival.
  const staggered = useRef(false);
  useLayoutEffect(() => {
    const root = container.current;
    // A different list element (say, cards swapped for a table) starts over without animating.
    if (root !== previousRoot.current) {
      previous.current = null;
      staggered.current = false;
    }
    previousRoot.current = root;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-flip-key]")];
    // Long lists are not measured on every render; they simply update in place.
    if (items.length > MAX_FLIP_ITEMS) {
      previous.current = null;
      return;
    }
    // Positions relative to the list's own content, so scrolling is not mistaken for movement.
    const box = root.getBoundingClientRect();
    const place = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - box.left + root.scrollLeft, top: r.top - box.top + root.scrollTop };
    };
    // Where each row is on screen now (a running slide included), then where layout puts it.
    const seen = new Map<HTMLElement, { left: number; top: number }>();
    for (const el of items) {
      const animation = running.current.get(el);
      if (animation && animation.playState === "running") {
        seen.set(el, place(el));
        animation.cancel();
      }
    }
    const now = new Map(items.map((el) => [el.dataset.flipKey as string, place(el)]));
    const before = previous.current;
    previous.current = now;
    const first = items.length > 0 && !staggered.current;
    if (first) staggered.current = true;
    if (!motionAllowed() || (!evenFromKeyboard && openedBy() === "keyboard")) return;

    if (first) {
      if (!stagger) return;
      const step = motionMs("--stagger");
      const duration = motionMs("--duration-base");
      const rise = getComputedStyle(document.documentElement).getPropertyValue("--distance-sm").trim() || "0px";
      if (duration === 0) return;
      items.forEach((el, index) => {
        el.animate([{ opacity: 0, transform: `translateY(${rise})` }, { opacity: 1, transform: "none" }], {
          duration,
          delay: Math.min(index, MAX_STAGGERED - 1) * step,
          easing: EASE_OUT,
          fill: "backwards",
        });
      });
      return;
    }

    if (!before) return;
    // Only small changes glide (a row added, removed or moved). A re-filter that changes many rows
    // at once snaps into place: a list of rows flying about reads as busy, not alive.
    let changed = 0;
    for (const key of now.keys()) if (!before.has(key)) changed += 1;
    for (const key of before.keys()) if (!now.has(key)) changed += 1;
    if (changed > MAX_CHANGED) return;
    const glide = motionMs("--duration-glide");
    for (const el of items) {
      const key = el.dataset.flipKey as string;
      const rect = now.get(key) as { left: number; top: number };
      const was = seen.get(el) ?? before.get(key);
      if (!was) {
        if (!enter) continue;
        el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: motionMs("--duration-fast"), easing: EASE_OUT });
        continue;
      }
      const dx = was.left - rect.left;
      const dy = was.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      running.current.set(el, el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: glide, easing: EASE_OUT }));
    }
  });
}
