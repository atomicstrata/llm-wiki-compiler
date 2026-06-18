/**
 * Tests for the lossless v1→v2 WikiState migration.
 *
 * Phase 2 of the Configurable Lifecycle Knowledge Platform introduces a typed
 * ownership mirror: alongside the v1 `concepts` / `frozenSlugs` string lists,
 * a v2 state carries `entities` / `frozenEntities` as branded `EntityId`s of
 * the form `concepts/<slug>`. These tests pin the migration's four contracts:
 *
 *  - lossless upgrade (v1 fields retained, typed mirror added),
 *  - idempotency (re-migrating a v2 state is a no-op, never double-typed),
 *  - determinism (sorted output, byte-stable across repeated runs), and
 *  - fail-closed behaviour (a non-slug-safe bare slug throws, never dropped).
 */

import { describe, it, expect } from "vitest";
import { migrateStateToV2 } from "../src/state/migrate.js";
import { EntityIdError } from "../src/profile/identity.js";
import type { WikiState } from "../src/utils/types.js";

/** A minimal, valid v1 state used as the base fixture for the suite. */
function v1Fixture(): WikiState {
  return {
    version: 1,
    indexHash: "i",
    sources: {
      "a.md": { hash: "h", concepts: ["rag", "x"], compiledAt: "T" },
    },
    frozenSlugs: ["rag"],
  };
}

describe("migrateStateToV2 — lossless v1→v2 upgrade", () => {
  it("bumps version and adds the typed mirror while retaining v1 fields", () => {
    const v2 = migrateStateToV2(v1Fixture());
    expect(v2.version).toBe(2);
    const src = v2.sources["a.md"];
    expect(src.entities).toEqual(["concepts/rag", "concepts/x"]);
    expect(src.concepts).toEqual(["rag", "x"]);
    expect(v2.frozenEntities).toEqual(["concepts/rag"]);
    expect(v2.frozenSlugs).toEqual(["rag"]);
  });

  it("carries hash, compiledAt, and indexHash through unchanged", () => {
    const v2 = migrateStateToV2(v1Fixture());
    expect(v2.indexHash).toBe("i");
    expect(v2.sources["a.md"].hash).toBe("h");
    expect(v2.sources["a.md"].compiledAt).toBe("T");
  });
});

describe("migrateStateToV2 — idempotency", () => {
  it("returns a deep-equal v2 state when given an already-v2 state", () => {
    const once = migrateStateToV2(v1Fixture());
    const twice = migrateStateToV2(once);
    expect(twice).toEqual(once);
  });

  it("never double-types entities on a second migration", () => {
    const twice = migrateStateToV2(migrateStateToV2(v1Fixture()));
    expect(twice.sources["a.md"].entities).toEqual(["concepts/rag", "concepts/x"]);
    expect(twice.frozenEntities).toEqual(["concepts/rag"]);
  });
});

describe("migrateStateToV2 — determinism", () => {
  it("produces deep-equal output across two migrations of the same input", () => {
    expect(migrateStateToV2(v1Fixture())).toEqual(migrateStateToV2(v1Fixture()));
  });

  it("sorts entities and frozenEntities lexicographically", () => {
    const v1 = v1Fixture();
    v1.sources["a.md"].concepts = ["zebra", "apple", "mango"];
    v1.frozenSlugs = ["zebra", "apple"];
    const v2 = migrateStateToV2(v1);
    expect(v2.sources["a.md"].entities).toEqual([
      "concepts/apple",
      "concepts/mango",
      "concepts/zebra",
    ]);
    expect(v2.frozenEntities).toEqual(["concepts/apple", "concepts/zebra"]);
  });
});

describe("migrateStateToV2 — fail-closed", () => {
  it("throws on a bare slug with spaces rather than silently dropping it", () => {
    const v1 = v1Fixture();
    v1.sources["a.md"].concepts = ["Bad Slug"];
    expect(() => migrateStateToV2(v1)).toThrow(EntityIdError);
  });

  it("throws on an uppercase frozen slug rather than silently dropping it", () => {
    const v1 = v1Fixture();
    v1.frozenSlugs = ["UPPER"];
    expect(() => migrateStateToV2(v1)).toThrow(EntityIdError);
  });
});
