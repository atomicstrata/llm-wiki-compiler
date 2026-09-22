/**
 * @file test/operation-bundles/run-terminal.test.ts
 * @description Controller-level terminal-proof, authority-owner, and exact
 * manifest-identity regressions for operation-run semantic validation.
 */

import { describe, expect, it } from "vitest";
import { compensationId, mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { appendOperationTransition, signOperationRun } from "../../src/operation-bundles/run-integrity.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import { residualFindingsDigest } from "../../src/operation-bundles/run-residuals.js";
import type { AppendOperationTransitionInput, OperationRunContent } from "../../src/operation-bundles/run-types.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { runFixture } from "./run-fixture.js";

const KEY = Buffer.alloc(32, 44);
const AT = "2026-07-17T03:00:00.000Z";
const DIGEST = `sha256:${"7".repeat(64)}` as OperationDigest;
const OTHER_DIGEST = `sha256:${"8".repeat(64)}` as OperationDigest;
const ACTOR: OperationPrincipal = { id: "operator", surface: "cli", grants: [] };
const ABANDONER: OperationPrincipal = { ...ACTOR, grants: ["operation-bundle.abandon"] };
const OWNER = { pid: 404, processStartTime: AT };
const EVIDENCE = { digest: DIGEST, byteCount: 1, type: "observation", provenance: "controller" };

/** Append one deterministic transition through the production projector. */
function append(run: OperationRunContent, input: Omit<AppendOperationTransitionInput, "actor" | "at">, actor = ACTOR) {
  return appendOperationTransition(run, { ...input, actor, at: AT });
}

/** Build one approved applying run with bounded manifest obligations. */
function applying(authoritativeMutationCount = 0, compensatorIndices: readonly number[] = [], controlTransitionAllowance = 32, optionalProjectionCount = 0) {
  const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount, compensatorIndices, controlTransitionAllowance, optionalProjectionCount });
  const approved = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
  const run = append(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  return { ...base, run };
}

/** Build a compensated terminal with optional compensator evidence. */
function compensatedRun(withEvidence: boolean, controlTransitionAllowance = 32) {
  const base = applying(1, [0], controlTransitionAllowance);
  const id = mutationId(base.bundleId, 0), compensation = compensationId(id);
  let run = append(base.run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
  run = append(run, { type: "mutation-applied", stateAfter: "applying", payload: { kind: "mutation", mutationId: id, evidence: EVIDENCE } });
  run = append(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
  run = append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: id } });
  const evidence = withEvidence ? { evidence: EVIDENCE } : {};
  run = append(run, { type: "compensation-completed", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: id, ...evidence } });
  return { ...base, run: append(run, { type: "compensated", stateAfter: "compensated", payload: { kind: "none" } }) };
}

/** Sign and parse one projected run through production validation. */
function parse(run: OperationRunContent, binding: ReturnType<typeof runFixture>["binding"]) { return parseOperationRun(JSON.stringify(signOperationRun(KEY, run)), binding); }

/** Start and settle one authoritative mutation outcome. */
function terminalMutation(run: OperationRunContent, id: ReturnType<typeof mutationId>, type: "mutation-applied" | "mutation-skipped-idempotent" | "mutation-failed") {
  const started = append(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
  return append(started, { type, stateAfter: "applying", payload: { kind: "mutation", mutationId: id, evidence: EVIDENCE } });
}

/** Enter compensation under the unchanged approved authority snapshot. */
function beginCompensation(run: OperationRunContent) { return append(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } }); }

/** Park then resume one run under its unchanged authority snapshot. */
function parkAndResume(run: OperationRunContent) {
  const parked = append(run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
  return append(parked, { type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
}

/** Start the declared compensator for one mutation. */
function startCompensation(run: OperationRunContent, id: ReturnType<typeof mutationId>) {
  return append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensationId(id), mutationId: id } });
}

/** Settle one compensator with evidence as completed or failed. */
function finishCompensation(run: OperationRunContent, id: ReturnType<typeof mutationId>, type: "compensation-completed" | "compensation-failed" = "compensation-completed") {
  return append(run, { type, stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensationId(id), mutationId: id, evidence: EVIDENCE } });
}

/** Build two applied mutations in declared forward order. */
function twoAppliedMutations(compensatorIndices: readonly number[] = [0, 1]) {
  const base = applying(2, compensatorIndices);
  const ids = [0, 1].map((index) => mutationId(base.bundleId, index));
  const first = terminalMutation(base.run, ids[0]!, "mutation-applied");
  return { base, ids, run: terminalMutation(first, ids[1]!, "mutation-applied") };
}

