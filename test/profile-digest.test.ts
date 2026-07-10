/**
 * Tests for the canonical profile digest.
 *
 * The digest is durable identity, so these tests pin its key invariants: it is
 * stable across key reordering and equivalent numeric spellings (`1.0` vs `1`),
 * and the underlying RFC 8785 (JCS) canonicalization is exercised with the
 * official Appendix B.1 number-serialization vector as a regression guard on
 * the vetted dependency wrapper.
 */

import { describe, it, expect } from "vitest";
import canonicalize from "canonicalize";
import { profileDigest } from "../src/profile/digest.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A minimal valid profile, fields declared in deliberately non-sorted order. */
function sampleProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "sample",
    displayName: "Sample",
    entities: { docs: { directory: "wiki/docs" } },
  };
}

describe("profileDigest", () => {
  it("is a lowercase 64-char hex SHA-256", () => {
    expect(profileDigest(sampleProfile())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across top-level key reordering", () => {
    const reordered = {
      entities: { docs: { directory: "wiki/docs" } },
      displayName: "Sample",
      profileId: "sample",
      schemaVersion: 1,
    } as ProfilePack;
    expect(profileDigest(reordered)).toBe(profileDigest(sampleProfile()));
  });

  it("treats 1.0 and 1 as the same number per the JCS lib", () => {
    const a = { schemaVersion: 1, profileId: "n", entities: { d: { directory: "wiki/d", retrieval: { defaultWeight: 1.0 } } } } as ProfilePack;
    const b = { schemaVersion: 1, profileId: "n", entities: { d: { directory: "wiki/d", retrieval: { defaultWeight: 1 } } } } as ProfilePack;
    expect(profileDigest(a)).toBe(profileDigest(b));
  });

  it("canonicalizes the official RFC 8785 Appendix B.1 number vector", () => {
    const numbers = [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27];
    expect(canonicalize({ numbers })).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  });
});
