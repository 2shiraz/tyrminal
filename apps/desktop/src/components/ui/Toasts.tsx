import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

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

/** Transient, non-blocking notifications announced politely to assistive technology. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((tone: Tone, text: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), VISIBLE_MS);
  }, []);

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <div key={toast.id} className="toast" data-tone={toast.tone}>
              <Icon size={16} />
              <span className="selectable" style={{ wordBreak: "break-word" }}>
                {toast.text}
              </span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
