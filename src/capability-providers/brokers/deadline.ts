/**
 * @file The invocation wall-time deadline, carried as an expiry AND a signal.
 * @description An `AbortSignal` alone cannot answer "is the budget spent?".
 * `AbortSignal.timeout(n)` aborts from a TIMER CALLBACK, so between the moment
 * the budget is genuinely exhausted and the moment the event loop gets around to
 * running that callback, `signal.aborted` is still `false`. Every broker gated
 * its adapter I/O on exactly that property, so a host under event-loop pressure
 * — a loaded CI runner, a busy compile — would start outbound work after the
 * wall-time bound it advertises had already passed.
 *
 * The deadline therefore carries two things that answer two different questions:
 *
 * - `expired()` — has the budget been spent? Read SYNCHRONOUSLY immediately
 *   before adapter I/O, against a monotonic clock, so the answer never waits on
 *   a scheduler.
 * - `signal` — cancel work already in flight. Passed to adapters, which is what
 *   a signal is actually for.
 *
 * The clock is injectable so the boundary can be asserted deterministically. It
 * is deliberately NOT the only change: making the test reproducible while
 * production kept consulting the signal would have silenced the instrument and
 * left the gap, which is the more dangerous half of this defect.
 *
 * A monotonic source is required rather than wall-clock time — the budget is a
 * duration, and `Date.now()` can step backwards across an NTP correction or a
 * DST boundary, which would resurrect an already-spent deadline.
 */

/** Milliseconds from an arbitrary fixed origin, never stepping backwards. */
export type MonotonicNowMs = () => number;

/** The host wall-time bound on one invocation's outbound work. */
export interface HostInvocationDeadlineV1 {
  /**
   * Aborts when the budget is spent OR the host-injected signal fires. Handed
   * to adapters to cancel in-flight work; it is NOT the authority on whether
   * new work may start, because it can lag the clock it represents.
   */
  readonly signal: AbortSignal;
  /**
   * True once the wall-time budget is spent or the composed signal has aborted.
   * The authority every broker consults before beginning adapter I/O.
   */
  readonly expired: () => boolean;
}

/** The default monotonic source; `performance.now()` is unaffected by clock steps. */
const defaultMonotonicNowMs: MonotonicNowMs = () => performance.now();

/**
 * Build the invocation deadline from the effective grant's wall-time budget and
 * any host-injected signal.
 *
 * An injected signal can only TIGHTEN the bound; it can never drop it, which is
 * why the composed signal is an `any` of both and `expired()` reports the
 * earlier of the two conditions.
 *
 * @param injected - Optional host signal that may cancel earlier than the budget.
 * @param wallTimeMs - The grant's wall-time budget; a non-integer or negative
 *   value is treated as an already-spent budget, matching the previous bound.
 * @param monotonicNowMs - Monotonic clock, injectable for deterministic tests.
 */
export function createInvocationDeadline(
  injected: AbortSignal | undefined,
  wallTimeMs: number,
  monotonicNowMs: MonotonicNowMs = defaultMonotonicNowMs,
): HostInvocationDeadlineV1 {
  const bounded = Number.isSafeInteger(wallTimeMs) && wallTimeMs >= 0 ? wallTimeMs : 0;
  const expiresAtMs = monotonicNowMs() + bounded;
  const wall = AbortSignal.timeout(bounded);
  const signal = injected === undefined ? wall : AbortSignal.any([injected, wall]);
  return Object.freeze({
    signal,
    // The signal is consulted FIRST so an injected cancellation is honoured
    // immediately, and the clock second so an unfired timer cannot hide a spent
    // budget. Neither alone is sufficient.
    expired: () => signal.aborted || monotonicNowMs() >= expiresAtMs,
  });
}
