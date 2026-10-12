import { Dialog } from "../../components/ui/Dialog";
import { IconShieldAlert } from "../../components/ui/icons";
import { msgProduction } from "../../lib/messages-production";

/**
 * Asks before an action reaches production hosts (P-26): broadcasting, a multi-host snippet run,
 * connecting a group. Names every production host involved; Cancel has focus, so Enter or Escape
 * never confirms by accident.
 */
export function ProductionConfirm({
  title,
  body,
  confirmLabel,
  hosts,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** Labels of the production hosts involved. */
  hosts: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} role="alertdialog" tone="warning" icon={<IconShieldAlert size={18} />} onDismiss={onCancel}>
      <div className="stack">
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {body}
        </p>
        <p style={{ fontSize: "var(--text-sm)" }}>{msgProduction.confirmHosts(hosts.length)}</p>
        <ul className="production-list" aria-label={msgProduction.label}>
          {hosts.map((label, index) => (
            // Labels can repeat (two hosts with one name); the position keeps keys unique.
            <li key={`${index}-${label}`}>
              <span className="badge badge-production">{msgProduction.label}</span> {label}
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
            {msgProduction.confirmCancel}
          </button>
          <button type="button" className="btn btn-warning" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
