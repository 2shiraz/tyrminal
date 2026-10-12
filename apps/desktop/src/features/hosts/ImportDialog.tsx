import type { GroupSummary, ImportFormat, ImportPreview } from "@tyrminal/contracts";
import { useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice } from "../../components/ui/controls";
import { IconFolderOpen, IconUpload } from "../../components/ui/icons";
import { importer, knownHostImport } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";
import { groupPath } from "./HostEditor";

const MAX_IMPORT_BYTES = 1024 * 1024;

/** A file source, or the vault's own trusted known hosts (no file). */
type Source = ImportFormat | "known_hosts";

const ACCEPT: Partial<Record<ImportFormat, string>> = {
  csv: ".csv,text/csv",
  putty_reg: ".reg",
  mobaxterm: ".ini,.mxtsessions",
  securecrt: ".xml,.ini",
};

/**
 * Decodes a chosen file: UTF-16 with a byte-order mark (regedit writes .reg files that way) or
 * UTF-8. Invalid sequences become U+FFFD; the core then rejects or skips what does not validate.
 */
export function decodeImportFile(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Import in two steps: choose a file (read in the page as text, never executed), see what would
 * be added and what is left out, then import everything in one transaction.
 */
export function ImportDialog({
  groups,
  intoGroup,
  onClose,
  onImported,
}: {
  groups: GroupSummary[];
  intoGroup: string | null;
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [format, setFormat] = useState<Source>("openssh_config");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [target, setTarget] = useState<string | null>(intoGroup);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { pending, error, run } = useAction();

  async function chosen(file: File | undefined) {
    if (!file) return;
    setPreview(null);
    setProblem(null);
    setFileName(file.name);
    if (file.size > MAX_IMPORT_BYTES) {
      setProblem(msg.hosts.importTooLarge);
      return;
    }
    if (format === "known_hosts") return;
    const source = format;
    const text = decodeImportFile(await file.arrayBuffer());
    const result = await run(() => importer.preview(source, text));
    if (result) {
      setPreview(result);
      if (result.hosts.length === 0) setProblem(msg.hosts.importNothing);
    }
  }

  async function loadKnownHosts() {
    setPreview(null);
    setProblem(null);
    setFileName(null);
    const result = await run(() => knownHostImport.preview());
    if (result) {
      setPreview(result);
      if (result.hosts.length === 0) setProblem(msgD.import.knownHostsNone);
    }
  }

  async function confirm() {
    if (!preview || preview.hosts.length === 0 || pending) return;
    const count = await run(() => importer.run(preview.hosts, target));
    if (count !== undefined && count !== null) onImported(count);
  }

  return (
    <Dialog title={msg.hosts.importTitle} icon={<IconUpload size={18} />} onDismiss={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgD.import.body}
        </p>
        <label className="field">
          <span className="label">{msg.hosts.importFormat}</span>
          <select
            className="select"
            value={format}
            onChange={(event) => {
              const value = event.target.value as Source;
              setFormat(value);
              setPreview(null);
              setFileName(null);
              setProblem(null);
              if (value === "known_hosts") void loadKnownHosts();
            }}
          >
            <option value="openssh_config">{msg.hosts.importOpenssh}</option>
            <option value="csv">{msg.hosts.importCsv}</option>
            <option value="putty_reg">{msgD.import.putty}</option>
            <option value="mobaxterm">{msgD.import.mobaxterm}</option>
            <option value="securecrt">{msgD.import.securecrt}</option>
            <option value="known_hosts">{msgD.import.knownHosts}</option>
          </select>
        </label>
        {format === "csv" && <p className="hint">{msg.hosts.importCsvHint}</p>}
        {format === "putty_reg" && <p className="hint">{msgD.import.puttyHint}</p>}
        {format === "mobaxterm" && <p className="hint">{msgD.import.mobaxtermHint}</p>}
        {format === "securecrt" && <p className="hint">{msgD.import.securecrtHint}</p>}
        {format === "known_hosts" && <p className="hint">{msgD.import.knownHostsHint}</p>}
        {format !== "known_hosts" && (
          <div className="row-flex" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={pending} data-autofocus>
              <IconFolderOpen size={15} />
              {msg.hosts.importChoose}
            </button>
            {fileName && (
              <span className="mono selectable" data-testid="import-file">
                {fileName}
              </span>
            )}
            <input
              ref={input}
              type="file"
              hidden
              accept={ACCEPT[format]}
              aria-label={msg.hosts.importChoose}
              onChange={(event) => {
                void chosen(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        )}

        {problem && <Notice tone="warning">{problem}</Notice>}

        {preview && preview.hosts.length > 0 && (
          <div className="stack-sm" data-testid="import-preview">
            <Notice tone="success">
              <strong>{msg.hosts.importPreview(preview.hosts.length)}.</strong> {msg.hosts.importAuthNote}
            </Notice>
            <ul className="list import-list" aria-label={msg.hosts.importPreview(preview.hosts.length)}>
              {preview.hosts.slice(0, 200).map((h, i) => (
                <li key={`${h.label}-${i}`}>
                  <div className="row-main">
                    <span className="row-title">{h.label}</span>
                    <span className="row-sub">
                      {msg.hosts.destination(h.username, h.address, h.port)}
                      {h.group ? ` · ${h.group}` : ""}
                      {h.tags.length > 0 ? ` · ${h.tags.join(", ")}` : ""}
                    </span>
                    {h.notes.map((note) => (
                      <span key={note} className="hint">
                        {note}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {preview.duplicates.length > 0 && <Notice tone="warning">{msg.hosts.importDuplicates(preview.duplicates.slice(0, 20).join(", "))}</Notice>}
            {groups.length > 0 && (
              <label className="field">
                <span className="label">{msg.hosts.importInto}</span>
                <select className="select" value={target ?? ""} onChange={(event) => setTarget(event.target.value || null)}>
                  <option value="">{msg.hosts.groupTopLevel}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {groupPath(groups, g.id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {preview && preview.skipped.length > 0 && (
          <details className="import-skipped" data-testid="import-skipped">
            <summary>{msg.hosts.importSkipped(preview.skipped.length)}</summary>
            <ul className="stack-xs" style={{ marginTop: 8 }}>
              {preview.skipped.map((s, i) => (
                <li key={`${s.line}-${i}`} className="hint">
                  {s.line > 0 && <span className="mono">{msg.hosts.lineShort(s.line)} </span>}
                  {s.text && <span className="mono selectable">{s.text}</span>} — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}

        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!preview || preview.hosts.length === 0 || pending}
            onClick={confirm}
          >
            {pending ? msg.common.working : msg.hosts.importRun(preview?.hosts.length ?? 0)}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
