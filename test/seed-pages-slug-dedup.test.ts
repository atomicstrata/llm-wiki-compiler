/**
 * @file test/seed-pages-slug-dedup.test.ts
 * @description `generateSeedPages` must dedup seeds by slug FIRST-SEEN-WINS, so a
 * later seed whose title `slugify`s to an already-seen slug can never share the
 * committed set's `namespace/slug` key.
 *
 * Two distinct seed titles ("Shared Topic" / "Shared, Topic") collapse to the
 * SAME slug `shared-topic`. Without dedup, both writes share that key — so if the
 * planner floor-BLOCKS the colliding write, BOTH drop from `generation.seedSlugs`
 * (the skipped key matches the committed one), silently never resolving/embedding
 * the committed sibling. With first-seen dedup only ONE write is built, so the
 * committed first seed survives.
 *
 * This file pins both: (1) only ONE write is applied (the duplicate is dropped
 * up front), and (2) the committed first seed stays in `seedSlugs` when its
 * colliding sibling is floor-blocked — the teeth that FAIL against the pre-dedup
 * code, where the second collider landed in `skipped` and took the first down
 * with it (the shared `concepts/shared-topic` key).
 */

import { describe, it, expect, vi } from "vitest";
import { generateSeedPages } from "../src/compiler/seed-pages.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import { buildDefaultSchema } from "../src/schema/defaults.js";
import type { SchemaConfig } from "../src/schema/index.js";
import { useSeedPagesRoot, emptyGeneration } from "./fixtures/seed-pages-harness.js";

const ctx = useSeedPagesRoot("seed-dedup-");

/** Two seeds whose distinct titles both slugify to `shared-topic`. */
function collidingSeedSchema(): SchemaConfig {
  return {
    ...buildDefaultSchema(),
    seedPages: [
      { title: "Shared Topic", kind: "overview", summary: "First — kept." },
      { title: "Shared, Topic", kind: "overview", summary: "Collides — dropped." },
    ],
  };
}

describe("generateSeedPages dedups seeds by slug first-seen-wins", () => {
  it("applies only one write for two slug-colliding seeds", async () => {
    const applySpy = vi
      .spyOn(compileWrite, "applyCompilePageWritesLocked")
      .mockResolvedValue({ skipped: [] });

    const generation = emptyGeneration();
    await generateSeedPages(ctx.dir, collidingSeedSchema(), generation);

    const applied = applySpy.mock.calls[0][1];
    expect(applied).toHaveLength(1); // only first-seen write built
    expect(applied[0].slug).toBe("shared-topic");
    expect(generation.seedSlugs).toEqual(["shared-topic"]); // listed once
  });

  it("a committed first seed survives a floor-blocked colliding sibling", async () => {
    // The exact pre-dedup bug: first seed commits, a DISTINCT-title second seed
    // collides on slug and is floor-blocked. Pre-dedup both shared `shared-topic`
    // so the committed first dropped too; post-dedup the collider never becomes a
    // second write, so the first stays committed.
    const schema: SchemaConfig = {
      ...buildDefaultSchema(),
      seedPages: [
        { title: "Shared Topic", kind: "overview", summary: "First — committed." },
        { title: "Shared, Topic", kind: "overview", summary: "Collides — would block." },
      ],
    };
    // Block any write that DID carry the collider's identity; since the collider
    // is deduped away, nothing is skipped and the first stays committed.
    vi.spyOn(compileWrite, "applyCompilePageWritesLocked").mockImplementation(async (_root, items) => {
      // Block only if a SECOND `shared-topic` write somehow reached apply (the bug).
      const dupes = items.filter((it) => it.slug === "shared-topic");
      return { skipped: dupes.length > 1 ? [{ item: dupes[1], reason: "floor:deny" }] : [] };
    });

    const generation = emptyGeneration();
    await generateSeedPages(ctx.dir, schema, generation);

    expect(generation.seedSlugs).toEqual(["shared-topic"]); // committed sibling survives
  });
});
