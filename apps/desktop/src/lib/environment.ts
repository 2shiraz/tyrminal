// Pure helpers for environment variables referenced by snippets (SNP-14).

export const MAX_STARTUP_SNIPPETS = 16;

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
