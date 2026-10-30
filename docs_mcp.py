#!/usr/bin/env python3
"""docs-mcp — universal documentation index + search over /home/toxic/pens/**.

Discovers EVERY doc (*.md, *.txt, *.rst) under the pens tree (auto-skipping
node_modules/.git/target/dist/bazel*), indexes it into a local sqlite FTS5
database (stdlib only — universal, no service dependency), and serves:

  MCP tools:
    search_docs(query, scope?, limit?)  — FTS5-ranked hits with path + snippet
    read_doc(path, offset?, limit?)     — content with line numbers
    doc_stats()                         — corpus: docs, bytes, pens covered
    refresh_docs(force?)                — incremental re-index (mtime-based)

Design doctrine:
- Universal: works for ANY /home/toxic/pens/** layout, not estate-specific.
- Zero external services: sqlite3 FTS5 ships with python; no hindsight, no
  vector DB, no network. (A hindsight vector lane can bolt on later behind
  the same tool surface if its API becomes reachable.)
- ffs live lane: search_docs --live delegates to `ffs grep` for regex-grade
  search when FTS ranking is not enough.
- Incremental: files are re-read only when mtime/size changed; a full rescan
  of ~18k files takes seconds, the index makes search milliseconds.

MCP stdio: JSON-RPC 2.0 (initialize / tools/list / tools/call).
Register in thresher mcp_config.json + ~/.local/bin symlink.
"""
import asyncio, json, os, sqlite3, sys, time

PENS = os.environ.get("DOCS_MCP_ROOT", "/home/toxic/pens")
DB = os.path.expanduser("~/.cache/morphe/docs-index.sqlite3")
SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", ".venv", "venv",
             "__pycache__", ".cache", "bazel-out", "bazel-bin", "bazel-testlogs",
             "bazel-tau", ".next", ".turbo", "vendor"}
EXTS = (".md", ".txt", ".rst")

