/**
 * Timeline pages in exports: the JSON export carries them at their real
 * `wiki/timeline/` path, and the OKF bundle, which holds knowledge to carry
 * between projects, leaves these regenerated pages out.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import path from "path";
import { collectExportPages } from "../src/export/collect.js";
import { runOkfExport } from "../src/export/okf/run.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const CONCEPT = "---\ntitle: Kiln\nsummary: A kiln.\nsources: []\n---\n\nA kiln.\n";
const DAY = "---\ntitle: Monday, May 4, 2026\nsummary: Fired.\nsources: []\ntimeline: daily\ndate: 2026-05-04\n---\n\nFired.\n";

describe("timeline pages in exports", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot("timeline-export");
    await mkdir(path.join(root, "wiki/timeline"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/kiln.md"), CONCEPT);
    await writeFile(path.join(root, "wiki/timeline/2026-05-04.md"), DAY);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("gives a timeline page its own path in the JSON export", async () => {
    const pages = await collectExportPages(root);
    expect(pages.map((page) => page.path).sort()).toEqual(["wiki/concepts/kiln.md", "wiki/timeline/2026-05-04.md"]);
  });

  it("leaves timeline pages out of the OKF bundle", async () => {
    const out = path.join(root, "okf");
    await runOkfExport(root, { out });
    const files = await readdir(out, { recursive: true });
    expect(files.some((file) => String(file).includes("kiln"))).toBe(true);
    expect(files.some((file) => String(file).includes("2026-05-04"))).toBe(false);
  });
});
