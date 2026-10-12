// Nav glides (docs/design/motion.md, PR 3): when the current item of a list changes after a click,
// a transient indicator carrying the current item's fill and accent edge slides from the old item
// to the new one, and the new item's own marker is hidden only while it slides. The resting pixels
// are the item's own, so nothing changes at rest. Keyboard changes (arrows, shortcuts) are instant,
// as is everything under reduced motion. A second click mid-glide starts from where the indicator is.
import { type RefObject, useLayoutEffect, useRef } from "react";

import { motionMs, openedBy } from "./inputModality";

const ACTIVE = '[aria-current="page"]';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function boxIn(container: HTMLElement, rect: DOMRect): Box {
  const c = container.getBoundingClientRect();
  return { top: rect.top - c.top + container.scrollTop, left: rect.left - c.left + container.scrollLeft, width: rect.width, height: rect.height };
}

export function useGlide(container: RefObject<HTMLElement | null>, className = "nav-glide"): void {
  const previous = useRef<{ item: HTMLElement; box: Box } | null>(null);
  const glide = useRef<{ element: HTMLElement; animation: Animation } | null>(null);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const item = root.querySelector<HTMLElement>(ACTIVE);
    const was = previous.current;
    previous.current = item ? { item, box: boxIn(root, item.getBoundingClientRect()) } : null;
    if (!item || !was || was.item === item) return;
    const ms = motionMs("--duration-glide");
    if (ms <= 0 || openedBy() !== "pointer" || typeof root.animate !== "function") return;

    // Start where the eye is: the indicator mid-glide, else the item that was current.
    const running = glide.current;
    const from = running ? boxIn(root, running.element.getBoundingClientRect()) : was.box;
    running?.animation.cancel();
    const to = previous.current?.box as Box;
    if (Math.abs(from.top - to.top) < 1 && Math.abs(from.left - to.left) < 1) return;

    const element = running?.element ?? document.createElement("span");
    element.className = className;
    element.setAttribute("aria-hidden", "true");
    Object.assign(element.style, { top: `${to.top}px`, left: `${to.left}px`, width: `${to.width}px`, height: `${to.height}px` });
    if (!element.isConnected) root.prepend(element);
    root.dataset.gliding = "";
    const animation = element.animate(
      [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }],
      { duration: ms, easing: getComputedStyle(root).getPropertyValue("--ease-in-out").trim() || "ease-in-out" },
    );
    glide.current = { element, animation };
    animation.onfinish = () => {
      if (glide.current?.animation !== animation) return;
      element.remove();
      delete root.dataset.gliding;
      glide.current = null;
    };
  });
}
