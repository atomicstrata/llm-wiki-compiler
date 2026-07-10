/**
 * @file test/fixtures/reroute-cli-helper.ts
 * @description Shared setup for the SUBPROCESS (real-CLI) compile-reroute
 * integration suite. Centralises the three things every scenario repeats so the
 * per-test bodies stay short and fallow sees no duplication:
 *
 *  1. {@link stubAlphaCompile} — the canned aimock responses (one "Alpha"
 *     concept + a fixed page body + a fixed embedding) that drive a real
 *     `llmwiki compile` subprocess with a MOCKED provider;
 *  2. {@link setupProject} — a temp workspace (`sources/`), realpath'd so a
 *     planted journal target's absolute path matches the realpath'd root the CLI
 *     sees (macOS `mkdtemp` returns a `/var → /private/var` symlink);
 *  3. {@link plantCrashedBatch} — write a `pending` journal whose recorded target
 *     is the real on-disk concept page with a captured pre-state DIFFERENT from
 *     the current (post-"crash") bytes, so the real CLI's recover/compile reverts
 *     it to the captured pre-state.
 *
 * The journal record shape mirrors {@link import("../../src/trust/journal.js").JournalBatch}
 * exactly so a planted batch is loadable + revertable by the real CLI binary.
 */

import { readFile, writeFile, readdir, realpath } from "fs/promises";
import path from "path";
import type { MockClaudeHandle } from "./aimock-helper.js";
import { writeJournal, journalDir, pathExists } from "../trust/journal-fixture.js";
import { CONCEPTS_DIR } from "../../src/utils/constants.js";

/** A fixed 8-dim embedding so the page/chunk embedding passes succeed deterministically. */
const STUB_EMBEDDING = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

/** The on-disk concept page the canned "Alpha" extraction compiles to. */
export const ALPHA_PAGE_REL = path.join(CONCEPTS_DIR, "alpha.md");

/**
 * Register the canned compile responses: one new "Alpha" concept, a fixed page
 * body, and a fixed embedding vector — enough to drive a real `llmwiki compile`
 * subprocess end-to-end with no live provider traffic.
 *
 * @param handle - aimock handle from `useAimockLifecycle().start()`.
 */
export function stubAlphaCompile(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            { concept: "Alpha", summary: "First concept.", is_new: true, tags: ["t"], confidence: 0.9 },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Body paragraph one.\n\nBody paragraph two." });
  handle.mock.onEmbedding(/.*/, { embedding: STUB_EMBEDDING });
}

/** A source body long enough to be ingested and to mention the Alpha concept repeatedly. */
export const ALPHA_SOURCE = "# Source\n\nAlpha is a concept. ".repeat(20);

/**
 * Realpath a workspace root so a planted journal target's absolute path matches
 * the realpath'd root the CLI canonicalises to (macOS `mkdtemp` → `/var →
 * /private/var` symlink). The existing journal/recover tests realpath the same way.
 *
 * @param rawCwd - The raw `mkdtemp`/`makeWorkspace` path.
 * @returns The canonical (realpath'd) project root.
 */
export async function setupProject(rawCwd: string): Promise<string> {
  return realpath(rawCwd);
}

/**
 * Plant a `pending` journal that simulates a half-applied crashed batch: the
 * Alpha page on disk is overwritten with post-crash bytes, while the journal
 * records the page's REAL pre-crash bytes as the entry pre-state. A real `recover`
 * or `compile` recovery must revert the page to those pre-state bytes.
 *
 * @param root - The realpath'd project root.
 * @returns The pre-crash bytes the page must be restored to.
 */
export async function plantCrashedBatch(root: string): Promise<string> {
  const page = path.join(root, ALPHA_PAGE_REL);
  const preCrashBytes = await readFile(page, "utf-8");
  await writeFile(page, "HALF-APPLIED POST-CRASH BYTES — must be reverted", "utf-8");
  await writeJournal(
    root,
    "crashed-batch",
    JSON.stringify({
      batchId: "crashed-batch",
      status: "pending",
      entries: [{ targetPath: page, preState: { absent: false, content: preCrashBytes } }],
    }),
  );
  return preCrashBytes;
}

/**
 * True when the journal directory exists but holds zero `.json` batch files —
 * the commit-prune / post-recovery steady state (the dir is created by a compile
 * but every committed batch is pruned, so it is present-but-empty, not absent).
 *
 * @param root - The realpath'd project root.
 */
export async function journalIsEmpty(root: string): Promise<boolean> {
  const dir = journalDir(root);
  if (!(await pathExists(dir))) return true; // absent ⇒ nothing pending
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return files.length === 0;
}
