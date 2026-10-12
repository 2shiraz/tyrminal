import { useState } from "react";

import { IconButton } from "../../components/ui/controls";
import { IconChevronDown, IconCopy, IconDownload, IconRefreshCw, IconUpload, IconX } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { formatSize, visibleName } from "../sftp/model";
import { msgFiles } from "./messages";
import { type Transfer, totals } from "./transfers";
import { useExit } from "../../lib/exitGhost";

function detail(t: Transfer): string {
  switch (t.state) {
    case "running": {
      const amount = msg.files.progress(formatSize(t.done), t.total == null ? null : formatSize(t.total));
      return t.rate == null ? amount : `${amount}, ${msgFiles.rate(formatSize(Math.round(t.rate)))}`;
    }
    case "done":
      return msg.files.doneSummary(t.files ?? 1, t.skipped ?? 0);
    case "cancelled":
      return msg.files.cancelled;
    case "failed":
      return `${msg.files.failed}: ${t.error ?? ""}`;
  }
}

const percent = (done: number, total: number | null) => (total ? Math.min(100, Math.floor((done / total) * 100)) : null);

/**
 * The transfer queue at the bottom of a file browser: a one-line summary with a 3 px bar that
 * opens to one row per transfer (progress, rate, Cancel, the reason a transfer failed).
 */
export function TransferDrawer<T extends Transfer & { job?: unknown }>({
  transfers,
  onCancel,
  onRetry,
  onClear,
}: {
  transfers: T[];
  onCancel: (t: T) => void;
  /** Starts a failed or cancelled transfer again (offered when it can be). */
  onRetry?: ((t: T) => void) | undefined;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  // When the last transfer is cleared, the drawer fades out rather than vanishing.
  const exitRef = useExit<HTMLElement>({ evenFromKeyboard: true });
  if (transfers.length === 0) return null;
  const sum = totals(transfers);
  const overall = percent(sum.done, sum.total);
  return (
    <section
      ref={exitRef}
      className="xfer"
      aria-label={msg.files.transfers}
      data-open={open || undefined}
      // The status edge, as a toast: failed wins, then running, else all done.
      data-tone={sum.failed > 0 ? "danger" : sum.running > 0 ? "accent" : "success"}
    >
      <div className="xfer-head">
        <button type="button" className="xfer-toggle" aria-expanded={open} aria-label={open ? msgFiles.hideTransfers : msgFiles.showTransfers} onClick={() => setOpen((v) => !v)}>
          <IconChevronDown size={14} className="xfer-chevron" />
          <span className="xfer-title">{msg.files.transfers}</span>
          <span className="xfer-sum">{msgFiles.summary(sum.running, sum.failed)}</span>
          {/* Folded, the header carries the overall share; open, each row has its own. */}
          {!open && sum.running > 0 && overall != null && <span className="xfer-pct">{msgFiles.percent(overall)}</span>}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} disabled={!transfers.some((t) => t.state !== "running")}>
          {msg.files.clearDone}
        </button>
      </div>
      {!open && sum.running > 0 && <Bar value={overall} label={msg.files.transfers} />}
      {open && (
        <ul className="xfer-list">
          {transfers.map((t) => {
            const pct = percent(t.done, t.total);
            return (
              <li key={t.id} className="xfer-row" data-state={t.state}>
                <span className="xfer-icon" aria-hidden="true">
                  {t.direction === "upload" ? <IconUpload size={14} /> : t.direction === "copy" ? <IconCopy size={14} /> : <IconDownload size={14} />}
                </span>
                <span className="xfer-name" title={visibleName(t.name)}>
                  {visibleName(t.name)}
                </span>
                <span className="xfer-end">
                  {t.state === "running" ? (
                    <>
                      {pct != null && <span className="xfer-pct">{msgFiles.percent(pct)}</span>}
                      <IconButton size="sm" label={msg.files.cancelTransfer(t.name)} onClick={() => onCancel(t)}>
                        <IconX size={13} />
                      </IconButton>
                    </>
                  ) : (t.state === "failed" || t.state === "cancelled") && onRetry && t.job ? (
                    <IconButton size="sm" label={msgFiles.retryTransfer(t.name)} onClick={() => onRetry(t)}>
                      <IconRefreshCw size={13} />
                    </IconButton>
                  ) : null}
                </span>
                {t.state === "running" && <Bar value={pct} label={t.name} />}
                <span className="xfer-detail" data-testid="transfer-state">
                  {detail(t)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A 3 px bar; without a known total it shows a still, partly filled track (no animation). */
function Bar({ value, label }: { value: number | null; label: string }) {
  return (
    <span className="xfer-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} data-indeterminate={value == null || undefined}>
      <span style={{ transform: `scaleX(${(value ?? 100) / 100})` }} />
    </span>
  );
}
