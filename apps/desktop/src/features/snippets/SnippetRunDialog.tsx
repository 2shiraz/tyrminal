import type { SnippetSummary } from "@tyrminal/contracts";

import { Dialog } from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/controls";
import { IconClipboardPaste, IconPlay } from "../../components/ui/icons";
import { msg } from "../../lib/messages";

export interface SnippetRunRequest {
  snippet: SnippetSummary;
  mode: "paste" | "run";
  paneId: number;
  /** The session shown in the preview; the send is refused if the pane has moved on. */
  sessionId: string;
  targetLabel: string;
  targetIdentity: string;
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
