/**
 * @file src/preparations/attempts/cancel-delivery.ts
 * @description In-flight cancellation DELIVERY for one phase attempt (design
 * section 23.2). This is the whole of the lock-RELEASED middle leg: the
 * pre-launch safe-boundary check, the executor-owned cancellation signal and its
 * bounded advisory poll, the leg invocation itself, and the bounded post-delivery
 * deadline that stops an unresponsive provider from holding preparation forever.
 *
 * Nothing here holds or takes the project lock — that is the entire point of the
 * leg it drives. It reads only the lock-free advisory `.cancel` file and writes
 * nothing durable: every outcome it produces is handed back to the executor's
 * commit path, which revalidates the lease and records the honest result.
 */

import { meteredFaultUsage } from "../../capability-providers/runtime/observed-usage.js";
import { preparationCancellationRequested } from "../cancellation.js";
import type { AttemptExecutionRequestV1, AttemptLegOutcomeV1, SealedAttemptContextV1 } from "./types.js";

/**
 * How often the executor re-reads the advisory `.cancel` file during a leg.
 * Overridable via `LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS`, mirroring the cancel
 * deadline below: a test that must prove the poll CANNOT have ticked during its
 * leg sets it beyond the leg's lifetime, turning a timing assumption into a
 * pinned precondition.
 */
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 100;

/**
 * The default bounded cancel interval: how long the executor waits for a leg to
 * honor a DELIVERED cancel before abandoning it recovery-required. It bounds the
 * attempt so an unresponsive provider can never hold preparation. Overridable via
 * `LLMWIKI_PREP_CANCEL_DEADLINE_MS` (a fast value keeps the held-pipe test quick).
 */
const DEFAULT_CANCEL_DEADLINE_MS = 5_000;

/**
 * The effect-free cancelled outcome fed to the ordinary commit path when a valid
 * cancellation is observed at the pre-launch safe boundary (design section 23.2:
 * "no new ordinary phase starts"). It carries no invocation, evidence, or effect,
 * so the existing commit revalidates the lease, records no effect, publishes
 * nothing, and settles the phase `cancelled` with the owner cleared — an honest
 * effect-free cancellation that never falsely claims work ran.
 */
function cancelledBeforeLaunchOutcome(): AttemptLegOutcomeV1 {
  return { phaseState: "cancelled", pendingEvidence: [], effects: [], invocationCount: 0, brokerRequestCount: 0, tokenCount: 0, costMicros: 0 };
}

/**
 * Poll the lock-free advisory `.cancel` file at the pre-launch safe boundary. A
 * forged, stale, or unreadable file yields false and the ordinary leg runs; only
 * a valid present request short-circuits to the effect-free cancelled outcome.
 */
async function cancellationBeforeLaunch(request: AttemptExecutionRequestV1): Promise<boolean> {
  return preparationCancellationRequested(request.root, request.binding.workspaceId, request.binding.runId);
}

