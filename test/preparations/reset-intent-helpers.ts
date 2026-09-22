/**
 * @file test/preparations/reset-intent-helpers.ts
 * @description Shared setup for the two-invocation reset's first pass.
 *
 * Both the supersession suite and the grammar suite need a REAL recorded intent —
 * planted markers cannot stand in, because the continuation token only exists if pass
 * one minted it. Keeping that setup in one place means the two suites cannot drift into
 * testing subtly different starting states.
 */

import { resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import { MISSING_KEY_CONFIRMATION } from "../../src/preparations/receipts.js";
import { LIFECYCLE_ACTOR, removePreparationKey, stagePreparation } from "./lifecycle-fixture.js";

/** Stage a preparation, remove its key, and run the reset's first pass. */
export async function recordFirstPassIntent(root: string, at: string): Promise<{
  unitId: string; continuation: { unitId: string; token: string };
}> {
  await stagePreparation(root);
  await removePreparationKey(root);
  const first = await resetPreparationKeyEpochLocked(root, {
    actor: LIFECYCLE_ACTOR, at, confirmation: MISSING_KEY_CONFIRMATION,
  });
  if (first.status !== "intent-recorded") throw new Error("expected intent-recorded pass one");
  return { unitId: first.unitId, continuation: { unitId: first.unitId, token: first.continuationToken } };
}
