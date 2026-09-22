/**
 * Selective compiler promotion: binary recovery must restore exact bytes, reject
 * ambiguous encodings, and retain the write-ahead guarantee after persistence
 * failure. These exercise real files and the existing journal replay surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as journal from "../src/trust/journal.js";
import { WIKI, makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";
import { journalFile, quarantineFile, writeJournal, pathExists } from "./trust/journal-fixture.js";

let root: string;
const BINARY = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xc3, 0x28]);
beforeEach(async () => { root = await makeTrustRoot("binary-port-"); });
afterEach(async () => { await cleanupTrustRoot(root); });

describe("binary-safe journal promotion", () => {
  it("replays a multi-megabyte binary prestate without exhausting the stack", async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0xff);
    const target = path.join(root, WIKI, "large-image.bin");
    await writeFile(target, bytes);
    const batch = await journal.openBatch(root, { maxAggregatePreStateBytes: bytes.length });
    await journal.recordBinaryPreState(batch, target, { maxPreStateBytes: bytes.length });
    await writeFile(target, "interrupted replacement");
    await journal.replayJournal(root);
    expect(await readFile(target)).toEqual(bytes);
  });

  it("restores arbitrary bytes after a crash, without UTF-8 conversion", async () => {
    const target = path.join(root, WIKI, "image.bin");
    await writeFile(target, BINARY);
    const batch = await journal.openBatch(root);
    await journal.recordBinaryPreState(batch, target);
    await writeFile(target, "partial write");
    await journal.replayJournal(root);
    expect(await readFile(target)).toEqual(BINARY);
  });

  it.each(["QUJD\nRA==", "AB==", "not base64!"])("quarantines ambiguous encoding %j without touching the target", async content => {
    const target = path.join(root, WIKI, "image.bin");
    await writeFile(target, BINARY);
    await writeJournal(root, "bad", JSON.stringify({ batchId: "bad", status: "pending",
      entries: [{ targetPath: target, preState: { absent: false, encoding: "base64", content } }] }));
    await journal.replayJournal(root);
    expect(await readFile(target)).toEqual(BINARY);
    expect(await pathExists(quarantineFile(root, "bad"))).toBe(true);
  });

  it("counts decoded bytes and refuses before appending an over-budget entry", async () => {
    const a = path.join(root, WIKI, "a.bin"), b = path.join(root, WIKI, "b.bin");
    await writeFile(a, BINARY);
    await writeFile(b, Buffer.from([1]));
    const batch = await journal.openBatch(root, { maxAggregatePreStateBytes: BINARY.length });
    await journal.recordBinaryPreState(batch, a);
    await expect(journal.recordBinaryPreState(batch, b)).rejects.toBeInstanceOf(journal.JournalAggregateBudgetExceededError);
    expect(batch.entries).toHaveLength(1);
    const saved = JSON.parse(await readFile(journalFile(root, batch.batchId), "utf8"));
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].preState).toEqual({ absent: false, encoding: "base64", content: "/9gAgMMo" });
  });

  it("does not deduplicate an entry whose persistence failed", async () => {
    const target = path.join(root, WIKI, "page.md");
    await writeFile(target, "original");
    const batch = await journal.openBatch(root);
    const dir = path.dirname(journalFile(root, batch.batchId));
    await chmod(dir, 0o555);
    try {
      await expect(journal.recordPreState(batch, target)).rejects.toThrow();
      expect(batch.entries).toHaveLength(0);
    } finally { await chmod(dir, 0o755); }
    await journal.recordPreState(batch, target);
    await writeFile(target, "changed");
    await journal.replayJournal(root);
    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("refuses a symlinked binary leaf and an over-cap target", async () => {
    const target = path.join(root, WIKI, "image.bin"), alias = path.join(root, WIKI, "alias.bin");
    await writeFile(target, BINARY);
    await symlink(target, alias);
    const batch = await journal.openBatch(root);
    await expect(journal.recordBinaryPreState(batch, alias)).rejects.toThrow(/unreadable/);
    await expect(journal.recordBinaryPreState(batch, target, { maxPreStateBytes: 1 })).rejects.toThrow(/unreadable/);
    expect(batch.entries).toHaveLength(0);
  });
});
