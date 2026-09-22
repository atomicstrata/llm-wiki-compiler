/**
 * @file src/local-workflow-host/verifier-error.ts
 * @description Shared verifier error identity across core observations and the
 * optional engine's registry and receipt protocol.
 */
/** Typed failure raised by registry resolution or verifier rejection. */
export class WorkflowVerifierError extends Error {
  constructor(readonly reason: string) {
    super(`workflow verifier refused: ${reason}`);
    this.name = "WorkflowVerifierError";
  }
}
