/**
 * Shared MCP-server test fixture used by `test/mcp-server.test.ts`
 * (the broad tool/resource suite) and `test/mcp-context.test.ts`
 * (the Slice 5 `get_context_pack` slice). Both files used to inline
 * the same temp-root lifecycle, server bootstrap, internal-handler
 * caller, and workspace snapshotter; fallow flagged the duplication
 * after the Slice 5 split.
 *
 * Exposed surface:
 *   - `useMcpRoot(prefix)` registers beforeEach/afterEach and
 *     returns a `{ value: string }` so each test reads the current
 *     temp root via `root.value`.
 *   - `connectMcpClient(root)` spawns `llmwiki serve` and connects an
 *     SDK Client over stdio; `parseToolPayload` decodes its results.
 *   - `snapshotWorkspace(root)` walks the temp root and returns the
 *     sorted relative-path list so tests can assert "this tool did
 *     not mutate the workspace".
 *
 * The in-process server (`buildServer`, `callTool`) lives in
 * `mcp-test-server.ts`: it registers every wiki tool, which loads most
 * of the source tree, and the stdio tests talk to a CLI subprocess
 * instead, so they should not pay for it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, CLI_RUNTIME_FLAGS } from "./run-cli.js";

/** Live container for the current test's temp root path. */
export interface McpRootHandle {
  value: string;
}

/**
 * Test composable that creates + tears down a per-test temp
 * workspace with the directory layout the MCP server expects.
 * `prefix` lets each test file have an identifiable temp-dir name.
 */
export function useMcpRoot(prefix: string): McpRootHandle {
  const handle: McpRootHandle = { value: "" };
  beforeEach(async () => {
    handle.value = path.join(
      os.tmpdir(),
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(path.join(handle.value, "wiki/concepts"), { recursive: true });
    await mkdir(path.join(handle.value, "wiki/queries"), { recursive: true });
    await mkdir(path.join(handle.value, "sources"), { recursive: true });
    await mkdir(path.join(handle.value, ".llmwiki"), { recursive: true });
  });
  afterEach(async () => {
    await rm(handle.value, { recursive: true, force: true });
  });
  return handle;
}

/** A connected SDK Client + its transport, spawned over real stdio. */
export interface McpClientHandle {
  client: Client;
  transport: StdioClientTransport;
}

/**
 * Spawn `llmwiki serve --root <root>` over stdio and connect an SDK Client
 * through the full JSON-RPC stack. Shared by every MCP stdio integration test.
 */
export async function connectMcpClient(root: string): Promise<McpClientHandle> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [...CLI_RUNTIME_FLAGS, CLI, "serve", "--root", root],
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Parse the JSON payload out of a tool response's text content blocks. Shared by
 * the stdio integration tests so the text-join + JSON.parse lives in one place.
 *
 * @param result - A `tools/call` response from an SDK Client.
 * @returns The decoded JSON payload, typed by the caller.
 */
export function parseToolPayload<T>(result: CallToolResult): T {
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return JSON.parse(text) as T;
}

/**
 * Snapshot every file under `rootDir` by relative path so tests can
 * assert "this tool did not mutate the workspace" via a round-trip
 * equality check.
 */
export async function snapshotWorkspace(rootDir: string): Promise<string[]> {
  const entries: string[] = [];
  await walkInto(rootDir, rootDir, entries);
  return entries.sort();
}

/** Recursive walker used by {@link snapshotWorkspace}. */
async function walkInto(rootDir: string, dir: string, out: string[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await walkInto(rootDir, full, out);
    else out.push(path.relative(rootDir, full));
  }
}
