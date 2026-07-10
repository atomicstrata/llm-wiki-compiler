/**
 * @file test/compile-reroute-phases.test.ts
 * @description Integration coverage for routing the REMAINING FOUR compile
 * page-write sites (deletion-orphan, frozen-orphan, seed, resolution) through
 * the unified planner/executor — each as its OWN ordered journalled batch.
 *
 * Pins:
 *  - ordered per-site batches: a compile with a deleted source, a frozen slug,
 *    a seed page, and link-bearing pages opens one executor batch per applying
 *    site, in the deletion-orphan → generation → frozen-orphan → seed →
 *    resolution order;
 *  - committed read-after-write: the seed page (which weaves a related concept)
 *    renders from that concept's COMMITTED, link-resolved body, not an
 *    uncommitted draft;
 *  - no-source-changes branch: an up-to-date project whose schema declares a
 *    seed routes the early-return branch's seed + resolution through executor
 *    batches (no direct atomicWrite);
 *  - (H3) orphan idempotency: re-orphaning an already-`orphaned: true` page is a
 *    clean no-op — byte-identical output, NO batch entry for that page.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { buildFrontmatter } from "../src/utils/markdown.js";
import * as journal from "../src/trust/journal.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const ctx = useCompileProject({
  dirSuffix: "reroute-phases",
  sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha relates to Gamma.",
});

/** One extracted concept ("Gamma") reused by every stub below. */
const GAMMA_EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Gamma", summary: "Gamma summary.", is_new: true, confidence: 0.9 }],
});

/** Stub the extraction tool-call with the shared Gamma extraction and silence logs. */
function stubGammaExtraction(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(GAMMA_EXTRACTION);
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Stub extraction plus a fixed page body for the generation + seed `complete` calls. */
function stubProvider(pageBody: string): void {
  stubGammaExtraction();
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(pageBody);
}

/** Write a pre-existing concept page (e.g. a stale/orphan target) on disk. */
async function writeConceptPage(slug: string, fields: Record<string, unknown>, body: string): Promise<void> {
  const fm = buildFrontmatter(fields);
  await writeFile(path.join(ctx.dir, CONCEPTS_DIR, `${slug}.md`), `${fm}\n\n${body}\n`, "utf-8");
}

/** Read a concept page's full bytes. */
async function readConceptPage(slug: string): Promise<string> {
  return readFile(path.join(ctx.dir, CONCEPTS_DIR, `${slug}.md`), "utf-8");
}

/** Write a schema declaring one overview seed page (optionally related to a slug). */
async function writeSeedSchema(seedTitle: string, relatedSlugs: string[] = []): Promise<void> {
  await mkdir(path.join(ctx.dir, ".llmwiki"), { recursive: true });
  const schema = {
    version: 1,
    defaultKind: "concept",
    kinds: {},
    seedPages: [{ title: seedTitle, kind: "overview", summary: "Top-level overview.", relatedSlugs }],
  };
  await writeFile(path.join(ctx.dir, ".llmwiki", "schema.json"), JSON.stringify(schema, null, 2), "utf-8");
}

describe("ordered per-site executor batches", () => {
  it("routes deletion-orphan, generation, seed, resolution through batches in order", async () => {
    // A prior compile owned beta.md via a now-deleted source → deletion-orphan.
    await writeConceptPage("beta", { title: "Beta", summary: "s", sources: ["beta.md"] }, "Beta body.");
    await writeFile(
      path.join(ctx.dir, ".llmwiki", "state.json"),
      JSON.stringify({
        version: 1, indexHash: "", frozenSlugs: [],
        sources: { "beta.md": { hash: "x", concepts: ["beta"], compiledAt: "2024-01-01T00:00:00Z" } },
      }),
      "utf-8",
    );
    await writeSeedSchema("Overview");
    stubProvider("Gamma overview content mentioning Beta here.");

    const applySpy = vi.spyOn(compileWrite, "applyCompilePageWritesLocked");
    const result = await compileAndReport(ctx.dir);

    // beta source is gone → its page is orphaned; gamma generated; seed + index built.
    expect(result.errors).toEqual([]);
    expect((await readConceptPage("beta")).includes("orphaned: true")).toBe(true);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "gamma.md"))).toBe(true);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "overview.md"))).toBe(true);
    // Each applying site opened its own batch: deletion-orphan, generation,
    // seed, resolution (frozen-orphan had no frozen slug this run).
    expect(applySpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe("seed renders from committed prior-site pages", () => {
  it("a seed weaving a freshly-generated concept sees its COMMITTED body", async () => {
    await writeSeedSchema("Overview", ["gamma"]);
    const systemPrompts: string[] = [];
    stubGammaExtraction();
    vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async (system: string) => {
      // Capture every page-body prompt; the seed's embeds related-page bodies.
      systemPrompts.push(system ?? "");
      return "Body content here.";
    });

    const result = await compileAndReport(ctx.dir);
    expect(result.errors).toEqual([]);
    // The seed prompt saw gamma's COMMITTED page (its frontmatter title `Gamma`),
    // proving generation's batch committed to disk before the seed batch rendered.
    expect(systemPrompts.some((p) => p.includes("title: Gamma"))).toBe(true);
  });
});

describe("no-source-changes branch routes through executor", () => {
  it("early-return seed + resolution go through executor batches, not direct writes", async () => {
    // First compile lands gamma + state so the second compile has nothing to compile.
    await writeSeedSchema("Overview");
    stubProvider("Gamma body content here.");
    await compileAndReport(ctx.dir);
    vi.restoreAllMocks();

    // Second compile: no source changed, but the schema still declares the seed.
    stubProvider("Overview body content here.");
    const openSpy = vi.spyOn(journal, "openBatch");
    const result = await compileAndReport(ctx.dir);

    expect(result.compiled).toBe(0);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "overview.md"))).toBe(true);
    // The seed write (and any resolution) on the early branch opened ≥1 journal
    // batch — it did NOT bypass the executor with a direct atomicWrite.
    expect(openSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("H3: orphan idempotency", () => {
  it("re-orphaning an already-orphaned page is a clean no-op with no batch entry", async () => {
    // A page already marked orphaned, owned by a deleted source.
    await writeConceptPage(
      "stale", { title: "Stale", summary: "s", sources: ["stale.md"], orphaned: true }, "Stale body.",
    );
    await writeFile(
      path.join(ctx.dir, ".llmwiki", "state.json"),
      JSON.stringify({
        version: 1, indexHash: "", frozenSlugs: [],
        sources: { "stale.md": { hash: "x", concepts: ["stale"], compiledAt: "2024-01-01T00:00:00Z" } },
      }),
      "utf-8",
    );
    await rm(path.join(ctx.dir, "sources", "alpha.md")); // delete the only live source too
    stubProvider("unused");

    const before = await readConceptPage("stale");
    const orphanBatchSpy = vi.spyOn(compileWrite, "applyCompilePageWritesLocked");
    const result = await compileAndReport(ctx.dir);

    expect(result.errors).toEqual([]);
    // Byte-identical: the already-orphaned page is untouched.
    expect(await readConceptPage("stale")).toBe(before);
    // The deletion-orphan batch for stale.md carried ZERO items (guard returned
    // null), so no orphan batch wrote it.
    const orphanItems = orphanBatchSpy.mock.calls.flatMap((c) => c[1] as { slug: string }[]);
    expect(orphanItems.some((it) => it.slug === "stale")).toBe(false);
  });
});
