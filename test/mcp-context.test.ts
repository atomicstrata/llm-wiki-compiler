/**
 * Slice 5 MCP tests for `get_context_pack`.
 *
 * Lives in a sibling file so `test/mcp-server.test.ts` (which exercises
 * every other MCP tool + resource) stays inside the 400-line ceiling
 * the repo enforces on test files. The contracts pinned here:
 *   - the tool returns the v1 envelope shape and the text content
 *     block parses back to the same `structuredContent.result`
 *   - the MCP payload matches `buildContextPack()` byte-for-byte —
 *     the tool must NOT fork JSON construction
 *   - `omitRoot=true` keeps `project.root` present and `null`
 *   - `includeSources=true` materializes source windows for a
 *     claim-level citation
 *   - the tool works with every provider credential stripped
 *   - the tool does not mutate project files
 *
 * Tests drive the registered handler directly via the McpServer's
 * internal `_registeredTools` map — same pattern as mcp-server.test.ts
 * — so we never spin up an stdio transport.
 */

import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { buildContextPack } from "../src/context/build.js";
import { writePage } from "./fixtures/write-page.js";
import {
  buildServer,
  callTool,
  snapshotWorkspace,
  useMcpRoot,
} from "./fixtures/mcp-test-env.js";
import {
  sha256Hex,
  writeSourceFile,
  writeSourceState,
} from "./fixtures/state-json.js";

const rootHandle = useMcpRoot("llmwiki-mcp-context");
const rootOf = (): string => rootHandle.value;

/**
 * Suppress every Anthropic/OpenAI credential the host shell might have
 * set so the tool exercises the documented credential-free path.
 * Returns a restorer that puts every value back exactly as it was.
 */
function stripProviderEnv(): () => void {
  const previous: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    LLMWIKI_CLAUDE_SETTINGS_PATH: process.env.LLMWIKI_CLAUDE_SETTINGS_PATH,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(rootOf(), "no-settings.json");
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Seed one concept page and call `get_context_pack` against it.
 * Centralised so the per-test bodies focus on the assertion that
 * differentiates them, and fallow does not flag the seed+call pair
 * as duplication across sibling tests.
 */
async function seedRetrievalAndCall(): Promise<{
  pack: Record<string, unknown>;
  result: Awaited<ReturnType<typeof callTool>>;
}> {
  const root = rootOf();
  await writePage(
    path.join(root, "wiki/concepts"),
    "retrieval",
    { title: "Retrieval", summary: "How retrieval works" },
    "Body content.",
  );
  const server = buildServer(root);
  const result = await callTool(server, "get_context_pack", { prompt: "retrieval" });
  return {
    pack: result.structuredContent?.result as Record<string, unknown>,
    result,
  };
}

describe("get_context_pack tool", () => {
  it("returns v1 envelope with the stable top-level field set over a seeded wiki page", async () => {
    const { pack, result } = await seedRetrievalAndCall();
    expect(pack.version).toBe(1);
    expect(Object.keys(pack)).toEqual([
      "version",
      "prompt",
      "budget",
      "project",
      "primary",
      "neighbors",
      "warnings",
      "gaps",
      "suggestedActions",
    ]);
    // structuredContent and the text content block must agree byte-for-byte.
    expect(JSON.parse(result.content[0].text)).toEqual(pack);
  });

  it("matches buildContextPack() output byte-for-byte for the same inputs", async () => {
    const { pack } = await seedRetrievalAndCall();
    const fromCli = await buildContextPack({ root: rootOf(), prompt: "retrieval" });
    expect(pack).toEqual(fromCli);
  });

  it("omitRoot=true keeps project.root present and sets it to null", async () => {
    const root = rootOf();
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const server = buildServer(root);
    const result = await callTool(server, "get_context_pack", {
      prompt: "alpha",
      omitRoot: true,
    });
    const pack = result.structuredContent?.result as { project: Record<string, unknown> };
    expect(Object.keys(pack.project)).toContain("root");
    expect(pack.project.root).toBeNull();
  });

  it("includeSources=true materializes sourceWindows for a claim-level citation", async () => {
    const root = rootOf();
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "Cited prose. ^[paper.md:2-4]",
    );
    await writeFile(
      path.join(root, "sources", "paper.md"),
      ["one", "two", "three", "four", "five"].join("\n"),
      "utf-8",
    );
    const server = buildServer(root);
    const result = await callTool(server, "get_context_pack", {
      prompt: "alpha",
      includeSources: true,
    });
    const pack = result.structuredContent?.result as {
      primary: Array<{ sourceWindows: Array<Record<string, unknown>> }>;
    };
    expect(pack.primary[0].sourceWindows).toEqual([
      { file: "paper.md", start: 2, end: 4, text: "two\nthree\nfour" },
    ]);
  });

  it("works without provider credentials (semantic retrieval falls back silently)", async () => {
    const root = rootOf();
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const restore = stripProviderEnv();
    try {
      const server = buildServer(root);
      const result = await callTool(server, "get_context_pack", { prompt: "alpha" });
      const pack = result.structuredContent?.result as { version: number };
      expect(pack.version).toBe(1);
    } finally {
      restore();
    }
  });

  it("does not mutate project files", async () => {
    const root = rootOf();
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const beforeFiles = await snapshotWorkspace(root);
    const server = buildServer(root);
    await callTool(server, "get_context_pack", { prompt: "alpha" });
    const afterFiles = await snapshotWorkspace(root);
    expect(afterFiles).toEqual(beforeFiles);
  });

  it("get_context_pack surfaces freshnessStatus on primary pages", async () => {
    const root = rootOf();
    // State records OLD hash; disk has NEW content → stale
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] },
    });
    await writeSourceFile(root, "a.md", "NEW body");
    await writePage(
      path.join(root, "wiki/concepts"),
      "topic",
      { title: "Topic", summary: "The topic page" },
      "A topic page body.",
    );
    const server = buildServer(root);
    const result = await callTool(server, "get_context_pack", { prompt: "topic" });
    const pack = result.structuredContent?.result as {
      primary: Array<{ id: string; freshnessStatus: string }>;
    };
    const primary = pack.primary.find((p) => p.id.endsWith("topic"));
    expect(primary).toBeDefined();
    expect(primary?.freshnessStatus).toBe("stale");
  });
});
