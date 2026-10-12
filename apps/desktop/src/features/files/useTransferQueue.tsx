import type { ConflictChoice, TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";
import { useCallback, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { IconTriangleAlert } from "../../components/ui/icons";
import { files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { type Transfer, applyEvent, refused, started as startedTransfer } from "./transfers";

/** How to start one transfer; called again with the user's choice after a name conflict. */
export interface TransferJob {
  name: string;
  direction: TransferDirection;
  /** Folders are never replaced or merged: a conflict only offers Keep both. */
  folder: boolean;
  /** Where the existing item is, for the conflict's explanation. */
  remote: boolean;
  start: (choice: ConflictChoice, onEvent: (event: TransferEvent) => void) => Promise<TransferStarted>;
  /** Stops it when it was not started by the core (a desktop drop); default: the core's cancel. */
  cancel?: (transferId: string) => void;
  /** Runs once it finished (lists the destination again, for example). */
  onDone?: () => void;
}

/** A transfer row, plus what Retry needs. */
export type QueuedTransfer = Transfer & { job?: TransferJob };

interface Conflict {
  job: TransferJob;
  replacing?: string;
}

/**
 * The transfer queue of one file browser: starts jobs, holds events that arrive before a job's
 * id, asks about name conflicts one at a time (never replacing without asking), cancels and
 * retries. The owner keeps the list (the Files panel keeps it per session).
 */
export function useTransferQueue(list: QueuedTransfer[], setList: (change: (list: QueuedTransfer[]) => QueuedTransfer[]) => void, visible = true) {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const setListRef = useRef(setList);
  setListRef.current = setList;

  const run = useCallback((job: TransferJob, choice: ConflictChoice = "ask", replacing?: string) => {
    const update = (change: (list: QueuedTransfer[]) => QueuedTransfer[]) => setListRef.current(change);
    let bound: string | null = null;
    const early: TransferEvent[] = [];
    const apply = (id: string, event: TransferEvent) => {
      update((all) => all.map((t) => (t.id === id ? applyEvent(t, event) : t)));
      if (event.type === "done") job.onDone?.();
    };
    const onEvent = (event: TransferEvent) => {
      if (bound) apply(bound, event);
      else early.push(event);
    };
    // A retried row is replaced where it stood, not added again at the end.
    const place = (row: QueuedTransfer) =>
      update((all) => (replacing && all.some((t) => t.id === replacing) ? all.map((t) => (t.id === replacing ? row : t)) : [...all, row]));
    job
      .start(choice, onEvent)
      .then((s: TransferStarted) => {
        place({ ...startedTransfer(s), job });
        bound = s.transferId;
        for (const event of early.splice(0)) apply(s.transferId, event);
      })
      .catch((caught) => {
        const e = toAppError(caught);
        if (e.code === "CONFLICT" && choice === "ask") setConflicts((c) => [...c, { job, ...(replacing ? { replacing } : {}) }]);
        else place({ ...refused(job.name, job.direction, e.message), job });
      });
  }, []);

  const cancel = useCallback(
    (t: QueuedTransfer) => {
      if (t.job?.cancel) t.job.cancel(t.id);
      else void filesApi.cancel(t.id).catch(() => undefined);
    },
    [],
  );

  /** Starts a failed or cancelled transfer again, in its row. */
  const retry = useCallback((t: QueuedTransfer) => t.job && run(t.job, "ask", t.id), [run]);

  /** A transfer refused before it could start (a dropped folder): listed with the reason. */
  const refuse = useCallback((name: string, direction: TransferDirection, message: string) => setListRef.current((all) => [...all, refused(name, direction, message)]), []);

  const clear = useCallback(() => setListRef.current((all) => all.filter((t) => t.state === "running")), []);

  const conflict = conflicts[0] ?? null;
  const settle = () => setConflicts((c) => c.slice(1));
  const dialog =
    conflict && visible ? (
      <Dialog
        key={`${conflict.job.name}-${conflicts.length}`}
        title={msg.files.replaceTitle(conflict.job.name)}
        role="alertdialog"
        tone="danger"
        icon={<IconTriangleAlert size={18} />}
        onDismiss={settle}
      >
        <div className="stack">
          <p>{conflict.job.folder ? msg.files.folderExists : conflict.job.remote ? msg.files.replaceRemote : msg.files.replaceLocal}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={settle} data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className={conflict.job.folder ? "btn btn-primary" : "btn"}
              onClick={() => {
                settle();
                run(conflict.job, "keep_both", conflict.replacing);
              }}
            >
              {msg.files.keepBoth}
            </button>
            {!conflict.job.folder && (
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={() => {
                  settle();
                  run(conflict.job, "replace", conflict.replacing);
                }}
              >
                {msg.files.replace}
              </button>
            )}
          </div>
        </div>
      </Dialog>
    ) : null;

  return { list, run, cancel, retry, clear, refuse, dialog };
}
