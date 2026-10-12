// tmux and screen session awareness (P-31) in the connection side panel. The core lists the
// server's sessions with a fixed command on a separate exec channel; names are shown as plain
// text. Attach is offered only where the core built a command, and it is typed into the session
// only when the user chooses it.

import type { MultiplexerList, MultiplexerSession } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { ErrorNotice } from "../../components/ui/controls";
import { IconRefreshCw } from "../../components/ui/icons";
import { type AppError, multiplexers, toAppError } from "../../lib/ipc";
import { msgMx } from "../../lib/messages-multiplexers";

export function MultiplexerSection({ sessionId, onAttach }: { sessionId: string; onAttach: (session: MultiplexerSession) => void }) {
  const [list, setList] = useState<MultiplexerList | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [round, setRound] = useState(0);
  const [pending, setPending] = useState(false);

  // Listed when the panel opens (or shows another session) and on Refresh; never on a timer.
  useEffect(() => {
    let live = true;
    setPending(true);
    setError(null);
    multiplexers.list(sessionId).then(
      (result) => {
        if (!live) return;
        setList(result);
        setPending(false);
      },
      (e) => {
        if (!live) return;
        setError(toAppError(e));
        setPending(false);
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, round]);

  return (
    <section className="stack-sm" aria-labelledby="mux-title" data-testid="multiplexers">
      <div className="row-flex" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 id="mux-title" style={{ fontSize: "var(--text-sm)" }}>
          {msgMx.title}
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRound((r) => r + 1)} disabled={pending} aria-label={msgMx.refresh}>
          <IconRefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="muted" style={{ fontSize: "var(--text-xs)" }}>
        {msgMx.hint}
      </p>
      <ErrorNotice error={error} />
      {pending && list === null && <p className="muted">{msgMx.loading}</p>}
      {list?.state === "not_available" && <p className="muted">{msgMx.unavailable[list.reason]}</p>}
      {list?.state === "listed" && <Sessions list={list} onAttach={onAttach} />}
    </section>
  );
}

function Sessions({ list, onAttach }: { list: Extract<MultiplexerList, { state: "listed" }>; onAttach: (session: MultiplexerSession) => void }) {
  if (!list.tmuxInstalled && !list.screenInstalled) return <p className="muted">{msgMx.notInstalled}</p>;
  if (list.sessions.length === 0) return <p className="muted">{msgMx.none}</p>;
  return (
    <>
      <ul className="mux-sessions" aria-label={msgMx.title}>
        {list.sessions.map((s, i) => (
          <li key={`${s.kind}-${i}`} data-kind={s.kind}>
            <span className="stack-xs" style={{ minWidth: 0, flex: 1 }}>
              {/* Untrusted text from the server, rendered as text only. */}
              <span className="mono truncate" data-testid="mux-name">
                {s.name}
              </span>
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                {[msgMx.kind(s.kind), s.windows != null ? msgMx.windows(s.windows) : null, s.attached ? msgMx.attached : null].filter(Boolean).join(" · ")}
              </span>
              {!s.attachCommand && (
                <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                  {msgMx.notAttachable}
                </span>
              )}
            </span>
            {s.attachCommand && (
              <button type="button" className="btn btn-sm" onClick={() => onAttach(s)} aria-label={msgMx.attachLabel(s.kind, s.name)}>
                {msgMx.attach}
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.truncated && <p className="muted">{msgMx.truncated}</p>}
    </>
  );
}
