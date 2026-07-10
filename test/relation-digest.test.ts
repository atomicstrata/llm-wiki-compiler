/**
 * @file test/relation-digest.test.ts
 * @description Tests for relation content hashing and ULID minting (Phase 4).
 *
 * Pins: the content hash is a stable lowercase-hex SHA-256 invariant to
 * attribute key order; a symmetric edge canonicalizes its endpoints so (a→b)
 * and (b→a) hash identically while a directed edge does not; and a minted
 * relation id is a 26-char ULID-bearing `rel_` handle.
 */

import { describe, it, expect } from "vitest";
import type { EntityId } from "../src/profile/types.js";
import { relationContentHash, canonicalEndpoints } from "../src/relations/digest.js";
import { ulid, mintRelationId } from "../src/relations/ulid.js";

const A = "experiments/a" as EntityId;
const B = "ideas/b" as EntityId;

describe("relationContentHash", () => {
  it("is a stable lowercase-hex sha256 invariant to attribute key order", () => {
    const h1 = relationContentHash({ type: "tests", from: A, to: B, attributes: { x: 1, y: 2 } });
    const h2 = relationContentHash({ type: "tests", from: A, to: B, attributes: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when content changes", () => {
    const base = relationContentHash({ type: "tests", from: A, to: B, attributes: {} });
    const changed = relationContentHash({ type: "tests", from: A, to: B, attributes: { z: 1 } });
    expect(base).not.toBe(changed);
  });
});

describe("symmetric endpoint canonicalization", () => {
  it("makes (a→b) and (b→a) hash identically for a symmetric type", () => {
    const ab = canonicalEndpoints(A, B, "symmetric");
    const ba = canonicalEndpoints(B, A, "symmetric");
    const h1 = relationContentHash({ type: "rel", ...ab, attributes: {} });
    const h2 = relationContentHash({ type: "rel", ...ba, attributes: {} });
    expect(h1).toBe(h2);
  });

  it("keeps directed (a→b) and (b→a) distinct", () => {
    const h1 = relationContentHash({ type: "rel", ...canonicalEndpoints(A, B, "directed"), attributes: {} });
    const h2 = relationContentHash({ type: "rel", ...canonicalEndpoints(B, A, "directed"), attributes: {} });
    expect(h1).not.toBe(h2);
  });
});

describe("ulid / mintRelationId", () => {
  it("mints a 26-char crockford ulid and a rel_ handle", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mintRelationId()).toMatch(/^rel_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mintRelationId()).not.toBe(mintRelationId());
  });
});
