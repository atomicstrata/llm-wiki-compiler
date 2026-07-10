/**
 * @file test/trust/journal-fixture.ts
 * @description Shared journal-file helpers for the journal recovery/confinement
 * test suites. Both the best-effort `replayJournal` confinement tests and the
 * strict `recoverJournalBeforeCompile` tests plant raw journal JSON, probe the
 * journal/quarantine paths, and check on-disk existence the same way; this module
 * is the single definition of those helpers so the setup is not duplicated.
 */

import { writeFile, mkdir, access, symlink } from "fs/promises";
import path from "path";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";

/** Absolute path to the project's journal directory. */
export function journalDir(root: string): string {
  return path.join(root, LLMWIKI_DIR, "journal");
}

/** Absolute path to a journal file under the root's journal dir. */
export function journalFile(root: string, batchId: string): string {
  return path.join(journalDir(root), `${batchId}.json`);
}

/** Path the quarantine mechanism moves an untrusted journal to. */
export function quarantineFile(root: string, batchId: string): string {
  return path.join(journalDir(root), "quarantine", `${batchId}.json`);
}

/** Write a raw journal JSON string for `batchId` (creating the journal dir). */
export async function writeJournal(root: string, batchId: string, raw: string): Promise<void> {
  await mkdir(journalDir(root), { recursive: true });
  await writeFile(journalFile(root, batchId), raw, "utf-8");
}

/** True when a path exists on disk. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plant a partially-applied 2-target PENDING batch: a pre-existing target whose
 * bytes were overwritten before the (simulated) crash, and an absent-pre-batch
 * target that got created. The journal records both pre-states. Returns the two
 * absolute target paths so the caller can assert the full pre-state was restored.
 */
export async function plantPendingTwoTargetBatch(
  root: string,
  wikiSubdir: string,
  batchId: string,
): Promise<{ t1: string; t2: string }> {
  const t1 = path.join(root, wikiSubdir, "exists.md");
  const t2 = path.join(root, wikiSubdir, "fresh.md");
  await writeFile(t1, "OLD-1", "utf-8");
  await writeFile(t1, "NEW-1", "utf-8"); // partial write before crash
  await writeFile(t2, "NEW-2", "utf-8");
  await writeJournal(
    root,
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
  return { t1, t2 };
}

/**
 * Plant a PENDING batch whose single recorded target escapes `root` (a tampered
 * journal naming an out-of-tree victim), with the victim pre-populated so callers
 * can assert it was left untouched. Returns the victim's absolute path. The caller
 * is responsible for removing the out-of-tree victim afterward.
 */
export async function plantPendingEscapingTargetBatch(
  root: string,
  batchId: string,
): Promise<string> {
  const outside = path.join(root, "..", `escape-${path.basename(root)}.md`);
  await writeFile(outside, "PRECIOUS", "utf-8");
  await writeJournal(
    root,
    batchId,
    JSON.stringify({
      batchId,
      status: "pending",
      entries: [{ targetPath: outside, preState: { absent: true } }],
    }),
  );
  return outside;
}

/**
 * Plant a tampering scenario where the project's journal directory is a symlink
 * escaping `root` into `outsideDir`, with a victim file inside `outsideDir`.
 * Returns the victim's absolute path so the caller can assert it was untouched.
 */
export async function plantSymlinkedJournalDir(root: string, outsideDir: string): Promise<string> {
  const outsideVictim = path.join(outsideDir, "victim.json");
  await writeFile(outsideVictim, "OUTSIDE-DATA", "utf-8");
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await symlink(outsideDir, journalDir(root), "dir");
  return outsideVictim;
}