state = {"indexed": 0, "bytes": 0, "last_refresh": 0, "scanned": 0}


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB, timeout=30)
    conn.execute("""CREATE TABLE IF NOT EXISTS docs (
        path TEXT PRIMARY KEY, mtime REAL, size INTEGER, title TEXT, body TEXT)""")
    conn.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        path, title, body, content='docs', content_rowid='rowid')""")
    return conn


def discover():
    """Yield doc paths under PENS (universal: any pens/** layout)."""
    for root, dirs, files in os.walk(PENS):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for f in files:
            if f.endswith(EXTS):
                yield os.path.join(root, f)


def index_one(conn, path):
    try:
        st = os.stat(path)
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return 0
    title = ""
    for line in text.splitlines():
        if line.strip():
            title = line.lstrip("# ").strip()[:160]
            break
    conn.execute("INSERT INTO docs(path, mtime, size, title, body) VALUES(?,?,?,?,1) "
                 "ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, "
                 "title=excluded.title, body=excluded.body",
                 (path, st.st_mtime, st.st_size, title))
    # body placeholder trick: store real body in a second column to avoid dup storage
    conn.execute("UPDATE docs SET body=? WHERE path=?", (text, path))
    conn.execute("INSERT INTO docs_fts(path, title, body) SELECT path, title, body FROM docs WHERE path=?",
                 (path,))
    return len(text)


def refresh(force=False):
    conn = db()
    scanned = added = total_bytes = 0
    t0 = time.time()
    for path in discover():
        scanned += 1
        try:
            st = os.stat(path)
        except OSError:
            continue
        row = conn.execute("SELECT mtime, size FROM docs WHERE path=?", (path,)).fetchone()
        if row and not force and abs(row[0] - st.st_mtime) < 1 and row[1] == st.st_size:
            total_bytes += row[1]
            continue
        n = index_one(conn, path)
        added += 1
        total_bytes += n
        if added % 500 == 0:
            conn.commit()
    conn.commit()
    n_docs = conn.execute("SELECT count(*) FROM docs").fetchone()[0]
    conn.close()
    state.update({"indexed": n_docs, "bytes": total_bytes, "last_refresh": time.time(), "scanned": scanned})
    return {"docs": n_docs, "rescanned": added, "scanned": scanned,
            "bytes": total_bytes, "took_s": round(time.time() - t0, 2)}


def search(query, scope=None, limit=10):
    if not state["indexed"]:
        return {"query": query, "indexing": True,
                "note": "background index warming; use the live lane",
                "live": live_grep(query, scope, limit)}
    conn = db()
    q = " ".join(w.replace('"', '""') for w in query.split() if w) or '""'
    sql = ("SELECT path, title, bm25(docs_fts) AS rank FROM docs_fts WHERE docs_fts MATCH ? "
           "ORDER BY rank LIMIT ?")
    hits = []
    try:
        rows = conn.execute(sql, (q, limit * 4)).fetchall()
    except sqlite3.OperationalError as e:
        return {"error": "fts: %s" % e, "hint": "try simpler terms"}
    for path, title, rank in rows:
        if scope and scope not in path:
            continue
        snippet = ""
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            pos = text.lower().find(query.lower().split()[0]) if query.split() else -1
            if pos < 0:
                pos = 0
            snippet = text[max(0, pos - 80): pos + 240].replace("\n", " ")
        except OSError:
            pass
        hits.append({"path": path.replace(PENS + "/", ""), "title": title,
                     "score": round(-rank, 3), "snippet": snippet[:320]})
        if len(hits) >= limit:
            break
    conn.close()
    if not hits:
        return {"query": query, "hits": [], "note": "no FTS hit; try the live lane", "live": live_grep(query, scope, limit)}
    return {"query": query, "hits": hits}


def live_grep(query, scope=None, limit=10):
    """ffs lane: regex-grade live search over the pens tree."""
    import subprocess
    try:
        r = subprocess.run(["ffs", "grep", query, "--root", PENS, "--limit", str(limit * 3)],
                           capture_output=True, text=True, timeout=30)
        lines = [l for l in r.stdout.splitlines() if l.strip()][: limit * 3]
        if scope:
            lines = [l for l in lines if scope in l]
        return lines[:limit]
    except Exception as e:
        return ["ffs lane error: %s" % e]


def read_doc(path, offset=1, limit=120):
    full = os.path.join(PENS, path) if not path.startswith("/") else path
    if not os.path.isfile(full):
        return {"error": "no such doc", "path": path}
    with open(full, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    sel = lines[offset - 1: offset - 1 + limit]
    return {"path": path, "total_lines": len(lines), "offset": offset,
            "lines": ["%5d| %s" % (offset + i, l.rstrip()) for i, l in enumerate(sel)]}


# ---------------- MCP stdio ----------------

TOOLS = [
    {"name": "search_docs", "description": "Search ALL docs under /home/toxic/pens/** (FTS5-ranked; falls back to live ffs grep). Args: {query, scope?, limit?}",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "scope": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}},
    {"name": "read_doc", "description": "Read a doc by (pens-relative) path with line numbers. Args: {path, offset?, limit?}",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}, "required": ["path"]}},
    {"name": "doc_stats", "description": "Corpus stats: docs indexed, bytes, last refresh.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "refresh_docs", "description": "Incremental re-index of /home/toxic/pens/** docs. Args: {force?}",
     "inputSchema": {"type": "object", "properties": {"force": {"type": "boolean"}}}},
]


def handle_tool(name, args):
    if name == "search_docs":
        return search(args.get("query", ""), args.get("scope"), int(args.get("limit", 10)))
    if name == "read_doc":
        return read_doc(args["path"], int(args.get("offset", 1)), int(args.get("limit", 120)))
    if name == "doc_stats":
        if not state["indexed"]:
            return {"note": "index cold; run refresh_docs first", **state}
        return state
    if name == "refresh_docs":
        return refresh(bool(args.get("force")))
    return {"error": "unknown tool %s" % name}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def main():
    # index in a BACKGROUND thread: serve MCP immediately; search_docs before
    # the index warms reports "indexing" + the live ffs lane still answers.
    import threading
    threading.Thread(target=_bg_index, daemon=True).start()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    def _reader():
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)
    import threading
    threading.Thread(target=_reader, daemon=True).start()
    while True:
        line = await queue.get()
        if line is None:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        rid = msg.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "docs-mcp", "version": "1.0.0"}}})
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            params = msg.get("params") or {}
            try:
                result = handle_tool(params.get("name"), params.get("arguments") or {})
                text = json.dumps(result, indent=1, default=str)
                send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}})
            except Exception as e:
                send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "error: %s" % e}]}})
        elif method in ("ping",):
            send({"jsonrpc": "2.0", "id": rid, "result": {}})
        else:
            if rid is not None:
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method %s not supported" % method}})


def _bg_index():
    try:
        r = refresh()
        sys.stderr.write("docs-mcp: background index done %s\n" % json.dumps(r))
    except Exception as e:
        sys.stderr.write("docs-mcp: index error %s\n" % e)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
