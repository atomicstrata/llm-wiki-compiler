/**
 * @file test/context-typed-pages.test.ts
 * @description Audit FIX F3: typed entity pages of a NON-DEFAULT profile are now
 * in the `llmwiki context` page POOL — lexically rankable (so a prompt matching a
 * typed page surfaces it in `primary[]` WITH its body) AND graph-reachable (so a
 * relation neighbor appears in `neighbors[]`). The earlier test cheated by
 * starting expansion from a SYNTHETIC primary; this drives the REAL context
 * builder. A DEFAULT project's context pack is byte-identical (no typed pages).
 *
 * NOTE: this pins the LEXICAL + GRAPH path only. Semantic (embedding) retrieval of
 * typed pages is covered by the embedding-eligibility and embeddings-migrate suites.
 *
 * Task C1: `augmentSnapshotWithTypedPages` now also honors `retrieval.includeInContext`
 * on each entity type def — an explicit `false` drops that type's pages from the
 * lexical pool; omitted or `true` keeps them (tri-state, only explicit false excludes).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildContextPack } from "../src/context/build.js";
import { collectEntityPages } from "../src/profile/collect.js";
import { loadNonDefaultProfile } from "../src/profile/block.js";
import type { EntityId } from "../src/profile/types.js";
import {
  buildResearchLiteRelationsProject,
  writeMarkdownPage,
  seedTestsRelation,
  writeProfileFile,
} from "./fixtures/profile-fixtures.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "context-typed-"));
  await buildResearchLiteRelationsProject(root);
  // A distinctive-bodied idea page (the lexical match target) + a seeded relation
  // from an experiment to it (the graph neighbor).
  await writeMarkdownPage(root, "wiki/ideas", "sparse-routing", "---\nstatus: proposed\n---\nMixtureOfExperts conditional computation routing.");
  await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("FIX F3 — typed pages in the context pool", () => {
  it("ranks a typed entity page into primary[] (with its body) for a matching prompt", async () => {
    const pack = await buildContextPack({ root, prompt: "MixtureOfExperts" });
    const primary = pack.primary.find((p) => p.id === ("ideas/sparse-routing" as unknown as string));
    expect(primary).toBeDefined();
    expect(primary?.summary).toMatch(/MixtureOfExperts/);
  });

  it("surfaces the relation neighbor of a ranked typed page in neighbors[]", async () => {
    const pack = await buildContextPack({ root, prompt: "MixtureOfExperts", depth: 1 });
    const neighborIds = pack.neighbors.map((n) => n.to);
    expect(neighborIds).toContain("experiments/ablation-batch-size" as unknown as EntityId);
  });
});

describe("profile-invalid typed pages are excluded from the context pool", () => {
  // `papers` requires `title`; the valid page declares it, the invalid one omits it.
  const validBody = "QuantumAnnealing optimization survey.";
  const invalidBody = "QuantumAnnealing hardware notes.";
  beforeEach(async () => {
    await writeMarkdownPage(root, "wiki/papers", "valid-paper", `---\ntitle: Valid\n---\n${validBody}`);
    await writeMarkdownPage(root, "wiki/papers", "broken-paper", `---\nvenue: NeurIPS\n---\n${invalidBody}`);
  });

  it("collectEntityPages reports a field-violation for the title-less page (sanity)", async () => {
    const loaded = await loadNonDefaultProfile(root);
    const { problems } = await collectEntityPages(root, loaded!.profile);
    const broken = problems.find((p) => p.filePath?.endsWith("broken-paper.md"));
    expect(broken?.kind).toBe("field-violation");
  });

  it("ranks the VALID typed page into primary[] for a matching prompt", async () => {
    const pack = await buildContextPack({ root, prompt: "QuantumAnnealing optimization" });
    const ids = pack.primary.map((p) => p.id as unknown as string);
    expect(ids).toContain("papers/valid-paper");
  });

  it("never selects the field-violating typed page as a primary", async () => {
    const pack = await buildContextPack({ root, prompt: "QuantumAnnealing hardware notes" });
    const ids = pack.primary.map((p) => p.id as unknown as string);
    expect(ids).not.toContain("papers/broken-paper");
  });
});

describe("FIX F3 — default project context is byte-identical", () => {
  it("adds no typed pages for a default project (empty primary for a no-match prompt)", async () => {
    const def = await mkdtemp(path.join(os.tmpdir(), "context-default-"));
    try {
      const pack = await buildContextPack({ root: def, prompt: "MixtureOfExperts" });
      expect(pack.primary).toEqual([]);
      expect(pack.project.pages).toBe(0);
    } finally {
      await rm(def, { recursive: true, force: true });
    }
  });
});

// ─── Task C1: retrieval.includeInContext gates the lexical pool ───────────────

/** Profile with `ideas` excluded from context, `experiments` included (omitted). */
const INCLUDE_IN_CONTEXT_PROFILE = {
  schemaVersion: 1 as const,
  profileId: "test-include-in-context",
  entities: {
    ideas: {
      directory: "wiki/ideas",
      requiredFields: ["status"],
      fields: { status: { type: "string" as const } },
      retrieval: { includeInContext: false },
    },
    experiments: {
      directory: "wiki/experiments",
    },
  },
};

