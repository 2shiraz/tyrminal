#!/usr/bin/env node
// Seeds and checks docs/feature-matrix.csv against the ID tables in BUILD_SPEC.md §12.
//
//   node scripts/feature-matrix.mjs           merge: add missing IDs, keep existing tracking columns
//   node scripts/feature-matrix.mjs --check   fail if an ID is missing, unknown, or has an invalid status
//   node scripts/feature-matrix.mjs set ID[,ID...] key=value ...   update tracking columns of rows
//
// Research columns (title, evidence, sources, scope, phase) always come from the spec.
// Tracking columns (platforms .. verified_at) are owned by the CSV and never overwritten.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "BUILD_SPEC.md");
const csvPath = join(root, "docs", "feature-matrix.csv");

const COLUMNS = [
  "id", "title", "reference_evidence", "source_ids", "our_scope", "phase", "platforms",
  "implementation_paths", "test_ids", "status", "blocker", "verified_commit", "verified_at",
];
const TRACKING = COLUMNS.slice(6);
const STATUSES = new Set([
  "NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED_UNVERIFIED", "VERIFIED", "BLOCKED", "DEFERRED_BY_SCOPE",
]);
const EXPECTED = { research: 249, requested: 26, historical: 5, additions: 34 };

function cells(line) {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function scopeFor(disposition) {
  if (/^Excluded/.test(disposition)) return "excluded";
  if (/^Process/.test(disposition)) return "process";
  if (/^License/.test(disposition)) return "license";
  if (/extension/.test(disposition)) return "extension";
  if (/optional/.test(disposition)) return "optional";
  if (/changed/.test(disposition)) return "changed";
  return "in_scope";
}

function parseSpec() {
  const rows = [];
  const counts = { research: 0, requested: 0, historical: 0, additions: 0 };
  for (const line of readFileSync(specPath, "utf8").split("\n")) {
    if (!line.startsWith("| ")) continue;
    const c = cells(line);
    const id = c[0];
    if (/^[A-Z]{2,3}-\d{2}$/.test(id) && c.length === 5) {
      const [, evidence, capability, disposition, reference] = c;
      const phase = disposition.split(" — ")[0].replace(/ (optional|changed|extension)$/, "");
      rows.push({
        id, title: capability, reference_evidence: evidence,
        source_ids: [...reference.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]).join(" "),
        our_scope: disposition.includes(" — ") ? `${scopeFor(disposition)}: ${disposition.split(" — ")[1]}` : scopeFor(disposition),
        phase,
      });
      counts.research += 1;
    } else if (/^Q-\d{2}$/.test(id) && c.length === 3) {
      rows.push({ id, title: c[1], reference_evidence: "requested-unverified", source_ids: "S36 S37", our_scope: `track_e: ${c[2]}`, phase: "E" });
      counts.requested += 1;
    } else if (/^H-\d{2}$/.test(id) && c.length === 3) {
      rows.push({ id, title: c[1], reference_evidence: "historical", source_ids: "S33 S34 S35 S42", our_scope: `historical: ${c[2]}`, phase: "E" });
      counts.historical += 1;
    } else if (/^P-\d{2}$/.test(id) && c.length === 3) {
      rows.push({ id, title: c[1], reference_evidence: "product-addition", source_ids: "", our_scope: "in_scope", phase: c[2] });
      counts.additions += 1;
    }
  }
  for (const [k, want] of Object.entries(EXPECTED)) {
    if (counts[k] !== want) throw new Error(`BUILD_SPEC.md: expected ${want} ${k} IDs, parsed ${counts[k]}`);
  }
  return rows;
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function parseCsv(text) {
  const out = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out;
}

function readExisting() {
  if (!existsSync(csvPath)) return new Map();
  const [header, ...body] = parseCsv(readFileSync(csvPath, "utf8"));
  if (header.join(",") !== COLUMNS.join(",")) throw new Error("docs/feature-matrix.csv: unexpected header");
  return new Map(body.filter((r) => r.length > 1).map((r) => [r[0], Object.fromEntries(COLUMNS.map((c, i) => [c, r[i] ?? ""]))]));
}

function defaultStatus(row) {
  return /^(excluded|process|license)/.test(row.our_scope) || row.phase === "E" ? "DEFERRED_BY_SCOPE" : "NOT_STARTED";
}

const spec = parseSpec();
const existing = readExisting();
const check = process.argv.includes("--check");

if (process.argv[2] === "set") {
  const ids = (process.argv[3] ?? "").split(",").filter(Boolean);
  const updates = process.argv.slice(4).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]);
  for (const [key] of updates) if (!TRACKING.includes(key)) throw new Error(`not a tracking column: ${key}`);
  for (const id of ids) {
    const row = existing.get(id);
    if (!row) throw new Error(`unknown id: ${id}`);
    for (const [key, value] of updates) row[key] = value;
    if (!STATUSES.has(row.status)) throw new Error(`${id}: invalid status "${row.status}"`);
  }
}

if (check) {
  const problems = [];
  const specIds = new Set(spec.map((r) => r.id));
  for (const r of spec) {
    const e = existing.get(r.id);
    if (!e) { problems.push(`missing row ${r.id}`); continue; }
    if (!STATUSES.has(e.status)) problems.push(`${r.id}: invalid status "${e.status}"`);
    if (e.status === "VERIFIED" && (!e.test_ids || !e.verified_commit || !e.platforms)) {
      problems.push(`${r.id}: VERIFIED requires test_ids, platforms and verified_commit`);
    }
    if (e.status === "BLOCKED" && !e.blocker) problems.push(`${r.id}: BLOCKED requires a blocker`);
    if (e.title !== r.title) problems.push(`${r.id}: title drifted from BUILD_SPEC.md`);
  }
  for (const id of existing.keys()) if (!specIds.has(id)) problems.push(`unknown row ${id}`);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const tally = {};
  for (const e of existing.values()) tally[e.status] = (tally[e.status] ?? 0) + 1;
  console.log(`feature matrix ok: ${existing.size} rows`, JSON.stringify(tally));
} else {
  const lines = [COLUMNS.join(",")];
  for (const r of spec) {
    const e = existing.get(r.id) ?? {};
    const merged = { ...r };
    for (const c of TRACKING) merged[c] = e[c] ?? "";
    if (!merged.status) merged.status = defaultStatus(r);
    lines.push(COLUMNS.map((c) => csvEscape(merged[c])).join(","));
  }
  writeFileSync(csvPath, `${lines.join("\n")}\n`);
  console.log(`wrote ${spec.length} rows to docs/feature-matrix.csv`);
}
