/**
 * @file src/indexed/routing.ts
 * @description Which authority serves a project's catalog, history and
 * vectors: the incumbent files (`legacy`) or the `.llmwiki/indexed/` stores.
 *
 * The indexed stores are authoritative exactly when the project's scale
 * record names `local-indexed` as ACTIVE. Activation is the single atomic
 * write that ends a verified preparation, so a partly prepared project (a
 * readable record that is not yet active) keeps every reader and writer on
 * the incumbent files. A project with no record, indexed stores or downgrade
 * intent is never indexed.
 *
 * RESTORE. A project with a record whose indexed authority is being restored
 * (or whose restore was interrupted) refuses every routed operation, unless
 * the caller is that restore (`../segments/restore-marker.ts`).
 *
 * SCALE-DOWN. A fenced scale-down or a published successor with unresolved
 * live intent blocks routed operations (`scale-downgrade-pending`). Only the
 * exact fence admits the scale-down's own scoped
 * reads (`../segments/downgrade-access.ts`).
 *
 * FAIL CLOSED. Indexed stores with a MISSING or UNREADABLE record cannot say
 * which authority holds history and vectors, and the incumbent files there
 * may be a stale backup: the route refuses with `scale-state-unreadable`
 * rather than reading them. Anything at `.llmwiki/indexed` that cannot be
 * proved absent counts as present.
 */

import { realpath } from "node:fs/promises";
import { downgradeNeedsRecovery } from "../scale/downgrade-admission.js";
import { ScaleGateError } from "../scale/gate.js";
import { holdsDowngradeAccess } from "../segments/downgrade-access.js";
import { assertNoForeignRestore } from "../segments/restore-marker.js";
import { hasScaleRecord, indexedStoresMayExist, readScaleRecord } from "../scale/record.js";

/** Refuse when indexed stores may exist, otherwise answer "not indexed". */
async function legacyUnlessIndexedStores(root: string, reason: string): Promise<false> {
  if (await indexedStoresMayExist(root)) throw new ScaleGateError("scale-state-unreadable", reason);
  return false;
}

/** Whether the indexed stores are the active authority for the project at `root`. */
export async function indexedActive(root: string): Promise<boolean> {
  const hasRecord = await hasScaleRecord(root);
  const canonical = hasRecord ? await realpath(root).catch(() => root) : root;
  if (hasRecord) await assertNoForeignRestore(canonical);
  const read = hasRecord ? await readScaleRecord(root) : { kind: "absent" as const };
  if (await downgradeNeedsRecovery(canonical, read)) {
    const fenced = read.kind === "ok" && read.record.pending?.kind === "downgrade";
    if (!fenced || !(await holdsDowngradeAccess(canonical))) throw new ScaleGateError("scale-downgrade-pending");
  }
  if (read.kind === "absent") return legacyUnlessIndexedStores(root, "indexed stores exist but the scale record is missing");
  if (read.kind === "unreadable") return legacyUnlessIndexedStores(root, read.reason);
  return read.record.active.architecture === "local-indexed";
}
