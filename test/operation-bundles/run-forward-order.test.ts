/**
 * @file test/operation-bundles/run-forward-order.test.ts
 * @description Forward-execution ordering and compensation-history terminal
 * regressions for manifest-bound operation runs.
 */

import { describe, expect, it } from "vitest";
import { mutationId } from "../../src/operation-bundles/ids.js";
import { appendOperationTransition, signOperationRun } from "../../src/operation-bundles/run-integrity.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { AppendOperationTransitionInput, OperationRunContent } from "../../src/operation-bundles/run-types.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { runFixture } from "./run-fixture.js";

const KEY = Buffer.alloc(32, 45);
const AT = "2026-07-17T04:00:00.000Z";
const DIGEST = `sha256:${"9".repeat(64)}` as OperationDigest;
const ACTOR: OperationPrincipal = { id: "forward-order", surface: "cli", grants: [] };
const OWNER = { pid: 505, processStartTime: AT };
const EVIDENCE = { digest: DIGEST, byteCount: 1, type: "observation", provenance: "forward-order" };

interface WorkShape {
  authoritative?: number;
  requiredProjections?: number;
  optionalProjections?: number;
  compensators?: readonly number[];
}

/** Append one deterministic test transition through the production projector. */
function record(run: OperationRunContent, input: Omit<AppendOperationTransitionInput, "actor" | "at">) {
  return appendOperationTransition(run, { ...input, actor: ACTOR, at: AT });
}

/** Create one approved and applying run with the requested obligation shape. */
function liveRun(shape: WorkShape = {}) {
  const base = runFixture({
    key: KEY, actor: ACTOR, at: AT,
    authoritativeMutationCount: shape.authoritative ?? 0,
    requiredProjectionCount: shape.requiredProjections ?? 0,
    optionalProjectionCount: shape.optionalProjections ?? 0,
    compensatorIndices: shape.compensators ?? [],
  });
  const approved = record(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
  const run = record(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  return { ...base, run };
}

/** Start and settle one authoritative identity with bounded evidence. */
function finishMutation(run: OperationRunContent, id: ReturnType<typeof mutationId>, status: "applied" | "skipped-idempotent" | "failed") {
  const started = record(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
  return record(started, { type: `mutation-${status}`, stateAfter: "applying", payload: { kind: "mutation", mutationId: id, evidence: EVIDENCE } });
}

/** Start and settle one projection identity with immutable criticality. */
function finishProjection(run: OperationRunContent, id: ReturnType<typeof mutationId>, criticality: "required" | "optional", status: "applied" | "skipped-idempotent" | "failed") {
  const payload = { kind: "projection" as const, mutationId: id, criticality };
  const started = record(run, { type: "projection-started", stateAfter: "applying", payload });
  return record(started, { type: `projection-${status}`, stateAfter: "applying", payload: { ...payload, evidence: EVIDENCE } });
}

/** Park one active run and resume it with the unchanged approved authority. */
function parkAndResume(run: OperationRunContent) {
  const parked = record(run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
  return record(parked, { type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
}

/** Sign and parse one projected run through the production validation path. */
function parse(run: OperationRunContent, binding: ReturnType<typeof runFixture>["binding"]) {
  return parseOperationRun(JSON.stringify(signOperationRun(KEY, run)), binding);
}

describe("operation run forward ordering", () => {
  it("rejects overlapping authoritative mutation starts", () => {
    const base = liveRun({ authoritative: 2 });
    const first = mutationId(base.bundleId, 0), second = mutationId(base.bundleId, 1);
    let run = record(base.run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: first } });
    run = record(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: second } });
    expect(() => parse(run, base.binding)).toThrow(/one forward identity|forward.*started/i);
  });

  it.each(["absent", "failed"] as const)("blocks the next mutation when its predecessor is %s", (prior) => {
    const base = liveRun({ authoritative: 2 });
    const first = mutationId(base.bundleId, 0), second = mutationId(base.bundleId, 1);
    const beforeNext = prior === "failed" ? finishMutation(base.run, first, "failed") : base.run;
    const run = record(beforeNext, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: second } });
    expect(() => parse(run, base.binding)).toThrow(/authoritative mutation.*order/i);
  });

  it("rejects a projection before authoritative work settles", () => {
    const base = liveRun({ authoritative: 1, optionalProjections: 1 });
    const projection = mutationId(base.bundleId, 1);
    const run = record(base.run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional" } });
    expect(() => parse(run, base.binding)).toThrow(/authoritative.*before projection/i);
  });

  it("rejects an out-of-order projection start", () => {
    const base = liveRun({ optionalProjections: 2 });
    const second = mutationId(base.bundleId, 1);
    const run = record(base.run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: second, criticality: "optional" } });
    expect(() => parse(run, base.binding)).toThrow(/projection.*order/i);
  });

  it("rejects overlapping projection starts", () => {
    const base = liveRun({ optionalProjections: 2 });
    const first = mutationId(base.bundleId, 0), second = mutationId(base.bundleId, 1);
    let run = record(base.run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: first, criticality: "optional" } });
    run = record(run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: second, criticality: "optional" } });
    expect(() => parse(run, base.binding)).toThrow(/one forward identity|forward.*started/i);
  });

  it("rejects projection-failed for a required projection", () => {
    const base = liveRun({ requiredProjections: 1 });
    const required = mutationId(base.bundleId, 0);
    const failed = finishProjection(base.run, required, "required", "failed");
    expect(() => parse(failed, base.binding)).toThrow(/required projection.*failed|failure.*optional/i);
  });

  it("resumes one started required projection and settles it forward", () => {
    const base = liveRun({ requiredProjections: 1 });
    const required = mutationId(base.bundleId, 0);
    const payload = { kind: "projection" as const, mutationId: required, criticality: "required" as const };
    let run = record(base.run, { type: "projection-started", stateAfter: "applying", payload });
    run = parkAndResume(run);
    run = record(run, { type: "projection-applied", stateAfter: "applying", payload: { ...payload, evidence: EVIDENCE } });
    run = record(run, { type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" } });
    expect(parse(run, base.binding).state).toBe("succeeded");
  });

  it("accepts ordered authoritative work followed by ordered projections", () => {
    const base = liveRun({ authoritative: 3, optionalProjections: 2 });
    const ids = [0, 1, 2, 3, 4].map((index) => mutationId(base.bundleId, index));
    let run = finishMutation(base.run, ids[0]!, "skipped-idempotent");
    run = finishMutation(run, ids[1]!, "applied");
    run = finishMutation(run, ids[2]!, "applied");
    run = finishProjection(run, ids[3]!, "optional", "failed");
    run = finishProjection(run, ids[4]!, "optional", "applied");
    const parsed = parse(run, base.binding);
    const applied = parsed.mutationOutcomes.filter((item) => item.status === "applied");
    expect(applied[0]!.transitionSequence).toBeLessThan(applied[1]!.transitionSequence);
  });

  it("rejects success after compensation began without an outcome", () => {
    const base = liveRun({ authoritative: 1, compensators: [0] });
    const mutation = mutationId(base.bundleId, 0);
    let run = finishMutation(base.run, mutation, "applied");
    run = record(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    run = parkAndResume(run);
    run = record(run, { type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" } });
    expect(() => parse(run, base.binding)).toThrow(/success.*compensation-began/i);
  });
});
