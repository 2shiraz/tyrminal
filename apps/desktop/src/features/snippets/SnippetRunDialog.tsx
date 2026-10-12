import type { SnippetSummary } from "@tyrminal/contracts";

import { Dialog } from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/controls";
import { IconClipboardPaste, IconPlay } from "../../components/ui/icons";
import { variableRefs } from "../../lib/environment";
import { msg } from "../../lib/messages";
import { msgEnv } from "../../lib/messages-env";
import type { SessionEnvironment } from "../terminal/TerminalView";

export interface SnippetRunRequest {
  snippet: SnippetSummary;
  mode: "paste" | "run";
  paneId: number;
  /** The session shown in the preview; the send is refused if the pane has moved on. */
  sessionId: string;
  targetLabel: string;
  targetIdentity: string;
  /** Variables the target session requested and those its server refused (SSH only). */
  environment?: SessionEnvironment | null;
}

export type VariableState = "set" | "refused" | "unknown";

/** How each variable a snippet references stands on the target session (SNP-14). */
export function variableStates(text: string, environment: SessionEnvironment | null | undefined): [string, VariableState][] {
  return variableRefs(text).map((name) => [
    name,
    environment?.rejected.includes(name) ? "refused" : environment?.sent.includes(name) ? "set" : "unknown",
  ]);
}

/** A snippet is reviewed first when it has several lines or uses a variable the server refused. */
export function needsSnippetReview(request: SnippetRunRequest): boolean {
  const lines = request.snippet.text.replace(/\n$/, "").split("\n").length;
  return lines > 1 || variableStates(request.snippet.text, request.environment).some(([, state]) => state === "refused");
}

function VariableList({ request }: { request: SnippetRunRequest }) {
  const states = variableStates(request.snippet.text, request.environment);
  if (states.length === 0) return null;
  const label = { set: msgEnv.refSet, refused: msgEnv.refRefused, unknown: msgEnv.refUnknown };
  return (
    <div className="stack-xs">
      <span className="label">{msgEnv.refs}</span>
      <ul className="var-refs" aria-label={msgEnv.refs}>
        {states.map(([name, state]) => (
          <li key={name} data-state={state}>
            <span className="mono">${name}</span> <span className="faint">{label[state]}</span>
          </li>
        ))}
      </ul>
      {states.some(([, state]) => state !== "set") && <p className="hint">{msgEnv.refsHint}</p>}
    </div>
  );
}

/** Preview of a multi-line snippet: the exact text and the exact target, before anything is sent. */
export function SnippetRunDialog({ request, onCancel, onConfirm }: { request: SnippetRunRequest; onCancel: () => void; onConfirm: () => void }) {
  const lines = request.snippet.text.replace(/\n$/, "").split("\n").length;
  const run = request.mode === "run";
  return (
    <Dialog
      title={run ? msg.snippets.previewRunTitle(request.snippet.name) : msg.snippets.previewPasteTitle(request.snippet.name)}
      role="alertdialog"
      icon={run ? <IconPlay size={18} /> : <IconClipboardPaste size={18} />}
      tone={run ? "warning" : "accent"}
      wide
      onDismiss={onCancel}
    >
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msg.snippets.previewBody(lines)}
      </p>
      <div className="panel-target" data-ready="true" style={{ margin: 0 }}>
        <span className="status-dot" data-tone="ok" aria-hidden="true" />
        <strong>{request.targetLabel}</strong>
        <span className="faint mono">{request.targetIdentity}</span>
      </div>
      <pre className="code-block">{request.snippet.text}</pre>
      <VariableList request={request} />
      {run && <Notice tone="warning">{msg.snippets.textHint}</Notice>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          {run ? <IconPlay size={15} /> : <IconClipboardPaste size={15} />}
          {run ? msg.snippets.previewRun(lines) : msg.snippets.previewPaste}
        </button>
      </div>
    </Dialog>
  );
}
