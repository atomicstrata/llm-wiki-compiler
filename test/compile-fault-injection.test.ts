/**
 * @file test/compile-fault-injection.test.ts
 * @description The PHASE-ATOMIC guarantee of the compile reroute, proven by
 * fault injection at the executor seam.
 *
 *  - CRASH MID a page-write batch: a `writeOne` that throws on the 2nd write in
 *    the generation batch leaves the journal `pending` (the 1st page on disk, no
 *    commit). The NEXT compile's strict {@link recoverJournalBeforeCompile}
 *    REVERTS that batch to its pre-state (the half-written page is deleted)
 *    BEFORE the pipeline reads anything, then completes cleanly.
 *  - CRASH BEFORE the state flush (here: at resolution, after generation has
 *    committed): the draft is NEVER flushed, so `state.json` does NOT mark the
 *    source compiled → the next compile re-detects and re-runs. (Reuses the
 *    marker-ordering resolution seam.)
 *
 * Injection: `applyCompilePageWritesLocked` is spied to forward a faulting
 * {@link ApplyOptions.writeOne} into the REAL adapter, so the crash lands inside
 * the journalled batch exactly as a real mid-write fault would.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "fs";
import { readdir, mkdir } from "fs/promises";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CONCEPTS_DIR, STATE_FILE } from "../src/utils/constants.js";
import { atomicWrite } from "../src/utils/markdown.js";
import * as compileWrite from "../src/compiler/compile-write.js";
import * as resolver from "../src/compiler/resolver.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { readPersistedState } from "./fixtures/state-json.js";
import { journalFileCount } from "./fixtures/compile-reroute-helpers.js";

const ctx = useCompileProject({
  dirSuffix: "fault-injection",
  sourceFile: "sample.md",
  sourceContent: "# Sample\n\nAlpha and Beta are related.",
});

/** Stub extraction (two concepts → one generation batch of two pages). */
function stubTwoConcepts(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [
      { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.9 },
      { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.9 },
    ] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Generated body content here.");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Spy the adapter to inject a writeOne that throws on the Nth write of a batch. */
function injectWriteFaultOnNth(failOn: number): void {
  let n = 0;
  const real = compileWrite.applyCompilePageWritesLocked;
  vi.spyOn(compileWrite, "applyCompilePageWritesLocked").mockImplementation((root, items, _opts) =>
    real(root, items, {
      writeOne: async (filePath, content) => {
        n += 1;
        if (n === failOn) throw new Error("injected mid-batch write fault");
        // Mirror the executor's default writeOne: the path is already confined.
        await atomicWrite(filePath, content);
      },
    }),
  );
}

beforeEach(() => {
  stubTwoConcepts();
});

describe("crash MID a page-write batch leaves a pending journal the next compile reverts", () => {
  it("a half-written generation batch is reverted before any read, then completes", async () => {
    injectWriteFaultOnNth(2); // 1st page lands, 2nd throws → journal stays pending
    await expect(compileAndReport(ctx.dir)).rejects.toThrow("injected mid-batch write fault");

    // The batch never committed → exactly one pending journal file remains.
    expect(await journalFileCount(ctx.dir)).toBe(1);
    vi.restoreAllMocks();
    stubTwoConcepts();

    const result = await compileAndReport(ctx.dir);
    expect(result.errors).toEqual([]);
    // Strict pre-compile recovery reverted the half-batch (no orphan page from the
    // crashed run), then the clean re-run committed BOTH pages with no residue.
    expect([...result.pages].sort()).toEqual(["alpha", "beta"]);
    expect(await journalFileCount(ctx.dir)).toBe(0);
  });
});

describe("crash BEFORE the state flush re-runs the whole compile", () => {
  it("a resolution-phase throw leaves no compiled marker; the next compile completes it", async () => {
    const resolveSpy = vi.spyOn(resolver, "resolveAndApplyLinks");
    resolveSpy.mockRejectedValueOnce(new Error("injected resolution failure"));

    await expect(compileAndReport(ctx.dir)).rejects.toThrow("injected resolution failure");
    // Draft never flushed past resolution → no durable compiled marker.
    if (existsSync(path.join(ctx.dir, STATE_FILE))) {
      expect((await readPersistedState(ctx.dir)).sources["sample.md"]).toBeUndefined();
    }

    resolveSpy.mockRestore();
    const result = await compileAndReport(ctx.dir);
    expect(result.compiled).toBe(1);
    expect((await readPersistedState(ctx.dir)).sources["sample.md"].concepts.sort()).toEqual(["alpha", "beta"]);
  });
});

describe("crash mid-batch then the SAME source recompiles to a consistent page store", () => {
  it("after recovery the wiki has no stale half-written page from the crashed run", async () => {
    await mkdir(path.join(ctx.dir, CONCEPTS_DIR), { recursive: true });
    injectWriteFaultOnNth(1); // FIRST write throws → nothing should land
    await expect(compileAndReport(ctx.dir)).rejects.toThrow("injected mid-batch write fault");

    vi.restoreAllMocks();
    stubTwoConcepts();
    await compileAndReport(ctx.dir);

    const pages = (await readdir(path.join(ctx.dir, CONCEPTS_DIR))).filter((f) => f.endsWith(".md")).sort();
    expect(pages).toEqual(["alpha.md", "beta.md"]);
    expect(await journalFileCount(ctx.dir)).toBe(0);
  });
});
