// Actions on tokens in terminal output: addresses can be copied or turned into a new saved host
// (the editor opens prefilled; nothing connects by itself), and in local terminals paths can be
// copied. Hovering underlines a token; a plain click opens its menu, so dragging still selects.
// Links (URLs) keep their own confirmed flow. Display and clipboard only: nothing is sent.

import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import { BUILTIN_RULES, isIpv6 } from "../highlight/builtins";

export type TokenKind = "address" | "mac" | "path";

export interface Token {
  kind: TokenKind;
  text: string;
  /** Where the click happened (for the menu). */
  x: number;
  y: number;
}

const URL_RE = BUILTIN_RULES.find((r) => r.kind === "url")?.re ?? /\bhttps?:\/\/\S+/g;
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?(?![\w.]*\w)/g;
const IPV6_BRACKETED = /\[[0-9A-Fa-f:]{2,39}\](?::\d{1,5})?/g;
const IPV6 = /(?<![0-9A-Fa-f:\]])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?![0-9A-Fa-f:])/g;
const MAC = /(?<![\w:-])[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}(?![\w:-])/g;
const PATH = /(?<![\w/.~:-])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+\/?(?![\w/])/g;

interface Found {
  kind: TokenKind;
  start: number;
  end: number;
}

/** Tokens in one line of text, left to right, never inside a URL. */
export function findTokens(text: string, withPaths: boolean): Found[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  const insideUrl = (s: number, e: number) => urls.some(([a, b]) => s < b && a < e);
  const found: Found[] = [];
  const add = (kind: TokenKind, re: RegExp, accept?: (t: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      const s = m.index;
      const e = s + m[0].length;
      if (m[0].length === 0 || insideUrl(s, e) || found.some((f) => s < f.end && f.start < e)) continue;
      if (accept && !accept(m[0])) continue;
      found.push({ kind, start: s, end: e });
    }
  };
  add("address", IPV6_BRACKETED, (t) => isIpv6(t.replace(/^\[|\](?::\d+)?$/g, "")));
  add("address", IPV4);
  add("mac", MAC);
  add("address", IPV6, isIpv6);
  if (withPaths) add("path", PATH, (t) => /[A-Za-z_]/.test(t));
  return found.sort((a, b) => a.start - b.start);
}

/** Splits "10.0.0.5:2222" or "[fe80::1]:22" into an address and a port (22 when none). */
export function addressAndPort(text: string): { address: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) return { address: bracketed[1] as string, port: Number(bracketed[2] ?? 22) };
  const v4 = /^([\d.]+)(?::(\d+))?$/.exec(text);
  if (v4) return { address: v4[1] as string, port: Number(v4[2] ?? 22) };
  return { address: text, port: 22 };
}

/** The line's text and, per UTF-16 unit, the cell column it starts at. */
function lineText(line: IBufferLine): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const chars = line.getCell(x)?.getChars() ?? "";
    if (chars === "") continue;
    for (let i = 0; i < chars.length; i += 1) columns.push(x);
    text += chars;
  }
  return { text, columns };
}

export function tokenLinkProvider(term: Terminal, options: { paths: () => boolean; onToken: (token: Token) => void }): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(y - 1);
      // Full-screen applications own their screen and their clicks.
      if (!line || buffer.type === "alternate") return callback(undefined);
      const { text, columns } = lineText(line);
      const links: ILink[] = findTokens(text, options.paths()).map((f) => {
        const first = columns[f.start] as number;
        const last = columns[f.end - 1] as number;
        const value = text.slice(f.start, f.end);
        return {
          range: { start: { x: first + 1, y }, end: { x: last + 1, y } },
          text: value,
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            if (event.button !== 0) return;
            options.onToken({ kind: f.kind, text: value, x: event.clientX, y: event.clientY });
          },
        };
      });
      callback(links.length > 0 ? links : undefined);
    },
  };
}
