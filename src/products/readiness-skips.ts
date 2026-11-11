/**
 * @file src/products/readiness-skips.ts
 * @description The durable record of optional capabilities an operator has
 * explicitly declined (AS-1 §4.1: the readiness review "records explicit
 * skips").
 *
 * A SKIP IS RECORDED, NOT HIDDEN. The point of writing it down is that the next
 * review still LISTS the capability and says a person decided against it —
 * which is different from "not configured" (nobody has decided) and different
 * again from omitting it (nobody can tell it exists). A skip that removed the
 * row would make the review quieter and less true, and an operator returning in
 * six months could not tell a deliberate decision from an oversight.
 *
 * IT IS PROJECT STATE, NOT OPERATOR STATE. Whether this project wants a
 * capability is a property of the project — a second checkout of the same wiki
 * should inherit the decision, and a different project on the same machine
 * should not.
 *
 * UNREADABLE IS NOT EMPTY. A corrupt or unreadable file yields `null`, so the
 * review can say it could not determine the skips rather than silently claiming
 * none were recorded and re-listing capabilities the operator already declined.
 *
 * ONE BODY PER OPERATION, OVER THE RECORD'S OWN LEAF. `readRecordedSkipsFrom` and
 * `recordSkipFrom` decide absence, the length cap, parsing and the sorted JSON
 * over {@link ReadinessSkipLeaves}; the root forms keep their signatures and pass
 * {@link diskReadinessSkipLeaves}, which does the incumbent read and the
 * mkdir, `.tmp` write and rename when asked. Nothing selects a backend.
 */

import { rename } from "node:fs/promises";
import path from "node:path";

/** Where the decision lives, beside the project's other private state. */
const SKIPS_FILE = path.join(".llmwiki", "product-readiness-skips.json");

/** Bound the file so a malformed giant never has to be parsed. */
const MAX_SKIPS_BYTES = 64 * 1024;

/** The recorded set, or `null` when the record could not be read. */
export type RecordedSkipsV1 = ReadonlySet<string> | null;

/** What the skip record asks of the project. No member takes a project root. */
export interface ReadinessSkipLeaves {
  /** The record's text; `absent` when there is none, `unavailable` for any other read failure. */
  readText(): Promise<{ kind: "ok"; text: string } | { kind: "absent" } | { kind: "unavailable" }>;
  /**
   * Replace the record with the text `render` returns, so that a crash cannot leave a
   * half-written record; may reject. `render` is called only once the record's
   * directory exists, which is where the incumbent serialized it.
   */
  writeText(render: () => string): Promise<void>;
}

/** LOCAL DISK: the record file under `root`, built per call; no I/O until a member is asked. In no package index. */
export function diskReadinessSkipLeaves(root: string): ReadinessSkipLeaves {
  const destination = path.join(root, SKIPS_FILE);
  return {
    readText: async () => {
      try {
        return { kind: "ok", text: await Bun.file(destination).text() };
      } catch (error) {
        // ABSENT is a definite answer — nothing has been declined yet. Any other
        // read failure leaves the review unable to say, which is not the same.
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
      }
    },
    writeText: async (render) => {
      // Write-then-rename so a crash mid-write cannot leave a half-file that the
      // reader would then report as unreadable, stranding every prior decision.
      // Bun.write creates the record's directory when it is missing.
      const staging = `${destination}.tmp`;
      await Bun.write(staging, render());
      await rename(staging, destination);
    },
  };
}

/** Read the dimensions this project has declined. Absent means none declined. */
export async function readRecordedSkips(root: string): Promise<RecordedSkipsV1> {
  return readRecordedSkipsFrom(diskReadinessSkipLeaves(root));
}

/** {@link readRecordedSkips} over the record's own leaf: the one body. */
export async function readRecordedSkipsFrom(leaves: ReadinessSkipLeaves): Promise<RecordedSkipsV1> {
  const read = await leaves.readText();
  if (read.kind === "absent") return new Set();
  if (read.kind === "unavailable") return null;
  const text = read.text;
  if (text.length > MAX_SKIPS_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as { skipped?: unknown };
    if (!Array.isArray(parsed.skipped)) return null;
    if (!parsed.skipped.every((entry) => typeof entry === "string")) return null;
    return new Set(parsed.skipped as string[]);
  } catch {
    return null;
  }
}

/**
 * Record or clear one dimension's skip, preserving every other decision.
 *
 * REFUSES WHEN THE EXISTING RECORD IS UNREADABLE, rather than starting a fresh
 * one: overwriting would silently discard decisions the operator already made,
 * and a corrupt file is a thing to look at, not to replace.
 *
 * @param root - Project root.
 * @param dimensionId - The capability being declined or reinstated.
 * @param skipped - True to record a skip, false to clear it.
 * @returns The resulting set, or `null` when the record could not be updated.
 */
export async function recordSkip(
  root: string, dimensionId: string, skipped: boolean,
): Promise<RecordedSkipsV1> {
  return recordSkipFrom(diskReadinessSkipLeaves(root), dimensionId, skipped);
}

/** {@link recordSkip} over the record's own leaf: the one body. */
export async function recordSkipFrom(
  leaves: ReadinessSkipLeaves, dimensionId: string, skipped: boolean,
): Promise<RecordedSkipsV1> {
  const current = await readRecordedSkipsFrom(leaves);
  if (current === null) return null;
  const next = new Set(current);
  if (skipped) next.add(dimensionId);
  else next.delete(dimensionId);
  await leaves.writeText(() => `${JSON.stringify({ skipped: [...next].sort() }, null, 2)}\n`);
  return next;
}
