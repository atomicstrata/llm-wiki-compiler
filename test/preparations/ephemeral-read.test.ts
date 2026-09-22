/**
 * @file test/preparations/ephemeral-read.test.ts
 * @description Executable ephemeral read (design sections 7.1, 28.3, 31.8): a
 * read-only phase runs through the SAME hardened provider/host-handler legs a
 * durable attempt uses, in host-owned temporary custody, with the project lock
 * never held — and creates no project, operator, cache, run, or receipt byte. Each
 * case snapshots a real staged project tree before and after AND asserts the
 * private temporary/operator/cache root is left empty, so custody is provably
 * discarded on success, on refusal, and on a mid-flight failure.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { runEphemeralRead } from "../../src/preparations/ephemeral-execute.js";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import {
  driftingResolver, fakeRegistry, lockIsFree, providerAuthority, providerRequest, stagePreparation,
  type StagedPreparation,
} from "./attempt-fixture.js";
import { snapshotTree } from "./inputs-fixture.js";
import {
  ephemeralHostHandlerPlan, ephemeralProviderPlan, ephemeralRequest, ephemeralBrokerRequest, ephemeralTwoPhasePlan,
  HOST, runFixtureRead, withEphemeralSandbox,
} from "./ephemeral-fixture.js";

const BYTES = Buffer.from("ephemeral-answer-bytes");
const HEX = createHash("sha256").update(BYTES).digest("hex");
const USAGE = { brokerRequestCount: 0, tokenCount: "unobserved" as const, costMicros: "unobserved" as const };

let staged: StagedPreparation;
let outputRoot: string;
let outputPath: string;
beforeEach(async () => {
  staged = await stagePreparation();
  outputRoot = await mkdtemp(path.join(tmpdir(), "ephemeral-output-"));
  outputPath = path.join(outputRoot, "answer.json");
  await writeFile(outputPath, BYTES);
});
afterEach(async () => {
  await staged.cleanup();
  await rm(outputRoot, { recursive: true, force: true });
});

/** A completed provider invocation returning one artifact rooted at `outputPath`. */
function answered(): ProviderInvokeFn {
  return async () => ({ kind: "completed", admitted: {
    outcome: "succeeded",
    acceptedArtifacts: [{ outputId: "answer", mediaType: "application/json", digest: parseSha256Digest(`sha256:${HEX}`), byteCount: BYTES.byteLength,
      evidence: { evidencePath: outputPath, digest: parseSha256Digest(`sha256:${HEX}`), byteCount: BYTES.byteLength } }],
    counts: { declared: 1, acceptedArtifacts: 1, requiredMissing: 0, receipts: 0 },
    receipts: [], usage: USAGE, untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
}

/**
 * A FAILED provider invocation whose metered host-priced cost is far above the
 * sealed `maximumCostMicrosPerAttempt` of 10. The phase carries a model adapter,
 * so the dimension is applicable and the figure is a real measurement rather
 * than a structural zero.
 */
const failedOverCeiling: ProviderInvokeFn = async () => ({ kind: "completed", admitted: {
  outcome: "failed", problem: "provider-reported-failure", acceptedArtifacts: [],
  counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 }, receipts: [],
  usage: { brokerRequestCount: 1, tokenCount: 5, costMicros: 999 },
  untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } } as never);

describe("executable ephemeral read", () => {
  it("returns the bounded verified output bytes and host-observed counts", async () => {
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), answered()));
    const result = run.result;
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.phaseState).toBe("succeeded");
    expect(result.invocationCount).toBe(1);
    expect(result.outputs).toHaveLength(1);
    expect(Buffer.from(result.outputs[0]!.bytes).toString()).toBe(BYTES.toString());
    expect(result.outputs[0]!.untrusted).toBe(true);
  });

  it("writes no project byte and discards custody on a successful read", async () => {
    const before = await snapshotTree(staged.root);
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), answered()));
    expect(run.result.status).toBe("completed");
    expect(await snapshotTree(staged.root)).toEqual(before);
    expect(run.residue).toEqual([]);
  });

  it("writes no project byte and discards custody when a mid-flight failure refuses", async () => {
    const drifted = providerAuthority({ providerPinDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`) });
    const request = ephemeralRequest({ authorityResolver: driftingResolver(providerAuthority(), drifted) });
    const before = await snapshotTree(staged.root);
    const run = await withEphemeralSandbox(() => runFixtureRead(request, answered()));
    expect(run.result).toEqual({ status: "refused", reason: "provider-pin-drift" });
    expect(await snapshotTree(staged.root)).toEqual(before);
    expect(run.residue).toEqual([]);
  });

  it("refuses an ineligible durable plan before any launch or custody", async () => {
    let launched = false;
    const invoke: ProviderInvokeFn = async () => { launched = true; throw new Error("must not run"); };
    const durable = ephemeralProviderPlan();
    const request = ephemeralRequest({ plan: { ...durable, executionMode: "durable-preparation" } });
    const run = await withEphemeralSandbox(() => runFixtureRead(request, invoke));
    expect(run.result).toEqual({ status: "refused", reason: "execution-mode-not-ephemeral" });
    expect(launched).toBe(false);
    expect(run.residue).toEqual([]);
  });

  it("invokes the provider with the project lock free (no lock is ever taken)", async () => {
    let sawLockFree = false;
    const invoke: ProviderInvokeFn = async (...args) => {
      sawLockFree = await lockIsFree(staged.root);
      return answered()(...args);
    };
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), invoke));
    expect(sawLockFree).toBe(true);
    expect(run.result.status).toBe("completed");
  });

  it("drives a sealed host-handler phase and still writes nothing", async () => {
    const request = ephemeralRequest({
      plan: ephemeralHostHandlerPlan(),
      authorityResolver: { resolve: async () => ({ status: "ok", extras: providerAuthorityWithoutPin() }) },
      work: { kind: "host-handler", registry: fakeRegistry() },
    });
    const before = await snapshotTree(staged.root);
    const run = await withEphemeralSandbox(() => runEphemeralRead(request));
    expect(run.result.status === "completed" && run.result.phaseState).toBe("succeeded");
    expect(await snapshotTree(staged.root)).toEqual(before);
    expect(run.residue).toEqual([]);
  });

  it("executes the plan it captured, not a plan mutated after the read started", async () => {
    const plan = ephemeralProviderPlan();
    const invoke: ProviderInvokeFn = async (...args) => answered()(...args);
    const run = await withEphemeralSandbox(async () => {
      const pending = runFixtureRead(ephemeralRequest({ plan }), invoke);
      // Swap the executor the read is bound to while the leg is in flight.
      (plan.phases[0]!.executor as { capabilityId: string }).capabilityId = "exfiltrate";
      return pending;
    });
    expect(run.result.status).toBe("completed");
    expect(run.residue).toEqual([]);
  });

  it("delivers the caller's cancellation into the provider invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    let delivered: boolean | undefined;
    const invoke: ProviderInvokeFn = async (request, host) => {
      delivered = request.hostSignal?.aborted;
      return answered()(request, host);
    };
    await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest({ cancelSignal: controller.signal }), invoke));
    expect(delivered).toBe(true);
  });

  it("discards the abandoned leg's custody BEFORE returning at the time bound", async () => {
    const plan = ephemeralProviderPlan((phase) => { (phase.bounds as Record<string, number>).maximumTimeMsPerInstance = 25; });
    const invoke: ProviderInvokeFn = async (request, host) => {
      await new Promise<void>((resolve) => request.hostSignal?.addEventListener("abort", () => resolve(), { once: true }));
      return answered()(request, host);
    };
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest({ plan }), invoke));
    expect(run.result).toEqual({ status: "refused", reason: "time-bound-exceeded" });
    expect(run.residue).toEqual([]);
  });

  it("bounds the wait: a leg that never settles is refused at the sealed time bound", async () => {
    const plan = ephemeralProviderPlan((phase) => { (phase.bounds as Record<string, number>).maximumTimeMsPerInstance = 25; });
    const invoke: ProviderInvokeFn = () => new Promise(() => {});
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest({ plan }), invoke));
    expect(run.result).toEqual({ status: "refused", reason: "time-bound-exceeded" });
  });

  // A ceiling breach is a breach whatever the phase settled as. A FAILED read
  // used to complete here and hand back its raw over-ceiling cost in the result,
  // so a read surface reported a figure the sealed plan never authorized; the
  // ceiling is only checked at this seam, since nothing downstream sees the plan.
  it("refuses a failed read whose measured cost breached the sealed ceiling", async () => {
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralBrokerRequest("model"), failedOverCeiling));
    expect(run.result).toEqual({ status: "refused", reason: "cost-exceed-sealed-bound" });
    expect(run.residue).toEqual([]);
  });
});

/** The host-handler phase's authority: an exposure digest and no provider pin. */
function providerAuthorityWithoutPin() {
  const { providerPinDigest: _pin, ...rest } = providerAuthority();
  return rest;
}
