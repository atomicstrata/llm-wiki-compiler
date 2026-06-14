import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { readOkfBundle } from "../src/import/okf-read.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { make } = useOkfTempDir();

describe("readOkfBundle tolerance", () => {
  it("keeps a foreign doc with an unknown type + unknown keys + broken link", async () => {
    const b = path.join(await make("okf-tol-"), "bundle"); await mkdir(b, { recursive: true });
    await writeFile(path.join(b, "t.md"), "---\ntype: BigQuery Table\nvendorKey: 7\n---\n\nSee [x](/concepts/missing.md).\n");
    const docs = await readOkfBundle(b);
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.type).toBe("BigQuery Table");
    expect(docs[0].meta.vendorKey).toBe(7);
    expect(docs[0].body).toContain("/concepts/missing.md");
  });
  it("skips a typeless doc but keeps its sibling", async () => {
    const b = path.join(await make("okf-tol2-"), "bundle"); await mkdir(b, { recursive: true });
    await writeFile(path.join(b, "bad.md"), "---\ntitle: no type\n---\n\nx\n");
    await writeFile(path.join(b, "ok.md"), "---\ntype: concept\ntitle: Y\n---\n\ny\n");
    const docs = await readOkfBundle(b);
    expect(docs.map((d) => d.relPath)).toEqual(["ok.md"]);
  });
});
