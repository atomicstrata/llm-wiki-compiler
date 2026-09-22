/**
 * Version-locked compatibility support for the existing startWorkflowLocked API.
 * The caller MUST already own the compiler mutation lock. This deliberately does
 * not acquire, release, or claim to verify that lock, matching the legacy API.
 * This is a public integration seam, not a sandbox or approval boundary: trusted
 * in-process code can sign arbitrary run records, and already has filesystem
 * access to the run key. It grants no domain mutation authority. New runtime
 * operations use transaction-scoped host persistence.
 */
export { writeRun as writeRunWithCallerHeldLock } from "./run-store.js";
