/**
 * @file src/scale/selection.ts
 * @description The persisted embedding-format selection of `local-large`.
 *
 * Once `local-large` is active, every embedding store write uses the binary
 * container, including a project's very first store (the eager conversion only
 * covers a store that already existed). A project without a record, or whose
 * active architecture is `local-standard`, keeps today's selection exactly.
 * An untrustworthy record REJECTS rather than answering `false`, so a write
 * that somehow ran past the gate still fails closed instead of choosing a
 * format the person did not plan for.
 */

import { hasScaleRecord, readScaleRecord } from "./record.js";

/** Whether the project at `root` selects the binary embedding container. */
export async function scaleSelectsBinary(root: string): Promise<boolean> {
  if (!(await hasScaleRecord(root))) return false;
  const read = await readScaleRecord(root);
  if (read.kind === "unreadable") throw new Error(`scale-state-unreadable: ${read.reason}`);
  return read.kind === "ok" && read.record.active.architecture === "local-large";
}
