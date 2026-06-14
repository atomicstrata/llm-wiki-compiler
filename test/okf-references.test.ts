import { describe, it, expect } from "vitest";
import { collectReferenceFiles } from "../src/export/okf/references.js";
import type { ExportPage } from "../src/export/types.js";

const pages = [
  { citations: [{ file: "a.md", start: 1, end: 3 }] },
  { citations: [{ file: "a.md" }, { file: "b.md" }] },
] as ExportPage[];

describe("collectReferenceFiles", () => {
  it("returns the deduped set of cited source filenames", () => {
    expect(collectReferenceFiles(pages).sort()).toEqual(["a.md", "b.md"]);
  });
  it("ignores pages without citations", () => {
    expect(collectReferenceFiles([{} as ExportPage])).toEqual([]);
  });
});
