/**
 * Tests for the MCP server's tool registration, resource resolution, and
 * structured-output contracts. Avoids spinning up stdio transport — instead
 * we drive registered handlers directly via the McpServer's internal maps,
 * mirroring what an MCP client would invoke over the wire.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWikiTools, readPage } from "../src/mcp/tools.js";
import { registerWikiResources } from "../src/mcp/resources.js";
import { buildContextPack } from "../src/context/build.js";
import { writePage } from "./fixtures/write-page.js";

let root: string;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `llmwiki-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build a fresh McpServer with all wiki tools and resources registered. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "llmwiki-test", version: "0.0.0" });
  registerWikiTools(server, root);
  registerWikiResources(server, root);
  return server;
}

/** Internal helper: read the server's registered-tool map. */
function getRegisteredTools(server: McpServer): Record<string, unknown> {
  return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

/** Internal helper: read the server's registered-resource map. */
function getRegisteredResources(server: McpServer): Record<string, unknown> {
  return (server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources;
}

/** Internal helper: read the server's registered resource-template map. */
function getRegisteredResourceTemplates(server: McpServer): Record<string, unknown> {
  return (server as unknown as { _registeredResourceTemplates: Record<string, unknown> })._registeredResourceTemplates;
}

/** Invoke a registered tool's handler and return its raw result. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: { result: unknown } }> {
  const tools = getRegisteredTools(server);
  const tool = tools[name] as { handler: (args: Record<string, unknown>) => Promise<unknown> };
  return tool.handler(args) as Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: { result: unknown } }>;
}

describe("MCP server tool registration", () => {
  it("registers all 8 expected tools", () => {
    const server = buildServer();
    const names = Object.keys(getRegisteredTools(server)).sort();
    expect(names).toEqual([
      "compile_wiki",
      "get_context_pack",
      "ingest_source",
      "lint_wiki",
      "query_wiki",
      "read_page",
      "search_pages",
      "wiki_status",
    ]);
  });

  it("registers all 5 expected resources", () => {
    const server = buildServer();
    const staticUris = Object.keys(getRegisteredResources(server)).sort();
    const templateNames = Object.keys(getRegisteredResourceTemplates(server)).sort();
    expect(staticUris).toEqual(["llmwiki://index", "llmwiki://sources", "llmwiki://state"]);
    expect(templateNames).toEqual(["wiki-concept", "wiki-query"]);
  });
});

describe("ingest_source tool", () => {
  it("returns IngestResult shape for a local file", async () => {
    const sourceFile = path.join(root, "input.md");
    await writeFile(
      sourceFile,
      "# Sample\n\nLong enough body to satisfy the minimum source character threshold for ingest.",
    );

    const server = buildServer();
    const result = await callTool(server, "ingest_source", { source: sourceFile });
    const payload = result.structuredContent?.result as Record<string, unknown>;

    expect(payload).toMatchObject({
      filename: expect.any(String),
      charCount: expect.any(Number),
      truncated: false,
      source: sourceFile,
    });
  });
});

describe("compile_wiki tool", () => {
  it("returns CompileResult shape when no sources exist", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-actually-used";
    const server = buildServer();
    const result = await callTool(server, "compile_wiki", {});
    const payload = result.structuredContent?.result as Record<string, unknown>;

    expect(payload).toEqual(expect.objectContaining({
      compiled: expect.any(Number),
      skipped: expect.any(Number),
      deleted: expect.any(Number),
      concepts: expect.any(Array),
      pages: expect.any(Array),
      errors: expect.any(Array),
    }));
  });
});

describe("read_page tool and helper", () => {
  it("reads a concept page", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "neural-networks",
      { title: "Neural Networks", summary: "ML model" },
      "Deep learning basics.",
    );

    const page = await readPage(root, "neural-networks");
    expect(page).toEqual({
      slug: "neural-networks",
      title: "Neural Networks",
      summary: "ML model",
      body: "Deep learning basics.",
    });
  });

  it("falls back to queries dir when concept missing", async () => {
    await writePage(
      path.join(root, "wiki/queries"),
      "what-is-x",
      { title: "What is X?", summary: "An answer" },
      "Saved query body.",
    );

    const page = await readPage(root, "what-is-x");
    expect(page?.title).toBe("What is X?");
    expect(page?.body).toBe("Saved query body.");
  });

  it("returns null when slug exists in neither directory", async () => {
    expect(await readPage(root, "missing")).toBeNull();
  });

  it("read_page tool throws an error for missing pages", async () => {
    const server = buildServer();
    await expect(callTool(server, "read_page", { slug: "missing" })).rejects.toThrow(/not found/);
  });
});

describe("wiki_status tool", () => {
  it("returns expected status shape and does not modify the workspace", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "First" },
      "Body content.",
    );

    const beforeFiles = await snapshotWorkspace(root);
    const server = buildServer();
    const result = await callTool(server, "wiki_status", {});
    const afterFiles = await snapshotWorkspace(root);

    const status = result.structuredContent?.result as Record<string, unknown>;
    expect(status).toEqual(expect.objectContaining({
      pages: expect.objectContaining({ concepts: 1, queries: 0, total: 1 }),
      sources: expect.any(Number),
      orphanedPages: expect.any(Array),
      pendingChanges: expect.any(Array),
    }));
    expect(afterFiles).toEqual(beforeFiles);
  });

  it("reports pendingCandidates equal to the number of valid candidate files", async () => {
    const candidatesDir = path.join(root, ".llmwiki", "candidates");
    await mkdir(candidatesDir, { recursive: true });
    const validCandidates = [
      { id: "alpha-aaaaaaaa", slug: "alpha", title: "Alpha" },
      { id: "beta-bbbbbbbb", slug: "beta", title: "Beta" },
    ];
    for (const seed of validCandidates) {
      await writeFile(
        path.join(candidatesDir, `${seed.id}.json`),
        JSON.stringify({
          id: seed.id,
          title: seed.title,
          slug: seed.slug,
          summary: "Summary",
          sources: ["source.md"],
          body: "body",
          generatedAt: new Date().toISOString(),
        }),
        "utf-8",
      );
    }
    // A malformed JSON file should NOT inflate pendingCandidates.
    await writeFile(path.join(candidatesDir, "broken.json"), "not json", "utf-8");

    const server = buildServer();
    const result = await callTool(server, "wiki_status", {});
    const status = result.structuredContent?.result as { pendingCandidates: number };
    expect(status.pendingCandidates).toBe(validCandidates.length);
  });
});

describe("get_context_pack tool", () => {
  /**
   * Suppress every Anthropic/OpenAI credential the host shell might
   * have set so the tool exercises the documented credential-free
   * path. Returns a restorer for `afterEach`-style cleanup.
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
    process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(root, "no-settings.json");
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  /**
   * Seed one concept page and call `get_context_pack` against it.
   * Centralised so the per-test bodies stay focused on the assertion
   * that differentiates them, and so fallow does not flag the
   * seed+call pair as duplication across sibling tests.
   */
  async function seedRetrievalAndCall(): Promise<{
    pack: Record<string, unknown>;
    result: Awaited<ReturnType<typeof callTool>>;
  }> {
    await writePage(
      path.join(root, "wiki/concepts"),
      "retrieval",
      { title: "Retrieval", summary: "How retrieval works" },
      "Body content.",
    );
    const server = buildServer();
    const result = await callTool(server, "get_context_pack", { prompt: "retrieval" });
    return { pack: result.structuredContent?.result as Record<string, unknown>, result };
  }

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
    const fromCli = await buildContextPack({ root, prompt: "retrieval" });
    expect(pack).toEqual(fromCli);
  });

  it("omitRoot=true keeps project.root present and sets it to null", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const server = buildServer();
    const result = await callTool(server, "get_context_pack", {
      prompt: "alpha",
      omitRoot: true,
    });
    const pack = result.structuredContent?.result as { project: Record<string, unknown> };
    expect(Object.keys(pack.project)).toContain("root");
    expect(pack.project.root).toBeNull();
  });

  it("includeSources=true materializes sourceWindows for a claim-level citation", async () => {
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
    const server = buildServer();
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
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const restore = stripProviderEnv();
    try {
      const server = buildServer();
      const result = await callTool(server, "get_context_pack", { prompt: "alpha" });
      const pack = result.structuredContent?.result as { version: number };
      expect(pack.version).toBe(1);
    } finally {
      restore();
    }
  });

  it("does not mutate project files", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "" },
      "body",
    );
    const beforeFiles = await snapshotWorkspace(root);
    const server = buildServer();
    await callTool(server, "get_context_pack", { prompt: "alpha" });
    const afterFiles = await snapshotWorkspace(root);
    expect(afterFiles).toEqual(beforeFiles);
  });
});

