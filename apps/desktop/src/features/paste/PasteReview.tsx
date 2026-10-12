import { useMemo, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/controls";
import { IconClipboardPaste } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgP } from "../../lib/messages-paste";
import { analyzePaste, previewSegments, withoutBracketEnd } from "./pasteSafety";

/**
 * The paste review (P-14, P-25): names the session the text goes to, shows every character that
 * would not show on screen, and cannot send a bracketed-paste end marker. Cancel has focus.
 */
export function PasteReview({
  text: original,
  bracketed,
  target,
  onCancel,
  onSend,
}: {
  text: string;
  bracketed: boolean;
  target: { label: string; identity: string };
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState(original);
  const analysis = useMemo(() => analyzePaste(text), [text]);
  const segments = useMemo(() => previewSegments(text), [text]);
  const kinds = [...new Set(analysis.hidden.map((h) => h.kind))];

  return (
    <Dialog title={msgP.title(target.label)} icon={<IconClipboardPaste size={18} />} tone="warning" wide onDismiss={onCancel}>
      <p className="paste-target mono">{msgP.target(target.label, target.identity)}</p>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {analysis.runsAtOnce ? msgP.runsAtOnce : analysis.lines > 1 ? msgP.lines(analysis.lines) : null}
      </p>
      {(analysis.hidden.length > 0 || analysis.hasBracketEnd) && (
        <div role="alert" className="stack-xs">
          {analysis.hidden.length > 0 && (
            <Notice tone="warning">
              {msgP.hidden(analysis.hidden.length)} ({kinds.map((k) => msgP.hiddenKinds[k]).join("; ")})
            </Notice>
          )}
          {analysis.hasBracketEnd && <Notice tone="danger">{msgP.bracketEnd}</Notice>}
        </div>
      )}
      <pre className="code-block paste-preview" aria-label={msgP.preview}>
        {segments.map((s, i) =>
          // Positional pieces of one text.
          "text" in s ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i} className="paste-hidden" data-kind={s.hidden.kind} title={msgP.hiddenKinds[s.hidden.kind]}>
              {s.hidden.label}
            </span>
          ),
        )}
      </pre>
      {bracketed && !analysis.hasBracketEnd && <Notice tone="info">{msgP.bracketed}</Notice>}
      <div className="dialog-actions">
        {analysis.hasBracketEnd && (
          <button type="button" className="btn" onClick={() => setText(withoutBracketEnd(text))}>
            {msgP.removeBracketEnd}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        <button type="button" className="btn btn-primary" disabled={analysis.hasBracketEnd} onClick={() => onSend(text)}>
          {msgP.send}
        </button>
      </div>
    </Dialog>
  );
}
