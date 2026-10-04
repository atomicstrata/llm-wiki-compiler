/**
 * The wiki MCP tools must not write progress to stdout.
 *
 * Over stdio, stdout is the JSON-RPC stream, so a stray
 * `* Ingesting [file]: note.md` line reaches the client as a malformed
 * message. The OKF tools already run under `withQuiet` for this reason
 * (`src/mcp/okf-tools.ts`); these tests hold the wiki tools to the same rule
 * by watching `console.log`, which `output.status` and `output.header` write
 * through. None of these tools call an LLM, so no API key is required.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { useMcpRoot, buildServer, callTool } from "./fixtures/mcp-test-env.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Collect every console.log line printed while `work` runs. */
async function stdoutLinesDuring(work: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  await work();
  return lines;
}

describe("MCP wiki tools keep stdout clean", () => {
  const root = useMcpRoot("mcp-tools-stdout");

  it("ingest_source prints nothing to stdout", async () => {
    const note = path.join(root.value, "note.md");
    await writeFile(note, "# Note\n\nShort.\n", "utf-8");
    const server = buildServer(root.value);
    const lines = await stdoutLinesDuring(() =>
      callTool(server, "ingest_source", { source: note }),
    );
    expect(lines).toEqual([]);
  });

  it("lint_wiki and wiki_status print nothing to stdout", async () => {
    const server = buildServer(root.value);
    const lines = await stdoutLinesDuring(async () => {
      await callTool(server, "lint_wiki", {});
      await callTool(server, "wiki_status", {});
    });
    expect(lines).toEqual([]);
  });
});
