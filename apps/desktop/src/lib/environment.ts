// Pure helpers for environment variables referenced by snippets (SNP-14).

export const MAX_STARTUP_SNIPPETS = 16;
/** Longest line of a startup snippet in bytes (`MAX_STARTUP_LINE_LEN` in the core). */
export const MAX_STARTUP_LINE_LEN = 1000;

/** The 1-based number of the first line too long to type at startup, or null when all fit. */
export function overlongStartupLine(text: string): number | null {
  const encoder = new TextEncoder();
  const index = text.replace(/\n+$/, "").split("\n").findIndex((line) => encoder.encode(line).length > MAX_STARTUP_LINE_LEN);
  return index < 0 ? null : index + 1;
}

/**
 * Variable names a snippet references as `$NAME` or `${NAME…}`, in order of first use. Shell
 * special parameters (`$1`, `$?`, `$$`…) and escaped `\$` are not variables of ours.
 */
export function variableRefs(text: string): string[] {
  const out: string[] = [];
  const re = /(\\?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const match of text.matchAll(re)) {
    if (match[1]) continue;
    const name = match[2] ?? match[3];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
