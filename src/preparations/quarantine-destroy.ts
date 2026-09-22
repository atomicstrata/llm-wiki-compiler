/**
 * @file src/preparations/quarantine-destroy.ts
 * @description The one-phase verified-destroy engine, owned by the driver.
 *
 * Purge's terminal engine. Unlike the other two it publishes nothing: §10.2 makes
 * the already-authenticated completed quarantine receipt the sealed plan, and
 * §10.6 makes a crash resume "by re-reading that receipt and observing which exact
 * named leaves remain". Every unlink is absence-tolerant, so re-running after a
 * partial destroy completes cleanly.
 *
 * Reached only from the driver's engine switch, under a permit bound to `purge`.
 * Before Task 9E chunk C2 this was ungated: `purgeQuarantineObjectLeaves`
 * irreversibly unlinks quarantined bytes and is the most destructive mutation in
 * the package, and any caller that imported it could run it.
 */

import { destroyQuarantineUnitBytes } from "./lifecycle-fs/quarantine-operations.js";
import type { LifecycleMutationPermitV1 } from "./lifecycle-mutation-permit.js";
import type { QuarantineObjectV1 } from "./receipts.js";

/** Everything the destroy engine needs, assembled field by field by the driver. */
export interface VerifiedDestroyEngineInput {
  readonly permit: LifecycleMutationPermitV1;
  readonly root: string;
  readonly unitId: string;
  readonly objects: readonly Pick<QuarantineObjectV1, "objectName">[];
}

/**
 * Destroy exactly the bytes the settled receipt names, and nothing else.
 *
 * The object names come from the SIGNED receipt, never from a directory listing:
 * a listing would destroy whatever happens to be present, which is the recursive
 * behaviour §10.6 forbids in as many words.
 */
export async function destroySettledQuarantineUnit(
  input: VerifiedDestroyEngineInput,
): Promise<void> {
  await destroyQuarantineUnitBytes(
    input.permit, input.root, input.unitId, input.objects);
}
