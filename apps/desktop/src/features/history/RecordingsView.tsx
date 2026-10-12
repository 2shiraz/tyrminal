import type { RecordingSettings, SessionLogPlayback, SessionLogSummary } from "@tyrminal/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import {
  EmptyState,
  ErrorNotice,
  IconButton,
  Notice,
  Segmented,
  SettingRow,
  SkeletonRows,
  Switch,
  TextArea,
} from "../../components/ui/controls";
import {
  IconBookmark,
  IconBookmarkCheck,
  IconChevronLeft,
  IconEllipsis,
  IconHistory,
  IconPencil,
  IconPlay,
  IconScrollText,
  IconSearch,
  IconSquareTerminal,
  IconTrash2,
} from "../../components/ui/icons";
import { preferences, recordings as recordingsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { bytes, msgB } from "../../lib/messages-b";
import { useAction, useLoaded } from "../../lib/useAsync";
import { LogPlayer } from "./LogPlayer";

const KEEP_CHOICES = [1, 3, 5, 10, 20, 50, 100];
const LIMIT_CHOICES = [16, 64, 128, 256, 512];
/** How often the list refreshes while a session is being recorded. */
const POLL_MS = 3000;

type Filter = "all" | "bookmarked";

function stateBadge(state: SessionLogSummary["state"]) {
  const tone =
    state === "recording" ? "badge badge-accent" : state === "complete" ? "badge" : state === "size_limit" ? "badge badge-warning" : "badge badge-danger";
  return <span className={tone}>{msgB.recordings.states[state]}</span>;
}

function when(log: SessionLogSummary): string {
  const started = new Date(log.startedAt).toLocaleString();
  const duration = log.endedAt !== null ? ` · ${msgB.recordings.duration(log.endedAt - log.startedAt)}` : "";
  return `${started}${duration} · ${bytes(log.sizeBytes)}`;
}

/** Matches title, comment and state, case-insensitively, on every word of the query. */
function matches(log: SessionLogSummary, query: string): boolean {
  const haystack = `${log.title} ${log.comment} ${msgB.recordings.states[log.state]}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** The Recordings page: the recording switch and limits, the stored recordings, and playback. */
export function RecordingsView() {
  const settings = useLoaded(recordingsApi.settings);
  const logs = useLoaded(recordingsApi.list);
  const storage = useLoaded(recordingsApi.storage);
  const prefs = useLoaded(preferences.get);
  const notify = useToast();
  const opening = useAction();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [playing, setPlaying] = useState<SessionLogPlayback | null>(null);
  const [commenting, setCommenting] = useState<SessionLogSummary | null>(null);
  const [deleting, setDeleting] = useState<SessionLogSummary | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [menu, setMenu] = useState<{ log: SessionLogSummary; anchor: HTMLElement } | null>(null);
  const reloadLogs = logs.reload;
  const reloadStorage = storage.reload;

  const refresh = useCallback(() => {
    void reloadLogs();
    void reloadStorage();
  }, [reloadLogs, reloadStorage]);

  const anyRecording = (logs.value ?? []).some((l) => l.state === "recording");
  useEffect(() => {
    if (!anyRecording) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRecording, refresh]);

  const fail = useCallback((error: unknown) => notify("danger", (error as Error).message), [notify]);

  // The page's own copy of the settings. Each change applies to the latest copy and saves are
  // sent one after another, so two quick changes never overwrite each other.
  const [local, setLocal] = useState<RecordingSettings | null>(null);
  const latest = useRef<RecordingSettings | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (settings.value && latest.current === null) {
      latest.current = settings.value;
      setLocal(settings.value);
    }
  }, [settings.value]);

  function change(patch: Partial<RecordingSettings>) {
    const before = latest.current;
    if (!before) return;
    const next = { ...before, ...patch };
    latest.current = next;
    setLocal(next);
    queue.current = queue.current.then(async () => {
      try {
        await recordingsApi.setSettings(next);
        if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
          notify("info", next.enabled ? msgB.recordings.turnedOn : msgB.recordings.turnedOff);
        }
        refresh();
      } catch (error) {
        fail(error);
        // Show what is actually stored.
        const stored = await recordingsApi.settings().catch(() => null);
        if (stored) {
          latest.current = stored;
          setLocal(stored);
        }
      }
    });
  }

  async function toggleBookmark(log: SessionLogSummary) {
    try {
      await recordingsApi.bookmark(log.id, !log.bookmarked, log.comment);
      refresh();
    } catch (error) {
      fail(error);
    }
  }

  async function open(log: SessionLogSummary) {
    const playback = await opening.run(() => recordingsApi.open(log.id));
    if (playback) setPlaying(playback);
    refresh();
  }

  const all = logs.value ?? [];
  const shown = useMemo(
    () => all.filter((l) => (filter === "all" || l.bookmarked) && matches(l, query)),
    [all, filter, query],
  );

  if (playing && prefs.value) {
    const log = playing.log;
    return (
      <div className="page">
        <section className="page-inner stack" aria-labelledby="recording-title">
          <div className="page-header">
            <button type="button" className="btn btn-sm" onClick={() => setPlaying(null)}>
              <IconChevronLeft size={14} />
              {msgB.recordings.back}
            </button>
          </div>
          <div className="page-title">
            <h1 id="recording-title">
              {log.title} {stateBadge(log.state)} {log.bookmarked && <span className="badge badge-accent">{msgB.recordings.bookmark}</span>}
            </h1>
            <p>{when(log)}</p>
            {log.comment && <p className="selectable">{log.comment}</p>}
          </div>
          <Notice tone="info">{msgB.recordings.readOnly}</Notice>
          {log.state === "recording" && <Notice tone="info">{msgB.recordings.recordingNote}</Notice>}
          {log.state === "incomplete" && <Notice tone="warning">{msgB.recordings.incompleteNote}</Notice>}
          {log.state === "damaged" && <Notice tone="danger">{msgB.recordings.damagedNote}</Notice>}
          {log.state === "size_limit" && <Notice tone="warning">{msgB.recordings.sizeLimitNote}</Notice>}
          {playing.truncated && <Notice tone="warning">{msgB.recordings.truncated}</Notice>}
          <LogPlayer playback={playing} prefs={prefs.value.terminal} />
        </section>
      </div>
    );
  }

  const current = local;
  return (
    <div className="page">
      <section className="page-inner stack" aria-labelledby="recordings-title" style={{ maxWidth: 960 }}>
        <div className="page-header">
          <div className="page-title">
            <h1 id="recordings-title">{msgB.recordings.title}</h1>
            <p>{msgB.recordings.subtitle}</p>
          </div>
        </div>

        <section className="section" aria-label={msgB.recordings.record}>
          <ErrorNotice error={settings.error} />
          {current && (
            <div className="stack">
              <Switch
                label={msgB.recordings.record}
                hint={msgB.recordings.recordHint}
                checked={current.enabled}
                onChange={(enabled) => change({ enabled })}
              />
              <SettingRow label={msgB.recordings.keep} hint={msgB.recordings.keepHint}>
                <select
                  className="select"
                  aria-label={msgB.recordings.keep}
                  value={current.keepPerHost}
                  onChange={(event) => change({ keepPerHost: Number(event.target.value) })}
                >
                  {[...new Set([...KEEP_CHOICES, current.keepPerHost])].sort((a, b) => a - b).map((n) => (
                    <option key={n} value={n}>
                      {msgB.recordings.keepValue(n)}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow label={msgB.recordings.limit} hint={msgB.recordings.limitHint}>
                <select
                  className="select"
                  aria-label={msgB.recordings.limit}
                  value={current.maxLogMib}
                  onChange={(event) => change({ maxLogMib: Number(event.target.value) })}
                >
                  {[...new Set([...LIMIT_CHOICES, current.maxLogMib])].sort((a, b) => a - b).map((n) => (
                    <option key={n} value={n}>
                      {msgB.recordings.limitValue(n)}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </div>
          )}
        </section>

        <section className="section" aria-labelledby="recordings-stored">
          <div className="section-head">
            <h2 id="recordings-stored">{msgB.recordings.title}</h2>
            <span className="muted" data-testid="recordings-storage" style={{ fontSize: "var(--text-sm)" }}>
              {storage.value ? msgB.recordings.storage(storage.value.count, storage.value.totalBytes) : ""}
            </span>
            <span className="spacer" />
            {all.length > 0 && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeletingAll(true)}>
                <IconTrash2 size={13} />
                {msgB.recordings.deleteAll}
              </button>
            )}
          </div>
          {all.length > 0 && (
            <div className="toolbar">
              <div className="input-with-icon">
                <IconSearch size={15} />
                <input
                  className="input"
                  type="search"
                  aria-label={msgB.recordings.search}
                  placeholder={msgB.recordings.searchPlaceholder}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <span className="spacer" />
              <Segmented<Filter>
                label={msgB.recordings.filter}
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: msgB.recordings.filterAll },
                  { value: "bookmarked", label: msgB.recordings.filterBookmarked },
                ]}
              />
            </div>
          )}
          <ErrorNotice error={logs.error ?? opening.error} />
          {logs.value === null && !logs.error && <SkeletonRows count={3} />}
          {logs.value && all.length === 0 && (
            <EmptyState
              icon={<IconHistory size={26} />}
              title={msgB.recordings.emptyTitle}
              body={current?.enabled ? msgB.recordings.emptyOnBody : msgB.recordings.emptyOffBody}
              headingLevel={3}
            />
          )}
          {all.length > 0 && shown.length === 0 && (
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {msgB.recordings.noMatches}
            </p>
          )}
          {shown.length > 0 && (
            <ul className="list" aria-label={msgB.recordings.title} data-testid="recordings">
              {shown.map((log) => (
                <li key={log.id} data-recording={log.title} data-state={log.state}>
                  <span className="tile-icon" aria-hidden="true">
                    {log.kind === "local" ? <IconSquareTerminal size={17} /> : <IconScrollText size={17} />}
                  </span>
                  <div className="row-main">
                    <span className="row-title">
                      {log.title} {stateBadge(log.state)}
                    </span>
                    <span className="row-sub">{when(log)}</span>
                    {log.comment && <span className="row-sub selectable">{log.comment}</span>}
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={msgB.recordings.openNamed(log.title)}
                      disabled={log.state === "unreadable" || opening.pending}
                      onClick={() => void open(log)}
                    >
                      <IconPlay size={13} />
                      {msgB.recordings.open}
                    </button>
                    <IconButton
                      size="sm"
                      label={log.bookmarked ? msgB.recordings.unbookmarkNamed(log.title) : msgB.recordings.bookmarkNamed(log.title)}
                      aria-pressed={log.bookmarked}
                      onClick={() => void toggleBookmark(log)}
                    >
                      {log.bookmarked ? <IconBookmarkCheck size={15} /> : <IconBookmark size={15} />}
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={msgB.recordings.more(log.title)}
                      aria-haspopup="menu"
                      onClick={(event) => setMenu({ log, anchor: event.currentTarget })}
                    >
                      <IconEllipsis size={15} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>

      {menu && (
        <Menu
          label={msgB.recordings.more(menu.log.title)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: msgB.recordings.editComment, icon: <IconPencil size={15} />, onSelect: () => setCommenting(menu.log) },
            "separator",
            {
              label: msgB.recordings.delete,
              icon: <IconTrash2 size={15} />,
              tone: "danger",
              onSelect: () => setDeleting(menu.log),
            },
          ]}
        />
      )}

      {commenting && (
        <CommentDialog
          log={commenting}
          onClose={() => setCommenting(null)}
          onSaved={() => {
            setCommenting(null);
            refresh();
          }}
        />
      )}

      {deleting && (
        <Dialog title={msgB.recordings.deleteTitle} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => setDeleting(null)}>
          <p>{msgB.recordings.deleteBody(deleting.title)}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" autoFocus data-autofocus onClick={() => setDeleting(null)}>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                void recordingsApi.remove(target.id).then(refresh, fail);
              }}
            >
              {msgB.recordings.delete}
            </button>
          </div>
        </Dialog>
      )}

      {deletingAll && (
        <Dialog title={msgB.recordings.deleteAllTitle} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => setDeletingAll(false)}>
          <p>{msgB.recordings.deleteAllBody}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" autoFocus data-autofocus onClick={() => setDeletingAll(false)}>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setDeletingAll(false);
                void recordingsApi.removeAll().then((n) => {
                  notify("info", msgB.recordings.deletedAll(n));
                  refresh();
                }, fail);
              }}
            >
              {msgB.recordings.deleteAllConfirm}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function CommentDialog({ log, onClose, onSaved }: { log: SessionLogSummary; onClose: () => void; onSaved: () => void }) {
  const [comment, setComment] = useState(log.comment);
  const [bookmarked, setBookmarked] = useState(true);
  const { pending, error, run } = useAction();

  async function submit() {
    const saved = await run(() => recordingsApi.bookmark(log.id, bookmarked, comment));
    if (saved) onSaved();
  }

  return (
    <Dialog title={msgB.recordings.commentTitle} icon={<IconBookmark size={18} />} onDismiss={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextArea
          label={msgB.recordings.commentLabel}
          hint={msgB.recordings.commentHint}
          value={comment}
          onChange={setComment}
          maxLength={2000}
          rows={4}
          mono={false}
          autoFocus
        />
        <Switch label={msgB.recordings.bookmark} checked={bookmarked} onChange={setBookmarked} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {msgB.recordings.saveComment}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
