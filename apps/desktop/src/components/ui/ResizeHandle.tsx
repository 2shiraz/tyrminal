import type { PanelWidths } from "@tyrminal/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { usePreferences } from "../../app/preferences";
import { msgResize } from "../../lib/messages-resize";
import { setPanelResizing } from "../../lib/resizing";

export type PanelId = keyof PanelWidths;

interface PanelSpec {
  /** Width range in CSS pixels; the core clamps stored widths to the same range
   *  (crates/core/src/preferences.rs `PANEL_WIDTH_RANGES`). */
  min: number;
  max: number;
  /** Space kept for the rest of the container (the terminals, the host list): the window clamp. */
  reserve: number;
  /** The custom property the panel's CSS width reads, set on the container. */
  cssVar: string;
  /** The nearest ancestor that holds the panel and its neighbour. */
  container: string;
  /** +1: the handle is on the panel's right edge (dragging right widens); -1: on its left edge. */
  dir: 1 | -1;
  defaultWidth: (container: HTMLElement) => number;
}

export const PANELS: Record<PanelId, PanelSpec> = {
  sidebar: { min: 180, max: 360, reserve: 560, cssVar: "--w-sidebar", container: ".shell", dir: 1, defaultWidth: () => 224 },
  sidePanel: { min: 260, max: 640, reserve: 320, cssVar: "--w-side-panel", container: ".workspace", dir: -1, defaultWidth: () => 320 },
  files: { min: 320, max: 800, reserve: 320, cssVar: "--w-files", container: ".workspace", dir: -1, defaultWidth: () => 380 },
  filesTwoPane: {
    min: 560,
    max: 1400,
    reserve: 240,
    cssVar: "--w-files-two",
    container: ".workspace",
    dir: -1,
    defaultWidth: () => Math.min(880, Math.round(window.innerWidth * 0.7)),
  },
  hostPanel: { min: 340, max: 720, reserve: 360, cssVar: "--w-host-panel", container: ".hosts-layout", dir: -1, defaultWidth: () => 400 },
  sftpSplit: {
    min: 280,
    max: 4000,
    reserve: 281,
    cssVar: "--w-sftp-left",
    container: ".sftp-panes",
    dir: 1,
    defaultWidth: (c) => Math.round((c.clientWidth - 1) / 2),
  },
};

/** Arrow keys move the edge by this much. */
const STEP = 16;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * The draggable inner edge of a panel: a 6 px hit area with a hairline that turns accent on hover,
 * focus and drag. It is a focusable separator (arrows step 16 px, Home and End go to the ends,
 * double-click resets). The width lives in a custom property on the panel's container, written
 * once per animation frame during a drag without a React render, and is saved in preferences
 * when the drag ends.
 */
export function ResizeHandle({ panel, className }: { panel: PanelId; className?: string }) {
  const { prefs, update } = usePreferences();
  const spec = PANELS[panel];
  const ref = useRef<HTMLDivElement>(null);
  const stored = prefs.panelWidths?.[panel];
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const drag = useRef<{ startX: number; startWidth: number; width: number; moved: boolean; frame: number } | null>(null);

  const container = useCallback(() => ref.current?.parentElement?.closest<HTMLElement>(spec.container) ?? null, [spec]);

  const bounds = useCallback(() => {
    const c = container();
    // A hidden container measures 0: clamp to the window until it is shown.
    const available = c && c.clientWidth > 0 ? c.clientWidth : window.innerWidth;
    const max = Math.max(spec.min, Math.min(spec.max, available - spec.reserve));
    return { min: spec.min, max, fallback: c ? spec.defaultWidth(c) : spec.min };
  }, [container, spec]);

  const apply = useCallback(
    (width: number) => {
      const c = container();
      const el = ref.current;
      if (!c || !el) return;
      const { min, max } = bounds();
      c.style.setProperty(spec.cssVar, `${width}px`);
      el.setAttribute("aria-valuenow", String(width));
      el.setAttribute("aria-valuemin", String(min));
      el.setAttribute("aria-valuemax", String(max));
    },
    [bounds, container, spec],
  );

  const current = useCallback(() => {
    const { min, max, fallback } = bounds();
    return clamp(Math.round(storedRef.current ?? fallback), min, max);
  }, [bounds]);

  const save = useCallback(
    (width: number | undefined) =>
      update((p) => {
        const next: PanelWidths = { ...p.panelWidths };
        if (width === undefined) delete next[panel];
        else next[panel] = width;
        return { ...p, panelWidths: next };
      }),
    [panel, update],
  );

  // Before paint, so the panel never shows at another width first.
  // `stored` is read through storedRef; listing it re-applies a changed width.
  useLayoutEffect(() => {
    if (!drag.current) apply(current());
  }, [apply, current, stored]);

  // The window (or the space beside the panel) changed: clamp again.
  useEffect(() => {
    const c = container();
    if (!c) return;
    const observer = new ResizeObserver(() => {
      if (!drag.current) apply(current());
    });
    observer.observe(c);
    return () => {
      observer.disconnect();
      const d = drag.current;
      if (d) {
        cancelAnimationFrame(d.frame);
        drag.current = null;
        setPanelResizing(false);
      }
    };
  }, [apply, container, current]);

  function end() {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    apply(d.width);
    ref.current?.removeAttribute("data-active");
    setPanelResizing(false);
    if (!d.moved) return;
    storedRef.current = d.width;
    save(d.width);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = current();
    drag.current = { startX: event.clientX, startWidth: width, width, moved: false, frame: 0 };
    event.currentTarget.setAttribute("data-active", "true");
    setPanelResizing(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const { min, max } = bounds();
    const width = clamp(Math.round(d.startWidth + spec.dir * (event.clientX - d.startX)), min, max);
    if (width === d.width) return;
    d.width = width;
    d.moved = true;
    if (!d.frame)
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        apply(d.width);
      });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const { min, max } = bounds();
    const now = current();
    let width: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") width = now + (event.key === "ArrowRight" ? STEP : -STEP) * spec.dir;
    else if (event.key === "Home") width = min;
    else if (event.key === "End") width = max;
    else return;
    event.preventDefault();
    width = clamp(width, min, max);
    if (width === now) return;
    storedRef.current = width;
    apply(width);
    save(width);
  }

  function reset() {
    storedRef.current = undefined;
    apply(current());
    save(undefined);
  }

  return (
    // aria-valuenow/min/max are written imperatively (apply), so a drag never re-renders.
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={msgResize[panel]}
      tabIndex={0}
      className={`resize-handle${className ? ` ${className}` : ""}`}
      data-panel={panel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}
