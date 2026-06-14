import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { buildFreshnessSnapshot, computeFreshness } from "../src/freshness/index.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

let dir: string; const cwd = process.cwd();
afterEach(async () => { process.chdir(cwd); if (dir) await rm(dir, { recursive: true, force: true }); });

async function bundleWith(rel: string, body: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "okf-inv-"));
  const b = path.join(dir, "kb");
  await mkdir(path.join(b, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(b, rel), body);
  return b;
}

/** Import the single-concept bundle, approve its one candidate, and return the live page text. */
async function importApproveReadConceptA(bundle: string): Promise<string> {
  await importCommand(dir, { okf: bundle });
  process.chdir(dir);
  const [c] = await listCandidates(dir);
  await reviewApproveCommand(c.id);
  return readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8");
}

describe("import invariants", () => {
  it("approval keeps durable imported provenance and writes no state.json", async () => {
    const b = await bundleWith("concepts/a.md", "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const page = await importApproveReadConceptA(b);
    expect(page).toContain("provenanceState: imported");
    expect(page).toMatch(/okf:kb/);
    await expect(stat(path.join(dir, ".llmwiki/state.json"))).rejects.toThrow();
  });

  it("nested same-name docs do not collapse (a/x.md, b/x.md both kept)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-inv2-"));
    const b = path.join(dir, "kb");
    await mkdir(path.join(b, "a"), { recursive: true }); await mkdir(path.join(b, "b"), { recursive: true });
    await writeFile(path.join(b, "a/x.md"), "---\ntype: concept\ntitle: AX\n---\n\nx\n");
    await writeFile(path.join(b, "b/x.md"), "---\ntype: concept\ntitle: BX\n---\n\nx\n");
    await importCommand(dir, { okf: b });
    const slugs = (await listCandidates(dir)).map((c) => c.slug).sort();
    expect(slugs).toEqual(["a-x", "b-x"]);
  });

  it("an imported page's source-derived freshness is unverified", async () => {
    const b = await bundleWith("concepts/a.md", "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const { meta } = parseFrontmatter(await importApproveReadConceptA(b));
    const snapshot = await buildFreshnessSnapshot(dir);
    const fresh = computeFreshness({ slug: "a", pageDirectory: "concepts", frontmatter: meta }, snapshot);
    expect(fresh.freshnessStatus).toBe("unverified");
  });
});
