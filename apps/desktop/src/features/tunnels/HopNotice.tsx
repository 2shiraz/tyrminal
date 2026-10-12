import type { ChainPosition } from "@tyrminal/contracts";

import { msgB } from "../../lib/messages-b";

/**
 * Names the jump-chain hop a prompt comes from ("Jump host 1 of 2: bastion"), so a jump host's
 * trust or password prompt is never mistaken for the destination's. Renders nothing for a direct
 * connection. The label is the user's own saved name, never server text.
 */
export function HopNotice({ hop }: { hop: ChainPosition | null | undefined }) {
  if (!hop) return null;
  return (
    <p className="hop-notice" role="note" data-testid="hop-notice">
      {msgB.hops.position(hop.index, hop.total, hop.label)}
    </p>
  );
}
