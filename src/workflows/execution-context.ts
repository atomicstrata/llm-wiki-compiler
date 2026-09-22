/**
 * Source compatibility export; implementation belongs to the optional engine.
 * Standard callers and the extracted runtime share the same module identities.
 */
export { runWriter, terminalRunWriter, projectWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { WorkflowExecutionContext, RunWriter, TerminalRunWriter } from "@atomicstrata/llmwiki-local-workflows";
