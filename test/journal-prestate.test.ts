/**
 * @file test/journal-prestate.test.ts
 * @description P4.1a witnesses for the intent journal's BINARY/AGGREGATE
 * pre-state contract (`src/trust/journal.ts` + `src/trust/journal-prestate.ts`).
 *
 * Decisive assertions and the mutant each one catches:
 *  - binary rollback byte-identity — a capture routed through the UTF-8 text
 *    reader corrupts the invalid-UTF-8 bytes and restores corrupt content;
 *  - base64-ALWAYS recording — a content-sniffing capture that stores
 *    "looks like text" binary as utf8 flips the persisted `encoding`;
 *  - legacy replay regression — a parser demanding the new discriminant
 *    refuses the exact legacy `{absent:false, content}` shape;
 *  - strict canonical base64 — a permissive `Buffer.from(content, "base64")`
 *    happily decodes whitespace/non-canonical input and replays it;
 *  - DECODED-byte accounting — accounting over the persisted envelope refuses
 *    a budget-exactly-fitting binary capture (~4/3× inflation);
 *  - aggregate refusal BEFORE persist — an admit-after-append leaves an
 *    over-budget entry journaled.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  openBatch, recordPreState, recordBinaryPreState, replayJournal,
  JournalAggregateBudgetExceededError, JournalPreStateUnreadableError,
  type JournalBatch,
} from "../src/trust/journal.js";
import { isCanonicalBase64 } from "../src/trust/journal-prestate.js";
import { JOURNAL_PRESTATE_MAX_BYTES } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import { journalFile, quarantineFile, writeJournal, pathExists } from "./trust/journal-fixture.js";

let root: string;
beforeEach(async () => {
  root = await makeTrustRoot("journal-prestate-");
});
afterEach(async () => {
  await cleanupTrustRoot(root);
});

/** PDF-ish bytes that do NOT survive a UTF-8 string round trip. */
const BINARY = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xff, 0xd8, 0x00, 0x80, 0xc3, 0x28, 0xa0, 0xa1]);
/** Historical suggested ceiling, used only to probe opt-in budget semantics. */
const TEST_AGGREGATE_CEILING = 256 * 1024 * 1024;

/** Seed a binary target, record its pre-state, and overwrite it (crash-shaped). */
async function seedBinaryCrash(): Promise<{ target: string; batch: JournalBatch }> {
  const target = path.join(root, WIKI, "asset.bin");
  await writeFile(target, BINARY);
  const batch = await openBatch(root);
  await recordBinaryPreState(batch, target);
  await writeFile(target, Buffer.from([0x00, 0x01, 0x02])); // partial write, then crash
  return { target, batch };
}

describe("binary pre-state capture and rollback", () => {
  it("restores a crashed-over binary target byte-identically", async () => {
    const { target } = await seedBinaryCrash();
    await replayJournal(root);
    expect(Buffer.compare(await readFile(target), BINARY)).toBe(0);
  });

  it("records the pre-state as canonical base64, always", async () => {
    const { batch } = await seedBinaryCrash();
    const persisted = JSON.parse(await readFile(journalFile(root, batch.batchId), "utf-8")) as {
      entries: Array<{ preState: { encoding?: string; content: string } }>;
    };
    expect(persisted.entries).toHaveLength(1);
    const preState = persisted.entries[0].preState;
    expect(preState.encoding).toBe("base64");
    expect(isCanonicalBase64(preState.content)).toBe(true);
    expect(Buffer.compare(Buffer.from(preState.content, "base64"), BINARY)).toBe(0);
  });

  it("records base64 even for bytes that LOOK like text (no content sniffing)", async () => {
    // A sniffing implementation would classify pure-ASCII bytes as utf8 and
    // persist them as a string; base64-ALWAYS means the binary API never does.
    const target = path.join(root, WIKI, "looks-like-text.bin");
    await writeFile(target, Buffer.from("plain ascii bytes\n", "utf-8"));
    const batch = await openBatch(root);
    await recordBinaryPreState(batch, target);
    const persisted = JSON.parse(await readFile(journalFile(root, batch.batchId), "utf-8")) as {
      entries: Array<{ preState: { encoding?: string } }>;
    };
    expect(persisted.entries[0].preState.encoding).toBe("base64");
  });

  it("records the absent marker for a missing binary target; revert deletes it", async () => {
    const target = path.join(root, WIKI, "fresh.bin");
    const batch = await openBatch(root);
    await recordBinaryPreState(batch, target);
    await writeFile(target, BINARY); // the batch's write lands, then crash
    await replayJournal(root);
    expect(await pathExists(target)).toBe(false);
    expect(batch.entries[0].preState).toEqual({ absent: true });
  });

  it("refuses an over-cap binary target as unreadable (per-target cap)", async () => {
    const target = path.join(root, WIKI, "big.bin");
    await writeFile(target, BINARY);
    const batch = await openBatch(root);
    await expect(recordBinaryPreState(batch, target, { maxPreStateBytes: 4 }))
      .rejects.toBeInstanceOf(JournalPreStateUnreadableError);
  });
});

