/**
 * Public source removal must respect restored operation recovery authority.
 * Runs the installed-shaped CLI entry against retained source/page bytes.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { twoSourceRmProject } from "../fixtures/rm-project.js";
import { runCLI } from "../fixtures/run-cli.js";
import { parkedSourceBundle } from "./executor-fixtures.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("rm recovery authority", () => {
  it("refuses source removal beside an unsettled bundle and retains all source/page bytes", async () => {
    root = await twoSourceRmProject();
    await parkedSourceBundle(root);
    const leaves = ["sources/bad.md", "wiki/concepts/junk.md", ".llmwiki/state.json"];
    const before = await Promise.all(leaves.map(leaf => readFile(path.join(root, leaf))));
    const result = await runCLI(["rm", "bad"], root, { LLMWIKI_EMBEDDINGS: "off" });
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain("operation bundle recovery is required");
    const after = await Promise.all(leaves.map(leaf => readFile(path.join(root, leaf))));
    expect(after).toEqual(before);
  });

  it("still allows read-only removal preview beside an unsettled bundle", async () => {
    root = await twoSourceRmProject();
    await parkedSourceBundle(root);
    const source = path.join(root, "sources/bad.md");
    const before = await readFile(source);
    const result = await runCLI(["rm", "bad", "--dry-run"], root);
    expect(result.code).toBe(0);
    expect(await readFile(source)).toEqual(before);
  });
});
