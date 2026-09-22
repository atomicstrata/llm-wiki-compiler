/**
 * @file src/workflows/integrity.ts
 * @description Compatibility forwarding for shared run-key creation and verification.
 */
export { loadOrCreateRunKey } from "../local-workflow-host/run-key.js";
export { loadRunKey, runIntegrity, integrityMatches } from "../workflow-history/integrity.js";
