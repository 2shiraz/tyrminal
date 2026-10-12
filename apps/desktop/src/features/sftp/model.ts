import type { LocalListing, RemoteEntry, RemoteListing } from "@tyrminal/contracts";

/** A folder a pane can show: on a server (absolute path) or inside a local folder the user chose. */
export type Loc = { kind: "remote"; path: string } | { kind: "local"; token: string; rootName: string; path: string[] };

export interface Folder {
  loc: Loc;
  entries: RemoteEntry[];
  truncated: boolean;
}

/** What one pane is connected to, as the other pane and the transfer queue need it. */
export type Endpoint =
  | { kind: "local"; token: string; rootName: string; path: string[] }
  | { kind: "remote"; sessionId: string; label: string; path: string };

export type SortKey = "name" | "modified" | "size" | "kind";
export interface Sort {
  key: SortKey;
  ascending: boolean;
}

export function remoteFolder(listing: RemoteListing): Folder {
  return { loc: { kind: "remote", path: listing.path }, entries: listing.entries, truncated: listing.truncated };
}

export function localFolder(listing: LocalListing): Folder {
  return {
    loc: { kind: "local", token: listing.token, rootName: listing.rootName, path: listing.path },
    entries: listing.entries,
    truncated: listing.truncated,
  };
}

export function sameLoc(a: Loc | null, b: Loc | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "remote" && b.kind === "remote") return a.path === b.path;
  if (a.kind === "local" && b.kind === "local") return a.token === b.token && a.path.join("/") === b.path.join("/");
  return false;
}

/** The folder above, or null at the top (server root, or the chosen local folder). */
export function parentLoc(loc: Loc): Loc | null {
  if (loc.kind === "local") return loc.path.length === 0 ? null : { ...loc, path: loc.path.slice(0, -1) };
  const trimmed = loc.path.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const cut = trimmed.lastIndexOf("/");
  return { kind: "remote", path: cut <= 0 ? "/" : trimmed.slice(0, cut) };
}

export function childLoc(loc: Loc, name: string): Loc {
  if (loc.kind === "local") return { ...loc, path: [...loc.path, name] };
  return { kind: "remote", path: `${loc.path.replace(/\/+$/, "")}/${name}` };
}

/** Breadcrumbs from the top down; the last one is the folder shown. */
export function crumbs(loc: Loc): { label: string; loc: Loc }[] {
  if (loc.kind === "local") {
    const list = [{ label: loc.rootName, loc: { ...loc, path: [] as string[] } as Loc }];
    loc.path.forEach((name, i) => list.push({ label: name, loc: { ...loc, path: loc.path.slice(0, i + 1) } }));
    return list;
  }
  const parts = loc.path.split("/").filter(Boolean);
  const list: { label: string; loc: Loc }[] = [{ label: "/", loc: { kind: "remote", path: "/" } }];
  parts.forEach((name, i) => list.push({ label: name, loc: { kind: "remote", path: `/${parts.slice(0, i + 1).join("/")}` } }));
  return list;
}

export function locText(loc: Loc): string {
  return loc.kind === "local" ? [loc.rootName, ...loc.path].join("/") : loc.path;
}

/** Shows server-supplied names safely: control characters become visible escapes. */
export function visibleName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters.
  return name.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Compact local date and time, `2026-10-11 14:05`, so the column never truncates. */
export function formatModified(unixSeconds: number | null): string {
  if (unixSeconds == null) return "";
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `rwxr-xr-x` style, with the file type letter first (`d`, `l`, `-`). */
export function modeString(entry: RemoteEntry): string {
  if (entry.permissions == null) return "";
  const type = entry.kind === "dir" ? "d" : entry.kind === "symlink" ? "l" : "-";
  const bits = "rwxrwxrwx";
  let text = type;
  for (let i = 0; i < 9; i++) text += entry.permissions & (1 << (8 - i)) ? bits[i] : "-";
  return text;
}

export function octal(mode: number | null): string {
  return mode == null ? "" : mode.toString(8).padStart(3, "0");
}

/** Hidden files, then the filter (case-insensitive substring), then the sort; folders first. */
export function visibleEntries(entries: RemoteEntry[], showHidden: boolean, filter: string, sort: Sort): RemoteEntry[] {
  const needle = filter.trim().toLowerCase();
  const list = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!needle || e.name.toLowerCase().includes(needle)));
  const direction = sort.ascending ? 1 : -1;
  const byName = (a: RemoteEntry, b: RemoteEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const compare = (a: RemoteEntry, b: RemoteEntry): number => {
    switch (sort.key) {
      case "name":
        return byName(a, b);
      case "modified":
        return (a.modified ?? -1) - (b.modified ?? -1) || byName(a, b);
      case "size":
        return (a.size ?? -1) - (b.size ?? -1) || byName(a, b);
      case "kind":
        return a.kind.localeCompare(b.kind) || byName(a, b);
    }
  };
  return list.sort((a, b) => {
    const dirs = Number(b.kind === "dir") - Number(a.kind === "dir");
    return dirs || direction * compare(a, b);
  });
}
