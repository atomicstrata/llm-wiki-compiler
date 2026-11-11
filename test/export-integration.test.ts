/**
 * CLI-level integration tests for `llmwiki export`.
 *
 * Exercises the export command end-to-end through the compiled CLI binary.
 * No LLM calls are made — export is a pure transformation of wiki content
 * on disk. dist/cli.js is built once by `bun run test` before the suite starts —
 * per-file beforeAll(npx tsup) calls are absent
 * intentionally (see schema-subprocess.test.ts for the canonical pattern).
 *
 * Test coverage:
 *  - --help shows the export command and --target flag
 *  - Default (all targets) produces all 6 artifact files with expected markers
 *  - --target llms-txt writes only llms.txt
 *  - --target json-ld writes only wiki.jsonld and produces valid JSON
 *  - --target graphml writes only wiki.graphml with XML header
 *  - Empty wiki (no concepts) exits cleanly with valid empty artifacts
 *  - GraphML and JSON-LD include wikilink-derived edges
 *  - Each format includes the five required metadata fields
 *  - llms.txt uses correct paths for concept vs query pages
 *  - llms.txt has ## Concepts and ## Saved Queries H2 sections
 *  - Marp --source filter includes only requested page kind
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { mkdir, rm, access } from "fs/promises";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { writePage } from "./fixtures/write-page.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_ARTIFACTS = [
  "llms.txt",
  "llms-full.txt",
  "wiki.json",
  "wiki.jsonld",
  "wiki.graphml",
  "wiki.md",
] as const;

const EXPORT_DIR = "dist/exports";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp wiki root with concepts and queries dirs. */
async function makeTempWikiRoot(suffix: string): Promise<string> {
  const root = path.join(tmpdir(), `llmwiki-export-it-${suffix}-${Date.now()}`);
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  return root;
}

/** Remove a temp root directory. */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Return true when a file exists at the given path. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Run the export command in the given root directory. */
async function runExport(
  root: string,
  args: string[] = [],
): Promise<import("./fixtures/run-cli.js").CLIResult> {
  return runCLI(["export", ...args], root);
}

/**
 * Run export for a single target and return the content of the output file.
 * Asserts the CLI exits 0 before reading.
 */
async function runExportAndRead(root: string, target: string, filename: string): Promise<string> {
  const result = await runExport(root, ["--target", target]);
  expectCLIExit(result, 0);
  return readFile(path.join(root, EXPORT_DIR, filename), "utf-8");
}

/** Fixture page metadata used across tests. */
const ALPHA_META = {
  title: "Alpha Concept",
  summary: "The first concept.",
  tags: ["science"],
  sources: ["source-a.md"],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
};

const BETA_META = {
  title: "Beta Concept",
  summary: "The second concept.",
  tags: ["science"],
  sources: ["source-b.md"],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
};

const QUERY_META = {
  title: "Sample Query",
  summary: "A saved query page.",
  tags: ["query"],
  sources: ["source-q.md"],
  createdAt: "2024-02-01T00:00:00.000Z",
  updatedAt: "2024-02-02T00:00:00.000Z",
};

/**
 * Write a two-concept fixture wiki into root with a [[wikilink]] from alpha to beta.
 * Returns the concepts dir path.
 */
async function writeFixtureWiki(root: string): Promise<string> {
  const conceptsDir = path.join(root, "wiki/concepts");
  await writePage(conceptsDir, "alpha", ALPHA_META, "Alpha links to [[Beta Concept]].");
  await writePage(conceptsDir, "beta-concept", BETA_META, "Beta stands alone.");
  return conceptsDir;
}

/** Write a query page into root's wiki/queries directory. */
async function writeQueryPage(root: string): Promise<void> {
  const queriesDir = path.join(root, "wiki/queries");
  await writePage(queriesDir, "sample-query", QUERY_META, "This is a saved query.");
}

/**
 * Assert that the given content includes the source, creation, and update
 * metadata values from ALPHA_META. Used across format-coverage tests to avoid
 * repeating the same three expect calls.
 */
