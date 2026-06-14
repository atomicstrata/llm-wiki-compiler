import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { okfDocToPage } from "../src/import/okf-map.js";
import { collectExportPages } from "../src/export/collect.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

let dir: string; const cwd = process.cwd();
afterEach(async () => { process.chdir(cwd); if (dir) await rm(dir, { recursive: true, force: true }); });

const ctx = { bundleId: "b", titleOf: () => null };
const FOREIGN = { relPath: "concepts/t.md", meta: { type: "BigQuery Table", title: "T" }, body: "Body.\n" };

describe("okfPath durability across approval + export", () => {
  it("keeps x-okf.okfPath on the live page and surfaces it through collectExportPages", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-okfpath-"));
    const mapped = okfDocToPage(FOREIGN, ctx);
    await writeCandidate(dir, {
      title: mapped.title, slug: mapped.slug, summary: mapped.summary, sources: mapped.sources,
      body: mapped.body, reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: mapped.targetDirectory, okfPath: mapped.okfPath,
    });
    process.chdir(dir);
    const [c] = await listCandidates(dir);
    await reviewApproveCommand(c.id);
    const live = await readFile(path.join(dir, `wiki/concepts/${mapped.slug}.md`), "utf-8");
    expect((parseFrontmatter(live).meta["x-okf"] as any).okfPath).toBe("concepts/t.md");
    const exp = await collectExportPages(dir);
    expect(exp.find((p) => p.slug === mapped.slug)!.xOkf?.okfPath).toBe("concepts/t.md");
  });
});
