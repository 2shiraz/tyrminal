// Per-field checks for autosave, mirroring the core's rules (crates/core/src/validate.rs) so an
// invalid field is shown at once and never sent. The core checks every value again.

/** Control, format (bidi, zero-width) and other invisible characters the core refuses. */
const DECEPTIVE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function validLabel(value: string): boolean {
  const t = value.trim();
  return t !== "" && bytes(t) <= 256 && !DECEPTIVE.test(t);
}

/** A host name or IP literal, without scheme, user, port or path. */
export function validAddress(value: string): boolean {
  const t = value.trim();
  const bare = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  if (bare === "" || bytes(bare) > 253) return false;
  // IPv6 literal: hex groups and colons (the core parses it exactly).
  if (/^[0-9a-fA-F:.]+$/.test(bare) && bare.includes(":")) return true;
  return /^[\p{L}\p{N}._-]+$/u.test(bare) && !bare.startsWith("-") && !bare.startsWith(".") && !bare.includes("..");
}

/** Empty (inherit, or asked when connecting) or a user name the core accepts. */
export function validUsername(value: string): boolean {
  if (value === "") return true;
  return bytes(value) <= 255 && !DECEPTIVE.test(value) && !/\s/u.test(value) && !value.startsWith("-");
}

export function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

export function validTags(text: string): boolean {
  const tags = parseTags(text);
  return tags.length <= 16 && tags.every((t) => bytes(t) <= 32 && !DECEPTIVE.test(t));
}

/** `""` is valid when something else supplies the port (a group, or Telnet's default). */
export function validPort(text: string, emptyAllowed: boolean): boolean {
  if (text === "") return emptyAllowed;
  if (!/^\d{1,5}$/.test(text)) return false;
  const n = Number(text);
  return n >= 1 && n <= 65535;
}

export function validGroupName(value: string): boolean {
  return validLabel(value) && !value.includes("/");
}

/** `[A-Za-z_][A-Za-z0-9_]*`, 64 bytes at most. */
export function validEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value.trim());
}

export function validEnvValue(value: string): boolean {
  return bytes(value) <= 4096 && !DECEPTIVE.test(value);
}
