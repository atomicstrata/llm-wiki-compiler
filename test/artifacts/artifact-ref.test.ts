import { describe, it, expect } from "vitest";
import { parseArtifactRef, formatArtifactRef } from "../../src/artifacts/ref.js";

const HEX = "a".repeat(64);
const good = `experiment-result/probe@sha256:${HEX}`;

describe("ArtifactRef parse/format", () => {
  it("parses a valid compact ref and round-trips", () => {
    const ref = parseArtifactRef(good);
    expect(ref).toEqual({ artifactType: "experiment-result", slug: "probe", sha256: HEX });
    expect(formatArtifactRef(ref!)).toBe(good);
  });
  it("rejects a non-string, bad hash length, non-hex, non-slug, or missing parts", () => {
    for (const bad of [42, `x/y@sha256:${"a".repeat(63)}`, `x/y@sha256:${"g".repeat(64)}`,
      `X/y@sha256:${HEX}`, `x/Y@sha256:${HEX}`, `x@sha256:${HEX}`, `x/y@md5:${HEX}`]) {
      expect(parseArtifactRef(bad as unknown)).toBeNull();
    }
  });
});
