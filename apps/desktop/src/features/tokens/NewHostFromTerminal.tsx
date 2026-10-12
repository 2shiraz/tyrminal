import { useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { HostEditor } from "../hosts/HostEditor";
import { type NewHostRequest, onNewHostRequest } from "./requests";

/**
 * The new-host editor, prefilled from an address clicked in terminal output. Saving creates the
 * host like any other; it never connects by itself.
 */
export function NewHostFromTerminal({ onDone }: { onDone: () => void }) {
  const data = useVaultData();
  const [request, setRequest] = useState<NewHostRequest | null>(null);
  useEffect(() => onNewHostRequest(setRequest), []);
  if (!request) return null;
  return (
    <HostEditor
      host={null}
      initial={{ address: request.address, port: request.port, username: "" }}
      keys={data.keys.value ?? []}
      groups={data.groups.value ?? []}
      onClose={() => {
        setRequest(null);
        onDone();
      }}
      onSaved={() => {
        setRequest(null);
        void data.hosts.reload();
        onDone();
      }}
    />
  );
}
