/**
 * @file test/compile-write.test.ts
 * @description Coverage for the compile→trust PAGE-WRITE ADAPTER
 * (`src/compiler/compile-write.ts`) — the seam that routes `compile`'s page
 * writes through the unified planner + the LOCK-FREE guarded executor under the
 * caller's already-held project lock.
 *
 * Because the adapter uses {@link applyApprovedMutationsLocked} (which acquires
 * NOTHING), every test that applies a batch acquires the project lock FIRST via
 * {@link acquireLock} and releases it in `finally` — exactly the discipline
 * `compile` provides around its whole pipeline.
 *
 * The suite pins the four contracts:
 *  - allowed pages write BYTE-IDENTICAL to a direct {@link atomicWrite}, as ONE
 *    journalled batch (verified via a single-batch spy on the journal seam);
 *  - a mid-batch injected write failure leaves the journal `pending` (no partial
 *    commit) and a subsequent {@link replayJournal} reverts to the pre-state;
 *  - EMPTY items is a no-op: NO journal file is created and `skipped` is empty;
 *  - (H2) a floor-blocked oversized page is RETURNED in `skipped` (reason
 *    `floor:…`), the OTHER valid pages STILL write, and the call does NOT throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, readFile, mkdir, access } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { mkdtemp, rm } from "fs/promises";
import { applyCompilePageWritesLocked } from "../src/compiler/compile-write.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { atomicWrite } from "../src/utils/markdown.js";
import * as journal from "../src/trust/journal.js";
import { replayJournal } from "../src/trust/journal.js";
import { MAX_SOURCE_CHARS, GENERATED_PAGE_MAX_CHARS } from "../src/utils/constants.js";
import { failingWriteOneOnNth } from "./trust/fixture.js";

let root: string;
const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "compile-write-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
});

afterEach(async () => {
  await releaseLock(root);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Acquire the project lock, run `fn` under it, release in finally (compile's discipline). */
async function underLock<T>(fn: () => Promise<T>): Promise<T> {
  const got = await acquireLock(root);
  expect(got).toBe(true);
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}

/** Absolute on-disk path of a compiled page. */
function pagePath(namespace: string, slug: string): string {
  return path.join(root, "wiki", namespace, `${slug}.md`);
}

describe("applyCompilePageWritesLocked — allowed writes", () => {
  it("writes every page BYTE-IDENTICAL to a direct atomicWrite", async () => {
    const items = [
      { namespace: "concepts" as const, slug: "alpha", body: GOOD_BODY },
      { namespace: "queries" as const, slug: "beta", body: "---\ntitle: B\n---\n\nb\n" },
    ];
    const { skipped } = await underLock(() => applyCompilePageWritesLocked(root, items));
    expect(skipped).toEqual([]);

    for (const it of items) {
      const expected = path.join(root, `${it.slug}.expected`);
      await atomicWrite(expected, it.body);
      expect(await readFile(pagePath(it.namespace, it.slug), "utf-8")).toBe(
        await readFile(expected, "utf-8"),
      );
    }
  });

  it("applies all allowed pages as ONE journalled batch", async () => {
    const openSpy = vi.spyOn(journal, "openBatch");
    const items = [
      { namespace: "concepts" as const, slug: "one", body: GOOD_BODY },
      { namespace: "concepts" as const, slug: "two", body: GOOD_BODY },
    ];
    await underLock(() => applyCompilePageWritesLocked(root, items));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(pagePath("concepts", "one"))).toBe(true);
    expect(existsSync(pagePath("concepts", "two"))).toBe(true);
  });
});

describe("applyCompilePageWritesLocked — atomicity under fault injection", () => {
  it("leaves the journal pending on a mid-batch failure; replay reverts to pre-state", async () => {
    const t1 = pagePath("concepts", "one");
    await writeFile(t1, "OLD-1"); // pre-existing → must revert to prior bytes
    const t2 = pagePath("concepts", "two"); // absent pre-batch → must stay absent

    const faultyWriteOne = failingWriteOneOnNth(2);

    const items = [
      { namespace: "concepts" as const, slug: "one", body: GOOD_BODY },
      { namespace: "concepts" as const, slug: "two", body: GOOD_BODY },
    ];
    await underLock(async () => {
      await expect(
        applyCompilePageWritesLocked(root, items, { writeOne: faultyWriteOne }),
      ).rejects.toThrow(/injected write failure/);
      await replayJournal(root);
    });

    expect(await readFile(t1, "utf-8")).toBe("OLD-1");
    expect(existsSync(t2)).toBe(false);
  });
});

describe("applyCompilePageWritesLocked — empty no-op", () => {
  it("opens NO journal batch and returns empty skipped for empty items", async () => {
    const openSpy = vi.spyOn(journal, "openBatch");
    const { skipped } = await underLock(() => applyCompilePageWritesLocked(root, []));
    expect(skipped).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
    await expect(access(path.join(root, ".llmwiki", "journal"))).rejects.toThrow();
  });
});

/** A valid-frontmatter page body of exactly `chars` total length. */
function bodyOfLength(chars: number): string {
  const prefix = "---\ntitle: Merged\n---\n\n";
  return prefix + "x".repeat(chars - prefix.length);
}

describe("applyCompilePageWritesLocked — merged page above the single-source cap (the fix)", () => {
  it("WRITES a merged concept page BETWEEN MAX_SOURCE_CHARS and GENERATED_PAGE_MAX_CHARS", async () => {
    // A legitimately merged concept page (over the single-source cap, under the
    // generated-page guardrail) must NOT be silently dropped by compile.
    const merged = bodyOfLength(MAX_SOURCE_CHARS + 50_000);
    expect(merged.length).toBeGreaterThan(MAX_SOURCE_CHARS);
    expect(merged.length).toBeLessThan(GENERATED_PAGE_MAX_CHARS);
    const items = [{ namespace: "concepts" as const, slug: "popular", body: merged }];

    const { skipped } = await underLock(() => applyCompilePageWritesLocked(root, items));

    // Plan-time allowed it AND apply-time wrote it (plan/apply agree on the cap):
    expect(skipped).toEqual([]);
    expect(await readFile(pagePath("concepts", "popular"), "utf-8")).toBe(merged);
  });
});

describe("applyCompilePageWritesLocked — floor-blocked page is skipped, not aborting (H2)", () => {
  it("returns the oversized page in skipped while the valid page still writes", async () => {
    // NOTE: compile pages get the larger GENERATED_PAGE_MAX_CHARS guardrail (they
    // are merged across sources), so a page is only floor-skipped ABOVE that cap.
    const oversized = "x".repeat(GENERATED_PAGE_MAX_CHARS + 1);
    const items = [
      { namespace: "concepts" as const, slug: "good", body: GOOD_BODY },
      { namespace: "concepts" as const, slug: "huge", body: oversized },
    ];

    const { skipped } = await underLock(() => applyCompilePageWritesLocked(root, items));

    expect(skipped).toHaveLength(1);
    expect(skipped[0].item.slug).toBe("huge");
    expect(skipped[0].reason).toMatch(/^floor:/);
    // The valid page STILL wrote despite its sibling being blocked.
    expect(await readFile(pagePath("concepts", "good"), "utf-8")).toBe(GOOD_BODY);
    // The blocked page was never written.
    expect(existsSync(pagePath("concepts", "huge"))).toBe(false);
  });
});
