#!/usr/bin/env bun
// docs-mcp (bun lane) — NATIVE Bun implementation; python docs_mcp.py stays
// as fallback. Same MCP tool surface, bun-native speed:
//   - Bun.stdin.stream() for zero-copi stdio JSON-RPC
//   - bun:sqlite (built into bun) with FTS5 for the index — no subprocess
//   - Bun.Glob / fs.scanwalk for discovery
// Universal for /home/toxic/pens/**: discovers every *.md/*.txt/*.rst,
// incremental by (mtime,size), auto-skips node_modules/.git/target/dist.

import { Database } from "bun:sqlite";
import { readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PENS = process.env.DOCS_MCP_ROOT ?? "/home/toxic/pens";
const DB_PATH = `${process.env.HOME}/.cache/morphe/docs-index.sqlite3`;
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", ".venv",
  "venv", "__pycache__", ".cache", "bazel-out", "bazel-bin", "bazel-testlogs",
  "bazel-tau", ".next", ".turbo", "archive", "runs", "vendor", ".pytest_cache"]);
const EXTS = new Set([".md", ".txt", ".rst"]);
// Data dumps >512KB are provenance dumps, not docs — index their head only.
const BODY_CAP = 524_288;

const state = { indexed: 0, bytes: 0, lastRefresh: 0, scanning: false };

function db(): Database {
  mkdirSync(`${process.env.HOME}/.cache/morphe`, { recursive: true });
  // per-lane DB file: the python fallback lane warms the SAME file holding
  // the write lock (SQLITE_BUSY). Bun lane gets its own WAL db + busy grace.
  const conn = new Database(DB_PATH.replace(".sqlite3", ".bun.sqlite3"), { create: true });
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA busy_timeout = 5000");
  conn.exec(`CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY, mtime REAL, size INTEGER, title TEXT, body TEXT)`);
  // External-content FTS5: bodies stored ONCE (docs table); fts indexes by rowid.
  conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title, body, content='docs', content_rowid='rowid')`);
  conn.exec(`CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END`);
  conn.exec(`CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END`);
  conn.exec(`CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END`);
  return conn;
}

function* discover(dir = PENS): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      yield* discover(full);
    } else if (EXTS.has(e.name.slice(e.name.lastIndexOf(".")))) {
      yield full;
    }
  }
}

let conn = db();

function refresh(force = false): Record<string, unknown> {
  state.scanning = true;
  const t0 = performance.now();
  let rescanned = 0, bytes = 0;
  const insert = conn.prepare(
    `INSERT INTO docs(path, mtime, size, title, body) VALUES(?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size,
     title=excluded.title, body=excluded.body`);
  const get = conn.prepare(`SELECT mtime, size FROM docs WHERE path=?`);
  const upsert = conn.transaction((items: Array<[string, number, number, string, string]>) => {
    for (const row of items) insert.run(...row);
  });
  let batch: Array<[string, number, number, string, string]> = [];
  for (const path of discover()) {
    let st; try { st = statSync(path); } catch { continue; }
    bytes += st.size;
    const row = get.get(path) as { mtime: number; size: number } | null;
    if (row && !force && Math.abs(row.mtime - st.mtimeMs) < 1 && row.size === st.size) continue;
    let text = ""; try { text = readFileSync(path, "utf8"); } catch { continue; }
    const title = text.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "").slice(0, 160) ?? "";
    batch.push([path, st.mtimeMs, st.size, title, text.slice(0, BODY_CAP)]);
    rescanned++;
    if (batch.length >= 500) { upsert(batch); batch = []; }
  }
  if (batch.length) upsert(batch);
  state.indexed = (conn.query(`SELECT count(*) n FROM docs`).get() as { n: number }).n;
  state.bytes = bytes;
  state.lastRefresh = Date.now() / 1000;
  state.scanning = false;
  return { docs: state.indexed, rescanned, bytes, tookMs: Math.round(performance.now() - t0) };
}

function search(query: string, scope?: string, limit = 10): Record<string, unknown> {
  if (state.scanning || !state.indexed)
    return { query, indexing: true, note: "index warming; live lane below", live: liveGrep(query, scope, limit) };
  const ftsQ = query.split(/\s+/).filter(Boolean).map(w => w.replace(/"/g, '""')).join(" ");
  let rows: Array<{ path: string; title: string; rank: number }>;
  try {
    rows = conn.query(
      `SELECT d.path AS path, d.title AS title, bm25(docs_fts) AS rank
       FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
       WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(ftsQ, limit * 4) as typeof rows;
  } catch (e) { return { error: `fts: ${e}` }; }
  const hits = rows
    .filter(r => !scope || r.path.includes(scope))
    .slice(0, limit)
    .map(r => {
      let snippet = "";
      try {
        const text = readFileSync(r.path, "utf8");
        const pos = text.toLowerCase().indexOf(query.toLowerCase().split(" ")[0] ?? "");
        snippet = text.slice(Math.max(0, (pos < 0 ? 0 : pos) - 80), (pos < 0 ? 0 : pos) + 240).replace(/\n/g, " ");
      } catch {}
      return { path: r.path.replace(PENS + "/", ""), title: r.title, score: Math.round(-r.rank * 1000) / 1000, snippet: snippet.slice(0, 320) };
    });
  return { query, hits, count: hits.length };
}

