import type { SnippetSummary } from "@tyrminal/contracts";
import { useEffect, useRef } from "react";

import { IconButton, Shortcut } from "../../components/ui/controls";
import { IconPanelRightClose } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { SnippetLibrary, type SnippetTarget, TargetIndicator } from "./SnippetLibrary";

/** Collapsible side panel beside the terminal. Everything in it is gone after a lock. */
export function SnippetsPanel({
  target,
  onSend,
  onClose,
}: {
  target: SnippetTarget | null;
  onSend: (snippet: SnippetSummary, mode: "paste" | "run") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);

  // Opening the panel from the keyboard moves focus into it (to its search field).
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, []);

  return (
    <aside
      ref={ref}
      className="side-panel"
      aria-label={msg.snippets.panel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("dialog")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{msg.snippets.panel}</h2>
        <Shortcut action="toggleSnippets" />
        <IconButton label={msg.snippets.close} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>
      <div style={{ paddingTop: "var(--space-3)" }}>
        <TargetIndicator target={target} />
      </div>
      <div className="panel-body" style={{ paddingTop: 0 }}>
        <SnippetLibrary target={target} onSend={onSend} compact />
      </div>
    </aside>
  );
}
