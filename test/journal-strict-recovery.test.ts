/**
 * @file test/journal-strict-recovery.test.ts
 * @description Coverage for the STRICT, FAIL-CLOSED pre-compile recovery entry
 * point `recoverJournalBeforeCompile` (`src/trust/journal-recovery.ts`).
 *
 * Unlike the best-effort `replayJournal` (which QUARANTINES-and-continues on a
 * malformed or target-escaping batch), the pre-compile gate must surface any
 * non-revertable condition as `unsafe` so compile refuses to start over a journal
 * it cannot cleanly recover. It returns:
 *  - `clean`    — journal dir absent, or nothing pending (legacy committed files pruned);
 *  - `replayed` — at least one pending batch was FULLY reverted and its file deleted;
 *  - `unsafe`   — the journal dir symlink-escapes root, OR a pending file is
 *                 malformed/unreadable, OR a recorded target escapes root.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { recoverJournalBeforeCompile, JournalUnsafeError } from "../src/trust/journal-recovery.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot, existsUnder } from "./trust/fixture.js";
import {
  journalFile,
  writeJournal,
  pathExists,
  plantSymlinkedJournalDir,
  plantPendingTwoTargetBatch,
  plantPendingEscapingTargetBatch,
} from "./trust/journal-fixture.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("journal-strict-recovery-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

describe("recoverJournalBeforeCompile — clean", () => {
  it("returns clean when the journal directory is absent", async () => {
    const result = await recoverJournalBeforeCompile(root);
    expect(result.status).toBe("clean");
  });

  it("prunes a legacy committed file and returns clean", async () => {
    const t1 = path.join(root, WIKI, "c.md");
    await writeJournal(
      root,
      "legacy",
      JSON.stringify({
        batchId: "legacy",
        status: "committed",
        entries: [{ targetPath: t1, preState: { absent: false, content: "X" } }],
      }),
    );

    const result = await recoverJournalBeforeCompile(root);

    expect(result.status).toBe("clean");
    expect(await pathExists(journalFile(root, "legacy"))).toBe(false);
  });
});

describe("recoverJournalBeforeCompile — replayed", () => {
  it("fully reverts a pending batch and deletes its file", async () => {
    const { t1 } = await plantPendingTwoTargetBatch(root, WIKI, "pending");

    const result = await recoverJournalBeforeCompile(root);

    expect(result.status).toBe("replayed");
    expect(await readFile(t1, "utf-8")).toBe("OLD-1");
    expect(await existsUnder(root, `${WIKI}/fresh.md`)).toBe(false);
    expect(await pathExists(journalFile(root, "pending"))).toBe(false);
  });
});

describe("recoverJournalBeforeCompile — unsafe (fail closed, no quarantine-and-continue)", () => {
  it("(b) returns unsafe for a malformed pending journal file", async () => {
    await writeJournal(root, "bad", "not json at all {{{");

    const result = await recoverJournalBeforeCompile(root);

    expect(result.status).toBe("unsafe");
  });

  it("(c) returns unsafe when a recorded target escapes root", async () => {
    const outside = await plantPendingEscapingTargetBatch(root, "evil");

    const result = await recoverJournalBeforeCompile(root);

    expect(result.status).toBe("unsafe");
    // The escaping target was NOT deleted.
    expect(await readFile(outside, "utf-8")).toBe("PRECIOUS");
    await rm(outside, { force: true });
  });
});

describe("JournalUnsafeError — typed fail-closed signal", () => {
  it("is an Error subclass carrying the named reason", () => {
    const err = new JournalUnsafeError("malformed journal x.json");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JournalUnsafeError");
    expect(err.message).toContain("malformed journal x.json");
  });
});

describe("recoverJournalBeforeCompile — unsafe (symlink-escaping journal dir)", () => {
  let outsideDir: string;

  beforeEach(async () => {
    outsideDir = await mkdtemp(path.join(tmpdir(), "journal-strict-outside-"));
  });

  afterEach(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("(a) returns unsafe when the journal dir symlink-escapes root", async () => {
    const outsideJournalFile = await plantSymlinkedJournalDir(root, outsideDir);

    const result = await recoverJournalBeforeCompile(root);

    expect(result.status).toBe("unsafe");
    // Touched nothing outside the project.
    expect(await readFile(outsideJournalFile, "utf-8")).toBe("OUTSIDE-DATA");
  });
});
