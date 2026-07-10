// test/okf-run-import.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { assertNoOutput } from "./fixtures/no-output.js";
import { writeOneDocBundle as bundle } from "./fixtures/okf-bundle-fixture.js";

/**
 * Write a one-doc bundle whose body MENTIONS an existing on-disk concept
 * ("Graph Theory"), plus that concept page itself, so a trusted import's
 * post-refresh interlink resolution has a real link target.
 */
async function bundleLinkingExisting(root: string): Promise<string> {
  const conceptsDir = path.join(root, "wiki/concepts");
  await mkdir(conceptsDir, { recursive: true });
  await writeFile(path.join(conceptsDir, "graph-theory.md"), "---\ntitle: Graph Theory\nsummary: s\n---\n\nAbout graphs.\n");
  const bundleDir = path.join(root, "kb");
  await mkdir(path.join(bundleDir, "concepts"), { recursive: true });
  await writeFile(path.join(bundleDir, "concepts", "net.md"), "---\ntype: concept\ntitle: Net\n---\n\nNet builds on Graph Theory.\n");
  return bundleDir;
}

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("runOkfImport", () => {
  it("stages by default and returns a staged report (no stdout)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii-"));
    const b = await bundle(dir);
    const report = await assertNoOutput(() => runOkfImport(dir, b, {}));
    expect(report.mode).toBe("staged");
    expect(report.pages).toEqual([{ slug: "a", okfPath: "concepts/a.md", targetDirectory: "concepts" }]);
    expect(await listCandidates(dir)).toHaveLength(1);
  });
  it("dry-run writes/stages nothing and reports would-import", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii2-"));
    const b = await bundle(dir);
    const report = await runOkfImport(dir, b, { dryRun: true });
    expect(report.mode).toBe("dry-run");
    expect(report.pages).toHaveLength(1);
    expect(await listCandidates(dir)).toHaveLength(0);
  });
  it("trusted writes live", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii3-"));
    const b = await bundle(dir);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.mode).toBe("written");
    expect((await stat(path.join(dir, "wiki/concepts/a.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8")).toContain("provenanceState: imported");
  });
  it("trusted import resolves interlinks into the imported page on disk", async () => {
    // Regression: refreshAfterImport calls resolveLinks, which now COMPUTES
    // rewrites the caller must apply. If discarded, the imported page never gets
    // its [[wikilink]] — this asserts it actually lands.
    dir = await mkdtemp(path.join(tmpdir(), "rii4-"));
    const b = await bundleLinkingExisting(dir);
    await runOkfImport(dir, b, { trusted: true });
    const net = await readFile(path.join(dir, "wiki/concepts/net.md"), "utf-8");
    expect(net).toContain("[[graph-theory|Graph Theory]]");
  });
});
