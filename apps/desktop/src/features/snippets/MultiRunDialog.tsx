import type { ExecutionTarget, HostSummary, SnippetExecResult, SnippetSummary } from "@tyrminal/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, Notice, TextField } from "../../components/ui/controls";
import { IconPlay, IconSave, IconSearch, IconTrash2 } from "../../components/ui/icons";
import { type AppError, snippetsD, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useSnippetRunHost } from "./runContext";

/** Runs at once; the rest wait their turn. */
const CONCURRENCY = 8;

type Row =
  | { state: "skipped" }
  | { state: "waiting" | "running"; runId: string }
  | { state: "done"; result: SnippetExecResult }
  | { state: "error"; error: AppError };

const ok = (row: Row | undefined) => row?.state === "done" && row.result.exitStatus === 0;

/**
 * Runs one snippet on several hosts: choose hosts (or a saved target), review the exact text
 * and the targets, then see each host's own result. Hosts without an open session in this window
 * are skipped and reported, never connected silently.
 */
export function MultiRunDialog({ snippet, onClose }: { snippet: SnippetSummary; onClose: () => void }) {
  const { hosts } = useVaultData();
  const runHost = useSnippetRunHost();
  const notify = useToast();
  const [step, setStep] = useState<"choose" | "review" | "run">("choose");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [targets, setTargets] = useState<ExecutionTarget[]>([]);
  const [targetName, setTargetName] = useState("");
  const [problem, setProblem] = useState<AppError | null>(null);
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [, refresh] = useState(0);
  const cancelled = useRef(false);
  const all = hosts.value ?? [];

  const loadTargets = () =>
    snippetsD
      .targets()
      .then(setTargets)
      .catch(() => setTargets([]));
  useEffect(() => {
    void loadTargets();
  }, []);

  // Sessions are read when needed: tabs may connect while the dialog is open.
  useEffect(() => {
    if (step === "run") return;
    const timer = window.setInterval(() => refresh((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [step]);
  const sessionOf = new Map(runHost.sessions().map((s) => [s.hostId, s.sessionId]));

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = [...all].sort((a, b) => a.label.localeCompare(b.label));
    return needle ? list.filter((h) => `${h.label} ${h.address} ${h.tags.join(" ")}`.toLowerCase().includes(needle)) : list;
  }, [all, filter]);
  const chosen = all.filter((h) => selected.has(h.id)).sort((a, b) => a.label.localeCompare(b.label));
  const missing = chosen.filter((h) => !sessionOf.has(h.id));
  const runnable = chosen.filter((h) => sessionOf.has(h.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function saveTarget() {
    setProblem(null);
    try {
      const saved = await snippetsD.saveTarget({ id: null, name: targetName, hostIds: chosen.map((h) => h.id) });
      notify("success", msgD.runs.targetSaved(saved.name));
      setTargetName("");
      void loadTargets();
    } catch (error) {
      setProblem(toAppError(error));
    }
  }

  async function run() {
    setStep("run");
    cancelled.current = false;
    const plan = new Map<string, Row>();
    for (const h of chosen) plan.set(h.id, sessionOf.has(h.id) ? { state: "waiting", runId: crypto.randomUUID() } : { state: "skipped" });
    setRows(new Map(plan));
    const queue = runnable.map((h) => ({ host: h, sessionId: sessionOf.get(h.id) as string }));
    const update = (id: string, row: Row) => setRows((current) => new Map(current).set(id, row));
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const planned = plan.get(next.host.id);
        if (!planned || planned.state !== "waiting") continue;
        if (cancelled.current) {
          update(next.host.id, { state: "error", error: toAppError({ code: "CANCELLED", message: "The run was cancelled." }) });
          continue;
        }
        update(next.host.id, { state: "running", runId: planned.runId });
        try {
          update(next.host.id, { state: "done", result: await snippetsD.exec(snippet.id, next.sessionId, planned.runId) });
        } catch (error) {
          update(next.host.id, { state: "error", error: toAppError(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  function cancelAll() {
    cancelled.current = true;
    for (const row of rows.values()) if (row.state === "running") void snippetsD.cancel(row.runId).catch(() => undefined);
  }

  const counts = [...rows.values()].reduce(
    (c, r) => ({
      ok: c.ok + (ok(r) ? 1 : 0),
      failed: c.failed + ((r.state === "done" && !ok(r)) || r.state === "error" ? 1 : 0),
      skipped: c.skipped + (r.state === "skipped" ? 1 : 0),
      busy: c.busy + (r.state === "running" || r.state === "waiting" ? 1 : 0),
    }),
    { ok: 0, failed: 0, skipped: 0, busy: 0 },
  );

  return (
    <Dialog
      title={step === "review" ? msgD.runs.reviewTitle(snippet.name) : msgD.runs.title(snippet.name)}
      icon={<IconPlay size={18} />}
      tone={step === "review" ? "warning" : "accent"}
      wide
      onDismiss={() => {
        if (counts.busy === 0) onClose();
      }}
    >
      {step === "choose" && (
        <div className="stack">
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgD.runs.body}
          </p>
          {targets.length > 0 && (
            <div className="row-flex" style={{ flexWrap: "wrap" }}>
              <label className="field" style={{ flex: 1 }}>
                <span className="label">{msgD.runs.savedTargets}</span>
                <select
                  className="select"
                  value=""
                  onChange={(event) => {
                    const target = targets.find((t) => t.id === event.target.value);
                    if (target) setSelected(new Set(target.hostIds));
                    if (target && target.missing > 0) notify("info", msgD.runs.targetMissing(target.missing));
                  }}
                >
                  <option value="">{msgD.runs.noSavedTarget}</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.hostIds.length})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="row-flex">
            <div className="input-with-icon" style={{ flex: 1 }}>
              <IconSearch size={15} />
              <input className="input" type="search" aria-label={msgD.runs.filter} placeholder={msgD.runs.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set(all.filter((h) => sessionOf.has(h.id)).map((h) => h.id)))}>
              {msgD.runs.selectOpen}
            </button>
          </div>
          <ul className="list run-host-list" aria-label={msgD.runs.hosts} data-testid="run-hosts">
            {shown.map((h) => (
              <li key={h.id}>
                <input type="checkbox" aria-label={msg.hosts.select(h.label)} checked={selected.has(h.id)} onChange={() => toggle(h.id)} />
                <div className="row-main">
                  <span className="row-title">{h.label}</span>
                  <span className="row-sub">{msg.hosts.destination(h.username, h.address, h.port)}</span>
                </div>
                <span className={`badge ${sessionOf.has(h.id) ? "badge-success" : ""}`}>{sessionOf.has(h.id) ? msgD.runs.sessionOpen : msgD.runs.noSession}</span>
              </li>
            ))}
          </ul>
          {chosen.length > 0 && (
            <div className="row-flex" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <TextField label={msgD.runs.targetName} value={targetName} onChange={setTargetName} maxLength={256} />
              </div>
              <button type="button" className="btn" disabled={targetName.trim() === ""} onClick={() => void saveTarget()}>
                <IconSave size={14} />
                {msgD.runs.saveTarget}
              </button>
            </div>
          )}
          {targets.length > 0 && <SavedTargetList targets={targets} onDeleted={() => void loadTargets()} />}
          {missing.length > 0 && (
            <Notice tone="info">
              {msgD.runs.connectMissingNote}{" "}
              <button type="button" className="btn btn-sm" onClick={() => missing.forEach((h) => runHost.connect(h))}>
                {msgD.runs.connectMissing(missing.length)}
              </button>
            </Notice>
          )}
          <ErrorNotice error={problem} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              {msg.common.cancel}
            </button>
            <button type="button" className="btn btn-primary" disabled={chosen.length === 0} onClick={() => setStep("review")}>
              {msgD.runs.review(chosen.length)}
            </button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="stack">
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgD.runs.reviewBody}
          </p>
          <pre className="code-block">{snippet.text}</pre>
          <ul className="list run-host-list" aria-label={msgD.runs.hosts} data-testid="run-review">
            {chosen.map((h) => (
              <li key={h.id}>
                <div className="row-main">
                  <span className="row-title">{h.label}</span>
                  <span className="row-sub">{msg.hosts.destination(h.username, h.address, h.port)}</span>
                </div>
                <span className={`badge ${sessionOf.has(h.id) ? "badge-success" : ""}`}>{sessionOf.has(h.id) ? msgD.runs.sessionOpen : msgD.runs.noSession}</span>
              </li>
            ))}
          </ul>
          {missing.length > 0 && <Notice tone="warning">{msgD.runs.skipped(missing.length)}</Notice>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setStep("choose")} autoFocus data-autofocus>
              {msgD.runs.back}
            </button>
            <button type="button" className="btn btn-primary" disabled={runnable.length === 0} onClick={() => void run()}>
              <IconPlay size={14} />
              {msgD.runs.run(runnable.length)}
            </button>
          </div>
        </div>
      )}

      {step === "run" && (
        <div className="stack">
          <p role="status" aria-live="polite" data-testid="run-summary">
            <strong>{msgD.runs.summary(counts.ok, counts.failed, counts.skipped)}</strong>
          </p>
          <ul className="list run-results" aria-label={msgD.runs.results} data-testid="run-results">
            {chosen.map((h) => (
              <ResultRow key={h.id} host={h} row={rows.get(h.id)} />
            ))}
          </ul>
          <div className="dialog-actions">
            {counts.busy > 0 && (
              <button type="button" className="btn btn-danger" onClick={cancelAll}>
                {msgD.runs.cancelAll}
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={counts.busy > 0} onClick={onClose}>
              {msgD.runs.done}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SavedTargetList({ targets, onDeleted }: { targets: ExecutionTarget[]; onDeleted: () => void }) {
  return (
    <details>
      <summary className="hint">{msgD.runs.savedTargets}</summary>
      <ul className="stack-xs" style={{ marginTop: 8 }}>
        {targets.map((t) => (
          <li key={t.id} className="row-flex">
            <span style={{ flex: 1 }}>
              {t.name} ({t.hostIds.length}){t.missing > 0 ? ` · ${msgD.runs.targetMissing(t.missing)}` : ""}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`${msgD.runs.deleteTarget} ${t.name}`}
              onClick={() => void snippetsD.deleteTarget(t.id).then(onDeleted, onDeleted)}
            >
              <IconTrash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function rowStatus(row: Row | undefined): { text: string; tone: string } {
  if (!row) return { text: msgD.runs.running, tone: "" };
  switch (row.state) {
    case "waiting":
    case "running":
      return { text: msgD.runs.running, tone: "" };
    case "skipped":
      return { text: msgD.runs.skippedRow, tone: "" };
    case "error":
      return { text: row.error.message, tone: "badge-danger" };
    case "done": {
      const { exitStatus, exitSignal } = row.result;
      if (exitStatus === 0) return { text: msgD.runs.succeeded, tone: "badge-success" };
      return { text: exitSignal ? msgD.runs.signal(exitSignal) : msgD.runs.exit(exitStatus ?? -1), tone: "badge-danger" };
    }
  }
}

function ResultRow({ host, row }: { host: HostSummary; row: Row | undefined }) {
  const { text: status, tone } = rowStatus(row);
  return (
    <li data-host={host.label} data-state={row?.state ?? "waiting"} style={{ flexWrap: "wrap" }}>
      <div className="row-main">
        <span className="row-title">{host.label}</span>
      </div>
      <span className={`badge ${tone}`}>{status}</span>
      {row?.state === "done" && (
        <details style={{ flexBasis: "100%" }}>
          <summary className="hint">{msgD.runs.stdout}</summary>
          {/* Remote output is shown as plain text only (the core already removed control characters). */}
          <pre className="code-block">{row.result.stdout || msgD.runs.noOutput}</pre>
          {row.result.stderr && (
            <>
              <span className="hint">{msgD.runs.stderr}</span>
              <pre className="code-block">{row.result.stderr}</pre>
            </>
          )}
          {row.result.truncated && <p className="hint">{msgD.runs.truncated}</p>}
          {row.result.envRejected.length > 0 && <p className="hint" role="note">{msgD.env.runRejected(row.result.envRejected)}</p>}
        </details>
      )}
    </li>
  );
}
