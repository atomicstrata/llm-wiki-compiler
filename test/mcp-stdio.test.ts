/**
 * First real MCP-over-stdio integration test for llmwiki.
 *
 * Previous MCP tests drive registered handlers in-process (no transport). This
 * file spawns the actual `llmwiki serve --root <tmp>` binary over stdio, connects
 * an SDK Client via StdioClientTransport, and calls `wiki_status` through the
 * full JSON-RPC stack — verifying the pending-review count from a seeded candidate.
 *
 * The candidate is written directly into `.llmwiki/candidates/` so no LLM is
 * needed and the test is fully deterministic. `wiki_status` is read-only and
 * never calls a provider, so no API key is required.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI } from "./fixtures/run-cli.js";
import { useMcpRoot } from "./fixtures/mcp-test-env.js";

const rootHandle = useMcpRoot("mcp-stdio");

/** Write a minimal valid ReviewCandidate JSON into the candidates directory. */
async function seedPendingCandidate(root: string): Promise<void> {
  const now = new Date().toISOString();
  const candidate = {
    id: "alpha-deadbeef",
    title: "Alpha",
    slug: "alpha",
    summary: "Alpha summary.",
    sources: ["intro.md"],
    body: `---\ntitle: Alpha\nsummary: Alpha summary.\nsources: []\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n---\n\n# Alpha\n\nAlpha summary.`,
    generatedAt: now,
    reviewMode: "policy",
    heldReasons: [{ code: "low-confidence" }],
  };
  const candidatesDir = path.join(root, ".llmwiki", "candidates");
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(
    path.join(candidatesDir, `${candidate.id}.json`),
    JSON.stringify(candidate, null, 2),
    "utf-8",
  );
}

/** Connect an SDK Client to a freshly spawned llmwiki MCP server. */
async function connectMcpClient(root: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "serve", "--root", root],
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/** Parse the JSON status payload from a wiki_status tool response. */
function parseStatusResult(result: Awaited<ReturnType<Client["callTool"]>>): { pendingCandidates: number } {
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return JSON.parse(text) as { pendingCandidates: number };
}

describe("MCP stdio: wiki_status pending-review count", () => {
  it("reports pendingCandidates ≥ 1 after seeding a candidate file", async () => {
    const root = rootHandle.value;
    await seedPendingCandidate(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "wiki_status", arguments: {} });
      const status = parseStatusResult(result);
      expect(status.pendingCandidates).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
