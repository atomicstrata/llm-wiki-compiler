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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, readFile, mkdir, symlink, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { replayJournal } from "../src/trust/journal.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot, existsUnder } from "./trust/fixture.js";
import {
  journalDir as journalDirOf,
  journalFile as journalFileOf,
  quarantineFile as quarantineFileOf,
  writeJournal as writeJournalTo,
  pathExists as exists,
  plantSymlinkedJournalDir,
  plantPendingTwoTargetBatch,
} from "./trust/journal-fixture.js";
import * as output from "../src/utils/output.js";

let root: string;

beforeEach(async () => {
  root = await makeTrustRoot("trust-journal-confine-");
});

afterEach(async () => {
  await cleanupTrustRoot(root);
});

/** Root-bound wrappers over the shared journal-fixture helpers. */
const journalDir = (): string => journalDirOf(root);
const journalFile = (batchId: string): string => journalFileOf(root, batchId);
const quarantineFile = (batchId: string): string => quarantineFileOf(root, batchId);
const writeJournal = (batchId: string, raw: string): Promise<void> =>
  writeJournalTo(root, batchId, raw);

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
    const batchId = "good";
    const { t1 } = await plantPendingTwoTargetBatch(root, WIKI, batchId);

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

describe("replayJournal — symlinked journal directories (filesystem tampering)", () => {
  let outsideDir: string;

  beforeEach(async () => {
    outsideDir = await mkdtemp(path.join(tmpdir(), "trust-journal-outside-"));
  });

  afterEach(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("(a) quarantine subdir is a symlink escaping root → outside file untouched, warns", async () => {
    const evilOutside = path.join(outsideDir, "evil.json");
    await writeFile(evilOutside, "OUTSIDE-PRECIOUS", "utf-8");
    await mkdir(journalDir(), { recursive: true });
    await symlink(outsideDir, path.join(journalDir(), "quarantine"), "dir");
    await writeFile(path.join(journalDir(), "evil.json"), "not json {{{", "utf-8");
    const noteSpy = vi.spyOn(output, "note").mockImplementation(() => undefined);

    await expect(replayJournal(root)).resolves.toBeUndefined();

    expect(await readFile(evilOutside, "utf-8")).toBe("OUTSIDE-PRECIOUS");
    expect(await exists(path.join(journalDir(), "evil.json"))).toBe(false);
    expect(noteSpy).toHaveBeenCalled();
    noteSpy.mockRestore();
  });

  it("(b) journal dir itself is a symlink escaping root → fails closed, touches nothing", async () => {
    const outsideJournalFile = await plantSymlinkedJournalDir(root, outsideDir);
    const noteSpy = vi.spyOn(output, "note").mockImplementation(() => undefined);

    await expect(replayJournal(root)).resolves.toBeUndefined();

    expect(await readFile(outsideJournalFile, "utf-8")).toBe("OUTSIDE-DATA");
    expect(await exists(outsideJournalFile)).toBe(true);
    noteSpy.mockRestore();
  });

  it("(c) regression: normal journal dir still quarantines malformed + reverts pending", async () => {
    await writeJournal("malformed", "not json at all");
    const t1 = path.join(root, WIKI, "reg.md");
    await writeFile(t1, "OLD-REG", "utf-8");
    await writeFile(t1, "NEW-REG", "utf-8");
    await writeJournal(
      "pending",
      JSON.stringify({
        batchId: "pending",
        status: "pending",
        entries: [{ targetPath: t1, preState: { absent: false, content: "OLD-REG" } }],
      }),
    );

    await replayJournal(root);

    expect(await exists(quarantineFile("malformed"))).toBe(true);
    expect(await readFile(t1, "utf-8")).toBe("OLD-REG");
  });
});
