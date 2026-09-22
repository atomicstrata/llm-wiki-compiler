/**
 * Source compatibility export; implementation belongs to the optional engine.
 * Standard callers and the extracted runtime share the same module identities.
 */
export { startWorkflowWithHost, startWorkflowWithServices, UnknownWorkflowError, TooManyActiveRunsError, WorkflowRunStoreUnavailableError } from "@atomicstrata/llmwiki-local-workflows";
export type { StartWorkflowRequest, StartServices } from "@atomicstrata/llmwiki-local-workflows";
