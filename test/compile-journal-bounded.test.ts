/**
 * @file test/compile-journal-bounded.test.ts
 * @description (H1) journal-bounded + (group 3) lock/reentrancy coverage for the
 * compile reroute.
 *
 * (H1) JOURNAL DOES NOT GROW: a clean compile exercising multiple write sites
 * (generation + seed + resolution) leaves ZERO residual files in
 * `.llmwiki/journal/` — {@link commitBatch} unlinks each batch's journal on
 * commit. Running compile N times never accumulates journal files. This asserts
 * the journal DIR file count directly (NOT `journalHealth`, which is a later PR).
 *
 * (3) LOCK / REENTRANCY: compile drives the executor through the LOCK-FREE core
 * ({@link applyApprovedMutationsLocked}) under its OWN held project lock. The
 * proof is STRUCTURAL — the lock-free core WAS called and the self-locking
 * {@link applyApprovedMutations} was NOT — backed by the behavioural evidence
 * that a normal compile completes well within a sane timeout (a nested-acquire
 * would deadlock) and releases the lock afterward.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { LOCK_FILE } from "../src/utils/constants.js";
import * as executor from "../src/trust/executor.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import {
  journalFileCount,
  stubExtractionAndBody,
  writeOverviewSeedSchema,
} from "./fixtures/compile-reroute-helpers.js";

const ctx = useCompileProject({
  dirSuffix: "journal-bounded",
  sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha relates to Beta.",
});

/** Stub extraction + a fixed body, declare an overview seed (multi-site compile). */
async function setupMultiSiteCompile(): Promise<void> {
  stubExtractionAndBody("Alpha", "Alpha body mentioning Beta here.");
  await writeOverviewSeedSchema(ctx.dir);
}

describe("H1: the journal directory stays bounded across compiles", () => {
  it("a clean multi-site compile leaves zero residual journal files", async () => {
    await setupMultiSiteCompile();
    const result = await compileAndReport(ctx.dir);
    expect(result.errors).toEqual([]);
    expect(await journalFileCount(ctx.dir)).toBe(0);
  });

  it("running compile three times never accumulates journal files", async () => {
    await setupMultiSiteCompile();
    for (let i = 0; i < 3; i += 1) {
      await compileAndReport(ctx.dir);
      expect(await journalFileCount(ctx.dir)).toBe(0);
    }
  });
});

describe("lock/reentrancy: compile uses the lock-free core under its own lock", () => {
  it("calls the lock-free core, never the self-locking entry, with no deadlock", async () => {
    await setupMultiSiteCompile();
    const lockedSpy = vi.spyOn(executor, "applyApprovedMutationsLocked");
    const selfLockingSpy = vi.spyOn(executor, "applyApprovedMutations");

    const startMs = Date.now();
    // A nested-acquire deadlock would hang here; a sane bound proves it did not.
    const result = await compileAndReport(ctx.dir);
    expect(Date.now() - startMs).toBeLessThan(15_000);
    expect(result.errors).toEqual([]);

    // STRUCTURAL: the lock-free core ran; the self-locking entry never did.
    expect(lockedSpy).toHaveBeenCalled();
    expect(selfLockingSpy).not.toHaveBeenCalled();
    // The project lock was released in the pipeline's finally — no stale lock.
    expect(existsSync(path.join(ctx.dir, LOCK_FILE))).toBe(false);
    // A SECOND compile can acquire the (now-free) lock and run — proof of release.
    expect((await compileAndReport(ctx.dir)).errors).toEqual([]);
  }, 20_000);
});
