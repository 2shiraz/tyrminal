// Security review (P-27) in Settings. The core computes the findings on this computer over the
// unlocked vault; this view only lists them and opens the existing dialog that fixes each one.
// Nothing changes until the user completes that dialog.

import type { FindingSeverity, SecurityFinding, SecurityReview } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { ErrorNotice, Notice, SkeletonRows } from "../../components/ui/controls";
import { IconFingerprint, IconKeyRound, IconRefreshCw, IconServer, IconShieldCheck } from "../../components/ui/icons";
import { securityReview } from "../../lib/ipc";
import { msgSR } from "../../lib/messages-security-review";
import { useAction } from "../../lib/useAsync";
import { GenerateKeyDialog } from "../credentials/KeychainView";
import { HostEditor } from "../hosts/HostEditor";
import { RemoveTrustDialog } from "../settings/SettingsViews";

/** Mirrors `SecurityFinding::severity` in crates/contracts/src/security_review.rs. */
export function severityOf(f: SecurityFinding): FindingSeverity {
  switch (f.kind) {
    case "dsa_key":
    case "certificate_expired":
      return "high";
    case "short_rsa_key":
      return f.bits < 2048 ? "high" : "medium";
    case "password_sign_in":
    case "certificate_expiring":
      return "medium";
    case "key_without_passphrase":
    case "unused_known_host":
    case "ssh_rsa_only_known_host":
      return "low";
  }
}

const BADGE: Record<FindingSeverity, string> = {
  high: "badge badge-danger",
  medium: "badge badge-warning",
  low: "badge",
};

const date = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleDateString();

type Fix = { kind: "generate" } | { kind: "editHost"; hostId: string } | { kind: "removeKnownHost"; id: string; host: string; port: number };

export function SecurityReviewSection({ onOpenKeychain }: { onOpenKeychain: () => void }) {
  const { hosts, keys, groups } = useVaultData();
  const [review, setReview] = useState<SecurityReview | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const load = useAction();

  const run = () =>
    void load
      .run(() => securityReview.run())
      .then((r) => {
        if (r) setReview(r);
      });
  useEffect(run, []);

  /** After a fix dialog completes: refresh the shared lists and review again. */
  function fixed() {
    setFix(null);
    void hosts.reload();
    void keys.reload();
    run();
  }

  function describe(f: SecurityFinding): {
    icon: ReactNode;
    title: string;
    body: string;
    actions: ReactNode;
  } {
    const keychain = (
      <button type="button" className="btn btn-sm" onClick={onOpenKeychain}>
        {msgSR.actions.keychain}
      </button>
    );
    const generate = (
      <button type="button" className="btn btn-sm" onClick={() => setFix({ kind: "generate" })}>
        {msgSR.actions.generate}
      </button>
    );
    const label = (l: string) => l || msgSR.unknownKey;
    switch (f.kind) {
      case "dsa_key":
        return {
          icon: <IconKeyRound size={17} />,
          title: msgSR.dsa.title(f.label),
          body: msgSR.dsa.body(f.usedBy),
          actions: (
            <>
              {generate}
              {keychain}
            </>
          ),
        };
      case "short_rsa_key":
        return {
          icon: <IconKeyRound size={17} />,
          title: msgSR.shortRsa.title(f.label, f.bits),
          body: msgSR.shortRsa.body(f.usedBy),
          actions: (
            <>
              {generate}
              {keychain}
            </>
          ),
        };
      case "key_without_passphrase":
        return {
          icon: <IconKeyRound size={17} />,
          title: msgSR.noPassphrase.title(f.label),
          body: msgSR.noPassphrase.body(f.passphraseStored, f.usedBy),
          actions: keychain,
        };
      case "password_sign_in":
        return {
          icon: <IconServer size={17} />,
          title: msgSR.password.title(f.label),
          body: msgSR.password.body(f.stored),
          actions: (
            <button type="button" className="btn btn-sm" onClick={() => setFix({ kind: "editHost", hostId: f.hostId })}>
              {msgSR.actions.editHost}
            </button>
          ),
        };
      case "certificate_expired":
        return {
          icon: <IconKeyRound size={17} />,
          title: msgSR.certExpired.title(label(f.label)),
          body: msgSR.certExpired.body(date(f.validBefore)),
          actions: keychain,
        };
      case "certificate_expiring":
        return {
          icon: <IconKeyRound size={17} />,
          title: msgSR.certExpiring.title(label(f.label)),
          body: msgSR.certExpiring.body(date(f.validBefore)),
          actions: keychain,
        };
      case "unused_known_host":
      case "ssh_rsa_only_known_host": {
        const endpoint = msgSR.endpoint(f.host, f.port);
        const remove = (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() =>
              setFix({
                kind: "removeKnownHost",
                id: f.knownHostId,
                host: f.host,
                port: f.port,
              })
            }
          >
            {msgSR.actions.remove}
          </button>
        );
        return f.kind === "unused_known_host"
          ? {
              icon: <IconFingerprint size={17} />,
              title: msgSR.unusedKnownHost.title(endpoint),
              body: msgSR.unusedKnownHost.body(f.algorithm, f.fingerprint),
              actions: remove,
            }
          : {
              icon: <IconFingerprint size={17} />,
              title: msgSR.rsaOnlyKnownHost.title(endpoint),
              body: msgSR.rsaOnlyKnownHost.body(f.fingerprint),
              actions: remove,
            };
      }
    }
  }

  const editing = fix?.kind === "editHost" ? hosts.value?.find((h) => h.id === fix.hostId) : undefined;

  return (
    <div className="stack" data-testid="security-review">
      <ErrorNotice error={load.error} />
      {review === null && !load.error && <SkeletonRows count={2} />}
      {review && (
        <>
          <div role="status">
            {review.findings.length === 0 ? (
              <Notice tone="success">{msgSR.clean}</Notice>
            ) : (
              <p style={{ fontWeight: 600 }}>{msgSR.summary(review.findings.length)}</p>
            )}
          </div>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgSR.scope(review.keys, review.hosts, review.certificates, review.knownHosts)}
          </p>
          {review.findings.length > 0 && (
            <ul className="list" aria-label={msgSR.title}>
              {review.findings.map((f, i) => {
                const severity = severityOf(f);
                const d = describe(f);
                return (
                  <li key={`${f.kind}-${i}`} data-kind={f.kind} data-severity={severity}>
                    <span className="tile-icon" aria-hidden="true">
                      {d.icon}
                    </span>
                    <div className="row-main">
                      <span className="row-title">
                        <span className={BADGE[severity]}>{msgSR.severity(severity)}</span> {d.title}
                      </span>
                      <span className="row-sub">{d.body}</span>
                    </div>
                    <div className="row-flex">{d.actions}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div>
        <button type="button" className="btn btn-ghost" onClick={run} disabled={load.pending}>
          {review === null ? <IconShieldCheck size={15} aria-hidden="true" /> : <IconRefreshCw size={15} aria-hidden="true" />}
          {load.pending ? msgSR.running : msgSR.run}
        </button>
      </div>

      {fix?.kind === "generate" && <GenerateKeyDialog onClose={() => setFix(null)} onDone={fixed} />}
      {fix?.kind === "editHost" && editing && (
        <HostEditor host={editing} keys={keys.value ?? []} groups={groups.value ?? []} onClose={() => setFix(null)} onSaved={fixed} />
      )}
      {fix?.kind === "removeKnownHost" && <RemoveTrustDialog entry={fix} onClose={() => setFix(null)} onDone={fixed} />}
    </div>
  );
}