function assertAlphaMetadataPresent(content: string): void {
  expect(content).toContain("source-a.md");
  expect(content).toContain("2024-01-01T00:00:00.000Z");
  expect(content).toContain("2024-01-02T00:00:00.000Z");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("export CLI integration", () => {
  it("export --help shows the command and --target flag", async () => {
    const root = await makeTempWikiRoot("help");
    try {
      const result = await runCLI(["export", "--help"], root);
      expect(result.stdout).toContain("export");
      expect(result.stdout).toContain("--target");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export (all targets) writes all 6 artifacts", async () => {
    const root = await makeTempWikiRoot("all");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root);
      expectCLIExit(result, 0);
      for (const artifact of ALL_ARTIFACTS) {
        const exists = await fileExists(path.join(root, EXPORT_DIR, artifact));
        expect(exists, `${artifact} should exist`).toBe(true);
      }
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export (all targets) llms.txt contains # Knowledge Wiki marker and Alpha Concept", async () => {
    const root = await makeTempWikiRoot("llms-marker");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root);
      expectCLIExit(result, 0);
      const content = await readFile(path.join(root, EXPORT_DIR, "llms.txt"), "utf-8");
      expect(content).toContain("#");
      expect(content).toContain("Alpha Concept");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export (all targets) wiki.jsonld contains @graph key", async () => {
    const root = await makeTempWikiRoot("jsonld-all");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root);
      expectCLIExit(result, 0);
      const content = await readFile(path.join(root, EXPORT_DIR, "wiki.jsonld"), "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed).toHaveProperty("@graph");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export --target llms-txt writes only llms.txt", async () => {
    const root = await makeTempWikiRoot("llms-only");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root, ["--target", "llms-txt"]);
      expectCLIExit(result, 0);
      expect(await fileExists(path.join(root, EXPORT_DIR, "llms.txt"))).toBe(true);
      for (const artifact of ALL_ARTIFACTS.filter((a) => a !== "llms.txt")) {
        expect(await fileExists(path.join(root, EXPORT_DIR, artifact))).toBe(false);
      }
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export --target json-ld writes only wiki.jsonld and is valid JSON", async () => {
    const root = await makeTempWikiRoot("jsonld-only");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root, ["--target", "json-ld"]);
      expectCLIExit(result, 0);
      expect(await fileExists(path.join(root, EXPORT_DIR, "wiki.jsonld"))).toBe(true);
      for (const artifact of ALL_ARTIFACTS.filter((a) => a !== "wiki.jsonld")) {
        expect(await fileExists(path.join(root, EXPORT_DIR, artifact))).toBe(false);
      }
      const content = await readFile(path.join(root, EXPORT_DIR, "wiki.jsonld"), "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export --target graphml writes only wiki.graphml with XML header", async () => {
    const root = await makeTempWikiRoot("graphml-only");
    try {
      await writeFixtureWiki(root);
      const result = await runExport(root, ["--target", "graphml"]);
      expectCLIExit(result, 0);
      expect(await fileExists(path.join(root, EXPORT_DIR, "wiki.graphml"))).toBe(true);
      for (const artifact of ALL_ARTIFACTS.filter((a) => a !== "wiki.graphml")) {
        expect(await fileExists(path.join(root, EXPORT_DIR, artifact))).toBe(false);
      }
      const content = await readFile(path.join(root, EXPORT_DIR, "wiki.graphml"), "utf-8");
      expect(content.trimStart()).toMatch(/^<\?xml/);
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("export on an empty wiki exits cleanly with empty-safe artifacts", async () => {
    const root = await makeTempWikiRoot("empty");
    try {
      const result = await runExport(root);
      expectCLIExit(result, 0);
      for (const artifact of ALL_ARTIFACTS) {
        expect(await fileExists(path.join(root, EXPORT_DIR, artifact))).toBe(true);
      }
      const llmsTxt = await readFile(path.join(root, EXPORT_DIR, "llms.txt"), "utf-8");
      expect(llmsTxt).toContain("0 pages");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("wiki.graphml includes edge for [[wikilink]] between pages", async () => {
    const root = await makeTempWikiRoot("graphml-edges");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "graphml", "wiki.graphml");
      expect(content).toContain('source="alpha"');
      expect(content).toContain('target="beta-concept"');
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("wiki.jsonld includes mentions link for [[wikilink]] between pages", async () => {
    const root = await makeTempWikiRoot("jsonld-edges");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "json-ld", "wiki.jsonld");
      const parsed = JSON.parse(content) as {
        "@graph": Array<{ mentions?: Array<{ "@id": string }> }>;
      };
      const alphaNode = parsed["@graph"].find((n) =>
        (n as Record<string, unknown>)["@id"]?.toString().endsWith("alpha"),
      );
      expect(alphaNode).toBeDefined();
      expect(alphaNode?.mentions).toBeDefined();
      const mentionIds = (alphaNode?.mentions ?? []).map((m) => m["@id"]);
      expect(mentionIds.some((id) => id.endsWith("beta-concept"))).toBe(true);
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Finding 1: Each format must include all five metadata fields
  // -------------------------------------------------------------------------

  it("graphml node includes sources, createdAt, and updatedAt", async () => {
    const root = await makeTempWikiRoot("graphml-meta");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "graphml", "wiki.graphml");
      expect(content).toContain('key="sources"');
      expect(content).toContain('key="createdAt"');
      expect(content).toContain('key="updatedAt"');
      assertAlphaMetadataPresent(content);
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("json-ld node includes isBasedOn (sources), dateCreated, dateModified", async () => {
    const root = await makeTempWikiRoot("jsonld-meta");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "json-ld", "wiki.jsonld");
      const parsed = JSON.parse(content) as {
        "@graph": Array<Record<string, unknown>>;
      };
      const alphaNode = parsed["@graph"].find((n) =>
        n["@id"]?.toString().endsWith("alpha"),
      );
      expect(alphaNode).toBeDefined();
      expect(alphaNode?.["isBasedOn"]).toEqual(["source-a.md"]);
      expect(alphaNode?.["dateCreated"]).toBe("2024-01-01T00:00:00.000Z");
      expect(alphaNode?.["dateModified"]).toBe("2024-01-02T00:00:00.000Z");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("llms.txt entries include tags, sources, and timestamps in colon note", async () => {
    const root = await makeTempWikiRoot("llms-meta");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "llms-txt", "llms.txt");
      expect(content).toContain("tags: science");
      assertAlphaMetadataPresent(content);
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("llms-full.txt sections include timestamps", async () => {
    const root = await makeTempWikiRoot("llms-full-meta");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "llms-full-txt", "llms-full.txt");
      expect(content).toContain("Created: 2024-01-01T00:00:00.000Z");
      expect(content).toContain("Updated: 2024-01-02T00:00:00.000Z");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("marp slides include sources and timestamps in speaker notes", async () => {
    const root = await makeTempWikiRoot("marp-meta");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "marp", "wiki.md");
      assertAlphaMetadataPresent(content);
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Finding 2: llms.txt path correctness and H2 sections
  // -------------------------------------------------------------------------

  it("llms.txt uses wiki/concepts/ path for concept pages", async () => {
    const root = await makeTempWikiRoot("llms-concept-path");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "llms-txt", "llms.txt");
      expect(content).toContain("wiki/concepts/alpha.md");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("llms.txt uses wiki/queries/ path for query pages", async () => {
    const root = await makeTempWikiRoot("llms-query-path");
    try {
      await writeQueryPage(root);
      const content = await runExportAndRead(root, "llms-txt", "llms.txt");
      expect(content).toContain("wiki/queries/sample-query.md");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("llms.txt has ## Concepts section when concept pages exist", async () => {
    const root = await makeTempWikiRoot("llms-concepts-h2");
    try {
      await writeFixtureWiki(root);
      const content = await runExportAndRead(root, "llms-txt", "llms.txt");
      expect(content).toContain("## Concepts");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("llms.txt has ## Saved Queries section when query pages exist", async () => {
    const root = await makeTempWikiRoot("llms-queries-h2");
    try {
      await writeFixtureWiki(root);
      await writeQueryPage(root);
      const content = await runExportAndRead(root, "llms-txt", "llms.txt");
      expect(content).toContain("## Saved Queries");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Finding 4: Marp --source filter
  // -------------------------------------------------------------------------

  it("marp --source queries includes only query pages", async () => {
    const root = await makeTempWikiRoot("marp-source-queries");
    try {
      await writeFixtureWiki(root);
      await writeQueryPage(root);
      const result = await runExport(root, ["--target", "marp", "--source", "queries"]);
      expectCLIExit(result, 0);
      const content = await readFile(path.join(root, EXPORT_DIR, "wiki.md"), "utf-8");
      expect(content).toContain("Sample Query");
      expect(content).not.toContain("Alpha Concept");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("marp --source concepts includes only concept pages", async () => {
    const root = await makeTempWikiRoot("marp-source-concepts");
    try {
      await writeFixtureWiki(root);
      await writeQueryPage(root);
      const result = await runExport(root, ["--target", "marp", "--source", "concepts"]);
      expectCLIExit(result, 0);
      const content = await readFile(path.join(root, EXPORT_DIR, "wiki.md"), "utf-8");
      expect(content).toContain("Alpha Concept");
      expect(content).not.toContain("Sample Query");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  it("marp --source queries CLI summary reports the filtered count, not the total", async () => {
    const root = await makeTempWikiRoot("marp-source-summary");
    try {
      await writeFixtureWiki(root); // 2 concepts
      await writeQueryPage(root); //  1 query
      const result = await runExport(root, ["--target", "marp", "--source", "queries"]);
      expectCLIExit(result, 0);
      // 1 query should be reported, not the 3 collected pages.
      expect(result.stdout).toContain("Done — 1 pages exported");
      expect(result.stdout).not.toContain("Done — 3 pages exported");
    } finally {
      await cleanup(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // JSON export: pageDirectory field rename (avoids collision with schema PageKind)
  // -------------------------------------------------------------------------

  it("wiki.json pages expose pageDirectory, not the legacy `kind` field", async () => {
    const root = await makeTempWikiRoot("json-page-directory");
    try {
      await writeFixtureWiki(root);
      await writeQueryPage(root);
      const content = await runExportAndRead(root, "json", "wiki.json");
      const doc = JSON.parse(content) as { pages: Array<Record<string, unknown>> };
      const concept = doc.pages.find((p) => p.title === "Alpha Concept");
      const query = doc.pages.find((p) => p.title === "Sample Query");
      expect(concept?.pageDirectory).toBe("concepts");
      expect(query?.pageDirectory).toBe("queries");
      // Old field name should no longer be emitted — it conflicted with
      // schema's PageKind ("concept"|"entity"|"comparison"|"overview").
      expect(concept).not.toHaveProperty("kind");
      expect(query).not.toHaveProperty("kind");
    } finally {
      await cleanup(root);
    }
  }, 30_000);
});