describe("legacy journal compatibility", () => {
  it("replays the exact legacy {absent:false, content} shape byte-identically", async () => {
    const kept = path.join(root, WIKI, "kept.md");
    const created = path.join(root, WIKI, "created.md");
    await writeFile(kept, "overwritten", "utf-8");
    await writeFile(created, "should vanish", "utf-8");
    await writeJournal(root, "legacy-1", JSON.stringify({
      batchId: "legacy-1", status: "pending",
      entries: [
        { targetPath: kept, preState: { absent: false, content: "café ✓\n" } },
        { targetPath: created, preState: { absent: true } },
      ],
    }));
    await replayJournal(root);
    expect(await readFile(kept, "utf-8")).toBe("café ✓\n");
    expect(await pathExists(created)).toBe(false);
  });
});

/** Plant a pending base64 journal for `content` and return the seeded target. */
async function plantBase64Journal(batchId: string, content: string): Promise<string> {
  const target = path.join(root, WIKI, `${batchId}.bin`);
  await writeFile(target, "CURRENT", "utf-8");
  await writeJournal(root, batchId, JSON.stringify({
    batchId, status: "pending",
    entries: [{ targetPath: target, preState: { absent: false, content, encoding: "base64" } }],
  }));
  return target;
}

describe("strict canonical-base64 replay parsing", () => {
  it("quarantines a base64 pre-state carrying whitespace, touching nothing", async () => {
    const target = await plantBase64Journal("ws-1", "QUJD\nRA==");
    await replayJournal(root);
    expect(await readFile(target, "utf-8")).toBe("CURRENT");
    expect(await pathExists(quarantineFile(root, "ws-1"))).toBe(true);
  });

  it("quarantines non-canonical base64 (trailing-bit smuggle), touching nothing", async () => {
    // "AB==" decodes but re-encodes as "AA==" — a permissive decode would
    // silently replay bytes the journal never canonically recorded.
    const target = await plantBase64Journal("nc-1", "AB==");
    await replayJournal(root);
    expect(await readFile(target, "utf-8")).toBe("CURRENT");
    expect(await pathExists(quarantineFile(root, "nc-1"))).toBe(true);
  });

  it("replays a well-formed canonical base64 entry to its exact bytes", async () => {
    const target = await plantBase64Journal("ok-1", BINARY.toString("base64"));
    await replayJournal(root);
    expect(Buffer.compare(await readFile(target), BINARY)).toBe(0);
  });
});

