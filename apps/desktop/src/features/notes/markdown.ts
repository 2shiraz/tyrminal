// A small Markdown reader for host and group notes (P-30). It produces a tree of plain values that
// NoteView turns into React elements: there is no HTML string anywhere, so markup in a note is
// shown as text, never interpreted. Images are never loaded (only their alt text is kept), and a
// link exists only for http, https and ssh destinations that pass `noteLink`.

export type NoteLink =
  | { kind: "web"; url: string; host: string }
  | { kind: "ssh"; url: string; host: string; port: number | null; username: string | null };

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; link: NoteLink; c: Inline[] }
  /** An image is never fetched: only its description is shown. */
  | { t: "image"; alt: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

/** How far inline syntax looks ahead for its closing mark, so hostile text stays linear. */
const LOOKAHEAD = 2000;
const MAX_DEPTH = 8;

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/**
 * The destination of a link in a note, or null when it is not one that may be opened:
 * `http`/`https` without embedded credentials, or `ssh://[user@]host[:port][/]`.
 * Everything else (javascript:, data:, file:, vbscript:, relative paths, ...) is null.
 */
export function noteLink(raw: string): NoteLink | null {
  const url = raw.trim();
  if (!url || url.length > 2048 || /\s/.test(url) || CONTROL.test(url) || url.includes("\\")) return null;
  const web = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i.exec(url);
  if (web) {
    const authority = web[2] ?? "";
    // Credentials in a web link are a classic way to disguise where it really goes.
    if (!authority || authority.includes("@")) return null;
    const host = authority.replace(/:\d{1,5}$/, "");
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i.test(host)) return null;
    return { kind: "web", url, host: host.toLowerCase() };
  }
  const ssh = /^ssh:\/\/(?:([a-z0-9._-]{1,64})@)?(\[[0-9a-f:.]+\]|[a-z0-9.-]{1,253})(?::(\d{1,5}))?\/?$/i.exec(url);
  if (ssh) {
    const port = ssh[3] ? Number(ssh[3]) : null;
    if (port !== null && (port < 1 || port > 65535)) return null;
    const host = (ssh[2] ?? "").replace(/^\[|\]$/g, "");
    if (!host || host.startsWith("-") || host.startsWith(".")) return null;
    return { kind: "ssh", url, host, port, username: ssh[1] ?? null };
  }
  return null;
}

// ---------- inline ----------

function closing(text: string, from: number, mark: string): number {
  const end = Math.min(text.length, from + LOOKAHEAD);
  const at = text.indexOf(mark, from);
  return at >= 0 && at < end ? at : -1;
}

/** `[text](dest)` starting at `open` (the `[`): the label, destination and end, or null. */
function linkAt(text: string, open: number): { label: string; dest: string; end: number } | null {
  let depth = 0;
  const limit = Math.min(text.length, open + LOOKAHEAD);
  for (let i = open; i < limit; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      if (text[i + 1] !== "(") return null;
      // The destination may hold balanced parentheses (CommonMark).
      let close = -1;
      for (let j = i + 2, parens = 0; j < limit + 2 && j < text.length; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === "(") parens++;
        else if (text[j] === ")" && parens-- === 0) {
          close = j;
          break;
        }
      }
      if (close < 0) return null;
      // An optional title ("dest "title"") is dropped; only the destination counts.
      const dest = text.slice(i + 2, close).trim().split(/\s+/)[0] ?? "";
      return { label: text.slice(open + 1, i), dest: dest.replace(/^<|>$/g, ""), end: close + 1 };
    }
  }
  return null;
}

/**
 * The closing emphasis mark for an opening one at `from`: not after a space, and for `_` not
 * inside a word (CommonMark's flanking rules, simplified), so `snake_case` and `__init__`-like
 * identifiers stay as they are.
 */
function emphasisClose(text: string, from: number, mark: string): number {
  const end = Math.min(text.length, from + LOOKAHEAD);
  for (let at = text.indexOf(mark, from); at >= 0 && at < end; at = text.indexOf(mark, at + 1)) {
    const before = text[at - 1] ?? " ";
    const after = text[at + mark.length] ?? " ";
    if (at > from && !/\s/.test(before) && !(mark[0] === "_" && /[a-z0-9]/i.test(after))) return at;
  }
  return -1;
}

