/**
 * @file test/operation-bundles/run-retirement-annotations.test.ts
 * @description Regression proofs that historical optional-work warnings and
 * informational notices survive honest post-effect retirement terminals while
 * remaining unavailable to pre-effect terminals and complete success.
 */

import { describe, expect, it } from "vitest";
import { compensationId, mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { appendOperationTransition, signOperationRun } from "../../src/operation-bundles/run-integrity.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { AppendOperationTransitionInput, OperationRunContent, ResidualFinding } from "../../src/operation-bundles/run-types.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { runFixture } from "./run-fixture.js";

const KEY = Buffer.alloc(32, 72);
const AT = "2026-07-18T01:30:00.000Z";
const DIGEST = `sha256:${"b".repeat(64)}` as OperationDigest;
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: ["operation-bundle.abandon"] };
const OWNER = { pid: 722, processStartTime: AT };
const EVIDENCE = { digest: DIGEST, byteCount: 1, type: "observation", provenance: "controller" };
type WarningCounts = Omit<Extract<AppendOperationTransitionInput["payload"], { kind: "warning" }>, "kind" | "code">;
const FAILED_WARNING: WarningCounts = { attempted: 1, completed: 0, skipped: 0, failed: 1 };

/** Append one transition through the same pure projection used by storage. */
function append(run: OperationRunContent, input: Omit<AppendOperationTransitionInput, "actor" | "at">): OperationRunContent {
  return appendOperationTransition(run, { ...input, actor: ACTOR, at: AT });
}

/** Start execution and record one optional failed projection plus both annotations. */
function annotatedApplying(warning: WarningCounts = FAILED_WARNING) {
  const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 1, optionalProjectionCount: 1, compensatorIndices: [0] });
  let run = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
  run = append(run, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  const mutation = mutationId(base.bundleId, 0), projection = mutationId(base.bundleId, 1);
  run = append(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: mutation } });
  run = append(run, { type: "mutation-applied", stateAfter: "applying", payload: { kind: "mutation", mutationId: mutation, evidence: EVIDENCE } });
  run = append(run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional" } });
  run = append(run, { type: "projection-failed", stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional", evidence: EVIDENCE } });
  run = append(run, { type: "warning-recorded", stateAfter: "applying", payload: { kind: "warning", code: "optional-failed", ...warning } });
  run = append(run, { type: "notice-recorded", stateAfter: "applying", payload: { kind: "notice", code: "retry-observed" } });
  return { base, run, mutation, projection };
}

/** Start one optional projection without settling or annotating it. */
function startedOptionalProjection() {
  const base = runFixture({ key: KEY, actor: ACTOR, at: AT, optionalProjectionCount: 1 });
  let run = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
  run = append(run, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  const projection = mutationId(base.bundleId, 0);
  run = append(run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional" } });
  return { base, run, projection };
}

/** Parse one signed fixture through production run validation. */
function parseFixture(run: OperationRunContent, base: ReturnType<typeof runFixture>) {
  return parseOperationRun(JSON.stringify(signOperationRun(KEY, run)), base.binding);
}

/** Complete the declared compensator and enter the compensated terminal. */
function compensated(warning?: WarningCounts): ReturnType<typeof annotatedApplying> {
  const fixture = annotatedApplying(warning);
  const compensation = compensationId(fixture.mutation);
  let run = append(fixture.run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  run = append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: fixture.mutation } });
  run = append(run, { type: "compensation-completed", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: fixture.mutation, evidence: EVIDENCE } });
  return { ...fixture, run: append(run, { type: "compensated", stateAfter: "compensated", payload: { kind: "none" } }) };
}

/** Settle a parked annotated run by one distinct recovery proof. */
function recovered(warning?: WarningCounts): ReturnType<typeof annotatedApplying> {
  const fixture = annotatedApplying(warning);
  const parked = append(fixture.run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
  const payload = { kind: "recovery" as const, bundleId: mintBundleId(), runId: mintOperationRunId(), manifestDigest: DIGEST, terminalState: "succeeded" as const, stateVersion: 4, chainTip: DIGEST };
  return { ...fixture, run: append(parked, { type: "recovered", stateAfter: "recovered", payload }) };
}

/** Settle a parked annotated run with exact compact residual evidence. */
function abandoned(warning?: WarningCounts): ReturnType<typeof annotatedApplying> {
  const fixture = annotatedApplying(warning);
  const parked = append(fixture.run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
  const findings: ResidualFinding[] = [fixture.mutation, fixture.projection].map((id) => ({ code: "residual", mutationId: id, authoritativeNamespace: id === fixture.mutation ? "workspace-sources" : "workspace-projections", evidence: EVIDENCE }));
  const findingsDigest = canonicalDigest({ schemaVersion: 1, kind: "operation-run-residual-findings", findings }) as OperationDigest;
  return { ...fixture, run: append(parked, { type: "abandoned", stateAfter: "abandoned", residualFindings: findings, payload: { kind: "abandonment", confirmation: "confirm-residual-state", findingCount: findings.length, findingsDigest } }) };
}

describe("post-effect annotation retirement", () => {
  it.each([
    ["compensated", compensated], ["recovered", recovered], ["abandoned", abandoned],
  ] as const)("retains warning and notice history through %s", (_state, build) => {
    const fixture = build();
    const parsed = parseOperationRun(JSON.stringify(signOperationRun(KEY, fixture.run)), fixture.base.binding);
    expect(parsed).toMatchObject({ state: _state, completionWarnings: [{ code: "optional-failed" }], notices: [{ code: "retry-observed" }] });
  });

  it.each([
    ["compensated", compensated], ["recovered", recovered], ["abandoned", abandoned],
  ] as const)("rejects warning counts that contradict %s projection history", (_state, build) => {
    const fixture = build({ attempted: 1, completed: 1, skipped: 0, failed: 0 });
    expect(() => parseOperationRun(JSON.stringify(signOperationRun(KEY, fixture.run)), fixture.base.binding))
      .toThrow(/warning.*reconcile|optional.*outcome/i);
  });

  it("rejects unsupported warning counts while applying", () => {
    const fixture = startedOptionalProjection();
    let run = append(fixture.run, { type: "projection-failed", stateAfter: "applying", payload: { kind: "projection", mutationId: fixture.projection, criticality: "optional", evidence: EVIDENCE } });
    run = append(run, { type: "warning-recorded", stateAfter: "applying", payload: { kind: "warning", code: "optional-failed", attempted: 1, completed: 1, skipped: 0, failed: 0 } });
    expect(() => parseFixture(run, fixture.base)).toThrow(/warning.*reconcile|optional.*outcome/i);
  });

  it("rejects unsupported warning counts after the run parks", () => {
    const fixture = startedOptionalProjection();
    let run = append(fixture.run, { type: "warning-recorded", stateAfter: "applying", payload: { kind: "warning", code: "optional-failed", ...FAILED_WARNING } });
    run = append(run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    expect(() => parseFixture(run, fixture.base)).toThrow(/warning.*reconcile|optional.*outcome/i);
  });

  it("rejects a warning that preclaims a later optional failure", () => {
    const fixture = startedOptionalProjection();
    let run = append(fixture.run, { type: "warning-recorded", stateAfter: "applying", payload: { kind: "warning", code: "optional-failed", ...FAILED_WARNING } });
    run = append(run, { type: "projection-failed", stateAfter: "applying", payload: { kind: "projection", mutationId: fixture.projection, criticality: "optional", evidence: EVIDENCE } });
    expect(() => parseFixture(run, fixture.base)).toThrow(/warning.*reconcile|optional.*outcome/i);
  });
});
