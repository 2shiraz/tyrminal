// Pure helpers for suggestions: matching, shell quoting and the bytes an insertion types.
// Insertions never end with Enter: a suggestion is put on the command line for the user to
// review and run themselves.

import type { RemoteEntry, SnippetSummary } from "@tyrminal/contracts";

import { COMMANDS, type CommandInfo } from "./commands";

export const MAX_SHOWN = 8;

/** Control characters (and bidi overrides) that must never be typed into a terminal unasked. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export function hasUnsafeCharacters(text: string): boolean {
  return UNSAFE.test(text);
}

/** POSIX shell quoting: bare when only safe characters, otherwise single-quoted. */
export function shellQuote(text: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The bytes that put `text` on the command line: bracketed when the shell asked for it. */
export function insertionBytes(text: string, bracketed: boolean): Uint8Array {
  const body = bracketed ? `\u001b[200~${text}\u001b[201~` : text;
  return new TextEncoder().encode(body);
}

export function matchCommands(query: string): CommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q || q.includes("/")) return [];
  const starts = COMMANDS.filter((c) => c.name.startsWith(q));
  const mentions = COMMANDS.filter((c) => !c.name.startsWith(q) && c.description.toLowerCase().includes(q));
  return [...starts, ...mentions].slice(0, MAX_SHOWN);
}

export function matchSnippets(query: string, snippets: SnippetSummary[]): SnippetSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return snippets.slice(0, MAX_SHOWN);
  const byName = snippets.filter((s) => s.name.toLowerCase().includes(q));
  const byText = snippets.filter((s) => !s.name.toLowerCase().includes(q) && `${s.folder} ${s.text}`.toLowerCase().includes(q));
  return [...byName, ...byText].slice(0, MAX_SHOWN);
}

/** Whether the query is a path to complete: it starts with /, ~ or ./, or contains a slash. */
export function isPathQuery(query: string): boolean {
  const q = query.trim();
  return q.startsWith("/") || q.startsWith("~") || q.startsWith("./") || q.includes("/");
}

/**
 * Splits a path query into the folder to list and the name prefix to match. `~` resolves against
 * the login folder (`home`); relative paths against `cwd`, the shell's folder when shell
 * integration reports it and the login folder otherwise.
 */
export function splitPathQuery(query: string, home: string, cwd = home): { dir: string; prefix: string; shown: string } {
  let q = query.trim();
  if (q === "~") q = "~/";
  const cut = q.lastIndexOf("/");
  const shown = q.slice(0, cut + 1);
  const prefix = q.slice(cut + 1);
  let dir = shown;
  if (dir.startsWith("~/")) dir = `${home}/${dir.slice(2)}`;
  else if (dir.startsWith("./")) dir = `${cwd}/${dir.slice(2)}`;
  else if (!dir.startsWith("/")) dir = `${cwd}/${dir}`;
  dir = dir.replace(/\/+$/, "") || "/";
  return { dir, prefix, shown };
}

export interface PathSuggestion {
  /** What is inserted: the typed folder part plus the name, shell-quoted. */
  insert: string;
  label: string;
  dir: boolean;
  /** Names with control characters are shown but cannot be inserted. */
  unsafe: boolean;
}

export function matchPaths(shown: string, prefix: string, entries: RemoteEntry[]): PathSuggestion[] {
  const lower = prefix.toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(lower) && (prefix.startsWith(".") || !e.name.startsWith(".")))
    .slice(0, MAX_SHOWN)
    .map((e) => {
      const dir = e.kind === "dir";
      const path = `${shown}${e.name}${dir ? "/" : ""}`;
      // `~/` must stay unquoted to expand; quote the rest.
      const insert = path.startsWith("~/") ? `~/${shellQuote(path.slice(2))}` : shellQuote(path);
      return { insert, label: path, dir, unsafe: hasUnsafeCharacters(e.name) };
    });
}
