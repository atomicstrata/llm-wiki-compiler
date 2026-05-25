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
 *   - `buildServer(root)` returns a fresh `McpServer` with every
 *     wiki tool + resource registered.
 *   - `callTool(server, name, args)` invokes a registered tool's
 *     handler directly (no stdio transport) and returns its raw
 *     `{ content, structuredContent }` envelope.
 *   - `snapshotWorkspace(root)` walks the temp root and returns the
 *     sorted relative-path list so tests can assert "this tool did
 *     not mutate the workspace".
 */

import { mkdir, readdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWikiTools } from "../../src/mcp/tools.js";
import { registerWikiResources } from "../../src/mcp/resources.js";

/** Live container for the current test's temp root path. */
export interface McpRootHandle {
  value: string;
}

/**
 * Vitest composable that creates + tears down a per-test temp
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

/** Build a fresh McpServer with all wiki tools and resources registered. */
export function buildServer(root: string): McpServer {
  const server = new McpServer({ name: "llmwiki-test", version: "0.0.0" });
  registerWikiTools(server, root);
  registerWikiResources(server, root);
  return server;
}

/** MCP envelope shape returned by every registered tool handler. */
export interface McpToolEnvelope {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { result: unknown };
}

/**
 * Invoke a registered tool's handler directly. Mirrors what an MCP
 * client would do over stdio without paying the transport setup cost.
 */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolEnvelope> {
  const tools = (server as unknown as {
    _registeredTools: Record<
      string,
      { handler: (a: Record<string, unknown>) => Promise<unknown> }
    >;
  })._registeredTools;
  const tool = tools[name];
  return tool.handler(args) as Promise<McpToolEnvelope>;
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
