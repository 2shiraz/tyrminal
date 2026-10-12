import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { useExit } from "../../lib/exitGhost";

import { IconCircleAlert, IconCircleCheck, IconInfo } from "./icons";

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

  const pause = () => {
    paused.current = true;
    for (const entry of timers.current.values()) window.clearTimeout(entry.timer);
  };
  const resume = () => {
    paused.current = false;
    const now = Date.now();
    for (const [id, entry] of [...timers.current]) {
      // What was left when the pointer arrived, counted from now.
      schedule(id, Math.max(0, entry.due - now));
    }
  };

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite" onPointerEnter={pause} onPointerLeave={resume}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  // A toast times out on its own, so it fades whichever input was last.
  const exitRef = useExit<HTMLDivElement>({ evenFromKeyboard: true });
  const Icon = ICONS[toast.tone];
  return (
    <div ref={exitRef} className="toast" data-tone={toast.tone}>
      <Icon size={16} />
      <span className="selectable" style={{ wordBreak: "break-word" }}>
        {toast.text}
      </span>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
