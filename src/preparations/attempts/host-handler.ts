/**
 * @file src/preparations/attempts/host-handler.ts
 * @description The host-handler execution leg (design section 15.4). Registered
 * host handlers use the SAME attempt, lease, bounds, evidence, and revalidation
 * protocol as providers; host-handler does not mean trusted shortcut. The COMPLETE
 * caller input (ref, registry resolve callable, declared limits) is captured ONCE
 * into a frozen data-only snapshot BEFORE any await, rejecting accessors/proxies,
 * so a getter cannot return one value to the checks and another to the handler.
 * The leg binds the ref to the sealed executor, enforces the caller limits against
 * the sealed phase bounds, and derives the invocation's ceilings DIRECTLY from the
 * sealed phase bounds (never the caller). Output bytes flow into temporary custody.
 */

import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { admitHostHandlerLeg } from "./admit-result.js";
import type {
  AttemptLegContextV1, AttemptLegOutcomeV1, AttemptLegRunnerV1,
  HostHandlerDescriptorV1, HostHandlerInvocationV1, HostHandlerRefV1,
  PreparationHostHandlerRegistryV1,
} from "./types.js";

/**
 * The bounded host-handler leg selection: the sealed ref, registry, and ceilings.
 * Like the provider leg it carries NO project root or evidence destination —
 * handler output reaches temporary custody only, never the authoritative store.
 */
export interface HostHandlerLegInputV1 {
  readonly ref: HostHandlerRefV1;
  readonly registry: PreparationHostHandlerRegistryV1;
  readonly maximumOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly hostSignal?: AbortSignal;
}

/** The frozen data-only snapshot of the caller input, captured once before await. */
interface CapturedHostInput {
  readonly ref: HostHandlerRefV1;
  readonly resolve: PreparationHostHandlerRegistryV1["resolve"];
  readonly maximumOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly hostSignal?: AbortSignal;
}

/** Capture the complete host input once, binding the resolve callable before await. */
function captureHostInput(input: HostHandlerLegInputV1): CapturedHostInput {
  const top = captureOwnDataRecord(input);
  const ref = captureOwnDataRecord(top.ref);
  return Object.freeze({
    ref: Object.freeze({
      handlerId: ref.handlerId, handlerContractVersion: ref.handlerContractVersion,
      handlerContractDigest: ref.handlerContractDigest,
    }) as HostHandlerRefV1,
    resolve: input.registry.resolve.bind(input.registry),
    maximumOutputBytes: top.maximumOutputBytes as number, maximumWallTimeMs: top.maximumWallTimeMs as number,
    ...(top.hostSignal === undefined ? {} : { hostSignal: top.hostSignal as AbortSignal }),
  });
}

/** Fail closed unless the leg's handler ref is the exact handler the plan sealed. */
function assertRefBindsSealed(ref: HostHandlerRefV1, legContext: AttemptLegContextV1): void {
  const executor = legContext.sealed.executor;
  if (executor.kind !== "host-handler") throw new Error("host-handler leg used for a non-host-handler phase");
  if (ref.handlerId !== executor.handlerId
    || ref.handlerContractVersion !== executor.handlerContractVersion
    || ref.handlerContractDigest !== executor.handlerContractDigest) {
    throw new Error("host handler ref does not match the sealed executor");
  }
}

/** Fail closed unless the resolved descriptor is the exact sealed handler. */
function assertDescriptorBindsRef(descriptor: HostHandlerDescriptorV1, ref: HostHandlerRefV1): void {
  if (descriptor.handlerId !== ref.handlerId
    || descriptor.handlerContractVersion !== ref.handlerContractVersion
    || descriptor.handlerContractDigest !== ref.handlerContractDigest) {
    throw new Error("host handler descriptor does not bind the sealed handler ref");
  }
}

/** Fail closed unless the captured limits fit the SEALED phase and descriptor ceilings. */
function assertLimitsFit(captured: CapturedHostInput, descriptor: HostHandlerDescriptorV1, legContext: AttemptLegContextV1): void {
  const bounds = legContext.sealed.bounds;
  if (captured.maximumOutputBytes > bounds.maximumOutputEvidenceBytes || captured.maximumWallTimeMs > bounds.maximumTimeMsPerInstance) {
    throw new Error("host handler invocation exceeds the sealed phase bounds");
  }
  if (captured.maximumOutputBytes > descriptor.maximumOutputBytes || captured.maximumWallTimeMs > descriptor.maximumWallTimeMs) {
    throw new Error("host handler invocation exceeds the descriptor's declared bounds");
  }
}

/**
 * Compose the EXECUTOR-owned cancellation signal (design section 23.2) with any
 * caller signal so an operator cancel observed by the executor reaches the
 * in-flight handler; the executor signal is authoritative and, when absent (a
 * unit test), the caller signal is used unchanged.
 */
function composeHostSignal(executorSignal: AbortSignal | undefined, callerSignal: AbortSignal | undefined): AbortSignal | undefined {
  if (executorSignal === undefined) return callerSignal;
  return callerSignal === undefined ? executorSignal : AbortSignal.any([executorSignal, callerSignal]);
}

/** Build the bounded invocation; its ceilings come from the SEALED phase bounds. */
function invocationFor(captured: CapturedHostInput, legContext: AttemptLegContextV1): HostHandlerInvocationV1 {
  const bounds = legContext.sealed.bounds;
  const hostSignal = composeHostSignal(legContext.cancelSignal, captured.hostSignal);
  return {
    attemptId: legContext.attemptId, phaseInstanceId: legContext.sealed.phaseInstanceId,
    leaseNonce: legContext.lease.leaseNonce, inputExposureSetDigest: legContext.sealed.authority.inputExposureSetDigest,
    maximumOutputBytes: bounds.maximumOutputEvidenceBytes, maximumWallTimeMs: bounds.maximumTimeMsPerInstance,
    ...(hostSignal === undefined ? {} : { hostSignal }),
  };
}

/**
 * Build the host-handler leg runner. It runs ONLY while the project lock is
 * released and returns the normalized admitted outcome; every value is read from
 * the once-captured input so a substituted handler or swapped bound fails closed.
 */
export function hostHandlerLegRunner(input: HostHandlerLegInputV1): AttemptLegRunnerV1 {
  const captured = captureHostInput(input);
  return async (legContext: AttemptLegContextV1): Promise<AttemptLegOutcomeV1> => {
    assertRefBindsSealed(captured.ref, legContext);
    const resolution = captured.resolve(captured.ref);
    assertDescriptorBindsRef(resolution.descriptor, captured.ref);
    assertLimitsFit(captured, resolution.descriptor, legContext);
    const result = await resolution.handler.execute(invocationFor(captured, legContext));
    return admitHostHandlerLeg(result, legContext.sealed.bounds.maximumOutputEvidenceBytes);
  };
}
