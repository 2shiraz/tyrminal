import { useEffect } from "react";

import { ui } from "../lib/ipc";

/**
 * Interface size. The whole web view is zoomed natively (`ui_zoom_set`), so CSS pixels grow:
 * text, spacing, the sidebar and the terminal scale together and the OS keeps rendering at full
 * resolution (xterm sees a higher devicePixelRatio and stays crisp). `--ui-scale` on the root
 * reports the factor in effect.
 */

/** The choices in Settings, in percent; `null` is Auto. Kept in step with the core's list. */
export const INTERFACE_SCALES = [90, 100, 110, 125, 150] as const;

/** The window size, in unzoomed CSS pixels, that Auto treats as 100%. */
const BASE_WIDTH = 1440;
const BASE_HEIGHT = 900;
const AUTO_MIN = 1;
const AUTO_MAX = 1.35;
const STEP = 0.05;

/** Auto: grows with the window, in steps of 5%, between 100% and 135%. */
export function autoScale(width: number, height: number): number {
  const raw = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
  const stepped = Math.floor(raw / STEP + 1e-9) * STEP;
  return Math.round(Math.min(AUTO_MAX, Math.max(AUTO_MIN, stepped)) * 100) / 100;
}

/** The factor for a preference (`null`: Auto) and a window of `width` × `height` unzoomed pixels. */
export function scaleFor(preference: number | null | undefined, width: number, height: number): number {
  return preference ? preference / 100 : autoScale(width, height);
}

/** The next manual size for Cmd/Ctrl + = or −, from the current preference (Auto counts as 100%). */
export function stepScale(preference: number | null | undefined, direction: 1 | -1): number {
  const current = preference ?? 100;
  const index = INTERFACE_SCALES.findIndex((s) => s >= current);
  const at = index === -1 ? INTERFACE_SCALES.length - 1 : index;
  const next = INTERFACE_SCALES[Math.min(INTERFACE_SCALES.length - 1, Math.max(0, at + direction))];
  return next ?? 100;
}

/** Fired on `window` after the factor changed, so terminals refit to their new cell size. */
export const UI_SCALE_EVENT = "tyrminal:ui-scale";

/** The factor in effect in this window (native zoom shrinks `innerWidth` by it). */
let applied = 1;

function apply(scale: number) {
  if (scale === applied) return;
  applied = scale;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  void ui
    .setZoom(scale)
    .catch(() => undefined)
    .finally(() => window.dispatchEvent(new Event(UI_SCALE_EVENT)));
}

/** Keeps this window's interface size in step with the preference and, for Auto, the window. */
export function useInterfaceScale(preference: number | null | undefined) {
  useEffect(() => {
    // The window's size without the zoom already applied.
    const update = () => apply(scaleFor(preference, window.innerWidth * applied, window.innerHeight * applied));
    update();
    if (preference) return;
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [preference]);
}
