/** @file Shared host-only preparation authority and lock boundary. Both staging
 * and retirement require the same explicit grant and serialize against operator
 * apply. The callback is internal implementation, never SDK request data. */
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "./lock-gate.js";
import type { OperationPrincipal } from "./principal.js";

/** Capture host authority before waiting, then release the acquired lock on every exit. */
export async function withRecordPreparationLock<T>(root: string, principal: OperationPrincipal,
  action: (actor: OperationPrincipal) => Promise<T>): Promise<T> {
  const actor: OperationPrincipal = { id: principal.id, surface: principal.surface, grants: [...principal.grants] };
  if (!actor.grants.includes("operation-bundle.prepare")) throw new Error("record-prepare-grant-required");
  if (!await acquireMutationLock(root, "ordinary")) throw new Error("record-preparation-busy");
  try { return await action(actor); }
  finally { await releaseLock(root); }
}
