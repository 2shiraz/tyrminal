import { Dialog } from "../../components/ui/Dialog";
import { IconRadio } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";

export interface BroadcastTarget {
  paneId: number;
  /** The session the user reviewed; broadcast starts only if every pane still has this one. */
  sessionId: string;
  label: string;
  identity: string;
}

/**
 * Shows exactly which panes will receive typed input before broadcast starts (P-13). The safe
 * choice has initial focus; nothing is enabled until the user confirms this list.
 */
export function BroadcastReview({ targets, onConfirm, onCancel }: { targets: BroadcastTarget[]; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog title={msgC.broadcast.title(targets.length)} icon={<IconRadio size={18} />} tone="warning" role="alertdialog" onDismiss={onCancel}>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msgC.broadcast.body}
      </p>
      <ul className="broadcast-targets" aria-label={msgC.broadcast.listLabel}>
        {targets.map((t) => (
          <li key={t.paneId}>
            <span className="status-dot" data-tone="ok" aria-hidden="true" />
            <span className="row-main">
              <span>{t.label}</span>
              <span className="faint mono">{t.identity}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="faint" style={{ fontSize: "var(--text-sm)" }}>
        {msgC.broadcast.rules}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          {msgC.broadcast.start(targets.length)}
        </button>
      </div>
    </Dialog>
  );
}
