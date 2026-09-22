/**
 * @file test/preparations/ephemeral-read-security.test.ts
 * @description The adversarial contract of executable ephemeral read, carrying the
 * two reproductions recorded against the REMOVED first version as mandatory
 * regressions: (a) an accessor/getter-swap invocation that reads benign at
 * validation and hostile at use must fail closed, and (b) an invocation that does
 * not match the sealed plan phase on ANY authority dimension — capability, pin,
 * contract, exposure, effect plan, broker surface, or executor kind — must be
 * rejected BEFORE any custody or launch. Every case asserts the provider was never
 * invoked and the private temporary root is empty.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEphemeralRead } from "../../src/preparations/ephemeral-execute.js";
import { readPreparationEvidence } from "../../src/preparations/evidence-store.js";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";
import { fakeRegistry, PIN, providerAuthority, providerRequest, stagePreparation } from "./attempt-fixture.js";
import {
  ephemeralProviderPlan, ephemeralRequest, ephemeralBrokerRequest, ephemeralTwoPhasePlan, HOST, runFixtureRead, withEphemeralSandbox,
} from "./ephemeral-fixture.js";

const HOSTILE_PIN = parseSha256Digest(`sha256:${"e".repeat(64)}`);
const USAGE = { brokerRequestCount: 0, tokenCount: "unobserved" as const, costMicros: "unobserved" as const };

/** A completed provider invocation producing no artifact, receipt, or usage. */
const succeededInvoke: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
  outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
  receipts: [], usage: USAGE, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });

/** Run one ephemeral read whose provider must never be reached. */
async function refuseWithoutLaunch(request: ProviderInvocationRequestV1, overrides = {}) {
  let launched = false;
  const invoke: ProviderInvokeFn = async () => { launched = true; throw new Error("must not run"); };
  const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest({
    work: { kind: "provider-capability", request, host: HOST }, ...overrides,
  }), invoke));
  return { result: run.result, residue: run.residue, launched };
}

/** One provider input spec the sealed empty exposure set does not cover. */
const UNSEALED_SPEC = { inputId: "in-1", kind: "file", provenanceLabel: "p", mediaType: "application/json", bytes: new Uint8Array([1, 2, 3]) };

/**
 * Every authority dimension the plan↔invocation binding must cover: a mismatch
 * on ANY of them is rejected before custody or launch. Completeness matters more
 * than any single case — a dimension missing from this table is unbound.
 */
const SURFACE_MISMATCHES: ReadonlyArray<readonly [string, () => ProviderInvocationRequestV1]> = [
  ["capability surface", () => providerRequest({ capabilityId: "exfiltrate" })],
  ["provider pin", () => providerRequest({ pin: HOSTILE_PIN })],
  ["input exposure", () => providerRequest({ inputSpecs: [UNSEALED_SPEC] })],
  ["effect plan", () => providerRequest({ effectPlan: { effects: [] } })],
  ["broker surface", () => providerRequest({ brokers: { https: {} } })],
];

/** Install an accessor that answers benign once and hostile on every later read. */
function swapAfterFirstRead(target: object, key: string, benign: unknown, hostile: unknown): void {
  let reads = 0;
  Object.defineProperty(target, key, {
    get: () => (reads++ === 0 ? benign : hostile), enumerable: true, configurable: true,
  });
}

