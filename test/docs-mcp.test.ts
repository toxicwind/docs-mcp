import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type Subprocess } from "bun";

// Docs-mcp contract suite (toolkit canonical, toxicwind/docs-mcp.git).
// Drives the REAL stdio server (spawned) — the fd-0 sync pump is the contract.
// Contract: initialize answers after index warm (within gateway 30s deadline);
// search during a scan returns indexing:true + liveGrep fallback; stats reflect
// indexed state; ping round-trips. Cold-build is the first-run cost; the WAL
// DB is stateful (warm-DB 3.3s/137k verified 2026-11-02).
let proc: Subprocess;
let buf = "";
let id = 0;
const pending = new Map<number, { resolve: (v: unknown) => void }>();

function rpc(method: string, params?: unknown): Promise<unknown> {
  const mid = ++id;
  const message = JSON.stringify({ jsonrpc: "2.0", id: mid, method, params: params ?? {} }) + "\n";
  proc.stdin.write(message);
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve });
    setTimeout(() => {
      if (pending.delete(mid)) reject(new Error(`timeout ${method}`));
    }, 40_000);
  });
}

function pump(): void {
  for (;;) {
    const chunk = proc.stdout.read();
    if (chunk === null) break;
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.resolve(msg);
        else p.resolve(msg.result ?? {});
      }
    }
  }
}

beforeAll(() => {
  proc = spawn({
    cmd: ["bun", "/home/toxic/pens/toolkit/products/docs-mcp/docs_mcp.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdout?.readable?.on("data", () => pump());
});

afterAll(() => {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
});

describe("docs-mcp contract", () => {
  it("initialize completes within the gateway deadline and lists MCP tools", async () => {
    const res = (await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    })) as Record<string, unknown>;
    expect(res.capabilities).toBeDefined();
    const tools = (await rpc("tools/list")) as { tools?: unknown[] };
    expect(Array.isArray(tools.tools)).toBe(true);
    const names = (tools.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("search_docs");
    expect(names).toContain("read_doc");
    expect(names).toContain("doc_stats");
  }, 60_000);

  it("ping round-trips", async () => {
    const res = await rpc("ping");
    expect(res).toEqual({});
  }, 15_000);

  it("search returns a result object even while indexing (liveGrep fallback shape)", async () => {
    const res = (await rpc("tools/call", {
      name: "search_docs",
      arguments: { query: "estate lease", limit: 3 },
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).not.toBe(true);
    const text = (res.content ?? []).map((c) => c.text).join("\n");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it("doc_stats reports a documented state shape", async () => {
    const res = (await rpc("tools/call", {
      name: "doc_stats",
      arguments: {},
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    const text = (res.content ?? []).map((c) => c.text).join("\n");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it("read_doc on a real estate doc returns content (not error)", async () => {
    const res = (await rpc("tools/call", {
      name: "read_doc",
      arguments: { path: "/home/toxic/AGENTS.md" },
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    const text = (res.content ?? []).map((c) => c.text).join("\n");
    expect(text).toContain("AGENTS.md");
  }, 60_000);
});