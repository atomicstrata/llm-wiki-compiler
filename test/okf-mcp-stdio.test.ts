/**
 * MCP-over-stdio integration test for the OKF export tool.
 *
 * Mirrors `test/mcp-stdio.test.ts`: spawns the actual `llmwiki serve --root <tmp>`
 * binary over stdio, connects an SDK Client via StdioClientTransport, and calls
 * `export_okf` through the full JSON-RPC stack. Verifies the tool produces a
 * bundle on disk and returns a non-error response. `export_okf` makes no LLM
 * calls, so no API key is required.
 */

import { describe, it, expect } from "vitest";
import { stat, writeFile } from "fs/promises";
import path from "path";
import { useMcpRoot, connectMcpClient } from "./fixtures/mcp-test-env.js";

const rootHandle = useMcpRoot("okf-mcp-stdio");

/** Seed a minimal concept page so the OKF bundle has content to export. */
async function seedConceptPage(root: string): Promise<void> {
  await writeFile(
    path.join(root, "wiki/concepts/rag.md"),
    "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n",
    "utf-8",
  );
}

describe("MCP stdio: export_okf produces a bundle", () => {
  it("writes an OKF bundle to disk and returns a non-error response", async () => {
    const root = rootHandle.value;
    await seedConceptPage(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "export_okf", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect((await stat(path.join(root, "dist/exports/okf/index.md"))).isFile()).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
