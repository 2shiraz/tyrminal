import type { ExecutionTarget, GroupSummary, HostSummary, IpcError, SessionEvent, SnippetExecResult, SnippetSummary } from "@tyrminal/contracts";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, Notice, SecretField, TextField } from "../../components/ui/controls";
import { IconPlay, IconSave, IconSearch, IconTrash2 } from "../../components/ui/icons";
import { type AppError, sessions as sessionsApi, snippetsD, terminalOutput, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { msgProduction } from "../../lib/messages-production";
import { msgRuns } from "../../lib/messages-runs";
import { ProductionConfirm } from "../hosts/ProductionConfirm";
import { useIsProduction } from "../hosts/production";
import { useSnippetRunHost } from "./runContext";
import { groupSelection, hostsOfGroup, resolveTarget, selectionAsTarget } from "./runTargets";

/** Hosts run at once unless the user picks another number (1 to 8). */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

type Row =
  | { state: "queued" | "connecting" | "trust" | "signin" | "running" }
  | { state: "skipped"; reason: string }
  | { state: "done"; result: SnippetExecResult }
  | { state: "error"; error: AppError };

type TrustEvent = Extract<SessionEvent, { type: "trust_prompt" }>;
type AuthEvent = Extract<SessionEvent, { type: "auth_prompt" }>;
/** A question one run-only connection is waiting on; shown one at a time, in order. */
type Prompt = { host: HostSummary; session: { id: string | null } } & ({ kind: "trust"; event: TrustEvent } | { kind: "auth"; event: AuthEvent });

const BUSY = new Set<Row["state"]>(["queued", "connecting", "trust", "signin", "running"]);
const ok = (row: Row | undefined) => row?.state === "done" && row.result.exitStatus === 0;
const cancelledError = (): AppError => toAppError({ code: "CANCELLED", message: "The run was cancelled." });

/**
 * Runs one snippet on several hosts: choose hosts or groups (or a saved target), review the exact
 * text and the exact hosts, then see each host's own result. Hosts with an open session in this
 * window run on it; for the others a run-only connection is made for the run (trust and sign-in
 * as for a terminal, asked one host at a time and never assumed) and closed after it.
 */
export function MultiRunDialog({
  snippet,
  onClose,
  allOpen = false,
  hostIds,
}: {
  snippet: SnippetSummary | null;
  onClose: () => void;
  allOpen?: boolean;
  /** Hosts chosen already (a selection on Hosts); the choice can still be changed before the review. */
  hostIds?: readonly string[];
}) {
  const [chosen, setChosen] = useState(snippet);
  if (!chosen) return <SnippetPicker onPick={setChosen} onClose={onClose} />;
  return <MultiRun snippet={chosen} onClose={onClose} allOpen={allOpen} hostIds={hostIds} />;
}

/** "Run a snippet on all open sessions" from the palette: which snippet, before the review. */
function SnippetPicker({ onPick, onClose }: { onPick: (snippet: SnippetSummary) => void; onClose: () => void }) {
  const { snippets } = useVaultData();
  const [id, setId] = useState("");
  const list = [...(snippets.value ?? [])].sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`));
  const picked = list.find((s) => s.id === id) ?? null;
  return (
    <Dialog title={msgRuns.pickTitle} icon={<IconPlay size={18} />} onDismiss={onClose}>
      <div className="stack">
        <label className="field">
          <span className="label">{msgRuns.pickSnippet}</span>
          <select className="select" value={id} onChange={(e) => setId(e.target.value)} autoFocus data-autofocus>
            <option value="">{msgRuns.pickNone}</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.folder ? `${s.folder}/${s.name}` : s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={!picked} onClick={() => picked && onPick(picked)}>
            {msgRuns.next}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function MultiRun({ snippet, onClose, allOpen, hostIds }: { snippet: SnippetSummary; onClose: () => void; allOpen: boolean; hostIds?: readonly string[] | undefined }) {
  const { hosts, groups } = useVaultData();
  const runHost = useSnippetRunHost();
  const notify = useToast();
  const all = hosts.value ?? [];
  const groupList = groups.value ?? [];
  const [step, setStep] = useState<"choose" | "review" | "run">(allOpen ? "review" : "choose");
  const [selected, setSelected] = useState<Set<string>>(() => (allOpen ? new Set(runHost.sessions().map((s) => s.hostId)) : new Set(hostIds ?? [])));
  const [filter, setFilter] = useState("");
  /** Groups the user picked as a whole: kept as groups when the selection is saved as a target. */
  const [pickedGroups, setPickedGroups] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<ExecutionTarget[]>([]);
  const [targetName, setTargetName] = useState("");
  const [problem, setProblem] = useState<AppError | null>(null);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [skipInput, setSkipInput] = useState(false);
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [confirming, setConfirming] = useState(false);
  const isProduction = useIsProduction();
  const cancelled = useRef(false);
  /** Run ids of runs on open sessions, and the run-only connections this dialog opened. */
  const openRuns = useRef(new Set<string>());
  const ownConnections = useRef(new Set<string>());

  const loadTargets = () =>
    snippetsD
      .targets()
      .then(setTargets)
      .catch(() => setTargets([]));
  useEffect(() => {
    void loadTargets();
  }, []);

  // Closing the dialog (or a lock, which unmounts it) drops every connection it opened.
  useEffect(
    () => () => {
      for (const id of ownConnections.current) void sessionsApi.close(id).catch(() => undefined);
      for (const id of openRuns.current) void snippetsD.cancel(id).catch(() => undefined);
    },
    [],
  );

  // Tabs may connect while the dialog is open: the run host's `version` changes on every session
  // event, which re-renders this dialog and reads the sessions again (no polling).
  const sessionOf = new Map(runHost.sessions().map((s) => [s.hostId, s.sessionId]));

  const chosen = all.filter((h) => selected.has(h.id)).sort((a, b) => a.label.localeCompare(b.label));
  const closed = chosen.filter((h) => !sessionOf.has(h.id));

  const setHosts = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function saveTarget() {
    setProblem(null);
    try {
      const saved = await snippetsD.saveTarget({ id: null, name: targetName, ...selectionAsTarget(selected, pickedGroups, groupList, all) });
      notify("success", msgD.runs.targetSaved(saved.name));
      setTargetName("");
      void loadTargets();
    } catch (error) {
      setProblem(toAppError(error));
    }
  }

  const update = (id: string, row: Row) => setRows((current) => new Map(current).set(id, row));
  const dropPrompts = (session: { id: string | null }) => setPrompts((list) => list.filter((p) => p.session !== session));

  /** Connects a host without an open session, runs on it, and disconnects. */
  async function runClosed(host: HostSummary): Promise<void> {
    update(host.id, { state: "connecting" });
    const session: { id: string | null } = { id: null };
    let settle: (failure: IpcError | null) => void = () => undefined;
    const ready = new Promise<IpcError | null>((resolve) => {
      settle = resolve;
    });
    let connected = false;
    const onEvent = (event: SessionEvent) => {
      switch (event.type) {
        case "trust_prompt":
          update(host.id, { state: "trust" });
          setPrompts((list) => [...list, { host, session, kind: "trust", event }]);
          break;
        case "auth_prompt":
          update(host.id, { state: "signin" });
          setPrompts((list) => [...list, { host, session, kind: "auth", event }]);
          break;
        case "state":
          if (event.state === "connected" && !connected) {
            connected = true;
            settle(null);
          } else if (event.state === "authenticating" || event.state === "opening_channel") {
            update(host.id, { state: "connecting" });
          }
          break;
        case "closed":
          dropPrompts(session);
          if (!connected) settle(event.error ?? { code: "DISCONNECTED", message: "The connection ended before the run." });
          break;
        default:
          break;
      }
    };
    try {
      session.id = (await sessionsApi.openExec(host.id, !skipInput, onEvent)).sessionId;
    } catch (error) {
      update(host.id, { state: "error", error: toAppError(error) });
      return;
    }
    ownConnections.current.add(session.id);
    try {
      const failure = await ready;
      if (failure) {
        if (failure.code === "NEEDS_SIGN_IN") update(host.id, { state: "skipped", reason: msgRuns.needsSignIn });
        else update(host.id, { state: "error", error: cancelled.current ? cancelledError() : toAppError(failure) });
        return;
      }
      if (cancelled.current) {
        update(host.id, { state: "error", error: cancelledError() });
        return;
      }
      update(host.id, { state: "running" });
      try {
        update(host.id, { state: "done", result: await snippetsD.exec(snippet.id, session.id, crypto.randomUUID()) });
      } catch (error) {
        update(host.id, { state: "error", error: cancelled.current ? cancelledError() : toAppError(error) });
      }
    } finally {
      dropPrompts(session);
      // Closed once: Cancel may already have closed it.
      if (ownConnections.current.delete(session.id)) void sessionsApi.close(session.id).catch(() => undefined);
    }
  }

  /** Runs on a host's open session in this window. */
  async function runOpen(host: HostSummary, sessionId: string): Promise<void> {
    const runId = crypto.randomUUID();
    openRuns.current.add(runId);
    update(host.id, { state: "running" });
    try {
      update(host.id, { state: "done", result: await snippetsD.exec(snippet.id, sessionId, runId) });
    } catch (error) {
      update(host.id, { state: "error", error: toAppError(error) });
    } finally {
      openRuns.current.delete(runId);
    }
  }

  async function run() {
    setStep("run");
    cancelled.current = false;
    // The plan is fixed now: the hosts shown in the review, each on its session or its own connection.
    const plan = chosen.map((host) => ({ host, sessionId: sessionOf.get(host.id) ?? null }));
    setRows(new Map(plan.map((p) => [p.host.id, { state: "queued" } as Row])));
    const queue = [...plan];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (cancelled.current) {
          update(next.host.id, { state: "error", error: cancelledError() });
          continue;
        }
        if (next.sessionId) await runOpen(next.host, next.sessionId);
        else await runClosed(next.host);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  /**
   * The one gate between the review and the run: every confirmation that must name hosts before
   * anything runs (the production question of P-26) goes here, with the exact plan in `chosen`.
   */
  function confirmThenRun() {
    if (chosen.some(isProduction)) setConfirming(true);
    else void run();
  }

  function cancelAll() {
    cancelled.current = true;
    for (const id of openRuns.current) void snippetsD.cancel(id).catch(() => undefined);
    // Closing a run-only connection stops its run and any question it was waiting on.
    for (const id of ownConnections.current) void sessionsApi.close(id).catch(() => undefined);
    ownConnections.current.clear();
    setPrompts([]);
  }

  const counts = [...rows.values()].reduce(
    (c, r) => ({
      ok: c.ok + (ok(r) ? 1 : 0),
      failed: c.failed + ((r.state === "done" && !ok(r)) || r.state === "error" ? 1 : 0),
      skipped: c.skipped + (r.state === "skipped" ? 1 : 0),
      busy: c.busy + (BUSY.has(r.state) ? 1 : 0),
    }),
    { ok: 0, failed: 0, skipped: 0, busy: 0 },
  );
  const prompt = prompts[0] ?? null;

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
            <label className="field">
              <span className="label">{msgD.runs.savedTargets}</span>
              <select
                className="select"
                value=""
                onChange={(event) => {
                  const target = targets.find((t) => t.id === event.target.value);
                  if (!target) return;
                  setSelected(resolveTarget(target, groupList, all));
                  setPickedGroups(new Set(target.groupIds));
                  if (target.missing > 0) notify("info", msgRuns.targetMissing(target.missing));
                }}
              >
                <option value="">{msgD.runs.noSavedTarget}</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {msgRuns.targetLabel(t.name, t.hostIds.length, t.groupIds.length)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="row-flex" style={{ flexWrap: "wrap" }}>
            <div className="input-with-icon" style={{ flex: 1, minWidth: 180 }}>
              <IconSearch size={15} />
              <input className="input" type="search" aria-label={msgD.runs.filter} placeholder={msgD.runs.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set(all.map((h) => h.id)))}>
              {msgRuns.selectAll}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set(all.filter((h) => sessionOf.has(h.id)).map((h) => h.id)))}>
              {msgD.runs.selectOpen}
            </button>
          </div>
          <HostChooser hosts={all} groups={groupList} filter={filter} selected={selected} sessionOf={sessionOf} onHosts={setHosts}
            onGroup={(groupId, on) =>
              setPickedGroups((current) => {
                const next = new Set(current);
                if (on) next.add(groupId);
                else next.delete(groupId);
                return next;
              })
            } />
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
                {isProduction(h) && <span className="badge badge-production">{msgProduction.label}</span>}
                <span className={`badge ${sessionOf.has(h.id) ? "badge-success" : ""}`}>{sessionOf.has(h.id) ? msgD.runs.sessionOpen : msgD.runs.noSession}</span>
              </li>
            ))}
          </ul>
          {closed.length > 0 && (
            <>
              <Notice tone="info">{msgRuns.closedNote(closed.length)}</Notice>
              <label className="row-flex" style={{ gap: 8 }}>
                <input type="checkbox" checked={skipInput} onChange={(e) => setSkipInput(e.target.checked)} />
                <span>
                  {msgRuns.skipInput}
                  <span className="hint" style={{ display: "block" }}>
                    {msgRuns.skipInputHint}
                  </span>
                </span>
              </label>
            </>
          )}
          <label className="field" style={{ maxWidth: 200 }}>
            <span className="label">{msgRuns.concurrency}</span>
            <select className="select" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
              {Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div className="dialog-actions">
            {allOpen ? (
              <button type="button" className="btn" onClick={onClose} autoFocus data-autofocus>
                {msg.common.cancel}
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setStep("choose")} autoFocus data-autofocus>
                {msgD.runs.back}
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={chosen.length === 0} onClick={() => confirmThenRun()}>
              <IconPlay size={14} />
              {msgD.runs.run(chosen.length)}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <ProductionConfirm
          title={msgProduction.runTitle}
          body={msgProduction.runBody}
          confirmLabel={msgProduction.runConfirm}
          hosts={chosen.filter(isProduction).map((h) => h.label)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run();
          }}
        />
      )}

      {step === "run" && (
        <div className="stack">
          <p role="status" aria-live="polite" data-testid="run-summary">
            <strong>{msgD.runs.summary(counts.ok, counts.failed, counts.skipped)}</strong>
          </p>
          {prompt && <PromptPanel key={prompt.event.promptId + prompt.host.id} prompt={prompt} onAnswered={() => setPrompts((list) => list.filter((p) => p !== prompt))} />}
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

/** Hosts by group, with a tri-state checkbox per group; a flat list while filtering. */
function HostChooser({
  hosts,
  groups,
  filter,
  selected,
  sessionOf,
  onHosts,
  onGroup,
}: {
  hosts: HostSummary[];
  groups: GroupSummary[];
  filter: string;
  selected: ReadonlySet<string>;
  sessionOf: ReadonlyMap<string, string>;
  onHosts: (ids: string[], on: boolean) => void;
  onGroup: (groupId: string, on: boolean) => void;
}) {
  const isProduction = useIsProduction();
  const needle = filter.trim().toLowerCase();
  const sorted = useMemo(() => [...hosts].sort((a, b) => a.label.localeCompare(b.label)), [hosts]);
  const hostRow = (h: HostSummary, depth: number) => (
    <li key={h.id} style={{ paddingLeft: depth * 20 }}>
      <input type="checkbox" aria-label={msg.hosts.select(h.label)} checked={selected.has(h.id)} onChange={(e) => onHosts([h.id], e.target.checked)} />
      <div className="row-main">
        <span className="row-title">{h.label}</span>
        <span className="row-sub">{msg.hosts.destination(h.username, h.address, h.port)}</span>
      </div>
      {isProduction(h) && <span className="badge badge-production">{msgProduction.label}</span>}
      <span className={`badge ${sessionOf.has(h.id) ? "badge-success" : ""}`}>{sessionOf.has(h.id) ? msgD.runs.sessionOpen : msgD.runs.noSession}</span>
    </li>
  );
  if (needle) {
    const shown = sorted.filter((h) => `${h.label} ${h.address} ${h.tags.join(" ")}`.toLowerCase().includes(needle));
    return (
      <ul className="list run-host-list" aria-label={msgD.runs.hosts} data-testid="run-hosts">
        {shown.map((h) => hostRow(h, 0))}
      </ul>
    );
  }
  const rows: ReactNode[] = [];
  const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
    for (const g of groups.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const members = hostsOfGroup(g.id, groups, hosts).map((h) => h.id);
      rows.push(<GroupRow key={`g-${g.id}`} group={g} depth={depth} state={groupSelection(g.id, selected, groups, hosts)} empty={members.length === 0} onChange={(on) => {
            onHosts(members, on);
            onGroup(g.id, on);
          }}
        />);
      visit(g.id, depth + 1, seen);
      for (const h of sorted.filter((x) => x.groupId === g.id)) rows.push(hostRow(h, depth + 1));
    }
  };
  visit(null, 0, new Set());
  const known = new Set(groups.map((g) => g.id));
  const loose = sorted.filter((h) => h.groupId === null || !known.has(h.groupId));
  if (loose.length > 0 && groups.length > 0)
    rows.push(
      <li key="ungrouped" className="hint">
        {msgRuns.ungrouped}
      </li>,
    );
  for (const h of loose) rows.push(hostRow(h, 0));
  return (
    <ul className="list run-host-list" aria-label={msgD.runs.hosts} data-testid="run-hosts">
      {rows}
    </ul>
  );
}

function GroupRow({ group, depth, state, empty, onChange }: { group: GroupSummary; depth: number; state: "all" | "some" | "none"; empty: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <li style={{ paddingLeft: depth * 20 }} data-group={group.name}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={msgRuns.selectGroup(group.name)}
        checked={state === "all"}
        disabled={empty}
        onChange={() => onChange(state !== "all")}
      />
      <div className="row-main">
        <span className="row-title">{group.name}</span>
      </div>
    </li>
  );
}

/** The question a run-only connection waits on: a host key to trust, or a sign-in answer. */
function PromptPanel({ prompt, onAnswered }: { prompt: Prompt; onAnswered: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = prompt.session.id;
  const trust = async (decision: "once" | "always" | "cancel") => {
    if (!sessionId) return;
    setBusy(true);
    await sessionsApi.answerTrust(sessionId, prompt.event.promptId, decision).catch(() => undefined);
    onAnswered();
  };
  const answer = async (value: string | null) => {
    if (!sessionId) return;
    setBusy(true);
    await sessionsApi.answerAuth(sessionId, prompt.event.promptId, value).catch(() => undefined);
    setSecret("");
    onAnswered();
  };
  if (prompt.kind === "trust") {
    const e = prompt.event;
    return (
      <section className="notice notice-warning stack-sm" aria-label={msgRuns.trustTitle(prompt.host.label)} style={{ display: "block" }}>
        <strong>{msgRuns.trustTitle(prompt.host.label)}</strong>
        <p style={{ margin: 0 }}>{msgRuns.trustBody(prompt.host.label, `${e.host}:${e.port}`)}</p>
        <p className="fingerprint" style={{ margin: 0 }}>
          {e.algorithm} {e.fingerprint}
        </p>
        <div className="row-flex">
          <button type="button" className="btn" disabled={busy || !sessionId} onClick={() => void trust("cancel")} autoFocus>
            {msgRuns.skipHost}
          </button>
          <button type="button" className="btn" disabled={busy || !sessionId} onClick={() => void trust("once")}>
            {msgRuns.trustOnce}
          </button>
          <button type="button" className="btn" disabled={busy || !sessionId} onClick={() => void trust("always")}>
            {msgRuns.trustAlways}
          </button>
        </div>
      </section>
    );
  }
  const e = prompt.event;
  const label = e.kind === "password" ? msgRuns.password : e.kind === "key_passphrase" ? msgRuns.passphrase : (e.message ?? msgRuns.answer);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void answer(secret);
  };
  return (
    <section className="notice notice-info stack-sm" aria-label={msgRuns.signInTitle(prompt.host.label)} style={{ display: "block" }}>
      <strong>{msgRuns.signInTitle(prompt.host.label)}</strong>
      <p style={{ margin: 0 }}>{msgRuns.signInBody(e.username, prompt.host.label)}</p>
      <form className="row-flex" style={{ alignItems: "flex-end" }} onSubmit={submit}>
        <div style={{ flex: 1 }}>
          {e.echo ? <TextField label={label} value={secret} onChange={setSecret} autoFocus /> : <SecretField label={label} value={secret} onChange={setSecret} autoFocus />}
        </div>
        <button type="button" className="btn" disabled={busy || !sessionId} onClick={() => void answer(null)}>
          {msgRuns.skipHost}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !sessionId}>
          {msgRuns.signIn}
        </button>
      </form>
    </section>
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
              {msgRuns.targetLabel(t.name, t.hostIds.length, t.groupIds.length)}
              {t.missing > 0 ? ` · ${msgRuns.targetMissing(t.missing)}` : ""}
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
  if (!row) return { text: msgRuns.queued, tone: "" };
  switch (row.state) {
    case "queued":
      return { text: msgRuns.queued, tone: "" };
    case "connecting":
      return { text: msgRuns.connecting, tone: "" };
    case "trust":
      return { text: msgRuns.waitingTrust, tone: "badge-warning" };
    case "signin":
      return { text: msgRuns.waitingSignIn, tone: "badge-warning" };
    case "running":
      return { text: msgD.runs.running, tone: "" };
    case "skipped":
      return { text: msgRuns.skipped(row.reason), tone: "" };
    case "error":
      return { text: row.error.code === "CANCELLED" ? msgRuns.cancelled : row.error.message, tone: "badge-danger" };
    case "done": {
      const { exitStatus, exitSignal } = row.result;
      if (exitStatus === 0) return { text: msgD.runs.succeeded, tone: "badge-success" };
      return { text: exitSignal ? msgD.runs.signal(exitSignal) : msgD.runs.exit(exitStatus ?? -1), tone: "badge-danger" };
    }
  }
}

function ResultRow({ host, row }: { host: HostSummary; row: Row | undefined }) {
  const notify = useToast();
  const { text: status, tone } = rowStatus(row);
  const output = row?.state === "done" ? row.result.stdout + (row.result.stderr ? (row.result.stdout ? "\n" : "") + row.result.stderr : "") : "";
  return (
    <li data-host={host.label} data-state={row?.state ?? "queued"} style={{ flexWrap: "wrap" }}>
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
          <div className="row-flex">
            <button
              type="button"
              className="btn btn-sm"
              aria-label={msgRuns.copyOf(host.label)}
              onClick={() =>
                void navigator.clipboard.writeText(output).then(
                  () => notify("success", msgRuns.copied),
                  () => undefined,
                )
              }
            >
              {msgRuns.copy}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={msgRuns.saveOf(host.label)}
              onClick={() =>
                void terminalOutput.save(output).then(
                  (file) => file && notify("success", msgRuns.saved(file)),
                  (error) => notify("danger", toAppError(error).message),
                )
              }
            >
              {msgRuns.save}
            </button>
          </div>
        </details>
      )}
    </li>
  );
}
