import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type Subprocess } from "bun";

// Docs-mcp contract suite (toolkit canonical, toxicwind/docs-mcp.git).
// Drives the REAL stdio server (spawned) — the fd-0 sync pump + sync fd-1
// write deadlock fix is the contract under test (was: async Bun.write never
// flushed behind readSync, silently losing every response; fixed 2026-11-02
// with writeSync(1)). Integration test: real wall-clock timers are the only
// way to bound a child process's I/O — fake timers cannot drive it.
let proc: Subprocess;
let buf = "";
let id = 0;
const pending: Record<number, (value: unknown) => void> = {};

const RPC_TIMEOUT_MS = 40_000;

function rpc(method: string, params?: unknown): Promise<unknown> {
  const mid = ++id;
  const message = JSON.stringify({ jsonrpc: "2.0", id: mid, method, params: params ?? {} }) + "\n";
  proc.stdin.write(message);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  pending[mid] = resolve;
  const timer = setTimeout(() => {
    if (pending[mid]) {
      delete pending[mid];
      reject(new Error(`timeout ${method}`));
    }
  }, RPC_TIMEOUT_MS);
  void timer;
  return promise;
}

async function pump(child: Subprocess): Promise<void> {
  const stream = child.stdout;
  if (!stream) return;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value as Uint8Array);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: unknown; error?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown; error?: unknown; result?: unknown };
      } catch {
        continue;
      }
      if (msg && typeof msg.id === "number" && pending[msg.id]) {
        const settle = pending[msg.id];
        delete pending[msg.id];
        settle(msg.error ?? msg.result ?? {});
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
  void pump(proc);
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
    const tools = (await rpc("tools/list")) as { tools?: unknown };
    expect(tools.tools).toBeDefined();
  }, RPC_TIMEOUT_MS + 20_000);

  it("ping round-trips", async () => {
    const res = await rpc("ping");
    expect(res).toEqual({});
  }, RPC_TIMEOUT_MS + 5_000);

  it("tools/call search_docs returns a payload (even while indexing)", async () => {
    const res = (await rpc("tools/call", {
      name: "search_docs",
      arguments: { query: "estate lease", limit: 3 },
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(Array.isArray(res.content)).toBe(true);
  }, RPC_TIMEOUT_MS + 20_000);

  it("tools/call read_doc on a real estate doc returns AGENTS content", async () => {
    const res = (await rpc("tools/call", {
      name: "read_doc",
      arguments: { path: "/home/toxic/AGENTS.md" },
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).not.toBe(true);
    const text = (res.content ?? []).map((c) => c.text).join("\n");
    expect(text).toContain("AGENTS.md");
  }, RPC_TIMEOUT_MS + 20_000);
});