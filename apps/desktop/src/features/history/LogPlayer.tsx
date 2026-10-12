import type { PlaybackFrame, SessionLogPlayback, TerminalPreferences } from "@tyrminal/contracts";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { IconButton } from "../../components/ui/controls";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconPlay, IconX } from "../../components/ui/icons";
import { msgB } from "../../lib/messages-b";
import { fontsReady, terminalOptions } from "../terminal/TerminalController";
import { schemeById } from "../terminal/schemes";

/** Longest pause a replay waits between two frames, before the speed factor. */
const MAX_GAP_MS = 1000;
const SPEEDS = [1, 2, 4, 8] as const;

function decode(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

function apply(term: Terminal, frame: PlaybackFrame) {
  if (frame.type === "output") term.write(decode(frame.data));
  else term.resize(Math.max(2, frame.cols), Math.max(1, frame.rows));
}

/**
 * Read-only playback of a recording. The output is untrusted: nothing the terminal would send
 * back (query replies) goes anywhere, links never open, OSC 52 clipboard requests are swallowed,
 * and title or bell changes are ignored. The terminal keeps the recorded size.
 */
export function LogPlayer({ playback, prefs }: { playback: SessionLogPlayback; prefs: TerminalPreferences }) {
  const ref = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const replayTimer = useRef<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<boolean | null>(null);

  const stopReplay = useCallback(() => {
    if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
    replayTimer.current = null;
    setReplaying(false);
  }, []);

  const showAll = useCallback(() => {
    const t = term.current;
    if (!t) return;
    stopReplay();
    t.reset();
    t.resize(Math.max(2, playback.cols), Math.max(1, playback.rows));
    for (const frame of playback.frames) apply(t, frame);
  }, [playback, stopReplay]);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const t = new Terminal({
      ...terminalOptions(prefs),
      cols: Math.max(2, playback.cols),
      rows: Math.max(1, playback.rows),
      disableStdin: true,
      cursorBlink: false,
      scrollback: 100_000,
      // OSC 8 hyperlinks in a recording do nothing.
      linkHandler: { activate: () => undefined, allowNonHttpProtocols: false },
    });
    // Clipboard writes (OSC 52) from recorded output are dropped.
    const osc52 = t.parser.registerOscHandler(52, () => true);
    const s = new SearchAddon();
    t.loadAddon(s);
    t.loadAddon(new UnicodeGraphemesAddon());
    t.unicode.activeVersion = "15-graphemes";
    t.open(container);
    term.current = t;
    search.current = s;
    void fontsReady(prefs).then(() => showAll());
    return () => {
      if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
      osc52.dispose();
      t.dispose();
      term.current = null;
      search.current = null;
    };
    // The terminal is created once per playback; showAll is stable for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback]);

  function replay() {
    const t = term.current;
    if (!t) return;
    stopReplay();
    t.reset();
    t.resize(Math.max(2, playback.cols), Math.max(1, playback.rows));
    setReplaying(true);
    let index = 0;
    const step = () => {
      const frame = playback.frames[index];
      if (!frame) {
        replayTimer.current = null;
        setReplaying(false);
        return;
      }
      apply(t, frame);
      index += 1;
      const next = playback.frames[index];
      if (!next) {
        replayTimer.current = null;
        setReplaying(false);
        return;
      }
      const gap = Math.min(MAX_GAP_MS, Math.max(0, next.atMs - frame.atMs)) / speed;
      replayTimer.current = window.setTimeout(step, gap);
    };
    step();
  }

  function find(forward: boolean) {
    const s = search.current;
    if (!s || query === "") return;
    const options = { caseSensitive: false };
    setFound(forward ? s.findNext(query, options) : s.findPrevious(query, options));
  }

  const scheme = schemeById(prefs.scheme);
  return (
    <div className="stack">
      <div className="player-toolbar" role="toolbar" aria-label={msgB.recordings.playerLabel(playback.log.title)}>
        {replaying ? (
          <button type="button" className="btn btn-sm" onClick={stopReplay}>
            <IconX size={13} />
            {msgB.recordings.stopReplay}
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={replay}>
            <IconPlay size={13} />
            {msgB.recordings.replay}
          </button>
        )}
        <label className="player-speed">
          <span>{msgB.recordings.speed}</span>
          <select
            className="select"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value) as (typeof SPEEDS)[number])}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={showAll}>
          <IconChevronDown size={13} />
          {msgB.recordings.showAll}
        </button>
        <span className="spacer" />
        <input
          className="input"
          type="search"
          aria-label={msgB.recordings.find}
          placeholder={msgB.recordings.find}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFound(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find(!event.shiftKey);
            }
          }}
        />
        <IconButton size="sm" label={msgB.recordings.findPrevious} onClick={() => find(false)}>
          <IconChevronLeft size={14} />
        </IconButton>
        <IconButton size="sm" label={msgB.recordings.findNext} onClick={() => find(true)}>
          <IconChevronRight size={14} />
        </IconButton>
        {found === false && (
          <span className="muted" role="status" style={{ fontSize: "var(--text-sm)" }}>
            {msgB.recordings.noMatch}
          </span>
        )}
      </div>
      <div
        className="log-player"
        style={{ background: scheme.background, padding: prefs.padding }}
        data-testid="log-player"
        aria-label={msgB.recordings.playerLabel(playback.log.title)}
        role="region"
      >
        <div ref={ref} />
      </div>
    </div>
  );
}
