// Motion helpers (docs/design/interaction-polish.md §4, docs/design/overhaul.md "Motion"): short,
// transform and opacity only, and nothing at all under reduced motion (the OS setting or the
// in-app switch). CSS handles what it can (styles/global.css); these cover what CSS cannot see:
// an element about to be removed, and an element that moved.
import { type RefObject, useLayoutEffect, useRef } from "react";

export const ENTER_MS = 140;
export const EXIT_MS = 100;
export const MOVE_MS = 160;
const MAX_FLIP_ITEMS = 300;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

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
 * FLIP for the children of `container` that carry `data-flip-key`: a child that moved since the
 * last render slides from its old place to the new one, a child that is new fades in. Nothing
 * animates on the first render (page load) or under reduced motion; removals are instant.
 */
export function useFlip(container: RefObject<HTMLElement | null>): void {
  const previous = useRef<Map<string, { left: number; top: number }> | null>(null);
  const previousRoot = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    // A different list element (say, cards swapped for a table) starts over without animating.
    if (root !== previousRoot.current) previous.current = null;
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
    const now = new Map(items.map((el) => [el.dataset.flipKey as string, place(el)]));
    const before = previous.current;
    previous.current = now;
    if (!before || !motionAllowed()) return;
    for (const el of items) {
      const key = el.dataset.flipKey as string;
      const was = before.get(key);
      const rect = now.get(key) as { left: number; top: number };
      if (!was) {
        el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: ENTER_MS, easing: EASE_OUT });
        continue;
      }
      const dx = was.left - rect.left;
      const dy = was.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: EASE_OUT });
    }
  });
}
