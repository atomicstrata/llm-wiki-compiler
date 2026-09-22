/**
 * @file test/artifacts/artifact-members-journal.test.ts
 * @description W1 crash/rollback witnesses for member-bearing writes: a crash
 * BETWEEN the obsolete-leaf unlink and the commit replays to the pre-batch
 * bundle with the BINARY member restored byte-identically (the mutant is a
 * text-journal capture that corrupts non-UTF-8 bytes on revert); a COMMITTED
 * shrink survives replay unchanged; and an obsolete leaf larger than the
 * per-member journal cap refuses the WHOLE write before anything lands (the
 * budget/pre-state discipline: no unlink without a captured pre-state); and
 * the AGGREGATE budget binds through the production writer — enough planted
 * ≤cap alien leaves refuse the whole write (the mutant is the openBatch call
 * dropping its maxAggregatePreStateBytes argument, which would journal an
 * unbounded obsolete sweep and then unlink it all).
 */
import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { access, chmod, readFile, unlink, writeFile } from "fs/promises";
import { openBatch, recordBinaryPreState, replayJournal, JournalPreStateUnreadableError } from "../../src/trust/journal.js";
import {
  makeMembersRoot, writeBundle, resolveBundle, bundlePaths, twoMembers, membersBlock, BINARY_BYTES,
} from "../fixtures/member-artifact-root.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

describe("member journal crash discipline", () => {
  it("crash BETWEEN unlink and commit: replay restores the deleted BINARY member byte-identically (journal layer)", async () => {
    // The exact sequence apply-members runs for an obsolete leaf, stopped
    // before commitBatch — the pending batch is what a crash leaves behind.
    const root = await makeMembersRoot("members-crash");
    const ref = await writeBundle(root, twoMembers());
    const leaf = path.join(bundlePaths(root).expectedDir, "figure.bin");
    const batch = await openBatch(root, { maxAggregatePreStateBytes: 65536 });
    await recordBinaryPreState(batch, leaf, { maxPreStateBytes: 4096 });
    await unlink(leaf); // …crash here: no commit ever lands
    await replayJournal(root);
    expect((await readFile(leaf)).equals(BINARY_BYTES)).toBe(true);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it("the WRITER's own capture is binary-safe: a mid-batch failure through applyArtifactLocked restores exact bytes", async () => {
    // THROUGH the production write path (the journal-layer case above cannot
    // kill a writer that captures members as text): write A lands a binary
    // member; write B fails AFTER its pre-states, mid-write, by the slug dir
    // turning read-only; replay must restore A's member BYTE-IDENTICALLY.
    // The mutant: apply-members routing members through recordPreState —
    // the lossy UTF-8 round-trip restores corrupted bytes and this reddens.
    const root = await makeMembersRoot("members-writer-rollback");
    const ref = await writeBundle(root, twoMembers());
    const dir = bundlePaths(root).expectedDir;
    await chmod(dir, 0o555);
    try {
      await expect(writeBundle(root, [
        { fileName: "main.tex", bytes: Buffer.from("\\documentclass{article}", "utf8") },
        { fileName: "figure.bin", bytes: Buffer.from([0x01, 0x02]) },
      ])).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }
    await replayJournal(root);
    expect((await readFile(path.join(dir, "figure.bin"))).equals(BINARY_BYTES)).toBe(true);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it("a COMMITTED shrink survives replay: the obsolete leaf stays deleted and the new set verifies", async () => {
    const root = await makeMembersRoot("members-committed");
    await writeBundle(root, twoMembers());
    const ref = await writeBundle(root, [twoMembers()[0]!]);
    await replayJournal(root);
    await expect(access(path.join(bundlePaths(root).expectedDir, "figure.bin"))).rejects.toThrow();
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it("an obsolete leaf over the per-member cap REFUSES the whole write; replay leaves the store intact", async () => {
    const small = membersBlock({ maxMemberBytes: 64, maxTotalBytes: 256 });
    const root = await makeMembersRoot("members-obsolete-cap", small);
    await writeBundle(root, [{ fileName: "a.tex", bytes: Buffer.from("keep", "utf8") }]);
    const dir = bundlePaths(root).expectedDir;
    // A foreign oversized leaf the shrink would have to delete — but cannot
    // journal, so the write must refuse BEFORE any unlink or member write.
    await writeFile(path.join(dir, "huge.tex"), Buffer.alloc(1024, 0x61));
    await expect(writeBundle(root, [{ fileName: "b.tex", bytes: Buffer.from("new", "utf8") }]))
      .rejects.toThrow(JournalPreStateUnreadableError);
    await replayJournal(root);
    expect(await readFile(path.join(dir, "a.tex"), "utf8")).toBe("keep");
    expect((await readFile(path.join(dir, "huge.tex"))).length).toBe(1024);
    await expect(access(path.join(dir, "b.tex"))).rejects.toThrow();
  });

  it("the AGGREGATE budget binds: planted ≤cap alien leaves beyond it refuse the WHOLE write, mutating nothing", async () => {
    // 40 alien 4096-byte leaves = 163,840 decoded bytes of obsolete pre-states,
    // over the writer's budget (2*maxTotalBytes + 2*maxBytes = 147,456) while
    // each stays under the per-member cap — only the AGGREGATE ceiling can
    // refuse this. Refusal must land before any unlink or write: the aliens
    // survive and the original bundle still resolves ok.
    const root = await makeMembersRoot("members-agg-budget");
    const ref = await writeBundle(root, twoMembers());
    const dir = bundlePaths(root).expectedDir;
    const alien = (i: number) => path.join(dir, `alien-${String(i).padStart(2, "0")}.tex`);
    for (let i = 0; i < 40; i += 1) await writeFile(alien(i), Buffer.alloc(4096, i));
    await expect(writeBundle(root, twoMembers())).rejects.toThrow(/aggregate/i);
    // Nothing was unlinked or written: every alien survives (the sweep itself
    // reports them as tampering, which is the read side doing its job), and
    // removing them restores the ORIGINAL bundle to ok untouched.
    for (let i = 0; i < 40; i += 1) expect(await readFile(alien(i)).then((b) => b.length)).toBe(4096);
    for (let i = 0; i < 40; i += 1) await unlink(alien(i));
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });
});
