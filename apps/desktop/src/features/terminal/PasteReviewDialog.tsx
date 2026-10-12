import type { ReactNode } from "react";
import { useMemo } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/controls";
import { IconClipboardPaste } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgPaste } from "../../lib/messages-paste";
import { type PasteCheck, type PasteReason, removeBracketEnd, visibleSegments } from "./pasteSafety";
import { lineCount } from "./terminalPolicy";

export interface PasteTarget {
  /** The host (or local shell) as the user named it. */
  name: string;
  /** Where the session goes, as configured by the user (not supplied by the server). */
  identity: string;
  /** Extra labels for the target, such as an environment label; nothing fills this yet. */
  labels?: ReactNode;
}

const TITLES: Record<PasteReason, string> = {
  bracket_end: msgPaste.titleBracketEnd,
  hidden: msgPaste.titleHidden,
  multiline: msgPaste.titleMultiline,
  large: msgPaste.titleLarge,
  trailing_newline: msgPaste.titleTrailingNewline,
};

/**
 * The review shown before a paste is sent (P-14, P-25). It names the session the text goes to and
 * shows the exact text with control and invisible characters made visible. A paste that holds the
 * bracketed-paste end marker cannot be sent as it is, only with the marker removed.
 */
export function PasteReviewDialog({
  text,
  check,
  bracketed,
  target,
  onSend,
  onCancel,
}: {
  text: string;
  check: PasteCheck;
  bracketed: boolean;
  target: PasteTarget;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const segments = useMemo(() => {
    // Neighbouring hidden characters share one span so a long run stays cheap to render.
    const merged: { text: string; hidden: boolean }[] = [];
    for (const s of visibleSegments(text)) {
      const last = merged.at(-1);
      if (last && last.hidden && s.hidden) last.text += s.text;
      else merged.push({ ...s });
    }
    return merged;
  }, [text]);
  const reasons = new Set(check.reasons);
  const title = TITLES[check.reasons[0] ?? "multiline"];
  return (
    <Dialog title={title} icon={<IconClipboardPaste size={18} />} tone="warning" wide onDismiss={onCancel}>
      <p className="paste-target" data-testid="paste-target">
        <span className="muted">{msgPaste.target}</span> <strong>{target.name}</strong>
        <span className="muted"> · {target.identity}</span>
        {target.labels}
      </p>
      {reasons.has("bracket_end") && <Notice tone="danger">{msgPaste.bracketEnd}</Notice>}
      {reasons.has("hidden") && <Notice tone="warning">{msgPaste.hidden(check.hidden.length)}</Notice>}
      {reasons.has("multiline") && (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgPaste.multiline(lineCount(text))}
        </p>
      )}
      {reasons.has("large") && (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgPaste.large(text.length)}
        </p>
      )}
      {reasons.has("trailing_newline") && (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgPaste.trailingNewline}
        </p>
      )}
      <pre className="code-block" aria-label={msgPaste.textLabel}>
        {segments.map((s, index) =>
          s.hidden ? (
            // Position is the identity here: the segments are a fixed split of one string.
            <mark key={index} className="paste-hidden">
              {s.text}
            </mark>
          ) : (
            <span key={index}>{s.text}</span>
          ),
        )}
      </pre>
      {bracketed && !check.bracketEnd && <Notice tone="info">{msg.terminal.pasteBracketed}</Notice>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        {check.bracketEnd ? (
          <button type="button" className="btn btn-primary" onClick={() => onSend(removeBracketEnd(text))}>
            {msgPaste.removeMarker}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => onSend(text)}>
            {msg.terminal.pasteSend}
          </button>
        )}
      </div>
    </Dialog>
  );
}
