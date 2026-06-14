import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectReferenceFiles, resolveReferences } from "../src/export/okf/references.js";
import { safeRefName } from "../src/export/okf/mapping.js";
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

describe("resolveReferences", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "okf-refs-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources", "a.md"), "A", "utf-8");
  });

  it("keeps only cited files that exist inside sources/, mapped to safe dest names", async () => {
    const refs = await resolveReferences(root, [
      { citations: [{ file: "a.md" }, { file: "missing.md" }] },
    ] as ExportPage[]);
    expect([...refs.keys()]).toEqual(["a.md"]);
    expect(refs.get("a.md")!.destName).toBe(safeRefName("a.md"));
    expect(refs.get("a.md")!.srcAbs).toMatch(/sources\/.*a\.md$/);
  });
});
