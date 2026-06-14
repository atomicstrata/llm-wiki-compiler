import { describe, it, expect } from "vitest";
import { readProvenanceState } from "../src/export/collect.js";
import { parseProvenanceMetadata } from "../src/utils/markdown.js";

describe("provenanceState: imported", () => {
  it("readProvenanceState accepts imported, rejects junk", () => {
    expect(readProvenanceState({ provenanceState: "imported" })).toBe("imported");
    expect(readProvenanceState({ provenanceState: "nope" })).toBeUndefined();
  });
  it("the markdown.ts provenance gate also accepts imported", () => {
    const meta = { title: "X", provenanceState: "imported" };
    expect(parseProvenanceMetadata(meta).provenanceState).toBe("imported");
  });
});
