// Exits (docs/design/motion.md, PR 2: "everything that appears also leaves"). When a surface
// unmounts, a static copy of it fades out in its place for --duration-exit, then goes. The real
// element is gone at once: focus, input and tests move on immediately, and the copy is inert,
// hidden from assistive technology and stripped of ids, test ids and roles. Nothing is kept
// mounted, so no component has to know it is leaving.
import { type Ref, type RefCallback, useCallback, useRef } from "react";

import { motionMs, openedBy } from "./inputModality";

// Any new interaction or mounting surface ends an older visual exit immediately.
const activeExits = new Set<() => void>();
function cancelExits(): void {
  for (const cancel of [...activeExits]) cancel();
}

export interface ExitOptions {
  /** Where the copy ends up, besides transparent (motion.md: panels drift 4 px, popovers shrink). */
  transform?: string;
  /** Leave even when the last input was the keyboard (removals no one asked for, such as a toast timing out). */
  evenFromKeyboard?: boolean;
}

/** Plays the exit for `element`, which is about to be removed. Returns at once. */
export function playExit(element: HTMLElement, options: ExitOptions = {}): void {
  // Never extend the lifetime of input/security/terminal surfaces for decoration.
  const sensitive = 'form, input, textarea, [contenteditable="true"], dialog, [role="dialog"], [role="alertdialog"], .terminal-host';
  if (element.matches(sensitive) || element.querySelector(sensitive)) return;
  const ms = motionMs("--duration-exit");
  if (ms <= 0 || !element.isConnected || typeof element.animate !== "function") return;
  if (!options.evenFromKeyboard && openedBy() === "keyboard") return;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const presentation = getComputedStyle(element);
  const opacity = presentation.opacity;
  const transform = presentation.transform;
  const origin = presentation.transformOrigin;
  const zIndex = presentation.zIndex;
  const ghost = element.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("data-testid");
    node.removeAttribute("role");
    node.removeAttribute("aria-live");
  }
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.dataset.exitGhost = "";
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: zIndex === "auto" ? "50" : zIndex,
    transformOrigin: origin,
    transition: "none",
    animation: "none",
  });
  document.body.append(ghost);
  // A lock (or anything else that takes the whole shell away) must not leave decrypted content
  // on screen, even for 100 ms: once this commit is done, a copy whose shell is gone is removed
  // before the browser paints it.
  queueMicrotask(() => {
    if (!document.querySelector(".shell")) ghost.remove();
  });
  const animation = ghost.animate([{ opacity, transform }, { opacity: 0, transform: options.transform ?? "none" }], {
    duration: ms,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    fill: "forwards",
  });
  let removed = false;
  let timeout = 0;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const observer = new MutationObserver(() => {
    if (document.documentElement.dataset.reduceMotion === "true" || !document.querySelector(".shell")) remove();
  });
  const reduced = () => {
    if (media.matches) remove();
  };
  // Any later pointer or key action ends the visual at once. The listeners are attached after the
  // current task, because the event that closed the surface is often still being dispatched (the
  // close runs in window capture, before document capture); comparing timestamps cannot tell the
  // two apart where the clock is coarse.
  const onInput = () => remove();
  let listening = false;
  const listen = window.setTimeout(() => {
    if (removed) return;
    listening = true;
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
  }, 0);
  const remove = () => {
    if (removed) return;
    removed = true;
    activeExits.delete(remove);
    ghost.remove();
    animation.cancel();
    window.clearTimeout(timeout);
    window.clearTimeout(listen);
    if (listening) {
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    }
    media.removeEventListener("change", reduced);
    observer.disconnect();
  };
  activeExits.add(remove);
  media.addEventListener("change", reduced);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
  const appRoot = document.getElementById("root");
  if (appRoot) observer.observe(appRoot, { childList: true });
  animation.onfinish = remove;
  animation.oncancel = remove;
  // Belt and braces: never leave a copy behind.
  timeout = window.setTimeout(remove, ms + 200);
}

/**
 * A callback ref that plays the exit when its element is detached. Pass `forward` to keep a ref
 * the component already had.
 */
export function useExit<T extends HTMLElement>(options: ExitOptions = {}, forward?: Ref<T>): RefCallback<T> {
  const latest = useRef(options);
  latest.current = options;
  return useCallback(
    (node: T | null) => {
      if (typeof forward === "function") forward(node);
      else if (forward) (forward as { current: T | null }).current = node;
      if (!node) return;
      cancelExits();
      return () => {
        playExit(node, latest.current);
        if (typeof forward === "function") forward(null);
        else if (forward) (forward as { current: T | null }).current = null;
      };
    },
    [forward],
  );
}
