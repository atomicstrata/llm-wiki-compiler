/**
 * @file test/preparations/attempt-provider.test.ts
 * @description Provider-leg contract: the adapter constructs a frozen request
 * from the caller's fields and binds EVERY sealed authority dimension (pin,
 * capability, schema, and the ACTUAL input-spec content exposure) before
 * executing; the object handed to invoke is the constructed one, so a getter-swap
 * cannot deliver a different value. It drives ONLY `invokeCapabilityProvider`,
 * keeps the project lock released, and commits the honest failed phase on a
 * failed invocation. A drifted pin/capability/inputSpec or an accessor field
 * fails closed without executing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { PlatformArtifactV1 } from "../../src/capability-providers/packages/protocol.js";
import { deriveAttemptId } from "../../src/preparations/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { providerInputSpecsContentExposureDigest, providerLegRunner, type ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import {
  attemptRequest, EXPOSURE, lockIsFree, PIN, providerRequest, stageBrokerCapable,
  stagePreparation, wideBounds, type StagedPreparation,
} from "./attempt-fixture.js";
import type { ProviderInvocationHostV1, ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";

const HOST = {} as ProviderInvocationHostV1;
const EXECUTOR = { kind: "provider-capability", providerPinDigest: PIN, capabilityId: "gather", capabilityContractDigest: PIN };
const SPEC = { inputId: "in-1", kind: "file", provenanceLabel: "p", mediaType: "application/json", bytes: new Uint8Array([1, 2, 3]) };
const USAGE = { brokerRequestCount: 0, tokenCount: "unobserved" as const, costMicros: "unobserved" as const };
const succeeded: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
  outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
  receipts: [], usage: USAGE, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
const mustNotRun: ProviderInvokeFn = async () => { throw new Error("must not run"); };

let staged: StagedPreparation;
beforeEach(async () => { staged = await stagePreparation(); });
afterEach(() => staged.cleanup());

const sealedCtx = (inputExposureSetDigest: `sha256:${string}` = EXPOSURE) => ({
  attemptId: "pat" as never, lease: { pid: 1, leaseNonce: "n", acquiredAt: "t" },
  sealed: { phaseInstanceId: "phi", executor: EXECUTOR, bounds: wideBounds(),
    authority: { inputExposureSetDigest } } as never,
});

function leg(invoke: ProviderInvokeFn, request: ProviderInvocationRequestV1 = providerRequest()) {
  return providerLegRunner({ request, host: HOST, preparationRunId: staged.binding.runId }, invoke);
}

describe("preparation attempt provider leg", () => {
  it("invokes the provider with the project lock released and commits", async () => {
    let called = false, sawLockFree = false;
    const invoke: ProviderInvokeFn = async (...args) => { called = true; sawLockFree = await lockIsFree(staged.root); return succeeded(...args); };
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: leg(invoke) }));
    expect(called).toBe(true);
    expect(sawLockFree).toBe(true);
    expect(outcome.status).toBe("committed");
  });

  it("commits the honest failed phase when the provider invocation fails", async () => {
    const invoke: ProviderInvokeFn = async () => ({ kind: "failed", problem: "provider-protocol-invalid", detail: "x" });
    const request = attemptRequest(staged, { leg: leg(invoke) });
    const attemptId = deriveAttemptId(request.phaseInstanceId, 0);
    expect(await executePhaseAttempt(request)).toEqual({ status: "committed", attemptId, phaseState: "failed" });
  });

  it("fails closed when the request pin does not match the sealed executor", async () => {
    await expect(leg(mustNotRun, providerRequest({ pin: `sha256:${"c".repeat(64)}` }))(sealedCtx())).rejects.toThrow(/pin does not match the sealed executor/);
  });

  it("fails closed when the actual input specs do not match the sealed exposure", async () => {
    await expect(leg(mustNotRun, providerRequest({ inputSpecs: [SPEC] }))(sealedCtx())).rejects.toThrow(/exposure does not match the sealed attempt/);
  });

  it("fails closed when an authority field is an accessor (getter-swap)", async () => {
    const request = providerRequest();
    Object.defineProperty(request.expectedIdentity, "providerPinDigest", { get: () => PIN, enumerable: true, configurable: true });
    await expect(leg(mustNotRun, request)(sealedCtx())).rejects.toThrow();
  });

  it("hands invoke a reconstructed frozen request that drops uncaptured caller fields", async () => {
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req, host) => { received = req; return succeeded(req, host); };
    const request = { ...providerRequest(), maliciousField: "x" } as unknown as ProviderInvocationRequestV1;
    const outcome = await leg(invoke, request)(sealedCtx());
    expect(Object.isFrozen(received)).toBe(true);
    expect((received as unknown as { maliciousField?: string }).maliciousField).toBeUndefined();
    expect(outcome.observedProviderPinDigest).toBe(PIN);
  });

  it("measures host-observed broker usage, not the effect-receipt count", async () => {
    const invoke: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
      outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
      receipts: [], usage: { brokerRequestCount: 3, tokenCount: "unobserved", costMicros: "unobserved" },
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: leg(invoke) }));
    expect(outcome).toEqual({ status: "parked", reason: "broker-requests-exceed-sealed-bound" });
  });

  it("fails closed BEFORE invoking when a broker adapter is present under a zero broker bound", async () => {
    const request = providerRequest({ brokers: { https: {} } });
    await expect(leg(mustNotRun, request)(sealedCtx())).rejects.toThrow(/broker adapters under a zero broker-request bound/);
  });

  it("parks when an applicable token dimension (model adapter) cannot be measured", async () => {
    const s = await stageBrokerCapable();
    const modelInvoke: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
      outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
      receipts: [], usage: { brokerRequestCount: 1, tokenCount: "unobserved", costMicros: "unobserved" },
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
    const run = providerLegRunner({ request: providerRequest({ brokers: { model: {} } }), host: HOST, preparationRunId: s.binding.runId }, modelInvoke);
    const outcome = await executePhaseAttempt(attemptRequest(s, { leg: run }));
    await s.cleanup();
    expect(outcome).toEqual({ status: "parked", reason: "tokens-unobserved" });
  });

  it("host-derives the launch root and ignores the caller value even if mutated", async () => {
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req) => { received = req; return succeeded(req, HOST); };
    const request = providerRequest({ launchParentDir: "/caller-launch" });
    const run = leg(invoke, request);
    const promise = run(sealedCtx());
    (request.launch as { launchParentDir: string }).launchParentDir = "/attacker"; // mutate after the leg starts
    await promise;
    expect(received?.launch.launchParentDir).not.toBe("/caller-launch");
    expect(received?.launch.launchParentDir).not.toBe("/attacker");
  });

  it.each([
    { name: "omitted caller maxima", overrides: {} },
    { name: "caller maxima above the sealed ceiling", overrides: { operationsPackRequest: { brokerMaximums: { modelTokens: 200, modelCostUsd: 50 } } } },
  ])("applies sealed token and cost ceilings with $name", async ({ overrides }) => {
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req) => { received = req; return succeeded(req, HOST); };
    // The sealed context seals maximumTokensPerAttempt 100 / maximumCostMicrosPerAttempt 10.
    await leg(invoke, providerRequest(overrides))(sealedCtx());
    const maxima = (received?.authorityRequest as { operationsPackRequest: { brokerMaximums: { modelTokens: number; modelCostUsd: number } } }).operationsPackRequest.brokerMaximums;
    expect(maxima.modelTokens).toBe(100);
    expect(maxima.modelCostUsd).toBe(0.00001);
  });

  it("deep-captures launch.artifact so a post-capture mutation cannot reach invoke", async () => {
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req) => { received = req; return succeeded(req, HOST); };
    const request = providerRequest();
    const promise = leg(invoke, request)(sealedCtx());
    const artifact = request.launch.artifact as { -readonly [K in keyof PlatformArtifactV1]: PlatformArtifactV1[K] };
    artifact.entrypointRelativePath = "/attacker"; artifact.artifactDigest = parseSha256Digest(`sha256:${"e".repeat(64)}`);
    await promise;
    const seen = received?.launch.artifact;
    expect(seen?.entrypointRelativePath).toBe("entry.js");
    expect(seen?.artifactDigest).toBe(PIN);
  });

  it("intersects the sealed broker ceiling into the invocation envelope before invoking", async () => {
    const s = await stageBrokerCapable();
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req) => { received = req; return succeeded(req, HOST); };
    const request = providerRequest({ brokers: { https: {} }, resourceBounds: { brokerRequests: 100 } });
    const run = providerLegRunner({ request, host: HOST, preparationRunId: s.binding.runId }, invoke);
    await executePhaseAttempt(attemptRequest(s, { leg: run }));
    await s.cleanup();
    expect((received?.authorityRequest.resourceBounds as { brokerRequests: number }).brokerRequests).toBe(2);
  });

  it("deep-captures data fields so a post-capture mutation cannot reach invoke", async () => {
    let received: ProviderInvocationRequestV1 | undefined;
    const invoke: ProviderInvokeFn = async (req) => { received = req; return succeeded(req, HOST); };
    const context = { k: "sealed" };
    const request = providerRequest({ operationContext: context });
    await leg(invoke, request)(sealedCtx());
    context.k = "hacked";
    expect((received?.operationContext as { k: string }).k).toBe("sealed");
  });

  it("fails closed when the request plans an effect the seal does not declare", async () => {
    const effectPlan = { schemaVersion: 1, bounds: {}, entries: [{ effectId: "e1" }] };
    await expect(leg(mustNotRun, providerRequest({ effectPlan }))(sealedCtx()))
      .rejects.toThrow(/effect plan the sealed authority does not declare/);
  });

  it("fails closed on a plan it cannot READ, rather than reading it as empty", async () => {
    // The grant resolver owns plan shape; a value this check cannot parse must
    // not slip past a check whose job is noticing unsealed claims.
    await expect(leg(mustNotRun, providerRequest({ effectPlan: { effects: [] } }))(sealedCtx()))
      .rejects.toThrow(/effect plan the sealed authority does not declare/);
  });

  it("ADMITS a plan that claims no effects, because it authorizes none", async () => {
    // The effective-grant request type always carries a plan object, so
    // requiring its absence made every effect-free provider phase unreachable:
    // it would fail closed no matter what the host sent. A zero-entry plan
    // claims nothing, whatever ceilings it states.
    const effectPlan = { schemaVersion: 1, bounds: {}, entries: [] };
    const outcome = await leg(succeeded, providerRequest({ effectPlan }))(sealedCtx());
    expect(outcome.phaseState).toBe("succeeded");
  });

  it("copies input-spec bytes so a caller mutation cannot change what invoke reads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const spec = { inputId: "in-1", kind: "file", provenanceLabel: "p", mediaType: "application/json", bytes };
    const exposure = providerInputSpecsContentExposureDigest([spec]);
    let delivered: Uint8Array | undefined;
    const invoke: ProviderInvokeFn = async (req) => {
      bytes[0] = 9; // mutate the caller's original buffer after validation
      delivered = (req.inputSpecs[0] as unknown as { bytes: Uint8Array }).bytes;
      return succeeded(req, HOST);
    };
    await leg(invoke, providerRequest({ inputSpecs: [spec] }))(sealedCtx(exposure));
    expect(delivered?.[0]).toBe(1);
  });
});
