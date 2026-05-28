/**
 * Unit tests for the JSON export's bridge contract additions.
 *
 * Verifies the in-process behavior of `collectExportPages`,
 * `buildJsonExport`, and `validateProjectId`:
 *
 *  - Every new `ExportPage` field round-trips from frontmatter through
 *    the JSON envelope (path, kind, advisoryConfidence, provenanceState,
 *    contradictedBy, citations, aliases, advisoryFreshnessStatus).
 *  - `projectId` is embedded only when supplied; regex enforcement
 *    rejects malformed values at the validator boundary.
 *
 * Subprocess-level coverage of the CLI flag lives in
 * `bridge-export-contract-cli.test.ts` to keep file size under control.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { writePage } from "./fixtures/write-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { collectExportPages } from "../src/export/collect.js";
import { buildJsonExport } from "../src/export/json-export.js";
import {
  PROJECT_ID_PATTERN,
  validateProjectId,
} from "../src/export/project-id.js";

interface BridgeExportPage {
  title: string;
  slug: string;
  pageDirectory: "concepts" | "queries";
  path: string;
  kind?: string;
  advisoryConfidence?: number;
  provenanceState?: string;
  contradictedBy?: { slug: string; reason?: string }[];
  citations: { file: string; start?: number; end?: number }[];
  aliases?: string[];
  advisoryFreshnessStatus: string;
}

interface BridgeExportEnvelope {
  exportedAt: string;
  pageCount: number;
  projectId?: string;
  pages: BridgeExportPage[];
}

function findPage(envelope: BridgeExportEnvelope, slug: string): BridgeExportPage {
  const page = envelope.pages.find((p) => p.slug === slug);
  if (!page) throw new Error(`expected to find page with slug "${slug}" in export`);
  return page;
}

describe("bridge export contract — collectExportPages + buildJsonExport", () => {
  it("populates path, kind, citations, and advisoryFreshnessStatus for a basic concept", async () => {
    const root = await makeTempRoot("basic");
    await writePage(
      path.join(root, "wiki/concepts"),
      "retrieval",
      { title: "Retrieval", summary: "x", kind: "concept" },
      "Retrieval is selective lookup. ^[paper.md:10-15]\n",
    );

    const pages = await collectExportPages(root);
    const env = JSON.parse(buildJsonExport(pages)) as BridgeExportEnvelope;
    const page = findPage(env, "retrieval");

    expect(page.path).toBe("wiki/concepts/retrieval.md");
    expect(page.kind).toBe("concept");
    expect(page.advisoryFreshnessStatus).toBe("unverified");
    expect(page.citations).toEqual([{ file: "paper.md", start: 10, end: 15 }]);
  });

  it("round-trips advisoryConfidence, provenanceState, contradictedBy, aliases", async () => {
    const root = await makeTempRoot("trust");
    await writePage(
      path.join(root, "wiki/concepts"),
      "embeddings",
      {
        title: "Embeddings",
        summary: "vectors",
        kind: "concept",
        confidence: 0.82,
        provenanceState: "extracted",
        contradictedBy: [{ slug: "sparse-retrieval", reason: "different paradigm" }],
        aliases: ["llmwiki/old-proj/concepts/vectors"],
      },
      "Body.\n",
    );

    const pages = await collectExportPages(root);
    const env = JSON.parse(buildJsonExport(pages)) as BridgeExportEnvelope;
    const page = findPage(env, "embeddings");

    expect(page.advisoryConfidence).toBe(0.82);
    expect(page.provenanceState).toBe("extracted");
    expect(page.contradictedBy).toEqual([
      { slug: "sparse-retrieval", reason: "different paradigm" },
    ]);
    expect(page.aliases).toEqual(["llmwiki/old-proj/concepts/vectors"]);
  });

  it("omits aliases when none are declared and rejects out-of-range confidence", async () => {
    const root = await makeTempRoot("omit");
    await writePage(
      path.join(root, "wiki/concepts"),
      "vector-search",
      { title: "Vector Search", summary: "v", kind: "concept", confidence: 1.5 },
      "Body.\n",
    );

    const pages = await collectExportPages(root);
    const env = JSON.parse(buildJsonExport(pages)) as BridgeExportEnvelope;
    const page = findPage(env, "vector-search");

    expect(page.aliases).toBeUndefined();
    expect(page.advisoryConfidence).toBeUndefined();
  });

  it("flattens citations and de-dupes by (file,start,end)", async () => {
    const root = await makeTempRoot("citations");
    await writePage(
      path.join(root, "wiki/concepts"),
      "chunking",
      { title: "Chunking", summary: "s", kind: "concept" },
      "Claim one. ^[paper.md:10-15]\n\nClaim two. ^[paper.md:10-15, other.md:5-8]\n",
    );

    const pages = await collectExportPages(root);
    const env = JSON.parse(buildJsonExport(pages)) as BridgeExportEnvelope;
    const page = findPage(env, "chunking");

    expect(page.citations).toEqual([
      { file: "paper.md", start: 10, end: 15 },
      { file: "other.md", start: 5, end: 8 },
    ]);
  });
});

describe("bridge export contract — projectId envelope field", () => {
  it("omits projectId from the envelope when none is supplied", async () => {
    const root = await makeTempRoot("noproj");
    await writePage(
      path.join(root, "wiki/concepts"),
      "p",
      { title: "P", summary: "s" },
      "Body.\n",
    );
    const env = JSON.parse(buildJsonExport(await collectExportPages(root))) as BridgeExportEnvelope;
    expect(env.projectId).toBeUndefined();
  });

  it("embeds a valid projectId in the envelope", async () => {
    const root = await makeTempRoot("proj");
    await writePage(
      path.join(root, "wiki/concepts"),
      "p",
      { title: "P", summary: "s" },
      "Body.\n",
    );
    const pages = await collectExportPages(root);
    const env = JSON.parse(buildJsonExport(pages, { projectId: "my-kb" })) as BridgeExportEnvelope;
    expect(env.projectId).toBe("my-kb");
  });
});

describe("bridge export contract — validateProjectId", () => {
  it("accepts canonical kebab-case identifiers", () => {
    for (const id of ["a", "kb", "my-kb", "team-foo-2024", "abc123"]) {
      expect(validateProjectId(id)).toBe(id);
      expect(PROJECT_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it("rejects path-traversal, uppercase, leading hyphen, and oversize values", () => {
    const bad = ["../escape", "Foo", "-leading", "with space", "a".repeat(64)];
    for (const id of bad) {
      expect(() => validateProjectId(id)).toThrow(/Invalid projectId/);
    }
  });

  it("rejects non-string and empty inputs with a clear message", () => {
    expect(() => validateProjectId(undefined)).toThrow(/must be a string/);
    expect(() => validateProjectId(123)).toThrow(/must be a string/);
    expect(() => validateProjectId("")).toThrow(/must not be empty/);
  });
});