function liveGrep(query: string, scope?: string, limit = 10): string[] {
  try {
    const p = Bun.spawnSync(["ffs", "grep", query, "--root", PENS, "--limit", String(limit * 3)],
      { timeout: 30_000 });
    let lines = p.stdout.toString().split("\n").filter(Boolean);
    if (scope) lines = lines.filter(l => l.includes(scope));
    return lines.slice(0, limit);
  } catch (e) { return [`ffs lane error: ${e}`]; }
}

function readDoc(path: string, offset = 1, limit = 120): Record<string, unknown> {
  const full = path.startsWith("/") ? path : join(PENS, path);
  let text: string;
  try { text = readFileSync(full, "utf8"); } catch { return { error: "no such doc", path }; }
  const lines = text.split("\n");
  return { path, totalLines: lines.length, offset,
    lines: lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${String(offset + i).padStart(5)}| ${l}`) };
}

const TOOLS = [
  { name: "search_docs", description: "Search ALL docs under /home/toxic/pens/** (bun:sqlite FTS5; live ffs fallback). Args: {query, scope?, limit?}",
    inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "read_doc", description: "Read a doc by pens-relative path with line numbers. Args: {path, offset?, limit?}",
    inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "doc_stats", description: "Corpus stats: docs, bytes, last refresh.",
    inputSchema: { type: "object", properties: {} } },
  { name: "refresh_docs", description: "Re-index /home/toxic/pens/** docs (incremental). Args: {force?}",
    inputSchema: { type: "object", properties: { force: { type: "boolean" } } } },
  { name: "compare_repo", description: "Consilience: live repo state from toolkit fabric.json + agentic-moment audit moments. Args: {repo? (exact name), pen?}",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, pen: { type: "string" } } } },
  { name: "compare_list", description: "List the compare/agentic moments recorded in the audit engine (recent first). Args: {limit?}",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
];

const FABRIC_JSON = "/home/toxic/pens/toolkit/fabric.json";
const AUDIT_MOMENTS = "/home/toxic/pens/agentic-moment/products/audit/moments/index.jsonl";

/** Live per-repo trace from the minted fabric.json (not web narrators — the
 *  registry the toolkit generated from per-pen registries + on-disk git). */
function fabricState(): Array<{ pen: string; name: string; head?: string; dirty?: number }> {
  try {
    const f = JSON.parse(readFileSync(FABRIC_JSON, "utf8")) as { pens: Array<{ pen: string; products: Array<{ name: string; head?: string; dirty?: number }> }> };
    const out: Array<{ pen: string; name: string; head?: string; dirty?: number }> = [];
    for (const p of f.pens) for (const prod of p.products) out.push({ pen: p.pen, name: prod.name, head: prod.head, dirty: prod.dirty });
    return out;
  } catch { return []; }
}

/** Agentic moments from the audit engine — the compare trace, most recent first. */
function auditMoments(limit = 20): Array<{ ts: string; title: string; tags: string[] }> {
  try {
    const lines = readFileSync(AUDIT_MOMENTS, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map(l => { try { const m = JSON.parse(l); return { ts: m.ts, title: m.title, tags: m.tags ?? [] }; } catch { return undefined; } }).filter(Boolean) as Array<{ ts: string; title: string; tags: string[] }>;
  } catch { return []; }
}

function compareRepo(repo?: string, pen?: string): unknown {
  const all = fabricState();
  const matches = (repo ? all.filter(r => r.name === repo) : all).filter(r => !pen || r.pen === pen);
  const moments = (repo || pen ? auditMoments(1000) : []).filter(m => !repo || m.title.toLowerCase().includes(repo.toLowerCase()) || m.tags.some(t => t.toLowerCase().includes(repo.toLowerCase())));
  return { repo: repo ?? pen ?? "*", state: matches.slice(0, 25), moments: moments.slice(0, 10), count: matches.length };
}

function handleTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "search_docs") return search(String(args.query ?? ""), args.scope as string | undefined, Number(args.limit ?? 10));
  if (name === "read_doc") return readDoc(String(args.path), Number(args.offset ?? 1), Number(args.limit ?? 120));
  if (name === "doc_stats") return state.indexed ? state : { note: "index cold", ...state };
  if (name === "refresh_docs") return refresh(Boolean(args.force));
  if (name === "compare_repo") return compareRepo(args.repo ? String(args.repo) : undefined, args.pen ? String(args.pen) : undefined);
  if (name === "compare_list") return { moments: auditMoments(Number(args.limit ?? 20)) };
  return { error: `unknown tool ${name}` };
}

// Sync fd-1 write: the fd-0 readSync pump blocks the event loop, so the async
// Bun.write(Bun.stdout) would never flush before stdin EOF — every response
// was silently lost (probe: EXIT=0, stdout 0 bytes; anomaly #79 class, fixed
// 2026-11-02). writeSync(1) bypasses the event loop entirely.
import { writeSync } from "node:fs";
const send = (o: unknown) => writeSync(1, JSON.stringify(o) + "\n");

// Warm synchronously BEFORE the blocking fd-0 pump: the pump never yields to
// the event loop, so a deferred warm would never run. 1.2s warm is well within
// the gateway's 30s initialize deadline.
{
  const r = refresh();
  console.error(`docs-mcp: warmed ${r.docs} docs in ${r.tookMs}ms`);
}

// stdio JSON-RPC via synchronous fd-0 pump.
// Bun 1.4.4 regression: Bun.stdin / Bun.stdin.stream() async iteration never
// yields piped stdin (verified: node sees bytes, both bun installs see none,
// raw fs.readSync(0) works). kappa anomaly #79 hit the same class of bug.
// Deterministic blocking read pump — reads fd 0 until EOF, dispatches lines.
import { readSync } from "node:fs";

const FD0 = 0;
const CHUNK = Buffer.alloc(65_536);

function pumpStdio(): void {
  let buf = "";
  while (true) {
    let n: number;
    try { n = readSync(FD0, CHUNK, 0, CHUNK.length, null); } catch { break; }
    if (n <= 0) break; // EOF or EAGAIN-ish → done
    buf += CHUNK.toString("utf8", 0, n);
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: { method?: unknown; id?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      const { method, id } = msg;
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "docs-mcp", version: "1.2.0-bun" } } });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const p = msg.params ?? {};
        try {
          const result = handleTool(p.name, p.arguments ?? {});
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] } });
        } catch (e) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e}` }] } });
        }
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (id !== undefined && method !== "notifications/initialized") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method ${method} not supported` } });
      }
    }
  }
}

pumpStdio();
