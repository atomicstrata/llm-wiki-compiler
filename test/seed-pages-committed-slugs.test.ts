/**
 * @file test/seed-pages-committed-slugs.test.ts
 * @description `generateSeedPages` must report only the COMMITTED seed slugs.
 *
 * A seed page that passes the validate prefilter (no `result.error`) but is
 * FLOOR-BLOCKED by the planner lands in the executor's `skipped` set. Before the
 * fix the slug was pushed to `generation.seedSlugs` eagerly, BEFORE apply ran — so
 * a phantom (missing-on-disk) seed flowed into `finalizeWiki` link resolution and
 * embeddings refresh and was reported as written. This pins that `seedSlugs`
 * excludes a floor-skipped seed while still including the committed one.
 *
 * The floor-block is SIMULATED by spying on `applyCompilePageWritesLocked` to
 * return a `skipped` entry (reason `floor:deny`) for one of the two writes — the
 * deterministic stand-in for a planner deny — while reporting the other as applied.
 */

import { describe, it, expect, vi } from "vitest";
import { generateSeedPages } from "../src/compiler/seed-pages.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import { buildDefaultSchema } from "../src/schema/defaults.js";
import type { SchemaConfig } from "../src/schema/index.js";
import { useSeedPagesRoot, emptyGeneration } from "./fixtures/seed-pages-harness.js";

const ctx = useSeedPagesRoot("seed-committed-");

/** A two-seed schema: "Kept Overview" commits, "Blocked Overview" is floor-skipped. */
function twoSeedSchema(): SchemaConfig {
  return {
    ...buildDefaultSchema(),
    seedPages: [
      { title: "Kept Overview", kind: "overview", summary: "Committed." },
      { title: "Blocked Overview", kind: "overview", summary: "Floor-blocked." },
    ],
  };
}

describe("generateSeedPages reports only committed seed slugs", () => {
  it("excludes a floor-skipped seed from seedSlugs while keeping the committed one", async () => {
    vi.spyOn(compileWrite, "applyCompilePageWritesLocked").mockImplementation(async (_root, items) => {
      const blocked = items.find((it) => it.slug === "blocked-overview");
      return { skipped: blocked ? [{ item: blocked, reason: "floor:deny" }] : [] };
    });

    const generation = emptyGeneration();
    await generateSeedPages(ctx.dir, twoSeedSchema(), generation);

    expect(generation.seedSlugs).toContain("kept-overview"); // committed → reported
    expect(generation.seedSlugs).not.toContain("blocked-overview"); // skipped → NOT reported
    expect(generation.errors.some((e) => e.includes("blocked-overview"))).toBe(true); // still surfaced as error
  });
});
