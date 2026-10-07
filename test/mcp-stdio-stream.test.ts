/**
 * @file test/mcp-stdio-stream.test.ts
 * @description Over stdio, `llmwiki serve` owns stdout as its JSON-RPC stream,
 * so every line it writes there must be a JSON-RPC message. An SDK client
 * skips stray lines, which is how progress output went unnoticed, so the
 * subprocess test here reads the raw stream from the built CLI. The session
 * runs `ingest_source`, which prints progress lines when unguarded, alongside
 * a status call, a resource read and a workflow tool.
 *
 * The in-process test covers the server-wide guard on its own: starting the
 * stdio server puts the process in quiet mode, so a handler that forgets to
 * scope quiet mode itself still cannot print.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI } from "./fixtures/run-cli.js";
import { isQuiet, setQuiet } from "../src/utils/output.js";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

const RESPONSE_TIMEOUT_MS = 20_000;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  setQuiet(false);
  for (const child of children.splice(0)) child.kill();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A raw stdio session: every stdout line as written, plus request/response by id. */
interface RawSession {
  lines: string[];
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string): void;
}

/** Spawn the built `llmwiki serve` and speak newline-delimited JSON-RPC to it directly. */
function openRawSession(root: string): RawSession {
  const child = spawn(process.execPath, [CLI, "serve", "--root", root], {
    env: { ...process.env, LLMWIKI_EMBEDDINGS: "off" },
  });
  children.push(child);
  const lines: string[] = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const complete = buffered.split("\n");
    buffered = complete.pop() ?? "";
    for (const line of complete.filter(Boolean)) {
      lines.push(line);
      const message = parseJson(line);
      if (message && typeof message.id === "number") waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  return {
    lines,
    notify: (method) => void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), RESPONSE_TIMEOUT_MS);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
  };
}

/** Parse one line as a JSON object, or null when it is not JSON. */
function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A compiled-looking project plus a short source note to ingest. */
async function projectWithNote(): Promise<{ root: string; note: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-stdio-stream-"));
  roots.push(root);
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  const note = path.join(root, "note.md");
  await writeFile(note, "# Note\n\nShort.\n");
  return { root, note };
}

describe("llmwiki serve over stdio", () => {
  it("writes only JSON-RPC messages to stdout", async () => {
    const { root, note } = await projectWithNote();
    const session = openRawSession(root);
    await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
    session.notify("notifications/initialized");
    const ingest = await session.request("tools/call", { name: "ingest_source", arguments: { source: note } });
    await session.request("tools/call", { name: "wiki_status", arguments: {} });
    await session.request("resources/read", { uri: "llmwiki://index" });
    await session.request("tools/call", { name: "list_workflow_actions", arguments: {} });

    // PRECONDITION pinned: the ingest ran, so its progress lines had a chance to print.
    expect((ingest.result as { isError?: boolean }).isError, JSON.stringify(ingest)).not.toBe(true);
    const notJsonRpc = session.lines.filter(line => parseJson(line)?.jsonrpc !== "2.0");
    expect(notJsonRpc).toEqual([]);
  }, 60_000);
});

describe("startMCPServer", () => {
  it("puts the process in quiet mode before serving", async () => {
    const { startMCPServer } = await import("../src/mcp/server.js");
    const root = await mkdtemp(path.join(tmpdir(), "mcp-server-quiet-"));
    roots.push(root);
    expect(isQuiet(), "quiet mode leaked in from another test").toBe(false);
    await startMCPServer({ root, version: "0.0.0" });
    expect(isQuiet()).toBe(true);
  });
});
