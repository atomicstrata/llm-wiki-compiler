/**
 * CLI-level integration tests for the schema layer.
 *
 * Covers `schema init`, `schema show`, and the schema-aware `lint` behaviour
 * introduced in the feature/schema-layer branch.  All tests spawn the compiled
 * CLI binary so every code path — CLI parsing, file I/O, schema loading, and
 * lint rule evaluation — is exercised end-to-end without mocks.
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(label: string): Promise<string> {
  const dir = path.join(tmpdir(), `llmwiki-schema-test-${label}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Write a minimal overview page with a given number of wikilinks to wiki/concepts/. */
async function writeOverviewPage(root: string, wikilinkCount: number): Promise<void> {
  const conceptsDir = path.join(root, "wiki", "concepts");
  await mkdir(conceptsDir, { recursive: true });

  const links = Array.from({ length: wikilinkCount }, (_, i) => `[[Topic ${i + 1}]]`).join(" ");
  const content = [
    "---",
    "title: My Overview",
    "kind: overview",
    "summary: A top-level overview page.",
    "---",
    "",
    `This page covers the domain. ${links}`,
    "It provides a broad introduction to the subject.",
  ].join("\n");

  await writeFile(path.join(conceptsDir, "my-overview.md"), content, "utf-8");
}

/** Write a schema file to .llmwiki/schema.json under root. */
async function writeSchemaFile(root: string, schema: object): Promise<string> {
  const schemaDir = path.join(root, ".llmwiki");
  await mkdir(schemaDir, { recursive: true });
  const schemaPath = path.join(schemaDir, "schema.json");
  await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf-8");
  return schemaPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// dist/cli.js is built once by `bun run test` before the suite starts.
// Per-file beforeAll(npx tsup) calls were removed to avoid the parallel-worker
// race that PR #21 fixed — tsup's clean step would wipe dist/cli.js mid-test.

describe("schema integration tests", () => {
  // -------------------------------------------------------------------------
  // schema init
  // -------------------------------------------------------------------------

  it("schema init writes schema.json with expected default kinds", async () => {
    const cwd = await makeTmpDir("init-fresh");
    try {
      const result = await runCLI(["schema", "init"], cwd);
      expectCLIExit(result, 0);

      const schemaPath = path.join(cwd, ".llmwiki", "schema.json");
      expect(existsSync(schemaPath)).toBe(true);

      const raw = await readFile(schemaPath, "utf-8");
      const parsed = JSON.parse(raw) as { kinds?: Record<string, unknown> };
      expect(Object.keys(parsed.kinds ?? {})).toEqual(
        expect.arrayContaining(["concept", "entity", "comparison", "overview"]),
      );
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  it("schema init does not overwrite an existing schema file", async () => {
    const cwd = await makeTmpDir("init-existing");
    try {
      const customSchema = { version: 1, defaultKind: "concept", kinds: {}, seedPages: [] };
      await writeSchemaFile(cwd, customSchema);

      const before = await readFile(path.join(cwd, ".llmwiki", "schema.json"), "utf-8");
      const result = await runCLI(["schema", "init"], cwd);

      // Should exit 0 but warn, not overwrite
      expectCLIExit(result, 0);
      const after = await readFile(path.join(cwd, ".llmwiki", "schema.json"), "utf-8");
      expect(after).toBe(before);
      expect(result.stdout).toContain("already exists");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // schema show
  // -------------------------------------------------------------------------

  it("schema show with no schema file prints defaults and exits 0", async () => {
    const cwd = await makeTmpDir("show-defaults");
    try {
      const result = await runCLI(["schema", "show"], cwd);
      expectCLIExit(result, 0);
      // Output should contain known default kind names
      expect(result.stdout).toContain("concept");
      expect(result.stdout).toContain("overview");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  it("schema show with a custom schema prints content and loadedFrom path", async () => {
    const cwd = await makeTmpDir("show-custom");
    try {
      const customSchema = {
        version: 1,
        defaultKind: "entity",
        kinds: { overview: { minWikilinks: 5 } },
        seedPages: [],
      };
      const schemaPath = await writeSchemaFile(cwd, customSchema);

      const result = await runCLI(["schema", "show"], cwd);
      expectCLIExit(result, 0);
      // Must mention the file path so user knows which schema is in effect
      expect(result.stdout).toContain(schemaPath);
      // Should surface the overridden kind value
      expect(result.stdout).toContain("overview");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // lint with schema
  // -------------------------------------------------------------------------

  it("lint reports schema-cross-link-minimum when overview page has too few wikilinks", async () => {
    const cwd = await makeTmpDir("lint-schema-violation");
    try {
      // Schema demands overview pages have at least 3 wikilinks
      await writeSchemaFile(cwd, {
        version: 1,
        defaultKind: "concept",
        kinds: { overview: { minWikilinks: 3 } },
        seedPages: [],
      });
      // Page has only 1 wikilink — should trigger the rule
      await writeOverviewPage(cwd, 1);

      const result = await runCLI(["lint"], cwd);
      // lint exits non-zero when findings exist; we expect a finding here
      expectCLIExit(result, 1);
      // The lint output prints the human-readable message, not the rule name
      expect(result.stdout).toContain("overview");
      expect(result.stdout).toContain("requires at least");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  it("lint without a schema file does not emit schema-cross-link-minimum findings", async () => {
    const cwd = await makeTmpDir("lint-no-schema");
    try {
      // Overview page with 0 wikilinks; default minWikilinks for overview is 3
      // but concept pages default to 0 — without a schema file the default
      // overview rule (minWikilinks: 3) is still active.  We use a concept page
      // so existing behaviour is truly unchanged.
      const conceptsDir = path.join(cwd, "wiki", "concepts");
      await mkdir(conceptsDir, { recursive: true });
      const content = [
        "---",
        "title: Simple Concept",
        "kind: concept",
        "summary: A standalone idea.",
        "---",
        "",
        "This is a concept page with a reasonably long body for the empty-page rule.",
      ].join("\n");
      await writeFile(path.join(conceptsDir, "simple-concept.md"), content, "utf-8");

      const result = await runCLI(["lint"], cwd);
      expectCLIExit(result, 0);
      // Concept pages default to minWikilinks: 0, so no cross-link warning fires.
      // Assert on the actual warning message text (not the rule name, which the
      // CLI does not print) so a regression would be caught reliably.
      expect(result.stdout).not.toContain("requires at least");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  it("lint output includes the schema source path", async () => {
    const cwd = await makeTmpDir("lint-schema-source");
    try {
      const schemaPath = await writeSchemaFile(cwd, {
        version: 1,
        defaultKind: "concept",
        kinds: {},
        seedPages: [],
      });

      const result = await runCLI(["lint"], cwd);
      expectCLIExit(result, 0);
      // The lint command prints "Schema: <path>" so the user knows what's in effect
      expect(result.stdout).toContain(schemaPath);
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);
});
