// Immediate pressed feedback (docs/design/interaction-polish.md, section 1): buttons, rows and
// menu items are marked `data-pressed` on pointer down, before any click handler or render runs,
// and the CSS shows the pressed state with no transition. First used for file rows (#18).

/** A quick click stays visibly pressed for at least this long. */
export const PRESS_MS = 100;

/** Marks `element` pressed now and releases it on pointer up (after at least `PRESS_MS`). */
export function pressFeedback(element: HTMLElement) {
  const started = performance.now();
  element.dataset.pressed = "true";
  const release = () => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    const left = Math.max(0, PRESS_MS - (performance.now() - started));
    window.setTimeout(() => delete element.dataset.pressed, left);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

/** What counts as pressable: buttons and the rows, tabs, options and menu items that act like them. */
export const PRESSABLE =
  "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option'], [role='tab'], [role='row'], .host-card, .list > li, summary";

/**
 * One capture-phase listener for the whole document: the pressed state appears on the same frame
 * as the pointer goes down, whatever the component. Disabled controls are left alone.
 */
export function installPressFeedback(root: Document = document): () => void {
  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(PRESSABLE) : null;
    if (!target || target.matches(":disabled, [aria-disabled='true']")) return;
    pressFeedback(target);
  }
  root.addEventListener("pointerdown", onPointerDown, true);
  return () => root.removeEventListener("pointerdown", onPointerDown, true);
}
