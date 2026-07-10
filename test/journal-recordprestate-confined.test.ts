/**
 * @file test/journal-recordprestate-confined.test.ts
 * @description Fail-closed coverage for the HARDENED intent-journal pre-state
 * capture (`recordPreState`).
 *
 * Before this hardening `recordPreState` read a mutation target with a plain,
 * symlink-following, uncapped `readFile`. A live-TOCTOU attacker who swapped a
 * symlink IN at the target leaf between the confinement check and this read would
 * copy OUT-OF-ROOT bytes into the on-disk journal (an info-leak), and a planted
 * FIFO/huge file was a local DoS. The read now goes through the shared
 * `readCappedNoFollow` (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, fstat-regular, byte-cap):
 *
 *  - a symlinked leaf, a non-regular target (FIFO/dir), or one over the cap is
 *    `unavailable` → the whole mutation is REFUSED with a typed error, and the
 *    persisted journal never receives the target's (or a victim's) bytes;
 *  - a normal regular file is journaled as `content` and reverts byte-for-byte,
 *    including a large-but-under-cap page (the cap-regression guard);
 *  - a genuinely absent target stays `absent` (ENOENT only) and reverts as a delete.
 *
 * The `unavailable`→refuse (never coerced to `absent`) mapping is the crux: an
 * `absent` coercion would make a crash-revert DELETE a target that held content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir, symlink, rm, mkdtemp, open, rename } from "fs/promises";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import {
  openBatch,
  recordPreState,
  replayJournal,
  JournalPreStateUnreadableError,
} from "../src/trust/journal.js";
import { JOURNAL_PRESTATE_MAX_BYTES } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import { journalFile as journalFileOf, pathExists } from "./trust/journal-fixture.js";

let root: string;
let outsideDir: string;

beforeEach(async () => {
  root = await makeTrustRoot("journal-prestate-confined-");
  outsideDir = await mkdtemp(path.join(tmpdir(), "journal-prestate-outside-"));
});

afterEach(async () => {
  await cleanupTrustRoot(root);
  await rm(outsideDir, { recursive: true, force: true });
});

/** Read a batch's persisted journal file (throws if pruned). */
const readJournal = (batchId: string): Promise<string> => readFile(journalFileOf(root, batchId), "utf-8");

/**
 * Open a batch, assert `recordPreState(target)` REFUSES with the typed error, and
 * assert the persisted journal never received `secret` — the shared "refuse + no
 * out-of-root bytes leaked into the journal" contract every symlink-escape case
 * (leaf, parent) asserts identically.
 */
async function expectRefusedNoLeak(target: string, secret: string): Promise<void> {
  const batch = await openBatch(root);
  await expect(recordPreState(batch, target)).rejects.toThrow(JournalPreStateUnreadableError);
  expect(await readJournal(batch.batchId)).not.toContain(secret);
}

describe("recordPreState — leaf-symlink info-leak (live TOCTOU)", () => {
  it("refuses a symlinked leaf and never copies the victim's bytes into the journal", async () => {
    const secret = "TOP-SECRET-OUTSIDE-BYTES";
    await writeFile(path.join(outsideDir, "victim.md"), secret, "utf-8");
    const target = path.join(root, WIKI, "page.md");
    await symlink(path.join(outsideDir, "victim.md"), target); // leaf symlink → outside victim
    await expectRefusedNoLeak(target, secret);
  });
});

describe("recordPreState — parent-symlink info-leak (symlinked PARENT dir)", () => {
  it("refuses a leaf reached through a symlinked parent dir and never copies the outside bytes into the journal", async () => {
    const secret = "OUTSIDE_SECRET-parent-symlink";
    await writeFile(path.join(outsideDir, "secret.md"), secret, "utf-8");
    const concepts = path.join(root, WIKI);
    await rm(concepts, { recursive: true, force: true }); // drop the real wiki/concepts dir
    await symlink(outsideDir, concepts); // replace it with a symlink OUT of tree
    const target = path.join(concepts, "secret.md"); // in-tree path, out-of-tree bytes via the parent
    await expectRefusedNoLeak(target, secret);
  });
});

