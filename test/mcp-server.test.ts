/**
 * Tests for the MCP server's tool registration, resource resolution, and
 * structured-output contracts. Avoids spinning up stdio transport — instead
 * we drive registered handlers directly via the McpServer's internal maps,
 * mirroring what an MCP client would invoke over the wire.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readPageRecord } from "../src/pages/read.js";
import { writePage } from "./fixtures/write-page.js";
import {
  buildServer as buildSharedServer,
  callTool as callSharedTool,
  snapshotWorkspace,
  useMcpRoot,
} from "./fixtures/mcp-test-env.js";
import { appendHistory } from "../src/eval/stats.js";
import { makeEvalReport } from "./fixtures/eval-report.js";

const rootHandle = useMcpRoot("llmwiki-mcp");
/**
 * Mirror the shared fixture's temp-root path into a file-local
 * binding so the existing per-test bodies keep their `root` ergonomics.
 * This beforeEach runs AFTER `useMcpRoot`'s, which is the one that
 * creates the temp directory and assigns `rootHandle.value`.
 */
let root: string;
beforeEach(() => {
  root = rootHandle.value;
});

/** Local thin wrapper so the per-test bodies keep their `buildServer()` ergonomics. */
function buildServer(): McpServer {
  return buildSharedServer(root);
}

/** Local thin wrapper around the shared MCP tool caller. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: { result: unknown };
}> {
  return callSharedTool(server, name, args);
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

describe("MCP server tool registration", () => {
  it("registers all 10 expected tools", () => {
    const server = buildServer();
    const names = Object.keys(getRegisteredTools(server)).sort();
    expect(names).toEqual([
      "compile_wiki",
      "get_context_pack",
      "ingest_source",
      "lint_wiki",
      "query_wiki",
      "read_page",
      "run_eval",
      "search_pages",
      "verify_artifact",
      "wiki_status",
    ]);
  });

  it("registers all 5 expected resources", () => {
    const server = buildServer();
    const staticUris = Object.keys(getRegisteredResources(server)).sort();
    const templateNames = Object.keys(getRegisteredResourceTemplates(server)).sort();
    expect(staticUris).toEqual([
      "llmwiki://eval/history",
      "llmwiki://eval/report",
      "llmwiki://index",
      "llmwiki://sources",
      "llmwiki://state",
    ]);
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

describe("read_page tool and readPageRecord helper", () => {
  it("reads a concept page", async () => {
    await writePage(
      path.join(root, "wiki/concepts"),
      "neural-networks",
      { title: "Neural Networks", summary: "ML model" },
      "Deep learning basics.",
    );

    const page = await readPageRecord(root, "neural-networks");
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

    const page = await readPageRecord(root, "what-is-x");
    expect(page?.title).toBe("What is X?");
    expect(page?.body).toBe("Saved query body.");
  });

  it("returns null when slug exists in neither directory", async () => {
    expect(await readPageRecord(root, "missing")).toBeNull();
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

describe("error handling", () => {
  it("query_wiki throws when wiki state is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const server = buildServer();
    await expect(callTool(server, "query_wiki", { question: "anything" })).rejects.toThrow(/index not found/);
  });

  it("compile_wiki surfaces missing-credential errors", async () => {
    await withNoCredentials(root, async () => {
      const server = buildServer();
      await expect(callTool(server, "compile_wiki", {})).rejects.toThrow(/Anthropic credentials/);
    });
  });
});

type ResourceMap = Record<string, { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }>;

/** Read a static resource and return its first content block's raw text. */
async function readStaticResourceText(uri: string): Promise<string> {
  const server = buildServer();
  const resource = (getRegisteredResources(server) as ResourceMap)[uri];
  const result = await resource.readCallback(new URL(uri));
  return result.contents[0].text;
}

