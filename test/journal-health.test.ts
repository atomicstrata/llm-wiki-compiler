/**
 * @file test/journal-health.test.ts
 * @description Coverage for the READ-ONLY journal health detector
 * `journalHealth` (`src/trust/journal-health.ts`). It SURFACES the same
 * tamper/incomplete-compile state that the strict, MUTATING
 * `recoverJournalBeforeCompile` gate classifies — sharing one classifier — but
 * NEVER writes, replays, prunes, locks, or creates `.llmwiki`. It maps:
 *  - `ok`          — journal dir absent, or only legacy committed files / nothing pending;
 *  - `pending`     — at least one cleanly-loadable `status:"pending"` batch;
 *  - `unavailable` — the journal/private dir symlink-escapes root, OR a pending
 *                    file is malformed/unreadable, OR a recorded target escapes root.
 *
 * A tamper/corruption is NEVER reported as `ok`/`pending`. Every test asserts the
 * call mutated nothing on disk (no mkdir/prune/replay).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdtemp, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { journalHealth } from "../src/trust/journal-health.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import {
  journalDir,
  journalFile,
  writeJournal,
  pathExists,
  plantSymlinkedJournalDir,
  plantPendingTwoTargetBatch,
  plantPendingEscapingTargetBatch,
} from "./trust/journal-fixture.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("journal-health-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

/** Snapshot the sorted `.json` names in the journal dir (empty list if absent). */
async function journalSnapshot(): Promise<string[]> {
  try {
    return (await readdir(journalDir(root))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

describe("journalHealth — ok", () => {
  it("returns ok for a clean project and does NOT create .llmwiki", async () => {
    const result = await journalHealth(root);

    expect(result.status).toBe("ok");
    expect(await pathExists(path.join(root, LLMWIKI_DIR))).toBe(false);
  });

  it("returns ok when a clean compile left zero journal files", async () => {
    const result = await journalHealth(root);

    expect(result.status).toBe("ok");
    expect(await journalSnapshot()).toEqual([]);
  });

  it("returns ok for a legacy committed-only file WITHOUT deleting it", async () => {
    await writeJournal(
      root,
      "legacy",
      JSON.stringify({
        batchId: "legacy",
        status: "committed",
        entries: [{ targetPath: path.join(root, WIKI, "c.md"), preState: { absent: true } }],
      }),
    );

    const result = await journalHealth(root);

    expect(result.status).toBe("ok");
    expect(await pathExists(journalFile(root, "legacy"))).toBe(true);
  });
});

describe("journalHealth — pending", () => {
  it("returns pending for a cleanly-loadable status:pending batch", async () => {
    await plantPendingTwoTargetBatch(root, WIKI, "pending");
    const before = await journalSnapshot();
    const bytesBefore = await readFile(journalFile(root, "pending"), "utf-8");

    const result = await journalHealth(root);

    expect(result.status).toBe("pending");
    // Read-only: the pending journal file is byte-unchanged (no replay/prune).
    expect(await journalSnapshot()).toEqual(before);
    expect(await pathExists(journalFile(root, "pending"))).toBe(true);
    expect(await readFile(journalFile(root, "pending"), "utf-8")).toBe(bytesBefore);
  });
});

describe("journalHealth — unavailable (tamper/corruption, never ok/pending)", () => {
  it("returns unavailable for a malformed pending journal", async () => {
    await writeJournal(root, "bad", "not json at all {{{");

    const result = await journalHealth(root);

    expect(result.status).toBe("unavailable");
    expect(await pathExists(journalFile(root, "bad"))).toBe(true);
  });

  it("returns unavailable when a pending batch target escapes root", async () => {
    const outside = await plantPendingEscapingTargetBatch(root, "evil");

    const result = await journalHealth(root);

    expect(result.status).toBe("unavailable");
    expect(await readFile(outside, "utf-8")).toBe("PRECIOUS");
    await rm(outside, { force: true });
  });
});

describe("journalHealth — unavailable (symlink-escaping journal dir)", () => {
  let outsideDir: string;

  beforeEach(async () => {
    outsideDir = await mkdtemp(path.join(tmpdir(), "journal-health-outside-"));
  });

  afterEach(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("returns unavailable and touches nothing outside the project", async () => {
    const outsideVictim = await plantSymlinkedJournalDir(root, outsideDir);

    const result = await journalHealth(root);

    expect(result.status).toBe("unavailable");
    expect(await readFile(outsideVictim, "utf-8")).toBe("OUTSIDE-DATA");
  });
});
