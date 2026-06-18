/**
 * @file test/trust-journal.test.ts
 * @description Coverage for the single-store INTENT JOURNAL
 * (`src/trust/journal.ts`) — the durability record that realizes the CLP
 * atomicity contract for the PAGE store: "partial application is a bug".
 *
 * A batch is journalled `pending` (recording every target's pre-state — prior
 * bytes or an `absent` marker) BEFORE any write lands, then marked `committed`
 * once all writes succeed. {@link replayJournal} is the crash-recovery seam: on
 * startup, any `pending`-but-not-`committed` batch is REVERTED to its recorded
 * pre-state (prior bytes restored, or absent files deleted) and resolved.
 *
 * These tests pin the three contracts against a real tmp-dir fixture:
 *  (a) a committed batch survives replay untouched (no-op);
 *  (b) a crash-simulated pending batch (journal written + file 1 of 2 applied,
 *      never committed) replays to the FULL pre-state — never a partial
 *      post-state;
 *  (c) replay is idempotent (a second call is a no-op).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import {
  openBatch,
  recordPreState,
  commitBatch,
  replayJournal,
  type JournalBatch,
} from "../src/trust/journal.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot, existsUnder, expectRevertedToPreState } from "./trust/fixture.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("trust-journal-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

const exists = (rel: string) => existsUnder(root, rel);

/** Open a 2-target batch, recording pre-state for each, without committing. */
async function openTwoTargetBatch(t1: string, t2: string): Promise<JournalBatch> {
  const batch = await openBatch(root);
  await recordPreState(batch, path.join(root, t1));
  await recordPreState(batch, path.join(root, t2));
  return batch;
}

/** Open a batch, record one target's pre-state, then write `bytes` to it (no commit). */
async function recordThenWrite(batch: JournalBatch, rel: string, bytes: string): Promise<void> {
  await recordPreState(batch, path.join(root, rel));
  await writeFile(path.join(root, rel), bytes);
}

describe("replayJournal — committed batch", () => {
  it("leaves files in place and is a no-op", async () => {
    const t1 = `${WIKI}/a.md`;
    const t2 = `${WIKI}/b.md`;
    const batch = await openTwoTargetBatch(t1, t2);
    await writeFile(path.join(root, t1), "A-new");
    await writeFile(path.join(root, t2), "B-new");
    await commitBatch(batch);

    await replayJournal(root);

    expect(await readFile(path.join(root, t1), "utf-8")).toBe("A-new");
    expect(await readFile(path.join(root, t2), "utf-8")).toBe("B-new");
  });
});

describe("replayJournal — pending (crashed) batch", () => {
  it("reverts to FULL pre-state, never a partial post-state", async () => {
    const t1 = `${WIKI}/exists.md`; // pre-existing → revert to prior bytes
    const t2 = `${WIKI}/fresh.md`; //  absent pre-batch → delete on revert
    await writeFile(path.join(root, t1), "OLD-1");

    const batch = await openTwoTargetBatch(t1, t2);
    // Crash simulation: apply ONLY file 1, never commit.
    await writeFile(path.join(root, t1), "NEW-1");

    await replayJournal(root);

    // file 1 reverted to its prior bytes; file 2 (absent pre-batch) stays absent.
    await expectRevertedToPreState(root, t1, "OLD-1", t2);
  });

  it("deletes a file that was absent pre-batch but got written before the crash", async () => {
    const t1 = `${WIKI}/c.md`;
    const batch = await openBatch(root);
    await recordThenWrite(batch, t1, "PARTIAL"); // written, never committed

    await replayJournal(root);

    expect(await exists(t1)).toBe(false);
  });
});

describe("recordPreState — duplicate target in one batch", () => {
  it("reverts an absent-pre-batch path to ABSENT despite two writes to it", async () => {
    const t1 = `${WIKI}/dup-target.md`; // absent pre-batch
    const batch = await openBatch(root);
    // First mutation records pre-state (absent), then writes.
    await recordThenWrite(batch, t1, "FIRST");
    // Second mutation to the SAME path: a naive impl would now snapshot "FIRST"
    // (a partial post-state). The dedup must keep the first (absent) observation.
    await recordThenWrite(batch, t1, "SECOND"); // crash before commit

    await replayJournal(root);

    // The true pre-batch state was ABSENT; revert must delete, not re-create.
    expect(await exists(t1)).toBe(false);
  });
});

describe("replayJournal — idempotence", () => {
  it("a second replay is a no-op", async () => {
    const t1 = `${WIKI}/d.md`;
    await writeFile(path.join(root, t1), "OLD-D");
    const batch = await openBatch(root);
    await recordPreState(batch, path.join(root, t1));
    await writeFile(path.join(root, t1), "NEW-D");

    await replayJournal(root);
    expect(await readFile(path.join(root, t1), "utf-8")).toBe("OLD-D");

    // Second call: nothing pending remains, on-disk state is unchanged.
    await replayJournal(root);
    expect(await readFile(path.join(root, t1), "utf-8")).toBe("OLD-D");
  });
});