describe("error handling", () => {
  it("query_wiki throws when wiki state is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const server = buildServer();
    await expect(callTool(server, "query_wiki", { question: "anything" })).rejects.toThrow(/index not found/);
  });

  it("compile_wiki surfaces missing-credential errors", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const originalSettingsPath = process.env.LLMWIKI_CLAUDE_SETTINGS_PATH;
    process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(root, "no-such-settings.json");
    const server = buildServer();

    try {
      await expect(callTool(server, "compile_wiki", {})).rejects.toThrow(/Anthropic credentials/);
    } finally {
      if (originalSettingsPath !== undefined) {
        process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = originalSettingsPath;
      } else {
        delete process.env.LLMWIKI_CLAUDE_SETTINGS_PATH;
      }
    }
  });
});

describe("MCP resources", () => {
  it("resolves the wiki-index static resource", async () => {
    await writeFile(path.join(root, "wiki/index.md"), "# Test Index\n");
    const server = buildServer();
    const resource = (getRegisteredResources(server) as Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>)["llmwiki://index"];
    const result = await resource.readCallback(new URL("llmwiki://index"));
    expect(result.contents[0].text).toContain("Test Index");
  });

  it("resolves the wiki-state static resource", async () => {
    const server = buildServer();
    const resource = (getRegisteredResources(server) as Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>)["llmwiki://state"];
    const result = await resource.readCallback(new URL("llmwiki://state"));
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ version: 1, sources: expect.any(Object) });
  });

  it("resolves the wiki-sources static resource", async () => {
    await writeFile(
      path.join(root, "sources/article.md"),
      "---\ntitle: Article\nsource: example.com\n---\n\nbody",
    );
    const server = buildServer();
    const resource = (getRegisteredResources(server) as Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>)["llmwiki://sources"];
    const result = await resource.readCallback(new URL("llmwiki://sources"));
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toEqual([expect.objectContaining({ filename: "article.md", title: "Article" })]);
  });

  it("resolves a wiki-concept template resource", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha", summary: "First" },
      "Concept body.",
    );

    const server = buildServer();
    const template = (getRegisteredResourceTemplates(server) as Record<string, { readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }> }>)["wiki-concept"];
    const result = await template.readCallback(
      new URL("llmwiki://concept/alpha"),
      { slug: "alpha" },
    );
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ slug: "alpha", body: "Concept body." });
  });

  it("resolves a wiki-query template resource", async () => {
    await writePage(
      path.join(root, "wiki/queries"),
      "what-is-x",
      { title: "What is X?", summary: "An answer" },
      "Saved query body.",
    );

    const server = buildServer();
    const template = (getRegisteredResourceTemplates(server) as Record<string, { readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }> }>)["wiki-query"];
    const result = await template.readCallback(
      new URL("llmwiki://query/what-is-x"),
      { slug: "what-is-x" },
    );
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ slug: "what-is-x", body: "Saved query body." });
  });
});

/** Snapshot every file under root by relative path so we can detect mutations. */
async function snapshotWorkspace(rootDir: string): Promise<string[]> {
  const { readdir } = await import("fs/promises");
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else {
        entries.push(path.relative(rootDir, full));
      }
    }
  }
  await walk(rootDir);
  return entries.sort();
}

