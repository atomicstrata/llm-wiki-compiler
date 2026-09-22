/**
 * Legacy source-path compatibility for the optional local workflow engine.
 * Forwarding preserves one implementation and shared error constructor identity.
 */
export { RunUnavailableError, AdaptationRequiresConfirmError, AlreadyCurrentError, RunNotActiveError, UnknownGateError, GateActorMismatchError, SdkHumanGateError, TrustGateNotHereError, UnknownActionError, ActionInputError, ActionDeniedError, ActionRunWorkflowMismatchError, RunOwnerMismatchError, StageWriteScopeError, StageHasNoWritesError, StageWriteDeniedError, TrustGateRequiresGrantError, WorkflowArtifactChangedError, WorkflowArtifactUnverifiableError, StageOutputAlreadyAppliedError, StageOutputPendingError } from "@atomicstrata/llmwiki-local-workflows";
