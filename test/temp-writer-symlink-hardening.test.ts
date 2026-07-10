/**
 * @file test/temp-writer-symlink-hardening.test.ts
 * @description The three bespoke temp+rename writers (state.json, rule-state.json,
 * and the trust journal) now route through the hardened {@link atomicWrite}, so
 * none of them can be redirected outside the project root by a symlink planted at
 * the old predictable `<path>.tmp` leaf. Each test plants such a symlink, performs
 * a normal write, and asserts the out-of-tree sink is untouched while the in-root
 * target round-trips correctly.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, readFile, writeFile } from "fs/promises";
import path from "path";
import { writeState, readState } from "../src/utils/state.js";
import { updateRuleSourceState, readRuleState } from "../src/compiler/rule-state.js";
import { openBatch, recordPreState } from "../src/trust/journal.js";
import { STATE_FILE, RULE_STATE_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("tw");

/** Plant a symlink at `<file>.tmp` pointing at an out-of-tree sink. */
async function plantTempSymlink(file: string): Promise<string> {
  const sink = path.join(ctx.outside, "sink");
  await writeFile(sink, "original", "utf-8");
  await symlink(sink, `${file}.tmp`);
  return sink;
}

describe("bespoke temp-writers route through hardened atomicWrite", () => {
  it("writeState does not escape via a planted state.json.tmp symlink", async () => {
    const { root } = ctx;
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    const sink = await plantTempSymlink(path.join(root, STATE_FILE));

    await writeState(root, { version: 1, indexHash: "h", sources: {} });

    expect(await readFile(sink, "utf-8")).toBe("original"); // outside untouched
    expect((await readState(root)).indexHash).toBe("h"); // target round-trips
  });

  it("rule-state write does not escape via a planted rule-state.json.tmp symlink", async () => {
    const { root } = ctx;
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    const sink = await plantTempSymlink(path.join(root, RULE_STATE_FILE));

    await updateRuleSourceState(root, "a.md", { hash: "x", compiledAt: "t", concepts: [] });

    expect(await readFile(sink, "utf-8")).toBe("original");
    expect((await readRuleState(root)).sources["a.md"].hash).toBe("x");
  });

  it("journal persist does not escape via a planted journal.tmp symlink", async () => {
    const { root } = ctx;
    const batch = await openBatch(root); // writes the (empty) journal file
    const sink = await plantTempSymlink(
      path.join(root, LLMWIKI_DIR, "journal", `${batch.batchId}.json`),
    );

    await recordPreState(batch, path.join(root, "page.md")); // re-persists journal

    expect(await readFile(sink, "utf-8")).toBe("original");
    expect(batch.entries).toHaveLength(1);
  });
});
