/**
 * MCP-over-stdio integration tests for the OKF tools.
 *
 * Mirrors `test/mcp-stdio.test.ts`: each test spawns the actual
 * `llmwiki serve --root <tmp>` binary over stdio, connects an SDK Client via
 * StdioClientTransport, and drives a tool through the full JSON-RPC stack.
 * Covers `export_okf` (happy path), and `import_okf` staging, path-confinement
 * rejection, and dry-run — the paths a fake in-process `registerTool` can't
 * exercise. None of these tools call an LLM, so no API key is required.
 *
 * Root isolation: each `describe` owns its OWN `useMcpRoot` handle, and
 * `useMcpRoot` reassigns the root via `beforeEach` so every `it` gets a fresh
 * temp dir. The staging test (writes a candidate) and the dry-run test (asserts
 * zero candidates) therefore never share a root.
 */

import { describe, it, expect } from "vitest";
import { stat, writeFile, mkdir } from "fs/promises";
import path from "path";
import { useMcpRoot, connectMcpClient } from "./fixtures/mcp-test-env.js";
import { listCandidates } from "../src/compiler/candidates.js";

/** Seed a minimal concept page so the OKF bundle has content to export. */
async function seedConceptPage(root: string): Promise<void> {
  await writeFile(
    path.join(root, "wiki/concepts/rag.md"),
    "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n",
    "utf-8",
  );
}

/** Write a foreign OKF bundle under `<root>/kb` with one valid concept doc. */
async function writeBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "kb/concepts"), { recursive: true });
  await writeFile(path.join(root, "kb/concepts/a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n", "utf-8");
}

/** Read the JSON payload a tool returned via `jsonResult` (structuredContent.result). */
function payloadOf(result: Awaited<ReturnType<Awaited<ReturnType<typeof connectMcpClient>>["client"]["callTool"]>>): Record<string, unknown> {
  return (result.structuredContent as { result: Record<string, unknown> }).result;
}

describe("MCP stdio: export_okf produces a bundle", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-export");
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

describe("MCP stdio: import_okf stages candidates", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-import");
  it("stages a candidate and conveys the review gate over the wire", async () => {
    const root = rootHandle.value;
    await writeBundle(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "import_okf", arguments: { dir: "kb" } });
      expect(result.isError).toBeFalsy();
      expect((await listCandidates(root)).length).toBe(1);
      expect(payloadOf(result).nextAction).toMatch(/review|approve|staged/i);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("MCP stdio: OKF tools confine agent-supplied paths", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-confine");
  it("rejects an import dir and an export out that escape the root", async () => {
    const root = rootHandle.value;

    const { client, transport } = await connectMcpClient(root);
    try {
      const importEscape = await client.callTool({ name: "import_okf", arguments: { dir: "/etc" } });
      expect(importEscape.isError).toBe(true);
      const exportEscape = await client.callTool({ name: "export_okf", arguments: { out: "../escape" } });
      expect(exportEscape.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("MCP stdio: import_okf dry-run stages nothing", () => {
  const rootHandle = useMcpRoot("okf-mcp-stdio-dryrun");
  it("previews without staging and reports dry-run over the wire", async () => {
    const root = rootHandle.value;
    await writeBundle(root);

    const { client, transport } = await connectMcpClient(root);
    try {
      const result = await client.callTool({ name: "import_okf", arguments: { dir: "kb", dryRun: true } });
      expect(result.isError).toBeFalsy();
      expect(payloadOf(result).mode).toBe("dry-run");
      expect((await listCandidates(root)).length).toBe(0);
      expect(payloadOf(result).nextAction).toMatch(/preview|re-run|dryRun/i);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
