/**
 * @file test/trust-journal-confinement.test.ts
 * @description Fail-closed coverage for journal-replay path confinement.
 *
 * Before this guard, `replayJournal` parsed `.llmwiki/journal/*.json` with a
 * loose cast and acted on `entry.targetPath` verbatim — so a crafted or
 * corrupted journal whose `targetPath` escaped the project root (with
 * `preState.absent:true`) made replay DELETE a file OUTSIDE the project, and a
 * structurally malformed journal could drive arbitrary writes.
 *
 * Replay now (1) shape-validates each batch on load, (2) re-confines every
 * target under root via `confineUnderRoot`, and (3) QUARANTINES (moves to
 * `.llmwiki/journal/quarantine/`) and refuses to replay any journal that fails
 * either check. A fully-valid, fully-confined pending batch still reverts to
 * its pre-state, and replay stays idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir, access } from "fs/promises";
import path from "path";
import { replayJournal } from "../src/trust/journal.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot, existsUnder } from "./trust/fixture.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("trust-journal-confine-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

/** Absolute path to a journal file under the root's journal dir. */
function journalFile(batchId: string): string {
  return path.join(root, LLMWIKI_DIR, "journal", `${batchId}.json`);
}

/** Path the quarantine mechanism moves an untrusted journal to. */
function quarantineFile(batchId: string): string {
  return path.join(root, LLMWIKI_DIR, "journal", "quarantine", `${batchId}.json`);
}

/** Write a raw journal JSON string for `batchId` (creating the journal dir). */
async function writeJournal(batchId: string, raw: string): Promise<void> {
  await mkdir(path.dirname(journalFile(batchId)), { recursive: true });
  await writeFile(journalFile(batchId), raw, "utf-8");
}

/** True when a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert an untrusted journal was quarantined and never replayed: the named
 * `outside` file still holds `content`, the original journal file is gone, and a
 * quarantine copy exists.
 */
async function expectQuarantined(batchId: string, outside: string, content: string): Promise<void> {
  expect(await readFile(outside, "utf-8")).toBe(content);
  expect(await exists(journalFile(batchId))).toBe(false);
  expect(await exists(quarantineFile(batchId))).toBe(true);
}

describe("replayJournal — escaping target (crafted journal)", () => {
  it("(a) does NOT delete an outside file, quarantines the journal", async () => {
    const outside = path.join(root, "..", `escape-${path.basename(root)}.md`);
    await writeFile(outside, "PRECIOUS", "utf-8");
    const batchId = "evil";
    await writeJournal(
      batchId,
      JSON.stringify({
        batchId,
        status: "pending",
        entries: [{ targetPath: outside, preState: { absent: true } }],
      }),
    );

    await replayJournal(root);

    await expectQuarantined(batchId, outside, "PRECIOUS");
  });
});

describe("replayJournal — malformed journal (bad shape)", () => {
  it("(b) quarantines and does not replay; outside file untouched", async () => {
    const outside = path.join(root, "..", `keep-${path.basename(root)}.md`);
    await writeFile(outside, "KEEP", "utf-8");
    const batchId = "bad-shape";
    // `entries` is not an array of well-formed entries.
    await writeJournal(batchId, JSON.stringify({ batchId, status: "pending", entries: "nope" }));

    await replayJournal(root);

    await expectQuarantined(batchId, outside, "KEEP");
  });
});

describe("replayJournal — valid confined pending batch", () => {
  it("(c) still reverts confined targets to pre-state", async () => {
    const t1 = path.join(root, WIKI, "exists.md");
    const t2 = path.join(root, WIKI, "fresh.md");
    await writeFile(t1, "OLD-1", "utf-8");
    await writeFile(t1, "NEW-1", "utf-8"); // simulate the partial write before crash
    await writeFile(t2, "NEW-2", "utf-8");

    const batchId = "good";
    await writeJournal(
      batchId,
      JSON.stringify({
        batchId,
        status: "pending",
        entries: [
          { targetPath: t1, preState: { absent: false, content: "OLD-1" } },
          { targetPath: t2, preState: { absent: true } },
        ],
      }),
    );

    await replayJournal(root);

    expect(await readFile(t1, "utf-8")).toBe("OLD-1");
    expect(await existsUnder(root, `${WIKI}/fresh.md`)).toBe(false);
    expect(await exists(journalFile(batchId))).toBe(false);
    expect(await exists(quarantineFile(batchId))).toBe(false);
  });

  it("(d) is idempotent — a second replay is a no-op", async () => {
    const t1 = path.join(root, WIKI, "d.md");
    await writeFile(t1, "OLD-D", "utf-8");
    await writeFile(t1, "NEW-D", "utf-8");
    const batchId = "idem";
    await writeJournal(
      batchId,
      JSON.stringify({
        batchId,
        status: "pending",
        entries: [{ targetPath: t1, preState: { absent: false, content: "OLD-D" } }],
      }),
    );

    await replayJournal(root);
    expect(await readFile(t1, "utf-8")).toBe("OLD-D");
    await replayJournal(root);
    expect(await readFile(t1, "utf-8")).toBe("OLD-D");
  });
});