describe("MCP resources", () => {
  it("resolves the wiki-index static resource", async () => {
    await writeFile(path.join(root, "wiki/index.md"), "# Test Index\n");
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://index"];
    const result = await resource.readCallback(new URL("llmwiki://index"));
    expect(result.contents[0].text).toContain("Test Index");
  });

  it("resolves the wiki-state static resource", async () => {
    const parsed = JSON.parse(await readStaticResourceText("llmwiki://state"));
    expect(parsed).toMatchObject({ version: 1, sources: expect.any(Object) });
  });

  it("fails closed on a too-new state — does NOT stream the raw body", async () => {
    // A version-3 state was written by a newer llmwiki; the resource must not
    // serialize the body verbatim as if healthy (every sibling surface branches
    // on status). It surfaces the too-new condition and omits the real state.
    await writeFile(
      path.join(root, ".llmwiki/state.json"),
      JSON.stringify({ version: 3, indexHash: "secret", sources: { "leak.md": {} } }),
    );
    const text = await readStaticResourceText("llmwiki://state");
    const parsed = JSON.parse(text);
    expect(parsed.stateStatus).toBe("too-new");
    expect(parsed.error).toMatch(/newer llmwiki version/);
    expect(parsed).not.toHaveProperty("sources");
    expect(text).not.toContain("secret");
  });

  it("resolves the wiki-sources static resource", async () => {
    await writeFile(
      path.join(root, "sources/article.md"),
      "---\ntitle: Article\nsource: example.com\n---\n\nbody",
    );
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://sources"];
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

  it("S13: a `Foo #1` concept page round-trips through an encoded resource URI", async () => {
    const slug = "Foo #1";
    await writePage(path.join(root, "wiki/concepts"), slug, { title: "Foo One", summary: "S" }, "Hashy body.");

    const server = buildServer();
    const template = (getRegisteredResourceTemplates(server) as Record<string, { readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }> }>)["wiki-concept"];
    // The list URI percent-encodes the slug; the read decodes it back to the
    // raw slug var — `#` does not truncate the page-part at the fragment.
    const encoded = encodeURIComponent(slug);
    const result = await template.readCallback(new URL(`llmwiki://concept/${encoded}`), { slug });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ slug, body: "Hashy body." });
  });
});

describe("run_eval tool", () => {
  it("returns EvalReport shape for an empty project (fast suite)", async () => {
    const server = buildServer();
    const result = await callTool(server, "run_eval", { suite: "fast" });
    const payload = result.structuredContent?.result as Record<string, unknown>;
    expect(payload).toMatchObject({
      suite: "fast",
      timestamp: expect.any(String),
      health: expect.objectContaining({ score: expect.any(Number) }),
      citationCoverage: expect.objectContaining({ coveragePercent: expect.any(Number) }),
      stats: expect.objectContaining({ pageCount: expect.any(Number) }),
      thresholdViolations: expect.any(Array),
    });
    expect(payload.citationSupport).toBeUndefined();
  });

  it("throws credentials error when suite=full and no provider configured", async () => {
    await withNoCredentials(root, async () => {
      const server = buildServer();
      await expect(callTool(server, "run_eval", { suite: "full" })).rejects.toThrow(/Anthropic credentials/);
    });
  });
});

describe("eval resources", () => {
  it("resolves llmwiki://eval/report returning {} when no history exists", async () => {
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://eval/report"];
    const result = await resource.readCallback(new URL("llmwiki://eval/report"));
    expect(JSON.parse(result.contents[0].text)).toEqual({});
  });

  it("resolves llmwiki://eval/report returning the last report when history exists", async () => {
    await appendHistory(root, makeEvalReport());
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://eval/report"];
    const result = await resource.readCallback(new URL("llmwiki://eval/report"));
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toMatchObject({ suite: "fast", health: { score: 90 } });
  });

  it("resolves llmwiki://eval/history returning [] when no history exists", async () => {
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://eval/history"];
    const result = await resource.readCallback(new URL("llmwiki://eval/history"));
    expect(JSON.parse(result.contents[0].text)).toEqual([]);
  });

  it("resolves llmwiki://eval/history returning entries when history exists", async () => {
    await appendHistory(root, makeEvalReport());
    await appendHistory(root, makeEvalReport({ suite: "full" }));
    const server = buildServer();
    const resource = (getRegisteredResources(server) as ResourceMap)["llmwiki://eval/history"];
    const result = await resource.readCallback(new URL("llmwiki://eval/history"));
    const parsed = JSON.parse(result.contents[0].text) as unknown[];
    expect(parsed).toHaveLength(2);
  });
});

/** Run `fn` with all Anthropic credentials cleared and a missing settings path, then restore. */
async function withNoCredentials(root: string, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    LLMWIKI_CLAUDE_SETTINGS_PATH: process.env.LLMWIKI_CLAUDE_SETTINGS_PATH,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(root, "no-such-settings.json");
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