/** The bounded advisory poll interval, overridable for tests via env. */
function cancelPollIntervalMs(): number {
  const raw = Number(process.env.LLMWIKI_PREP_CANCEL_POLL_INTERVAL_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_CANCEL_POLL_INTERVAL_MS;
}

/** One running advisory poll: what it has delivered, and how to tear it down. */
interface CancellationPollV1 {
  /** True once THIS poll validated an operator cancel and delivered it. */
  delivered(): boolean;
  stop(): void;
}

/**
 * Start a bounded-interval poll of the advisory `.cancel` file DURING the leg and
 * trip the executor-owned signal on a valid operator cancel, delivering the
 * cancellation to the in-flight provider/host-handler leg (design section 23.2:
 * the executor "polls between provider/broker safe boundaries"). The poll only
 * reads the confined advisory — no other under-lock work — and `stop` clears the
 * timer so no poll survives the leg into the commit path.
 *
 * `delivered` IS THE DELIVERY RECORD, and it is a closure-local variable set on
 * the same line as the abort it accompanies. It is deliberately not read back off
 * `controller.signal.aborted`: `aborted` is a prototype getter, so a leg holding
 * the signal can shadow it with an own property and make the flag read true
 * without any operator cancel existing. The leg cannot abort the controller, but
 * that was never the whole boundary — nothing outside this function can see or
 * name this variable, which is what actually makes the fact host-owned.
 *
 * The re-entry guard reads the same local for the same reason: a leg that
 * shadowed `aborted` early would otherwise suppress every later tick, so a
 * genuine operator cancel would never be delivered and the bounded cancel
 * deadline would never arm.
 */
function startCancellationPoll(request: AttemptExecutionRequestV1, controller: AbortController): CancellationPollV1 {
  let stopped = false;
  let delivered = false;
  const timer = setInterval(() => {
    if (stopped || delivered) return;
    void preparationCancellationRequested(request.root, request.binding.workspaceId, request.binding.runId)
      .then((requested) => {
        if (!requested || stopped) return;
        delivered = true;
        controller.abort();
      })
      .catch(() => {});
  }, cancelPollIntervalMs());
  timer.unref?.();
  return { delivered: () => delivered, stop: () => { stopped = true; clearInterval(timer); } };
}

/**
 * Run the injected leg outside the lock with the executor-owned cancellation
 * signal in its context, mapping a thrown leg to park state. The leg wires the
 * signal into its Provider V2 invocation, so a mid-flight `controller.abort()`
 * reaches the running backend as a cooperative cancel plus forced termination.
 */
async function runLegSafely(request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1, cancelSignal: AbortSignal): Promise<AttemptLegOutcomeV1> {
  try {
    return await request.leg({ attemptId: sealed.attemptId, lease: sealed.lease, sealed, cancelSignal });
  } catch (error) {
    return legFaultOutcome(error);
  }
}

/**
 * The park outcome for a thrown leg. The classification is unchanged — an
 * unknown-state leg is `recovery-required`, which retry refuses — but a fault
 * that unwound with the broker meter live carries the spend the host had already
 * observed, so a billable call is not silently written off as free. A fault with
 * no measurement attached never reached a live meter, so no broker traffic was
 * possible and its zeroes are structural rather than assumed. Exported so a leg
 * driver classifies a fault exactly as the executor does instead of cloning it.
 */
export function legFaultOutcome(error: unknown): AttemptLegOutcomeV1 {
  const usage = meteredFaultUsage(error);
  return {
    phaseState: "recovery-required", pendingEvidence: [], effects: [], invocationCount: 0,
    brokerRequestCount: usage?.brokerRequestCount ?? 0,
    tokenCount: usage?.tokenCount ?? 0, costMicros: usage?.costMicros ?? 0,
    problem: "leg-fault",
  };
}

/** The bounded post-delivery cancel interval, overridable for tests via env. */
function cancelDeadlineMs(): number {
  const raw = Number(process.env.LLMWIKI_PREP_CANCEL_DEADLINE_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_CANCEL_DEADLINE_MS;
}

/** Resolve `"deadline"` a bounded interval AFTER the signal aborts; never before. */
function armCancelDeadline(signal: AbortSignal): Promise<"deadline"> {
  return new Promise((resolve) => {
    const arm = (): void => { const timer = setTimeout(() => resolve("deadline"), cancelDeadlineMs()); timer.unref?.(); };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
}

/**
 * The fail-closed outcome when a DELIVERED cancel's bounded interval expires with
 * the leg still pending: the attempt is abandoned `recovery-required` so
 * preparation is never held by a hung provider. Forced backend termination is the
 * Provider V2 invoke runtime's disposer, reached once the abandoned invocation
 * returns; the executor does not wait for it.
 */
function cancelDeadlineExpiredOutcome(): AttemptLegOutcomeV1 {
  return { phaseState: "recovery-required", pendingEvidence: [], effects: [], invocationCount: 1, brokerRequestCount: 0, tokenCount: 0, costMicros: 0, problem: "cancel-deadline-expired" };
}

/**
 * Race the leg against the bounded cancel deadline. The deadline only starts once
 * cancellation is DELIVERED (the signal aborts), so non-cancelled work is never
 * artificially capped; a leg that honors the cancel within the interval settles
 * honestly, and a leg still pending when the interval expires is abandoned
 * recovery-required so the attempt is bounded end to end.
 */
async function raceLegAgainstCancelDeadline(
  request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1, controller: AbortController,
): Promise<AttemptLegOutcomeV1> {
  const leg = runLegSafely(request, sealed, controller.signal).then((outcome) => ({ outcome }));
  const deadline = armCancelDeadline(controller.signal).then(() => ({ deadline: true as const }));
  const settled = await Promise.race([leg, deadline]);
  return "outcome" in settled ? settled.outcome : cancelDeadlineExpiredOutcome();
}

/**
 * One leg outcome plus the executor's OWN record of what it observed.
 *
 * `cancellationObserved` is a HOST fact, established at the moment this executor
 * validated an operator cancel and acted on it — at the pre-launch boundary, or
 * mid-flight when the poll delivered it. It is not a claim the leg makes: it is
 * read from a variable local to {@link startCancellationPoll}, which nothing
 * outside that closure can reach. Reading it off the signal instead would NOT be
 * equivalent — see that function for the shadowing vector that makes the
 * difference.
 *
 * It exists because the advisory `.cancel` file is not a durable record of the
 * past. The commit that follows used to re-derive "was a cancel observed" by
 * re-reading that file, so a request retracted between delivery and commit
 * erased an observation the executor had already acted on — the leg stopped, the
 * phase settled `cancelled`, and the run stayed `running` with cancellation not
 * sticky at all. An observation cannot be un-made by a file disappearing.
 */
export interface AttemptLegDeliveryV1 {
  readonly outcome: AttemptLegOutcomeV1;
  readonly cancellationObserved: boolean;
}

/**
 * Run the leg under an executor-owned cancellation signal, its advisory poll, and
 * a bounded cancel deadline. A cancel already durable at the pre-launch boundary
 * short-circuits to the effect-free cancelled outcome; otherwise the leg runs, the
 * poll trips the signal on a mid-flight cancel, and the deadline abandons a leg
 * that ignores the delivered cancel. The poll is always torn down before commit.
 *
 * The DELIVERY RECORD comes from the poll's own closure, never from the signal's
 * `aborted` flag — a leg holding the signal can shadow that getter and claim a
 * cancellation that never happened. See {@link startCancellationPoll}.
 */
export async function runAttemptLeg(
  request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1,
): Promise<AttemptLegDeliveryV1> {
  if (await cancellationBeforeLaunch(request)) {
    return { outcome: cancelledBeforeLaunchOutcome(), cancellationObserved: true };
  }
  const controller = new AbortController();
  const poll = startCancellationPoll(request, controller);
  try {
    const outcome = await raceLegAgainstCancelDeadline(request, sealed, controller);
    return { outcome, cancellationObserved: poll.delivered() };
  } finally {
    poll.stop();
  }
}
