import type { ContainerEngine, ContainerInfo, ContainerList } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconSquareTerminal } from "../../components/ui/icons";
import { sessions } from "../../lib/ipc";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";

export const engineName = (engine: ContainerEngine) => (engine === "docker" ? "Docker" : "Podman");

/**
 * P-33: the running containers on the host of a connected SSH session. Names, images and statuses
 * come from the server and are shown as plain text only. Opening a shell passes only the engine
 * and the container's ID; the core checks the ID again before anything reaches the server.
 */
export function ContainersDialog({
  sessionId,
  host,
  onOpen,
  onClose,
}: {
  sessionId: string;
  host: string;
  onOpen: (engine: ContainerEngine, container: ContainerInfo) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<ContainerList | null>(null);
  const load = useAction();
  const run = load.run;

  const refresh = useCallback(() => {
    setList(null);
    void run(() => sessions.containers(sessionId)).then((result) => {
      if (result) setList(result);
    });
  }, [sessionId, run]);

  useEffect(refresh, [refresh]);

  const engine = list?.engine ?? null;
  return (
    <Dialog title={msgD.containers.title(host)} icon={<IconSquareTerminal size={18} />} wide onDismiss={onClose}>
      <div className="stack">
        <p className="muted">{msgD.containers.body}</p>
        <ErrorNotice error={load.error} />
        {load.pending && !list && <p className="muted">{msgD.containers.loading}</p>}
        {list && !engine && <p className="muted">{msgD.containers.none}</p>}
        {list && engine && <p className="hint">{msgD.containers.engine(engineName(engine))}</p>}
        {list?.problem && (
          <div className="notice notice-danger" role="alert">
            <span>{msgD.containers.problem}</span> <span className="mono" data-testid="container-problem">{list.problem}</span>
          </div>
        )}
        {list && engine && !list.problem && list.containers.length === 0 && <p className="muted">{msgD.containers.empty}</p>}
        {engine && list && list.containers.length > 0 && (
          <table className="containers" aria-label={msgD.containers.list}>
            <thead>
              <tr>
                <th scope="col">{msgD.containers.name}</th>
                <th scope="col">{msgD.containers.image}</th>
                <th scope="col">{msgD.containers.status}</th>
                <th scope="col">
                  <span className="visually-hidden">{msgD.containers.openShort}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.containers.map((c) => (
                <tr key={c.id}>
                  <td className="mono" title={c.id}>
                    {c.name || c.id.slice(0, 12)}
                  </td>
                  <td className="mono">{c.image}</td>
                  <td>{c.status}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={msgD.containers.open(c.name || c.id.slice(0, 12))}
                      onClick={() => onOpen(engine, c)}
                    >
                      {msgD.containers.openShort}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list && list.skipped > 0 && <p className="hint">{msgD.containers.skipped(list.skipped)}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={refresh} disabled={load.pending}>
            {msgD.containers.refresh}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
            {msgD.containers.close}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