const BARE_URL = /^(?:https?|ssh):\/\/[^\s<>]+/i;

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ t: "text", v: buffer });
    buffer = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  const nested = (inner: string): Inline[] => (depth >= MAX_DEPTH ? [{ t: "text", v: inner }] : parseInline(inner, depth + 1));

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const rest = text.slice(i, i + LOOKAHEAD);

    if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()<>!#~-]/.test(text[i + 1] as string)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const end = closing(text, i + run.length, run);
      if (end >= 0) {
        push({ t: "code", v: text.slice(i + run.length, end).trim() || text.slice(i + run.length, end) });
        i = end + run.length;
        continue;
      }
      buffer += run;
      i += run.length;
      continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const link = linkAt(text, i + 1);
      if (link) {
        // Never a request for the image: its description stands in for it.
        push({ t: "image", alt: link.label });
        i = link.end;
        continue;
      }
    }
    if (ch === "[") {
      const link = linkAt(text, i);
      if (link) {
        const target = noteLink(link.dest);
        if (target) push({ t: "link", link: target, c: nested(link.label) });
        // A destination that may not be opened leaves only its text.
        else {
          flush();
          out.push(...nested(link.label));
        }
        i = link.end;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/i.exec(rest);
      if (auto) {
        const target = noteLink(auto[1] as string);
        if (target) push({ t: "link", link: target, c: [{ t: "text", v: target.url }] });
        else buffer += auto[0];
        i += auto[0].length;
        continue;
      }
    }
    // A bare URL counts only on its own (after a space, a line break or "("), never inside other text
    // such as an HTML attribute.
    if ((ch === "h" || ch === "H" || ch === "s" || ch === "S") && /[\s(]/.test(text[i - 1] ?? " ")) {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        const url = bare[0].replace(/[.,;:!?)'"\]]+$/, "");
        const target = noteLink(url);
        if (target) {
          push({ t: "link", link: target, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const mark = ch + ch;
      const end = emphasisClose(text, i + 2, mark);
      if (end > i + 2 && !/\s/.test(text[i + 2] ?? " ") && !(ch === "_" && /[a-z0-9]/i.test(text[i - 1] ?? " "))) {
        push({ t: "strong", c: nested(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
      // A run of marks that opens nothing is text, all of it.
      const run = new RegExp(`^\\${ch}+`).exec(rest)?.[0] ?? mark;
      buffer += run;
      i += run.length;
      continue;
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] !== " " && text[i + 1] !== undefined) {
      const end = emphasisClose(text, i + 1, ch);
      if (end > i + 1 && !(ch === "_" && /[a-z0-9]/i.test(text[i - 1] ?? " "))) {
        push({ t: "em", c: nested(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // the closing fence (or the end of the note)
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push(QUOTE.exec(lines[i] as string)?.[1] ?? "");
        i++;
      }
      blocks.push(depth >= MAX_DEPTH ? { t: "p", c: [{ t: "text", v: inner.join("\n") }] } : { t: "quote", c: parseMarkdown(inner.join("\n"), depth + 1) });
      continue;
    }
    const listKind = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
    if (listKind) {
      const items: Inline[][] = [];
      while (i < lines.length && listKind.test(lines[i] as string)) {
        items.push(parseInline(listKind.exec(lines[i] as string)?.[1] ?? ""));
        i++;
      }
      blocks.push({ t: "list", ordered: listKind === ORDERED, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() &&
      !FENCE.test(lines[i] as string) &&
      !HEADING.test(lines[i] as string) &&
      !QUOTE.test(lines[i] as string) &&
      !BULLET.test(lines[i] as string) &&
      !(para.length > 0 && RULE.test(lines[i] as string))
    ) {
      para.push(lines[i] as string);
      i++;
    }
    blocks.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** Every link a parsed note would offer, in order (for tests and checks). */
export function linksOf(blocks: Block[]): NoteLink[] {
  const out: NoteLink[] = [];
  const inline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === "link") {
        out.push(n.link);
        inline(n.c);
      } else if (n.t === "strong" || n.t === "em") inline(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === "p" || b.t === "h") inline(b.c);
    else if (b.t === "list") b.items.forEach(inline);
    else if (b.t === "quote") out.push(...linksOf(b.c));
  }
  return out;
}

/** The text a code block pastes: without trailing line breaks, so pasting never presses Enter. */
export function pasteText(code: string): string {
  return code.replace(/\n+$/, "");
}