describe("the aggregate pre-state budget", () => {
  it("refuses the capture that would exceed the budget, BEFORE persisting it", async () => {
    const a = path.join(root, WIKI, "a.md");
    const b = path.join(root, WIKI, "b.md");
    await writeFile(a, "123456", "utf-8");
    await writeFile(b, "123456", "utf-8");
    const batch = await openBatch(root, { maxAggregatePreStateBytes: 10 });
    await recordPreState(batch, a);
    await expect(recordPreState(batch, b)).rejects.toBeInstanceOf(JournalAggregateBudgetExceededError);
    const persisted = JSON.parse(await readFile(journalFile(root, batch.batchId), "utf-8")) as {
      entries: unknown[];
    };
    expect(persisted.entries).toHaveLength(1);
    // The refusal left the IN-MEMORY batch untouched too — a mutant that pushed
    // before admitting would corrupt it, and a retry would then exit through
    // the dedupe as a false success. The retry must refuse AGAIN.
    expect(batch.entries).toHaveLength(1);
    expect(batch.aggregatePreStateBytes).toBe(6);
    await expect(recordPreState(batch, b)).rejects.toBeInstanceOf(JournalAggregateBudgetExceededError);
  });

  it("withdraws an admitted entry when persisting it fails, so a retry re-records", async () => {
    const a = path.join(root, WIKI, "first.md");
    const b = path.join(root, WIKI, "second.md");
    await writeFile(a, "aaaa", "utf-8");
    await writeFile(b, "bbbb", "utf-8");
    const batch = await openBatch(root);
    await recordPreState(batch, a);
    const journalDir = path.dirname(journalFile(root, batch.batchId));
    await chmod(journalDir, 0o555); // persist cannot create its temp file
    try {
      await expect(recordPreState(batch, b)).rejects.toThrow();
      // Write-ahead safety: the failed entry is NOT left in memory, else a retry
      // would dedupe into a false success while the durable journal lacks it.
      expect(batch.entries).toHaveLength(1);
      expect(batch.aggregatePreStateBytes).toBe(4);
    } finally {
      await chmod(journalDir, 0o755);
    }
    await recordPreState(batch, b); // the retry genuinely re-records
    const persisted = JSON.parse(await readFile(journalFile(root, batch.batchId), "utf-8")) as {
      entries: unknown[];
    };
    expect(persisted.entries).toHaveLength(2);
  });

  it("accounts DECODED bytes, not the base64 envelope", async () => {
    const target = path.join(root, WIKI, "exact.bin");
    await writeFile(target, Buffer.alloc(300, 0xff)); // envelope is 400 base64 chars
    const fits = await openBatch(root, { maxAggregatePreStateBytes: 300 });
    await recordBinaryPreState(fits, target);
    expect(fits.aggregatePreStateBytes).toBe(300);
    const tight = await openBatch(root, { maxAggregatePreStateBytes: 299 });
    await expect(recordBinaryPreState(tight, target))
      .rejects.toBeInstanceOf(JournalAggregateBudgetExceededError);
  });

  it("is OPT-IN: an unbudgeted batch never refuses, a budgeted one does", async () => {
    // Existing callers (the compile executor journals an UNBOUNDED number of
    // page pre-states per batch) must keep their pre-existing unbudgeted
    // behaviour; only a caller that passes a budget can be refused.
    const a = path.join(root, WIKI, "opt-a.md");
    const b = path.join(root, WIKI, "opt-b.md");
    await writeFile(a, "123456", "utf-8");
    await writeFile(b, "123456", "utf-8");
    const unbudgeted = await openBatch(root);
    expect(unbudgeted.aggregatePreStateBudget).toBeUndefined();
    // Prime the counter AT the historical suggested ceiling: a default
    // aggregate ceiling would refuse the next
    // record; genuine opt-in admits it without allocating 256 MiB.
    unbudgeted.aggregatePreStateBytes = TEST_AGGREGATE_CEILING;
    await recordPreState(unbudgeted, a);
    await recordPreState(unbudgeted, b);
    expect(unbudgeted.entries).toHaveLength(2);
    expect(unbudgeted.aggregatePreStateBytes).toBe(TEST_AGGREGATE_CEILING + 12);
    const budgeted = await openBatch(root, { maxAggregatePreStateBytes: 10 });
    await recordPreState(budgeted, a);
    await expect(recordPreState(budgeted, b)).rejects.toBeInstanceOf(JournalAggregateBudgetExceededError);
    // This probe exceeds multiple per-target caps without allocating their payloads.
    expect(TEST_AGGREGATE_CEILING).toBeGreaterThanOrEqual(2 * JOURNAL_PRESTATE_MAX_BYTES);
  });
});
