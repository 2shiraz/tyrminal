// The sign-in prompt (password, key passphrase, keyboard-interactive) and the fingerprint display,
// shared by terminal panes, SFTP locations and key installation. A module of its own, so the views
// that use them do not pull in the terminal emulator.
import type { SessionEvent } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { Notice, SecretField, TextField } from "../../components/ui/controls";
import { IconKeyRound } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
// agent B: tunnels and history
import { HopNotice } from "../tunnels/HopNotice";
import { groupFingerprint } from "./terminalPolicy";

type AuthPrompt = Extract<SessionEvent, { type: "auth_prompt" }>;

export function Fingerprint({ value }: { value: string }) {
  const { algorithm, groups } = groupFingerprint(value);
  return (
    <div className="fingerprint" aria-label={value}>
      {algorithm && <span className="fingerprint-alg">{algorithm}</span>}
      {groups.map((group, index) => (
        // Position is the identity here: the groups are a fixed split of one string.
        <span key={`${index}-${group}`} aria-hidden="true">
          {group}
        </span>
      ))}
    </div>
  );
}

export function AuthDialog({ prompt, banner, onAnswer }: { prompt: AuthPrompt; banner: string | null; onAnswer: (secret: string | null) => void }) {
  const [secret, setSecret] = useState("");
  const isPassword = prompt.kind === "password";
  const isKbd = prompt.kind === "keyboard_interactive";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (secret === "") return;
    const value = secret;
    setSecret("");
    onAnswer(value);
  }

  const title = isKbd ? msg.terminal.kbdTitle(prompt.username) : isPassword ? msg.terminal.passwordTitle(prompt.username) : msg.terminal.passphraseTitle;
  const body = isKbd ? msg.terminal.kbdBody : isPassword ? msg.terminal.passwordBody : msg.terminal.passphraseBody;
  const label = isKbd ? msg.terminal.kbdAnswer : isPassword ? msg.hosts.password : msg.keys.passphrase;

  return (
    <Dialog title={title} icon={<IconKeyRound size={18} />} onDismiss={() => onAnswer(null)}>
      <form className="stack" onSubmit={submit}>
        {/* agent B: tunnels and history */}
        <HopNotice hop={prompt.hop} />
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {body}
        </p>
        {banner && (isPassword || isKbd) && (
          <div className="stack-xs">
            <span className="label">{msg.terminal.banner}</span>
            {/* Server-supplied text: rendered as plain text, never as markup. */}
            <pre className="banner-text">{banner}</pre>
          </div>
        )}
        {isKbd && prompt.message && (
          <div className="stack-xs">
            <span className="label">{msg.terminal.kbdQuestion}</span>
            {/* Server-supplied, sanitized by the core, still untrusted: plain text only. */}
            <pre className="banner-text" data-testid="kbd-question">
              {prompt.message}
            </pre>
          </div>
        )}
        {prompt.attempt > 1 && (
          <Notice tone="warning">
            {msg.terminal.retryHint} {msg.terminal.attempt(prompt.attempt, prompt.maxAttempts)}
          </Notice>
        )}
        {isKbd && prompt.echo ? (
          <TextField label={label} value={secret} onChange={setSecret} autoFocus maxLength={1024} autoComplete="off" spellCheck={false} />
        ) : (
          <SecretField label={label} value={secret} onChange={setSecret} autoFocus maxLength={1024} />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onAnswer(null)}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={secret === ""}>
            {msg.terminal.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
