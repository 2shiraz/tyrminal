// Nav glides: when the current item of a list changes after a click,
// a transient indicator carrying the current item's fill and accent edge slides from the old item
// to the new one, and the new item's own marker is hidden only while it slides. The resting pixels
// are the item's own, so nothing changes at rest. Keyboard changes (arrows, shortcuts) are instant,
// as is everything under reduced motion. A second click mid-glide starts from where the indicator is.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

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

/**
 * `active` selects the current item inside the container (the current nav row by default; the
 * checked option of a segmented choice, the selected tab of a panel).
 */
export function useGlide(container: RefObject<HTMLElement | null>, className = "nav-glide", active: string = ACTIVE): void {
  const previous = useRef<{ item: HTMLElement; box: Box } | null>(null);
  const glide = useRef<{ element: HTMLElement; animation: Animation } | null>(null);

  const clear = useCallback(() => {
    const running = glide.current;
    glide.current = null;
    if (running) {
      const root = running.element.parentElement;
      running.animation.cancel();
      running.element.remove();
      if (root) delete root.dataset.gliding;
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopIfReduced = () => {
      if (media.matches || document.documentElement.dataset.reduceMotion === "true") clear();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) clear();
    };
    const observer = new MutationObserver(stopIfReduced);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    media.addEventListener("change", stopIfReduced);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clear();
      observer.disconnect();
      media.removeEventListener("change", stopIfReduced);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [clear]);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) {
      clear();
      return;
    }
    const item = root.querySelector<HTMLElement>(active);
    const was = previous.current;
    previous.current = item ? { item, box: boxIn(root, item.getBoundingClientRect()) } : null;
    const ms = motionMs("--duration-glide");
    if (!item || !was || ms <= 0 || openedBy() !== "pointer" || typeof root.animate !== "function") {
      clear();
      return;
    }
    if (was.item === item) return;

    // Start where the eye is: the indicator mid-glide, else the item that was current.
    const running = glide.current;
    const from = running ? boxIn(root, running.element.getBoundingClientRect()) : was.box;
    clear();
    const to = previous.current?.box as Box;
    if (Math.abs(from.top - to.top) < 1 && Math.abs(from.left - to.left) < 1) return;

    const element = document.createElement("span");
    element.className = className;
    element.setAttribute("aria-hidden", "true");
    Object.assign(element.style, { top: `${to.top}px`, left: `${to.left}px`, width: `${to.width}px`, height: `${to.height}px` });
    if (!element.isConnected) root.prepend(element);
    root.dataset.gliding = "";
    const animation = element.animate(
      [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }],
      { duration: ms, easing: getComputedStyle(root).getPropertyValue("--ease-out").trim() || "ease-out" },
    );
    glide.current = { element, animation };
    const finished = () => {
      if (glide.current?.animation !== animation) return;
      element.remove();
      delete root.dataset.gliding;
      glide.current = null;
    };
    animation.onfinish = finished;
    animation.oncancel = finished;
  });
}
