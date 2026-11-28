/**
 * @file src/portable/store/disk-record-entries.ts
 * @description Recognising the one kind of non-record entry a ledger directory
 * of `<id>.json` records can legitimately hold after a crash: the temporary
 * sibling of the REPLACING writer.
 *
 * `atomicWrite` (and `writeProjectFileDurable`, which uses it) replaces a file
 * by writing `<file>.<16 lowercase hex>.tmp` in the same directory and renaming
 * it over `<file>`. A process killed between creating that temp and the rename
 * leaves it behind. The canonical record is only ever replaced by the rename,
 * so the leftover is never a record of anything: scanners skip it, untouched.
 *
 * This is deliberately exact. It is NOT the create-only writer's deterministic
 * `<file>.tmp` / `<file>.writing` siblings (see `disk-intent.ts`), it matches no
 * prefix or loose suffix, and the stem must itself be a safe record id. The
 * match must also cover the WHOLE name (`match[0] === name`), so no trailing
 * character of any kind, line terminators included, can follow `.tmp`; this
 * pins exactness explicitly instead of relying on anchor semantics. It reads,
 * removes and renames nothing.
 */

import { isSafeRecordId } from "../logical-paths.js";
import type { DirectoryEntry } from "./disk-io.js";

/** `<stem>.json.<16 lowercase hex>.tmp`: the replacing writer's temp for the record `<stem>.json`. */
const REPLACING_RECORD_TEMP = /^(.+)\.json\.[0-9a-f]{16}\.tmp$/u;

/**
 * True when `entry` is exactly a replacing-write temp sibling of a canonical
 * `<safeId>.json` record: a REGULAR file named `<safeId>.json.<16 lowercase
 * hex>.tmp` and nothing more. A directory, link or special file with that
 * name is not one.
 */
export function isReplacingRecordTemp(entry: DirectoryEntry): boolean {
  if (!entry.regular) return false;
  const match = REPLACING_RECORD_TEMP.exec(entry.name);
  return match !== null && match[0] === entry.name && isSafeRecordId(match[1]!);
}
