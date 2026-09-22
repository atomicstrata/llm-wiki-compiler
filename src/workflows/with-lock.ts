/**
 * Compatibility exports for workflow ownership and lock protocol helpers.
 * Internal event writers now require explicit host-backed persistence.
 */
export { assertRunOwnership, withHostRunLock, commitRunEvent, commitTerminalEvent, isTerminalStatus } from "@atomicstrata/llmwiki-local-workflows";
