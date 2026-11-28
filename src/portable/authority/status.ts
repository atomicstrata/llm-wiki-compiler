/**
 * @file src/portable/authority/status.ts
 * @description Reading what the authority recorded about an operation, and
 * settling what a crash left undecided.
 *
 * The commit receipt is the authority. An operation with a receipt IS
 * committed, whatever its identity record still says, so every answer here
 * checks the receipt first. That is also how an approval's custody is decided:
 * it is consumed exactly when the operation holding it has a receipt, so
 * consumption can never land separately from the commit it belongs to.
 */

import type {
  CustodyState,
  OperationIdentityRecordV1,
  PublicationStatus,
  ReceiptV1,
} from "../contracts.js";
import type { HostControl } from "../host/control.js";
import type { ProjectStore } from "../store/store.js";

/** The two things every authority step needs. */
export interface Authority {
  control: HostControl;
  store: ProjectStore;
}

/** The success arm a committed receipt stands for. */
function committedArm(receipt: ReceiptV1): PublicationStatus {
  if (receipt.proposal) return { kind: "proposed", receipt: receipt.proposal };
  if (receipt.approval) return { kind: "approved", operationId: receipt.operationId, approval: receipt.approval };
  return {
    kind: "committed", operationId: receipt.operationId, head: receipt.revision,
    published: receipt.published, skipped: receipt.skipped,
  };
}

/** True while a generation lease has not reached its host-capped expiry. */
export function isLeaseLive(record: OperationIdentityRecordV1, now = Date.now()): boolean {
  return record.generationLease !== null && Date.parse(record.generationLease.expiresAt) > now;
}

/** The recorded state of one operation. Never a submission rejection. */
export async function statusOf(auth: Authority, record: OperationIdentityRecordV1): Promise<PublicationStatus> {
  const { operationId } = record;
  const receipt = await auth.store.getReceipt(operationId);
  if (receipt) return committedArm(receipt);
  // A durable close outranks the identity record: it was written first, and a
  // crash may have prevented the identity record from ever catching up.
  const closure = await auth.store.getClosure(operationId);
  if (closure?.outcome === "abandoned") return { kind: "abandoned", operationId, resolution: closure.resolution };
  if (closure?.outcome === "refused") {
    return { kind: "refused", operationId, code: "recovered_no_effect", detail: closure.detail };
  }
  if (record.outcome === "refused") {
    return { kind: "refused", operationId, code: record.refusal ?? "recovered_no_effect", ...(record.detail ? { detail: record.detail } : {}) };
  }
  if (record.outcome === "abandoned" && record.resolution) {
    return { kind: "abandoned", operationId, resolution: record.resolution };
  }
  const parked = (await auth.store.unresolvedIntents()).includes(operationId);
  return parked ? { kind: "unknown", operationId } : { kind: "in_progress", operationId };
}

/**
 * Where an approval or ticket stands, derived from the operation holding it:
 * committed or abandoned → consumed; a known refusal → available again;
 * anything still open or unknown → reserved.
 */
export async function custodyOf(auth: Authority, key: string): Promise<CustodyState> {
  const holder = await auth.store.getReservation(key);
  if (holder === null) return { state: "available" };
  if ((await auth.store.getReceipt(holder)) !== null) return { state: "consumed", by: holder };
  // The durable close decides before the identity record does: an abandoned
  // operation keeps what it held even if its identity record was never updated.
  const closure = await auth.store.getClosure(holder);
  if (closure?.outcome === "abandoned") return { state: "consumed", by: holder };
  if (closure?.outcome === "refused") return { state: "available" };
  const record = await auth.store.getIdentity(holder);
  // On an adopted (format-2) project every holder's identity is kept in step with
  // its open marker, so a missing one was LOST, not never written: nothing proves
  // the hold was released, and it is reported held rather than promised available.
  if (record === null && (await auth.store.formatRefusesV1?.()) === true) return { state: "reserved", by: holder };
  if (record === null || record.outcome === "refused") return { state: "available" };
  if (record.outcome === "abandoned") return { state: "consumed", by: holder };
  return { state: "reserved", by: holder };
}

/** Bring an identity record up to date with its durable close. Returns whether there was one. */
async function reconcileFromClosure(auth: Authority, record: OperationIdentityRecordV1): Promise<boolean> {
  const closure = await auth.store.getClosure(record.operationId);
  if (closure === null) return false;
  const settled = closure.outcome === "abandoned"
    ? { ...record, outcome: "abandoned" as const, resolution: closure.resolution }
    : { ...record, outcome: "refused" as const, refusal: "recovered_no_effect" as const, detail: closure.detail };
  await auth.store.putIdentity(settled);
  return true;
}

/** Close one in-progress record that never reached an intent and holds no lease. */
async function closeOrphanBegin(auth: Authority, operationId: string, parked: ReadonlySet<string>): Promise<void> {
  const record = await auth.store.getIdentity(operationId);
  if (record === null || record.outcome !== "in-progress" || parked.has(operationId)) return;
  if ((await auth.store.getReceipt(operationId)) !== null) {
    await auth.store.putIdentity({ ...record, outcome: "committed" });
    return;
  }
  // Reconcile from a durable close BEFORE inferring an orphan: an operation an
  // operator abandoned must never be rewritten as "never started".
  if (await reconcileFromClosure(auth, record)) return;
  // A proposal's begin holds a lease. A live one is a running generation; an
  // expired one is taken over by a same-id retry. Neither is an orphan (C2).
  if (record.generationLease !== null) return;
  await auth.store.putIdentity({ ...record, outcome: "refused", refusal: "recovered_no_effect", detail: "never_started" });
}

/**
 * Ordinary recovery, run by whoever next holds the gate: settle every
 * decidable intent, then close begins that never started. A parked intent is
 * left for an operator; this never closes one by itself.
 */
export async function recoverLocked(auth: Authority): Promise<void> {
  for (const result of await auth.store.recover()) {
    const record = await auth.store.getIdentity(result.operationId);
    if (record === null) continue;
    if (result.result === "rolled-forward") await auth.store.putIdentity({ ...record, outcome: "committed" });
    if (result.result === "no-effect") {
      await auth.store.putIdentity({
        ...record, outcome: "refused", refusal: "recovered_no_effect", detail: result.detail,
      });
    }
  }
  const parked = new Set(await auth.store.unresolvedIntents());
  for (const operationId of await auth.store.listOpenOperations()) {
    await closeOrphanBegin(auth, operationId, parked);
  }
}
