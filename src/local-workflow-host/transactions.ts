/**
 * @file src/local-workflow-host/transactions.ts
 * @description Callback-scoped access to the existing project mutation lock.
 * Uses the same recovery gate and release implementation as every compiler
 * mutation. Handles carry no caller-editable authority and expire before unlock.
 * Existing caller-held-lock APIs remain separate and do not mint these handles.
 */
import path from "node:path";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock, type BlockingLockOptions } from "../utils/lock.js";
import { trackHostEffect } from "./tracked-effect.js";
import {
  LOCAL_WORKFLOW_CORE_INSTANCE, LocalWorkflowTransactionError,
  type LocalWorkflowTransaction, type LocalWorkflowTransactions,
} from "./contracts.js";

interface Lease {
  root: string;
  active: boolean;
  effects: ReturnType<typeof trackHostEffect>[];
}

/** Reject before an operation starts; a structurally similar object is not a lease. */
function assertLease(leases: WeakMap<LocalWorkflowTransaction, Lease>,
  transaction: LocalWorkflowTransaction, root: string): void {
  const lease = leases.get(transaction);
  if (!lease) throw new LocalWorkflowTransactionError("unknown");
  if (!lease.active) throw new LocalWorkflowTransactionError("expired");
  if (lease.root !== path.resolve(root)) throw new LocalWorkflowTransactionError("wrong-root");
}

/** Acquire once, await the entire callback, revoke the handle, then release once. */
async function withMutation<T>(leases: WeakMap<LocalWorkflowTransaction, Lease>, root: string,
  body: (transaction: LocalWorkflowTransaction) => Promise<T>, options: BlockingLockOptions): Promise<T> {
  const lease: Lease = { root: path.resolve(root), active: true, effects: [] };
  await acquireMutationLockBlocking(root, "ordinary", options);
  const transaction = Object.freeze({}) as LocalWorkflowTransaction;
  leases.set(transaction, lease);
  let callbackFailed = false;
  try {
    return await body(transaction);
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    lease.active = false;
    try {
      await Promise.all(lease.effects.map(effect => effect.settled));
      const unobserved = lease.effects.find(effect => effect.unobservedFailure());
      if (!callbackFailed && unobserved) throw unobserved.failure();
    } finally {
      await releaseLock(root);
    }
  }
}

/** Track admitted host operations so a forgotten await cannot release their lock early. */
function runEffect<T>(leases: WeakMap<LocalWorkflowTransaction, Lease>, transaction: LocalWorkflowTransaction,
  root: string, effect: () => Promise<T>): Promise<T> {
  assertLease(leases, transaction, root);
  const lease = leases.get(transaction)!;
  const tracked = trackHostEffect(effect);
  lease.effects.push(tracked);
  return tracked.result;
}

/** Internal host assembly helper; the effect callback is not part of the engine contract. */
export function createLocalWorkflowTransactionScope() {
  const leases = new WeakMap<LocalWorkflowTransaction, Lease>();
  const transactions: LocalWorkflowTransactions = Object.freeze({
    coreInstance: LOCAL_WORKFLOW_CORE_INSTANCE,
    withMutation: <T>(root: string, body: (transaction: LocalWorkflowTransaction) => Promise<T>,
      options: BlockingLockOptions = {}) => withMutation(leases, root, body, { ...options }),
    assertActive: (transaction: LocalWorkflowTransaction, root: string) => assertLease(leases, transaction, root),
  });
  return {
    transactions,
    runEffect: <T>(tx: LocalWorkflowTransaction, root: string, effect: () => Promise<T>) =>
      runEffect(leases, tx, root, effect),
  };
}

/** Construct a standalone transaction owner without invoking any filesystem service. */
export function createLocalWorkflowTransactions(): LocalWorkflowTransactions {
  return createLocalWorkflowTransactionScope().transactions;
}
