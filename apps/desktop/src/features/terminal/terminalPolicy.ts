// UI-side handling of untrusted terminal-supplied text. This is presentation hygiene; the native
// side enforces the real policy (no opener, no clipboard access, no command execution).

const MAX_TITLE_LENGTH = 80;

/**
 * Makes a remote-controlled terminal title safe to show as a tab label: control characters and
 * bidirectional overrides removed, whitespace collapsed, length capped. The result is still only
 * ever rendered as text.
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw
    // C0/C1 controls, zero-width and bidi controls that can disguise or reorder text.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

/**
 * Splits a fingerprint into short groups so two fingerprints can be compared by eye.
 * `SHA256:abcdefgh…` → `SHA256` + `abcd efgh …`.
 */
export function groupFingerprint(fingerprint: string): { algorithm: string; groups: string[] } {
  const separator = fingerprint.indexOf(":");
  const algorithm = separator > 0 ? fingerprint.slice(0, separator) : "";
  const body = separator > 0 ? fingerprint.slice(separator + 1) : fingerprint;
  return { algorithm, groups: body.match(/.{1,4}/g) ?? [] };
}
