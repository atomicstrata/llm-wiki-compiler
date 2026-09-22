/**
 * @file src/capability-providers/runtime/cancellation.ts
 * @description Invocation-level cancellation seam (D6.6). It composes the
 * host-supplied cancellation signal with the invocation wall-time deadline into
 * one signal the broker dispatcher and protocol pump both observe, so §22
 * layer-2 (stop dispatching new broker requests) reaches the broker layer. The
 * cooperative grace window and forced tree termination are Task 10's to own;
 * this module only creates the composed signal the later logic drives.
 */

/** One composed cancellation controller for a single invocation. */
export interface InvocationCancellationV1 {
  readonly signal: AbortSignal;
  readonly wasRequested: () => boolean;
}

/** Compose an optional host cancel signal with the invocation wall-time bound. */
export function createInvocationCancellation(
  wallTimeMs: number, hostSignal?: AbortSignal,
): InvocationCancellationV1 {
  const bounded = Number.isSafeInteger(wallTimeMs) && wallTimeMs >= 0 ? wallTimeMs : 0;
  const wall = AbortSignal.timeout(bounded);
  const signal = hostSignal === undefined ? wall : AbortSignal.any([hostSignal, wall]);
  return Object.freeze({
    signal,
    wasRequested: () => hostSignal?.aborted === true,
  });
}