describe("recordPreState — swap-out/open/swap-back parent race ({dev,ino} binding)", () => {
  it("refuses when the parent is swapped back to the real dir after open, never leaking the outside bytes", async () => {
    const outsideBytes = "OUTSIDE-RACE-BYTES";
    await mkdir(path.join(outsideDir, "evil"), { recursive: true });
    await writeFile(path.join(outsideDir, "evil", "page.md"), outsideBytes, "utf-8");
    const concepts = path.join(root, WIKI);
    const realConcepts = `${concepts}.real`;
    await writeFile(path.join(concepts, "page.md"), "INSIDE-bytes", "utf-8"); // canonical in-root leaf
    await rename(concepts, realConcepts); // swap OUT the real dir
    await symlink(path.join(outsideDir, "evil"), concepts); // parent → symlink OUT of tree
    const target = path.join(concepts, "page.md");
    const swapBack = async () => {
      await rm(concepts); // fires AFTER open, BEFORE the {dev,ino} check
      await rename(realConcepts, concepts); // parent looks canonical again — only the inode binding catches it
    };
    const batch = await openBatch(root);

    await expect(recordPreState(batch, target, { afterOpenForTest: swapBack })).rejects.toThrow(JournalPreStateUnreadableError);
    expect(await readJournal(batch.batchId)).not.toContain(outsideBytes);
  });
});

describe("recordPreState — non-regular targets", () => {
  it("refuses a directory target (non-regular)", async () => {
    const target = path.join(root, WIKI, "as-dir");
    await mkdir(target, { recursive: true });
    const batch = await openBatch(root);

    await expect(recordPreState(batch, target)).rejects.toThrow(JournalPreStateUnreadableError);
  });

  it("refuses a FIFO target without blocking (O_NONBLOCK)", async () => {
    const target = path.join(root, WIKI, "as-fifo");
    execFileSync("mkfifo", [target]); // a plain readFile would BLOCK here forever (DoS)
    const batch = await openBatch(root);

    await expect(recordPreState(batch, target)).rejects.toThrow(JournalPreStateUnreadableError);
  });
});

describe("recordPreState — legitimate targets are captured", () => {
  it("journals an existing regular file as content that reverts byte-for-byte", async () => {
    const target = path.join(root, WIKI, "page.md");
    await writeFile(target, "OLD", "utf-8");
    const batch = await openBatch(root);

    await recordPreState(batch, target);
    await writeFile(target, "NEW", "utf-8"); // crash simulation: written, never committed
    await replayJournal(root);

    expect(await readFile(target, "utf-8")).toBe("OLD");
  });

  it("journals an absent target as absent, reverting as a delete", async () => {
    const target = path.join(root, WIKI, "fresh.md");
    const batch = await openBatch(root);

    await recordPreState(batch, target); // ENOENT → absent
    await writeFile(target, "WRITTEN", "utf-8"); // crash simulation
    await replayJournal(root);

    expect(await pathExists(target)).toBe(false);
  });
});

describe("recordPreState — large-but-under-cap page (cap-regression guard)", () => {
  it("captures a legit page near the cap and reverts it byte-for-byte", async () => {
    const big = "a".repeat(JOURNAL_PRESTATE_MAX_BYTES - 1024 * 1024); // 15 MiB — under 16 MiB
    const target = path.join(root, WIKI, "big.md");
    await writeFile(target, big, "utf-8");
    const batch = await openBatch(root);

    await recordPreState(batch, target);
    await writeFile(target, "SMALL", "utf-8"); // crash simulation
    await replayJournal(root);

    expect(await readFile(target, "utf-8")).toBe(big);
  });
});

describe("recordPreState — direct over-cap refusal (16 MiB cap)", () => {
  it("refuses a regular target JUST over the cap, without persisting an entry for it", async () => {
    const target = path.join(root, WIKI, "huge.md");
    const handle = await open(target, "w"); // sparse-truncate, not a char-by-char slurp
    await handle.truncate(JOURNAL_PRESTATE_MAX_BYTES + 1);
    await handle.close();
    const batch = await openBatch(root);

    await expect(recordPreState(batch, target)).rejects.toThrow(JournalPreStateUnreadableError);
    const persisted = JSON.parse(await readJournal(batch.batchId));
    expect(persisted.entries).toHaveLength(0); // refused BEFORE any entry (or its bytes) was recorded
  });
});

describe("recordPreState — mid-batch partial refusal self-heals (P5.4)", () => {
  it("leaves no stuck pending batch and no data loss when the SECOND target refuses", async () => {
    const t1 = path.join(root, WIKI, "first.md");
    await writeFile(t1, "T1-OLD", "utf-8");
    await writeFile(path.join(outsideDir, "v.md"), "V", "utf-8");
    const t2 = path.join(root, WIKI, "second.md");
    await symlink(path.join(outsideDir, "v.md"), t2); // second target unreadable → refuse
    const batch = await openBatch(root);

    await recordPreState(batch, t1); // first target captured (content)
    await expect(recordPreState(batch, t2)).rejects.toThrow(JournalPreStateUnreadableError);
    await replayJournal(root); // crash-recovery on the pending, one-entry batch

    expect(await readFile(t1, "utf-8")).toBe("T1-OLD"); // no data loss (no write landed)
    expect(await pathExists(journalFileOf(root, batch.batchId))).toBe(false); // pruned — no stuck state
  });
});