/** Build one applied mutation at the compensation-entry boundary. */
function compensationReady(authoritativeMutationCount = 1, optionalProjectionCount = 0) {
  const base = applying(authoritativeMutationCount, [0], 32, optionalProjectionCount);
  const id = mutationId(base.bundleId, 0);
  const applied = terminalMutation(base.run, id, "mutation-applied");
  return { base, id, run: beginCompensation(applied) };
}

/** Build an applied mutation plus one projection in the requested state. */
function appliedMutationAndProjection(status: "started" | "applied" | "skipped-idempotent" | "failed") {
  const base = applying(1, [0], 32, 1);
  const mutation = mutationId(base.bundleId, 0), projection = mutationId(base.bundleId, 1);
  let run = terminalMutation(base.run, mutation, "mutation-applied");
  run = append(run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional" } });
  if (status !== "started") run = append(run, { type: `projection-${status}`, stateAfter: "applying", payload: { kind: "projection", mutationId: projection, criticality: "optional", evidence: EVIDENCE } });
  return { base, run };
}

/** Append the compensated terminal edge to a fully neutralized run. */
function settleCompensated(run: OperationRunContent) { return append(run, { type: "compensated", stateAfter: "compensated", payload: { kind: "none" } }); }

/** Start, finish, and terminally settle the remaining compensator. */
function finishRemainingAndSettle(run: OperationRunContent, id: ReturnType<typeof mutationId>) { return settleCompensated(finishCompensation(startCompensation(run, id), id)); }

/** Build one evidence-bearing residual finding for a work identity. */
function residualFinding(id: ReturnType<typeof mutationId>) {
  return { code: "residual", mutationId: id, authoritativeNamespace: "wiki", evidence: EVIDENCE };
}

/** Build the compact abandonment edge and its out-of-envelope details. */
function abandonment(findings: ReturnType<typeof residualFinding>[]) {
  return {
    type: "abandoned" as const, stateAfter: "abandoned" as const, residualFindings: findings,
    payload: { kind: "abandonment" as const, confirmation: "confirm-residual-state" as const,
      findingCount: findings.length, findingsDigest: residualFindingsDigest(findings) },
  };
}

describe("operation run terminal proofs", () => {
  it("requires approval authority and applying owner payloads", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT });
    const approvalWithoutAuthority = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "none" } });
    expect(() => parse(approvalWithoutAuthority, base.binding)).toThrow(/authoritySnapshotDigest|payload kind|closed state edge/);
    const approved = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
    const applyWithoutOwner = append(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "none" } });
    expect(() => parse(applyWithoutOwner, base.binding)).toThrow(/authoritySnapshotDigest|payload kind|closed state edge/);
  });

  it("rejects an applying record whose owner was removed and re-signed", () => {
    const { run, binding } = applying();
    const { applyOwner: _owner, ...withoutOwner } = run;
    expect(() => parse(withoutOwner, binding)).toThrow(/authority or apply owner|applyOwner/);
  });

  it("rejects execution transitions that replace approved authority", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT });
    const approved = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
    const live = append(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    const driftedApply = append(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: OTHER_DIGEST, applyOwner: OWNER } });
    expect(() => parse(driftedApply, base.binding)).toThrow(/authority.*approved|authority.*changed/i);
    const parked = append(live, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    const driftedResume = append(parked, { type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: OTHER_DIGEST, applyOwner: OWNER } });
    expect(() => parse(driftedResume, base.binding)).toThrow(/authority.*approved|authority.*changed/i);
    const driftedCompensation = append(live, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: OTHER_DIGEST, applyOwner: OWNER } });
    expect(() => parse(driftedCompensation, base.binding)).toThrow(/authority.*approved|authority.*changed/i);
  });

  it.each(["mutation-applied", "mutation-skipped-idempotent", "mutation-failed"] as const)(
    "requires evidence on %s",
    (type) => {
      const base = applying(1);
      const id = mutationId(base.bundleId, 0);
      const started = append(base.run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
      const terminal = append(started, { type, stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
      expect(() => parse(terminal, base.binding)).toThrow(/evidence/i);
    },
  );

  it.each(["projection-applied", "projection-skipped-idempotent", "projection-failed"] as const)(
    "requires evidence on %s",
    (type) => {
      const base = applying(0, [], 32, 1);
      const id = mutationId(base.bundleId, 0);
      const started = append(base.run, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: id, criticality: "optional" } });
      const terminal = append(started, { type, stateAfter: "applying", payload: { kind: "projection", mutationId: id, criticality: "optional" } });
      expect(() => parse(terminal, base.binding)).toThrow(/evidence/i);
    },
  );

  it("requires completed compensation evidence for every applied effect", () => {
    const base = compensatedRun(false);
    expect(() => parse(base.run, base.binding)).toThrow(/compensation.*evidence|bounded evidence/i);
  });

  it("accepts compensation only after the completed transition carries evidence", () => {
    const base = compensatedRun(true);
    expect(parse(base.run, base.binding).state).toBe("compensated");
  });

  it("retains park and terminal headroom after compensation begins", () => {
    const base = compensatedRun(true, 3);
    expect(parse(base.run, base.binding).state).toBe("compensated");
  });

  it.each(["unattempted", "started", "skipped-idempotent", "failed"] as const)(
    "refuses compensation-started for a %s mutation",
    (status) => {
      const base = applying(1, [0]);
      const id = mutationId(base.bundleId, 0), compensation = compensationId(id);
      let run = base.run;
      if (status !== "unattempted") run = append(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } });
      if (status === "skipped-idempotent" || status === "failed") run = append(run, { type: `mutation-${status}`, stateAfter: "applying", payload: { kind: "mutation", mutationId: id, evidence: EVIDENCE } });
      run = append(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
      run = append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: id } });
      const refusal = status === "started" ? /started authoritative mutation/i : /compensation.*applied mutation/i;
      expect(() => parse(run, base.binding)).toThrow(refusal);
    },
  );

  it("requires evidence when a compensation fails", () => {
    const base = applying(1, [0]);
    const id = mutationId(base.bundleId, 0), compensation = compensationId(id);
    let run = terminalMutation(base.run, id, "mutation-applied");
    run = append(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    run = append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: id } });
    run = append(run, { type: "compensation-failed", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: id } });
    expect(() => parse(run, base.binding)).toThrow(/evidence/i);
  });

  it("requires every applied mutation to declare a compensator before compensation begins", () => {
    const { base, run: applied } = twoAppliedMutations([0]);
    const run = beginCompensation(applied);
    expect(() => parse(run, base.binding)).toThrow(/every applied mutation.*declared compensator/i);
  });

  it("rejects direct and resumed compensation while another mutation remains started", () => {
    const base = applying(2, [0]);
    const applied = mutationId(base.bundleId, 0), unsettled = mutationId(base.bundleId, 1);
    let run = terminalMutation(base.run, applied, "mutation-applied");
    run = append(run, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: unsettled } });
    expect(() => parse(beginCompensation(run), base.binding)).toThrow(/started authoritative mutation/i);
    run = parkAndResume(run);
    expect(() => parse(beginCompensation(run), base.binding)).toThrow(/started authoritative mutation/i);
  });

  it.each(["started", "applied"] as const)("rejects compensation with a %s projection", (status) => {
    const { base, run: projected } = appliedMutationAndProjection(status);
    const run = beginCompensation(projected);
    expect(() => parse(run, base.binding)).toThrow(/started or applied projection/i);
  });

  it.each(["skipped-idempotent", "failed"] as const)("preserves compensation entry with a %s projection", (status) => {
    const { base, run: projected } = appliedMutationAndProjection(status);
    expect(parse(beginCompensation(projected), base.binding).state).toBe("compensating");
  });

  it("rejects compensation in forward mutation-application order", () => {
    const { base, ids, run: applied } = twoAppliedMutations();
    const run = startCompensation(beginCompensation(applied), ids[0]!);
    expect(() => parse(run, base.binding)).toThrow(/reverse mutation-application order/i);
  });

  it("rejects parallel compensation starts", () => {
    const { base, ids, run: applied } = twoAppliedMutations();
    let run = startCompensation(beginCompensation(applied), ids[1]!);
    run = startCompensation(run, ids[0]!);
    expect(() => parse(run, base.binding)).toThrow(/prior compensation.*settled/i);
  });

  it("does not advance compensation after a failed compensator", () => {
    const { base, ids, run: applied } = twoAppliedMutations();
    let run = startCompensation(beginCompensation(applied), ids[1]!);
    run = finishCompensation(run, ids[1]!, "compensation-failed");
    run = startCompensation(run, ids[0]!);
    expect(() => parse(run, base.binding)).toThrow(/prior compensation.*settled/i);
  });

  it("compensates sequentially in reverse mutation-application order", () => {
    const { base, ids, run: applied } = twoAppliedMutations();
    let run = finishCompensation(startCompensation(beginCompensation(applied), ids[1]!), ids[1]!);
    run = finishRemainingAndSettle(run, ids[0]!);
    expect(parse(run, base.binding).state).toBe("compensated");
  });

  it("resumes reverse order after completed compensations without replaying them", () => {
    const { base, ids, run: applied } = twoAppliedMutations();
    let run = finishCompensation(startCompensation(beginCompensation(applied), ids[1]!), ids[1]!);
    run = parkAndResume(run);
    run = finishRemainingAndSettle(beginCompensation(run), ids[0]!);
    expect(parse(run, base.binding).state).toBe("compensated");
  });
  it.each(["mutation", "projection"] as const)("rejects new %s work after compensation recovery", (kind) => {
    const { base, run: compensating } = compensationReady(2, 1);
    const id = mutationId(base.bundleId, kind === "mutation" ? 1 : 2);
    const resumed = parkAndResume(compensating);
    const run = kind === "mutation" ? append(resumed, { type: "mutation-started", stateAfter: "applying", payload: { kind: "mutation", mutationId: id } })
      : append(resumed, { type: "projection-started", stateAfter: "applying", payload: { kind: "projection", mutationId: id, criticality: "optional" } });
    expect(() => parse(run, base.binding)).toThrow(/forward mutation or projection outcome/i);
  });
  it("rejects compensation re-entry after a failed compensator", () => {
    const { base, id, run: compensating } = compensationReady();
    let run = finishCompensation(startCompensation(compensating, id), id, "compensation-failed");
    run = beginCompensation(parkAndResume(run));
    expect(() => parse(run, base.binding)).toThrow(/failed compensation/i);
  });
  it("re-enters compensation to settle a previously started compensator", () => {
    const { base, id, run: compensating } = compensationReady();
    let run = parkAndResume(startCompensation(compensating, id));
    run = settleCompensated(finishCompensation(beginCompensation(run), id));
    expect(parse(run, base.binding).state).toBe("compensated");
  });
  it("rejects success after any compensation outcome", () => {
    const base = compensatedRun(true);
    const withoutTerminal = base.run.transitions.slice(0, -1).reduce<OperationRunContent>((run, transition) => {
      if (transition.sequence === 0) return run;
      return append(run, { type: transition.type, stateAfter: transition.stateAfter, payload: transition.payload });
    }, base.content);
    let run = parkAndResume(withoutTerminal);
    run = append(run, { type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" } });
    expect(() => parse(run, base.binding)).toThrow(/success.*compensation|compensation.*success/i);
  });

  it("accepts compensated settlement with evidence-backed skipped and failed work", () => {
    const base = applying(3, [0]);
    const ids = base.run.obligations.authoritativeMutationIds;
    let run = base.run;
    for (const [index, status] of (["mutation-applied", "mutation-skipped-idempotent", "mutation-failed"] as const).entries()) run = terminalMutation(run, ids[index]!, status);
    const compensation = compensationId(ids[0]!);
    run = append(run, { type: "compensation-began", stateAfter: "compensating", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    run = append(run, { type: "compensation-started", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: ids[0]! } });
    run = append(run, { type: "compensation-completed", stateAfter: "compensating", payload: { kind: "compensation", compensationId: compensation, mutationId: ids[0]!, evidence: EVIDENCE } });
    run = append(run, { type: "compensated", stateAfter: "compensated", payload: { kind: "none" } });
    expect(parse(run, base.binding).state).toBe("compensated");
  });

  it.each(["started", "applied"] as const)("rejects compensated with a %s projection", (status) => {
    const { base, run: projected } = appliedMutationAndProjection(status);
    const mutation = mutationId(base.bundleId, 0);
    let run = startCompensation(beginCompensation(projected), mutation);
    run = settleCompensated(finishCompensation(run, mutation));
    expect(() => parse(run, base.binding)).toThrow(/projection/i);
  });

  it("requires recovered to bind a distinct successful recovery bundle", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT });
    const parked = append(base.content, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    const recovered = append(parked, { type: "recovered", stateAfter: "recovered", payload: { kind: "recovery", bundleId: base.bundleId, runId: base.runId, manifestDigest: DIGEST, terminalState: "succeeded", stateVersion: 4, chainTip: DIGEST } });
    expect(() => parse(recovered, base.binding)).toThrow(/distinct successful bound recovery bundle/);
    const valid = { kind: "recovery" as const, bundleId: mintBundleId(), runId: mintOperationRunId(), manifestDigest: DIGEST, terminalState: "succeeded" as const, stateVersion: 4, chainTip: DIGEST };
    const rebound = append(parked, { type: "recovered", stateAfter: "recovered", payload: valid });
    expect(parse(rebound, base.binding).state).toBe("recovered");
  });

  it("requires abandonment grant, confirmation, namespace, and evidence", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 1 });
    const parked = append(base.content, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    const finding = { code: "residual", mutationId: mutationId(base.bundleId, 0), authoritativeNamespace: "wiki", evidence: EVIDENCE };
    const ungranted = append(parked, abandonment([finding]));
    expect(() => parse(ungranted, base.binding)).toThrow(/destructive confirmation/);
    const granted = append(parked, abandonment([finding]), ABANDONER);
    expect(parse(granted, base.binding).state).toBe("abandoned");
  });

  it("requires unique complete abandonment coverage for unresolved work", () => {
    const base = applying(3, [], 32, 1);
    const ids = [0, 1, 2, 3].map((index) => mutationId(base.bundleId, index));
    let run = terminalMutation(base.run, ids[0]!, "mutation-applied");
    run = terminalMutation(run, ids[1]!, "mutation-skipped-idempotent");
    run = terminalMutation(run, ids[2]!, "mutation-failed");
    const parked = append(run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    const findings = [residualFinding(ids[0]!), residualFinding(ids[2]!), residualFinding(ids[3]!)];
    const omitted = append(parked, abandonment(findings.slice(0, 2)), ABANDONER);
    expect(() => parse(omitted, base.binding)).toThrow(/coverage|unresolved/i);
    const duplicate = append(parked, abandonment([...findings, findings[0]!]), ABANDONER);
    expect(() => parse(duplicate, base.binding)).toThrow(/duplicate|coverage/i);
    const exact = append(parked, abandonment(findings), ABANDONER);
    expect(parse(exact, base.binding).state).toBe("abandoned");
  });

  it("requires state-aware control slots while allowing a final terminal move", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT, controlTransitionAllowance: 1 });
    const rejected = append(base.content, { type: "rejected", stateAfter: "rejected", payload: { kind: "none" } });
    expect(parse(rejected, base.binding).state).toBe("rejected");
    const parked = append(base.content, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    expect(() => parse(parked, base.binding)).toThrow(/control.*headroom/i);
    const approved = append(base.content, { type: "approved", stateAfter: "approved", payload: { kind: "authority", authoritySnapshotDigest: DIGEST } });
    const applyingWithOne = append(approved, { type: "apply-started", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    expect(() => parse(applyingWithOne, base.binding)).toThrow(/control.*headroom/i);
  });

  it("rejects a repeated recovery resume that cannot still park and retire", () => {
    const base = applying(0, [], 4);
    let run = append(base.run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    expect(parse(run, base.binding).state).toBe("recovery-required");
    run = append(run, { type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    expect(parse(run, base.binding).state).toBe("applying");
    run = append(run, { type: "recovery-required", stateAfter: "recovery-required", payload: { kind: "problem", code: "bundle-recovery-required" } });
    expect(parse(run, base.binding).state).toBe("recovery-required");
    run = append(run, { type: "recovery-resumed", stateAfter: "applying", payload: { kind: "execution", authoritySnapshotDigest: DIGEST, applyOwner: OWNER } });
    expect(() => parse(run, base.binding)).toThrow(/control.*headroom/i);
  });

  it("rejects re-signed obligation IDs from a foreign bundle", () => {
    const base = runFixture({ key: KEY, actor: ACTOR, at: AT, authoritativeMutationCount: 1 });
    const foreign = mutationId(mintBundleId(), 0);
    const edited = { ...base.content, obligations: { ...base.content.obligations, authoritativeMutationIds: [foreign] } };
    expect(() => parse(edited, base.binding)).toThrow(/foreign or missing manifest mutation identity/);
  });

  it("does not invent failed or cancelled settlement after applying begins", () => {
    const { run, binding } = applying();
    const failed = append(run, { type: "failed", stateAfter: "failed", payload: { kind: "none" } });
    const cancelled = append(run, { type: "cancelled", stateAfter: "cancelled", payload: { kind: "none" } });
    expect(() => parse(failed, binding)).toThrow(/illegal state edge/);
    expect(() => parse(cancelled, binding)).toThrow(/illegal state edge/);
  });
});