describe("ephemeral read invocation binding", () => {
  it("fails closed on a getter-swap broker accessor (benign at validation, hostile at use)", async () => {
    const request = providerRequest();
    swapAfterFirstRead(request, "brokers", {}, { https: {} });
    const run = await refuseWithoutLaunch(request);
    expect(run.result).toEqual({ status: "refused", reason: "invocation-not-capturable" });
    expect(run.launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("fails closed on a getter-swap authority accessor", async () => {
    const request = providerRequest();
    swapAfterFirstRead(request.expectedIdentity as unknown as object, "providerPinDigest", PIN, HOSTILE_PIN);
    const run = await refuseWithoutLaunch(request);
    expect(run.result).toEqual({ status: "refused", reason: "invocation-not-capturable" });
    expect(run.launched).toBe(false);
  });

  it.each(SURFACE_MISMATCHES)("rejects an invocation whose %s is not the sealed phase's", async (_dimension, build) => {
    const run = await refuseWithoutLaunch(build());
    expect(run.result).toEqual({ status: "refused", reason: "invocation-rejected" });
    expect(run.launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("rejects broker adapters under a nonzero bound when the phase declares no broker plan", async () => {
    const plan = ephemeralProviderPlan(
      (phase) => { (phase.bounds as Record<string, number>).maximumBrokerRequestsPerAttempt = 1; },
      { maximumBrokerRequests: 2 },
    );
    const run = await refuseWithoutLaunch(providerRequest({ brokers: { https: {} } }), { plan });
    expect(run.result).toEqual({ status: "refused", reason: "invocation-rejected" });
    expect(run.launched).toBe(false);
  });

  it("admits the same broker adapters once the sealed phase declares that broker plan", async () => {
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralBrokerRequest("https"), succeededInvoke));
    expect(run.result.status).toBe("completed");
    expect(run.residue).toEqual([]);
  });

  it("rejects work whose kind is not the sealed executor's kind", async () => {
    const run = await withEphemeralSandbox(() => runEphemeralRead(ephemeralRequest({
      work: { kind: "host-handler", registry: fakeRegistry() },
    })));
    expect(run.result).toEqual({ status: "refused", reason: "work-kind-not-sealed-executor" });
    expect(run.residue).toEqual([]);
  });

  it("rejects an authority resolution that declares a mutating effect plan", async () => {
    const extras = providerAuthority({ effectPlanDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`) });
    const run = await refuseWithoutLaunch(providerRequest(), { authorityResolver: { resolve: async () => ({ status: "ok", extras }) } });
    expect(run.result).toEqual({ status: "refused", reason: "external-effect-required" });
    expect(run.launched).toBe(false);
  });

  it("rejects an authority resolution whose broker plan is not the sealed phase's", async () => {
    const extras = providerAuthority({ brokerPlanDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`) });
    const run = await refuseWithoutLaunch(providerRequest(), { authorityResolver: { resolve: async () => ({ status: "ok", extras }) } });
    expect(run.result).toEqual({ status: "refused", reason: "broker-plan-drift" });
    expect(run.launched).toBe(false);
  });

  it("parks the read rather than returning an outcome that reports an external effect", async () => {
    // The receipt only has to be countable here: any observed effect refuses.
    const invoke: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
      outcome: "succeeded", acceptedArtifacts: [], counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 1 },
      receipts: [{ outcome: "applied" } as never], usage: USAGE,
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), invoke));
    expect(run.result).toEqual({ status: "refused", reason: "external-effect-observed" });
    expect(run.residue).toEqual([]);
  });

  it("rejects a phase the plan's output contract does not declare as a producer", async () => {
    const run = await refuseWithoutLaunch(providerRequest(), { plan: ephemeralTwoPhasePlan(), logicalPhaseId: "collect" });
    expect(run.result).toEqual({ status: "refused", reason: "phase-not-declared-producer" });
    expect(run.launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("rejects a declared producer whose dependency phase would never have run", async () => {
    const run = await refuseWithoutLaunch(providerRequest(), { plan: ephemeralTwoPhasePlan(), logicalPhaseId: "second" });
    expect(run.result).toEqual({ status: "refused", reason: "phase-dependencies-unsatisfied" });
    expect(run.launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("rejects a request that smuggles its own provider runtime into the work", async () => {
    let launched = false;
    const rogue: ProviderInvokeFn = async () => { launched = true; throw new Error("must not run"); };
    // TypeScript alone cannot stop this: the field is refused at RUNTIME.
    const smuggled = {
      ...ephemeralRequest(),
      work: { kind: "provider-capability", request: providerRequest(), host: HOST, invoke: rogue },
    } as unknown as Parameters<typeof runEphemeralRead>[0];
    const run = await withEphemeralSandbox(() => runEphemeralRead(smuggled));
    expect(run.result).toEqual({ status: "refused", reason: "request-not-capturable" });
    expect(launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("rejects a phase that is not a single-expansion work phase", async () => {
    const plan = ephemeralProviderPlan();
    const gated = { ...plan, phases: [{ ...plan.phases[0]!, gate: { gateId: "review", gateKind: "review-preparation" as const } }] };
    const run = await withEphemeralSandbox(() => runEphemeralRead(ephemeralRequest({ plan: gated })));
    expect(run.result).toEqual({ status: "refused", reason: "durable-gate-required" });
    expect(run.residue).toEqual([]);
  });
});

describe("ephemeral read publication", () => {
  it("publishes the produced output to no preparation evidence CAS", async () => {
    const bytes = Buffer.from("ephemeral-output-never-published");
    const hex = createHash("sha256").update(bytes).digest("hex");
    const dir = await mkdtemp(path.join(tmpdir(), "ephemeral-out-"));
    await writeFile(path.join(dir, "out.json"), bytes);
    const staged = await stagePreparation();
    const invoke: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
      outcome: "succeeded",
      acceptedArtifacts: [{ outputId: "answer", mediaType: "application/json", digest: parseSha256Digest(`sha256:${hex}`), byteCount: bytes.byteLength,
        evidence: { evidencePath: path.join(dir, "out.json"), digest: parseSha256Digest(`sha256:${hex}`), byteCount: bytes.byteLength } }],
      counts: { declared: 1, acceptedArtifacts: 1, requiredMissing: 0, receipts: 0 },
      receipts: [], usage: USAGE, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), invoke));
    expect(run.result.status).toBe("completed");
    const location = { workspaceId: staged.binding.workspaceId, preparationId: staged.binding.preparationId };
    expect((await readPreparationEvidence(staged.root, location, hex)).status).toBe("absent");
    await staged.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});
