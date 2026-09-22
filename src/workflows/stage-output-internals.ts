/**
 * Source compatibility exports for host-bound workflow output contracts.
 * Execution helpers belong to the optional engine and require supplied services.
 */
export { recordSettledStageOutput, preflightApplyRecord, trustGateRequiresStaging, guardTrustGatedNonPageWrite, WORST_CASE_DECISION } from "@atomicstrata/llmwiki-local-workflows";
export type { SubmitResult } from "@atomicstrata/llmwiki-local-workflows";
