/**
 * Export-side round-trip invariant for OKF link rewriting.
 *
 * Asserts that reverse(forward(body)) == canonicalBody, and that the
 * contentHash is stable (same sha256 for identical bodies). This validates
 * that wikilink ↔ OKF link conversion is lossless and the hash domain is
 * deterministic.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { wikilinksToOkf, okfLinksToWikilinks, canonicalBody } from "../src/export/okf/mapping.js";

describe("export-side round-trip invariant", () => {
  it("reverse(forward(body)) == canonical body, and contentHash is stable", () => {
    const body = "See [[other]] and [[other|x]]. ^[a.md:1-3]\n";
    const resolve = (s: string) => (s === "other" ? { path: "concepts/other.md", title: "Other" } : null);
    const resolveLink = (p: string) => (p === "concepts/other" ? { slug: "other", title: "Other" } : null);
    const canon = canonicalBody(body);
    const okfBody = wikilinksToOkf(canon, resolve);
    const recovered = okfLinksToWikilinks(okfBody, resolveLink);
    expect(recovered).toBe(canon);
    const h = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
    expect(h(recovered)).toBe(h(canon));
  });
});
