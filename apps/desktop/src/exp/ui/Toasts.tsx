// Afterglow's toasts (experimental UI, branch only): swapped in for components/ui/Toasts.tsx by
// vite.exp.mjs, same exports and behaviour. Differences from main, all from the Afterglow layout:
// - a right-edge panel is found by its distance to the window edge (the content card sits a few
//   pixels in from it), and the stack keeps clear of the panel's left edge, not just its width;
// - timers also pause while the window is hidden, so a toast is never missed (Sonner's rule).
// Milestone M4 turns this into the stacked deck (plan §6.5).
import { type ReactNode, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useExit } from "../../lib/exitGhost";
import { useFlip } from "../../lib/motion";

import { IconCircleAlert, IconCircleCheck, IconInfo } from "../../components/ui/icons";

type Tone = "info" | "success" | "danger";

interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const ToastContext = createContext<(tone: Tone, text: string) => void>(() => undefined);

const ICONS = { info: IconInfo, success: IconCircleCheck, danger: IconCircleAlert };
const VISIBLE_MS = 4500;

/**
 * Transient, non-blocking notifications announced politely to assistive technology. Hovering the
 * stack pauses the timers, so a toast being read does not leave; leaving, a toast fades.
 *
 * Toasts never take a click: the stack is click-through and the hover is found by hit-testing the
 * pointer. A toast that appears over a control (Stop on a forward, Connect in Host details) would
 * otherwise pause itself as the user points at that control and cover it for as long as they do.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Per toast: its timer and when it is due, so hovering can pause and resume it.
  const timers = useRef(new Map<number, { timer: number; due: number }>());
  const paused = useRef(false);

  const dismiss = useCallback((id: number) => {
    timers.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, ms: number) => {
      timers.current.set(id, { timer: window.setTimeout(() => dismiss(id), ms), due: Date.now() + ms });
    },
    [dismiss],
  );

  const notify = useCallback(
    (tone: Tone, text: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, text }]);
      if (paused.current) timers.current.set(id, { timer: 0, due: Date.now() + VISIBLE_MS });
      else schedule(id, VISIBLE_MS);
    },
    [schedule],
  );

  const pause = useCallback(() => {
    paused.current = true;
    for (const entry of timers.current.values()) window.clearTimeout(entry.timer);
  }, []);
  const resume = useCallback(() => {
    paused.current = false;
    const now = Date.now();
    for (const [id, entry] of [...timers.current]) {
      // What was left when the pointer arrived, counted from now.
      schedule(id, Math.max(0, entry.due - now));
    }
  }, [schedule]);

  // A hidden window pauses the timers like a hover does; showing it again resumes them.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && !paused.current) pause();
      else if (!document.hidden && paused.current) resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pause, resume]);

  // The stack closes up when a toast leaves (toasts rise in through CSS, so no entrance here).
  const stackRef = useRef<HTMLDivElement>(null);
  useFlip(stackRef, { stagger: false, enter: false, evenFromKeyboard: true });

  // Hover by hit-test, while any toast is shown: the pointer over a toast pauses, off it resumes.
  const shown = toasts.length > 0;
  useEffect(() => {
    if (!shown) return;
    const over = (x: number, y: number) =>
      [...(stackRef.current?.children ?? [])].some((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
    const move = (event: PointerEvent) => {
      const inside = over(event.clientX, event.clientY);
      if (inside && !paused.current) pause();
      else if (!inside && paused.current) resume();
    };
    // Leaving the window counts as leaving the toast.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null && paused.current) resume();
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerout", out);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerout", out);
      if (paused.current) resume();
    };
  }, [shown, pause, resume]);

  // A panel along the right edge (side panels, Host details) has its own footer down there: while
  // one is open the stack sits beside it, not over it. Measured before paint, so a toast never
  // shows over the panel first.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!shown || !stack) return;
    let frame = 0;
    const sizes = new ResizeObserver(() => later());
    const measure = () => {
      frame = 0;
      let inset = 0;
      for (const panel of document.querySelectorAll<HTMLElement>(PANELS)) {
        sizes.observe(panel);
        // Layout width, not the box: a panel still sliding in is translated a few pixels.
        const r = panel.getBoundingClientRect();
        // Within the card's inset of the window edge counts as on it (Afterglow's content card).
        if (r.height > 0 && r.right > window.innerWidth - EDGE_SLACK) inset = Math.max(inset, window.innerWidth - (r.right - panel.offsetWidth));
      }
      stack.style.setProperty("--toast-inset", `${inset}px`);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    sizes.observe(document.documentElement);
    measure();
    const panels = new MutationObserver(later);
    panels.observe(document.body, { childList: true, subtree: true });
    return () => {
      panels.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [shown]);

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite" ref={stackRef}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** How close to the window's right edge a panel's right side must be to count as on that edge. */
const EDGE_SLACK = 16;

// Exit copies (lib/exitGhost.ts) are leaving: they do not hold the stack aside.
const PANELS = ":is(.side-panel, .host-panel):not([data-exit-ghost])";

function ToastItem({ toast }: { toast: Toast }) {
  // A toast times out on its own, so it fades whichever input was last.
  const exitRef = useExit<HTMLDivElement>({ evenFromKeyboard: true });
  const Icon = ICONS[toast.tone];
  return (
    <div ref={exitRef} className="toast" data-tone={toast.tone} data-flip-key={toast.id}>
      <Icon size={16} />
      <span style={{ wordBreak: "break-word" }}>
        {toast.text}
      </span>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
