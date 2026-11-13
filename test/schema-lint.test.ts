/**
 * Tests for the schema-aware lint rule and the lint orchestrator's
 * integration with the schema layer.
 */

import { describe, it, expect } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { checkSchemaCrossLinks, checkPageCrossLinks } from "../src/linter/rules.js";
import { lint } from "../src/linter/index.js";
import { buildDefaultSchema } from "../src/schema/index.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

const env = useLintTempRoot("schema-lint-test");

/** Live tmp project root — refreshed by useLintTempRoot's beforeEach. */
function tmpDir(): string {
  return env.dir;
}

/** Helper writing a concept page to the temp wiki. */
function writeConcept(slug: string, content: string): Promise<void> {
  return env.writeConcept(slug, content);
}

describe("checkSchemaCrossLinks", () => {
  it("flags overview pages with too few wikilinks", async () => {
    const body = "An overview page with only one [[Linked Page]].";
    await writeConcept("overview-page", `---\ntitle: Overview\nkind: overview\n---\n${body}`);

    const results = await checkSchemaCrossLinks(tmpDir(), buildDefaultSchema());
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("schema-cross-link-minimum");
    expect(results[0].severity).toBe("warning");
    expect(results[0].message).toContain("overview");
  });

  it("passes when the overview page meets the minimum", async () => {
    const body = "Sees [[A]], [[B]], and [[C]].";
    await writeConcept("overview-rich", `---\ntitle: Overview\nkind: overview\n---\n${body}`);

    const results = await checkSchemaCrossLinks(tmpDir(), buildDefaultSchema());
    expect(results).toHaveLength(0);
  });

  it("ignores concept pages because their default minimum is 0", async () => {
    await writeConcept("plain", "---\ntitle: Plain\n---\nNo links at all.");

    const results = await checkSchemaCrossLinks(tmpDir(), buildDefaultSchema());
    expect(results).toHaveLength(0);
  });

  it("respects custom minimums from a schema config", async () => {
    const schema = buildDefaultSchema();
    schema.kinds.concept.minWikilinks = 2;
    await writeConcept("c", "---\ntitle: C\nkind: concept\n---\nOnly [[One]] link here.");

    const results = await checkSchemaCrossLinks(tmpDir(), schema);
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain("at least 2");
  });
});

// ---------------------------------------------------------------------------
// checkPageCrossLinks — single-page in-memory variant (Finding 2)
// ---------------------------------------------------------------------------

describe("checkPageCrossLinks", () => {
  it("returns a violation when the page has fewer wikilinks than required", () => {
    const schema = buildDefaultSchema();
    const content = "---\ntitle: Overview\nkind: overview\n---\nOnly [[One]] link.";
    const results = checkPageCrossLinks(content, "wiki/concepts/overview.md", schema);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("schema-cross-link-minimum");
    expect(results[0].message).toContain("overview");
    expect(results[0].file).toBe("wiki/concepts/overview.md");
  });

  it("returns no violations when the page meets the minimum", () => {
    const schema = buildDefaultSchema();
    const content = "---\ntitle: Overview\nkind: overview\n---\nSees [[A]], [[B]], [[C]].";
    const results = checkPageCrossLinks(content, "wiki/concepts/overview.md", schema);
    expect(results).toHaveLength(0);
  });

  it("returns no violations for concept pages with default minimum of 0", () => {
    const schema = buildDefaultSchema();
    const content = "---\ntitle: Simple\nkind: concept\n---\nNo links at all.";
    const results = checkPageCrossLinks(content, "wiki/concepts/simple.md", schema);
    expect(results).toHaveLength(0);
  });
});

describe("lint orchestrator with schema", () => {
  it("loads the schema file and surfaces cross-link warnings", async () => {
    await mkdir(path.join(tmpDir(), ".llmwiki"), { recursive: true });
    const schemaContent = JSON.stringify({
      defaultKind: "concept",
      kinds: { concept: { minWikilinks: 1 } },
    });
    await writeFile(path.join(tmpDir(), ".llmwiki/schema.json"), schemaContent);
    await writeConcept("link-light", "---\ntitle: Link Light\nsummary: ok\n---\nNo links here at all in this body.");

    const summary = await lint(tmpDir());
    const schemaWarnings = summary.results.filter(
      (r) => r.rule === "schema-cross-link-minimum",
    );
    expect(schemaWarnings.length).toBeGreaterThan(0);
  });

  it("works with a wiki that has no schema file (defaults to concept, no warnings)", async () => {
    await writeConcept(
      "plain",
      "---\ntitle: Plain\nsummary: ok\n---\nA sufficiently long body to satisfy the empty-page check.",
    );

    const summary = await lint(tmpDir());
    const schemaWarnings = summary.results.filter(
      (r) => r.rule === "schema-cross-link-minimum",
    );
    expect(schemaWarnings).toHaveLength(0);
  });
});