/** Resolve the primary page ids for a SpectralMixture prompt from `ctxRoot`. */
async function spectralPrimaryIds(ctxRoot: string): Promise<string[]> {
  const pack = await buildContextPack({ root: ctxRoot, prompt: "SpectralMixture" });
  return pack.primary.map((p) => p.id as unknown as string);
}

describe("C1 — includeInContext gates the typed-page lexical pool", () => {
  let ctxRoot = "";
  beforeEach(async () => {
    ctxRoot = await mkdtemp(path.join(os.tmpdir(), "context-incl-"));
    await writeProfileFile(ctxRoot, INCLUDE_IN_CONTEXT_PROFILE as never);
    // ideas page — the type has includeInContext:false
    await writeMarkdownPage(ctxRoot, "wiki/ideas", "excluded-idea", "---\nstatus: proposed\n---\nSpectralMixture idea body.");
    // experiments page — omitted retrieval → included by default
    await writeMarkdownPage(ctxRoot, "wiki/experiments", "included-exp", "---\n---\nSpectralMixture experiment body.");
  });
  afterEach(async () => { if (ctxRoot) await rm(ctxRoot, { recursive: true, force: true }); });

  it("excludes a typed page whose entity type has retrieval.includeInContext:false", async () => {
    expect(await spectralPrimaryIds(ctxRoot)).not.toContain("ideas/excluded-idea");
  });

  it("includes a typed page whose entity type has retrieval.includeInContext omitted", async () => {
    expect(await spectralPrimaryIds(ctxRoot)).toContain("experiments/included-exp");
  });

  it("includes a typed page whose entity type has retrieval.includeInContext:true", async () => {
    const trueProfile = {
      ...INCLUDE_IN_CONTEXT_PROFILE,
      entities: {
        ...INCLUDE_IN_CONTEXT_PROFILE.entities,
        experiments: { directory: "wiki/experiments", retrieval: { includeInContext: true } },
      },
    };
    await writeProfileFile(ctxRoot, trueProfile as never);
    expect(await spectralPrimaryIds(ctxRoot)).toContain("experiments/included-exp");
  });

  it("still excludes a profile-invalid typed page regardless of includeInContext", async () => {
    // ideas requires `status`; write a page missing it — it's profile-invalid
    await writeMarkdownPage(ctxRoot, "wiki/ideas", "broken-idea", "---\n---\nSpectralMixture broken.");
    const ids = await spectralPrimaryIds(ctxRoot);
    // both the excluded (includeInContext:false) and invalid pages are absent
    expect(ids).not.toContain("ideas/broken-idea");
    expect(ids).not.toContain("ideas/excluded-idea");
  });
});
