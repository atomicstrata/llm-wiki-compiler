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
 * typed pages remains the deferred PR4 (embedding key-qualification).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildContextPack } from "../src/context/build.js";
import type { EntityId } from "../src/profile/types.js";
import {
  buildResearchLiteRelationsProject,
  writeMarkdownPage,
  seedTestsRelation,
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
