import { useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { IconRadio } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { msgI } from "../../lib/messages-input";
import { msgProduction } from "../../lib/messages-production";

export interface BroadcastTarget {
  paneId: number;
  /** The session the user reviewed; broadcast starts only if every pane still has this one. */
  sessionId: string;
  label: string;
  identity: string;
}

/**
 * Shows exactly which panes will receive typed input before broadcast starts (P-13). Every pane
 * is listed; the user can leave some out (at least two must stay). The safe choice has initial
 * focus; nothing is enabled until the user confirms this list.
 */
export function BroadcastReview({
  targets,
  production,
  onConfirm,
  onCancel,
}: {
  targets: BroadcastTarget[];
  /** Panes connected to a production host (P-26), marked in the list. */
  production?: ReadonlyMap<number, string>;
  /** The panes the user kept. */
  onConfirm: (chosen: ReadonlySet<number>) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set(targets.map((t) => t.paneId)));
  const count = chosen.size;
  const left = targets.length - count;
  const toggle = (paneId: number, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(paneId);
      else next.delete(paneId);
      return next;
    });
  return (
    <Dialog title={msgC.broadcast.title(count)} icon={<IconRadio size={18} />} tone="warning" role="alertdialog" onDismiss={onCancel}>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msgC.broadcast.body}
      </p>
      <ul className="broadcast-targets" aria-label={msgC.broadcast.listLabel}>
        {targets.map((t) => (
          <li key={t.paneId} data-excluded={!chosen.has(t.paneId) || undefined}>
            <input type="checkbox" aria-label={msgI.broadcast.include(t.label)} checked={chosen.has(t.paneId)} onChange={(e) => toggle(t.paneId, e.target.checked)} />
            <span className="status-dot" data-tone={chosen.has(t.paneId) ? "ok" : "neutral"} aria-hidden="true" />
            <span className="row-main">
              <span>{t.label}</span>
              <span className="faint mono">{t.identity}</span>
            </span>
            {production?.has(t.paneId) && <span className="badge badge-production">{msgProduction.label}</span>}
          </li>
        ))}
      </ul>
      {left > 0 && (
        <p className="faint" role="status" style={{ fontSize: "var(--text-sm)" }}>
          {count < 2 ? msgI.broadcast.needTwo : msgI.broadcast.excludedNote(left)}
        </p>
      )}
      <p className="faint" style={{ fontSize: "var(--text-sm)" }}>
        {msgC.broadcast.rules}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        <button type="button" className="btn btn-primary" disabled={count < 2} onClick={() => onConfirm(chosen)}>
          {msgC.broadcast.start(count)}
        </button>
      </div>
    </Dialog>
  );
}
