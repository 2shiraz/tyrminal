// Shows a note (P-30). Markdown becomes React elements from markdown.ts's tree, so nothing in a
// note is ever parsed as HTML. Links are buttons: a click shows where they go first, web links
// then open through link_open, and an ssh link only offers to add the server as a host. Code
// blocks can only be pasted into a session, always through the paste review.
import type { KeySummary, NoteFormat } from "@tyrminal/contracts";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/controls";
import { IconClipboardPaste, IconExternalLink, IconPlus, IconServer } from "../../components/ui/icons";
import { keys as keysApi, links } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { HostEditor } from "../hosts/HostEditor";
import { type Block, type Inline, type NoteLink, parseMarkdown, pasteText } from "./markdown";

export function NoteView({
  text,
  format,
  onPaste,
}: {
  text: string;
  format: NoteFormat;
  /** Offered on code blocks only where a session can take the paste (the connection panel). */
  onPaste?: ((text: string) => void) | undefined;
}) {
  const [link, setLink] = useState<NoteLink | null>(null);
  const blocks = useMemo(() => (format === "markdown" ? parseMarkdown(text) : null), [text, format]);

  return (
    <div className="note-view selectable">
      {blocks ? (
        blocks.map((block, index) => <BlockView key={index} block={block} onLink={setLink} onPaste={onPaste} />)
      ) : (
        <p className="note-plain">{text}</p>
      )}
      {link && <NoteLinkDialog link={link} onClose={() => setLink(null)} />}
    </div>
  );
}

function BlockView({ block, onLink, onPaste }: { block: Block; onLink: (link: NoteLink) => void; onPaste: ((text: string) => void) | undefined }): ReactNode {
  const inline = (nodes: Inline[]) => <InlineView nodes={nodes} onLink={onLink} />;
  switch (block.t) {
    case "p":
      return <p>{inline(block.c)}</p>;
    case "h": {
      // Note headings sit inside a panel: they are styled, not document-level headings.
      return (
        <p className="note-heading" data-level={block.level}>
          <strong>{inline(block.c)}</strong>
        </p>
      );
    }
    case "list": {
      const items = block.items.map((item, index) => <li key={index}>{inline(item)}</li>);
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return (
        <blockquote>
          {block.c.map((inner, index) => (
            <BlockView key={index} block={inner} onLink={onLink} onPaste={onPaste} />
          ))}
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "code":
      return (
        <div className="note-code">
          <pre className="code-block">
            <code>{block.text}</code>
          </pre>
          {onPaste && pasteText(block.text) && (
            <button type="button" className="btn btn-sm" onClick={() => onPaste(pasteText(block.text))} data-tooltip={msg.notes.pasteHint}>
              <IconClipboardPaste size={14} />
              {msg.notes.paste}
            </button>
          )}
        </div>
      );
  }
}

function InlineView({ nodes, onLink }: { nodes: Inline[]; onLink: (link: NoteLink) => void }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case "text":
            return <Fragment key={index}>{node.v}</Fragment>;
          case "code":
            return <code key={index}>{node.v}</code>;
          case "strong":
            return (
              <strong key={index}>
                <InlineView nodes={node.c} onLink={onLink} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <InlineView nodes={node.c} onLink={onLink} />
              </em>
            );
          case "image":
            return (
              <span key={index} className="note-image">
                {msg.notes.image(node.alt)}
              </span>
            );
          case "link":
            return (
              <button key={index} type="button" className="note-link" title={node.link.url} onClick={() => onLink(node.link)}>
                <InlineView nodes={node.c} onLink={onLink} />
              </button>
            );
        }
        return null;
      })}
    </>
  );
}

/** Where a clicked link goes, before anything happens. */
function NoteLinkDialog({ link, onClose }: { link: NoteLink; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [keyList, setKeyList] = useState<KeySummary[]>([]);
  useEffect(() => {
    if (!adding) return;
    keysApi.list().then(setKeyList, () => setKeyList([]));
  }, [adding]);

  if (adding && link.kind === "ssh") {
    return (
      <HostEditor
        host={null}
        initial={{ address: link.host, port: link.port ?? 22, username: link.username ?? "" }}
        keys={keyList}
        onClose={onClose}
        onSaved={onClose}
      />
    );
  }

  const web = link.kind === "web";
  return (
    <Dialog title={web ? msg.notes.linkTitle : msg.notes.sshTitle} icon={web ? <IconExternalLink size={18} /> : <IconServer size={18} />} onDismiss={onClose}>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {web ? msg.notes.linkBody : msg.notes.sshBody}
      </p>
      <dl className="kv">
        <dt>{msg.notes.linkHost}</dt>
        <dd>
          <strong>{link.host}</strong>
        </dd>
      </dl>
      <pre className="code-block" data-testid="note-link-destination">
        {link.url}
      </pre>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus data-autofocus>
          {msg.common.cancel}
        </button>
        {web ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              links.open(link.url).then(onClose, (e: { message?: string }) => setError(e.message ?? msg.terminal.linkRefused));
            }}
          >
            <IconExternalLink size={15} />
            {msg.notes.linkOpen}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={15} />
            {msg.notes.sshAdd}
          </button>
        )}
      </div>
    </Dialog>
  );
}
