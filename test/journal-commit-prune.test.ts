/**
 * @file test/journal-commit-prune.test.ts
 * @description Pins the COMMIT-PRUNE contract for the intent journal
 * (`src/trust/journal.ts`). Committed batches need no recovery — replay already
 * skips them — and at five journalled batches per compile (× repeated
 * watch/refresh) leaving a `<batchId>.json` file per commit accumulates
 * unboundedly, each holding page pre-state copies. So `commitBatch` now DELETES
 * the journal file on commit rather than re-persisting `status:"committed"`.
 *
 * These tests pin: (a) after open→recordPreState→commit the journal file is
 * GONE; (b) N sequential open/commit cycles leave the journal dir empty; (c) a
 * subsequent `replayJournal` is a clean no-op (nothing to recover).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readdir } from "fs/promises";
import path from "path";
import { openBatch, recordPreState, commitBatch, replayJournal } from "../src/trust/journal.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import { journalDir, journalFile, pathExists } from "./trust/journal-fixture.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("journal-commit-prune-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

/** Names of `.json` journal files currently in the journal dir (empty if dir absent). */
async function journalFiles(): Promise<string[]> {
  try {
    return (await readdir(journalDir(root))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("commitBatch — prunes the journal file on commit", () => {
  it("deletes the journal file once the batch commits", async () => {
    const target = path.join(root, WIKI, "a.md");
    const batch = await openBatch(root);
    await recordPreState(batch, target);
    await writeFile(target, "A-new");

    const file = journalFile(root, batch.batchId);
    expect(await pathExists(file)).toBe(true);

    await commitBatch(batch);

    expect(await pathExists(file)).toBe(false);
  });

  it("leaves the journal dir empty after N sequential open/commit cycles", async () => {
    for (let i = 0; i < 5; i++) {
      const target = path.join(root, WIKI, `page-${i}.md`);
      const batch = await openBatch(root);
      await recordPreState(batch, target);
      await writeFile(target, `body-${i}`);
      await commitBatch(batch);
    }

    expect(await journalFiles()).toEqual([]);
  });

  it("makes a subsequent replayJournal a clean no-op", async () => {
    const target = path.join(root, WIKI, "b.md");
    await writeFile(target, "B-original");
    const batch = await openBatch(root);
    await recordPreState(batch, target);
    await writeFile(target, "B-new");
    await commitBatch(batch);

    await replayJournal(root);

    // Committed write survives — replay found nothing pending to revert.
    const fs = await import("fs/promises");
    expect(await fs.readFile(target, "utf-8")).toBe("B-new");
    expect(await journalFiles()).toEqual([]);
  });
});
