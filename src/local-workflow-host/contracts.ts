/**
 * @file src/local-workflow-host/contracts.ts
 * @description Shared composition identity and transaction contracts for the
 * optional local workflow engine. Identity detects duplicate core instances;
 * neither the identity nor a transaction handle is an operator approval grant.
 */
import type { BlockingLockOptions } from "../utils/lock.js";

/** Deliberately module-local, never Symbol.for: duplicate core copies must differ. */
export const LOCAL_WORKFLOW_CORE_INSTANCE = Symbol("@atomicstrata/llmwiki-core/local-workflow-host");

declare const transactionBrand: unique symbol;

/** Opaque handle; the issuing host privately records root and callback lifetime. */
export interface LocalWorkflowTransaction {
  readonly [transactionBrand]: true;
}

/** The shared mutation lock exposed without granting arbitrary filesystem access. */
export interface LocalWorkflowTransactions {
  readonly coreInstance: symbol;
  withMutation<T>(root: string, body: (transaction: LocalWorkflowTransaction) => Promise<T>,
    options?: BlockingLockOptions): Promise<T>;
  assertActive(transaction: LocalWorkflowTransaction, root: string): void;
}

/** Refuse incompatible composition before calling any host method or doing I/O. */
export class LocalWorkflowCoreInstanceError extends Error {
  constructor() {
    super("local workflow host and runtime must resolve the same core module instance");
    this.name = "LocalWorkflowCoreInstanceError";
  }
}

/** A transaction was forged, belongs to another root/host, or has already ended. */
export class LocalWorkflowTransactionError extends Error {
  constructor(readonly reason: "unknown" | "expired" | "wrong-root") {
    super(`local workflow transaction is ${reason}`);
    this.name = "LocalWorkflowTransactionError";
  }
}

/** Check module identity synchronously, before accepting an executable host. */
export function assertLocalWorkflowCoreInstance(host: { readonly coreInstance: symbol }): void {
  if (host.coreInstance !== LOCAL_WORKFLOW_CORE_INSTANCE) throw new LocalWorkflowCoreInstanceError();
}
