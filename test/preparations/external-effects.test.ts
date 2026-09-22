/**
 * @file test/preparations/external-effects.test.ts
 * @description Governed mutating external effects (design section 18). A durable
 * START is recorded before the broker call and only a host receipt is committed;
 * an unknown outcome parks; a receipt that does not match the started effect is
 * refused; and the runtime effect permit fails closed without an approved,
 * current `confirm-external-effect` gate. A follow-up is a separately declared,
 * separately granted effect.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { parseEffectId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import { mintExternalEffectReceipt, type ExternalEffectReceiptV1 } from "../../src/capability-providers/brokers/receipts.js";
import { deriveAttemptId, deriveGateProofId, type PreparationRunId } from "../../src/preparations/ids.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { appendProjectedTransitionLocked, readPreparationRun } from "../../src/preparations/run-store.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import { authorGateProof } from "../../src/preparations/gates.js";
import {
  assertFollowUpEffectSeparatelyGoverned, assertRuntimeEffectPermitted, buildEffectStartContext,
  classifyReceiptOutcome, commitEffectReceiptLocked, EFFECT_CLAIM_DIMENSIONS, EFFECT_CLAIM_EXCLUSIONS,
  EffectAuthorityError, effectPlanEntryDigest, recordEffectStartLocked,
  type EffectStartContext, type PreparationEffectPlanV1,
} from "../../src/preparations/effects.js";
import type { NormalizedPreparationPlanV1 } from "../../src/preparations/plan-types.js";
import type { GateProofSummaryV1, PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { PreparationPrincipal } from "../../src/preparations/principals.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { externalEffectPlan, stageRequest } from "./store-fixture.js";

const DIGEST = parseSha256Digest(`sha256:${"a".repeat(64)}`);
const AT = "2026-07-20T00:00:00.000Z";
const cli: PreparationPrincipal = { id: "operator", surface: "cli", grants: [] };
const GATE_ID = "send";

/** A minimal external-effect-only plan: one effect phase and its approval gate. */
function externalPlan(): NormalizedPreparationPlanV1 {
  return {
    executionMode: "durable-preparation", atomicityClass: "external-effect-only",
    phases: [{ effectPlanDigest: DIGEST }, { gate: { gateId: GATE_ID, gateKind: "confirm-external-effect" } }],
    outputContract: { producingPhaseIds: ["p"] },
  } as unknown as NormalizedPreparationPlanV1;
}

const effectPlan: PreparationEffectPlanV1 = {
  schemaVersion: 1, effectClass: "email.send", targetIdentity: "mailbox:ops", providerPinDigest: DIGEST,
  grantSnapshotDigest: DIGEST, brokerId: "email", brokerContractVersion: "1.0.0", invocationId: "inv-1",
  idempotencyKey: "idem-1", requestDigest: DIGEST, rollbackSemantics: "none",
};

const RUN_ID = `prr_${"1".repeat(32)}` as const;

function proof(runId: PreparationRunId, gateId: string, planDigest: string): GateProofSummaryV1 {
  return {
    gateProofId: deriveGateProofId({ runId, gateId, planDigest, decisionIndex: 0 }), gateId, decision: "approved",
    decisionIndex: 0, planDigest: parseSha256Digest(planDigest), phaseDigest: DIGEST, inputDigest: DIGEST,
    authorityDigest: DIGEST, actor: { id: "operator", surface: "cli" }, at: AT,
  };
}

describe("external effect permit and start context", () => {
  it("permits an effect with an approved gate bound to the current plan digest", () => {
    const plan = externalPlan(); const planDigest = canonicalDigest(plan);
    expect(() => assertRuntimeEffectPermitted({ plan, gateProofs: [proof(RUN_ID, GATE_ID, planDigest)], externalEffectGateId: GATE_ID, currentPlanDigest: parseSha256Digest(planDigest) })).not.toThrow();
  });

  it("fails closed on a missing gate, a stale digest, and a local-bundle class", () => {
    const plan = externalPlan(); const planDigest = parseSha256Digest(canonicalDigest(plan));
    expect(() => assertRuntimeEffectPermitted({ plan, gateProofs: [], externalEffectGateId: GATE_ID, currentPlanDigest: planDigest })).toThrow(/missing-effect-gate/);
    const stale = proof(RUN_ID, GATE_ID, `sha256:${"b".repeat(64)}`);
    expect(() => assertRuntimeEffectPermitted({ plan, gateProofs: [stale], externalEffectGateId: GATE_ID, currentPlanDigest: planDigest })).toThrow(/missing-effect-gate/);
    const local = { ...plan, atomicityClass: "local-bundle-only", outputContract: { producingPhaseIds: ["p"], handoffCapacity: {} }, phases: [{ gate: { gateId: GATE_ID, gateKind: "confirm-external-effect" } }] } as unknown as NormalizedPreparationPlanV1;
    expect(() => assertRuntimeEffectPermitted({ plan: local, gateProofs: [proof(RUN_ID, GATE_ID, canonicalDigest(local))], externalEffectGateId: GATE_ID, currentPlanDigest: parseSha256Digest(canonicalDigest(local)) })).toThrow(/effect-forbidden-by-class/);
  });

  it("binds the effect plan to its declared entry digest", () => {
    const bound = effectPlanEntryDigest(effectPlan);
    expect(() => buildEffectStartContext({ preparationRunId: RUN_ID, attemptId: `pat_${"c".repeat(64)}`, brokerRequestIndex: 0, startedAt: AT, effectPlan, boundEffectPlanDigest: bound })).not.toThrow();
    expect(() => buildEffectStartContext({ preparationRunId: RUN_ID, attemptId: `pat_${"c".repeat(64)}`, brokerRequestIndex: 0, startedAt: AT, effectPlan, boundEffectPlanDigest: DIGEST })).toThrow(/effect-plan-unbound/);
  });

  it("classifies an unknown outcome as a park and applied as settled", () => {
    expect(classifyReceiptOutcome({ outcome: "outcome-unknown" } as ExternalEffectReceiptV1).kind).toBe("park");
    expect(classifyReceiptOutcome({ outcome: "applied" } as ExternalEffectReceiptV1)).toEqual({ kind: "settled", outcome: "applied" });
  });

  it("requires a follow-up to be declared, distinct, and separately granted", () => {
    const plan = externalPlan(); const planDigest = parseSha256Digest(canonicalDigest(plan));
    const followUp = parseSha256Digest(`sha256:${"f".repeat(64)}`);
    const base = { plan, currentPlanDigest: planDigest, gateProofs: [proof(RUN_ID, GATE_ID, planDigest)], originalEffectPlanDigest: DIGEST, followUpGateId: GATE_ID };
    expect(() => assertFollowUpEffectSeparatelyGoverned({ ...base, declaredFollowUpDigest: DIGEST, followUpEffectPlanDigest: DIGEST })).toThrow(/follow-up-not-distinct/);
    expect(() => assertFollowUpEffectSeparatelyGoverned({ ...base, declaredFollowUpDigest: undefined, followUpEffectPlanDigest: followUp })).toThrow(/follow-up-not-declared/);
    expect(() => assertFollowUpEffectSeparatelyGoverned({ ...base, declaredFollowUpDigest: followUp, followUpEffectPlanDigest: followUp })).not.toThrow();
  });
});

const root = useTempRoot();
const PHASE = `phi_${"d".repeat(64)}` as const;
const ATT = deriveAttemptId(PHASE, 0);
const NONCE = "lease-nonce-1";
const EFFECT_ENTRY = effectPlanEntryDigest(effectPlan);

async function pred(binding: PreparationRunBinding) {
  const read = await readPreparationRun(root.dir, binding);
  if (read.status !== "ok") throw new Error(read.status);
  return preparationRunPredecessor(read.run);
}

/** Approve one gate over the authenticated manifest plan and persist its full proof. */
async function approveGate(binding: PreparationRunBinding, plan: NormalizedPreparationPlanV1, gateId: string, gateKind: string, index: number) {
  const authored = authorGateProof({
    principal: cli, choice: "approved", decisionIndex: index, at: AT,
    authoritative: { runId: binding.runId, plan, gate: { gateId, gateKind: gateKind as never }, phaseInstanceId: PHASE, currentInput: plan.initialInputSet, currentEffectPlanDigest: EFFECT_ENTRY },
  });
  await appendProjectedTransitionLocked(root.dir, binding, await pred(binding), {
    type: "gate-decided", stateAfter: "running", actor: cli, at: AT,
    payload: { kind: "gate", gateProofId: authored.summary.gateProofId, decision: "approved" },
  }, (next) => ({ ...next, gateProofs: [...next.gateProofs, authored.summary] }));
}

/** Stage the external-effect plan and drive it to a fenced, gate-approved running run. */
async function preparedRun(opts: { owner?: boolean; phase?: boolean } = {}): Promise<{ binding: PreparationRunBinding; plan: NormalizedPreparationPlanV1 }> {
  const plan = externalEffectPlan(EFFECT_ENTRY);
  const staged = await stagePreparationLocked(root.dir, stageRequest(plan));
  if (staged.status !== "staged") throw new Error("not staged");
  const key = await readPreparationKey(root.dir);
  if (key.status !== "ok") throw new Error("no key");
  const binding: PreparationRunBinding = {
    runId: staged.manifest.runId, preparationId: staged.manifest.preparationId, workspaceId: staged.manifest.workspaceId,
    manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
  };
  await appendProjectedTransitionLocked(root.dir, binding, await pred(binding), {
    type: "phase-started", stateAfter: "running", actor: cli, at: AT, payload: { kind: "phase", phaseInstanceId: PHASE, phaseState: "running" },
  }, (next) => ({
    ...next,
    ...(opts.owner === false ? {} : { executionOwner: { pid: process.pid, leaseNonce: NONCE, attemptId: ATT, acquiredAt: AT } }),
    ...(opts.phase === false ? {} : { phaseSummaries: [{ phaseInstanceId: PHASE, logicalPhaseId: "collect", state: "running", disposition: "required", attemptCount: 1, currentAttemptId: ATT, invocationCount: 0, brokerRequestCount: 0, effectCount: 0 }] }),
  }));
  await approveGate(binding, plan, "send", "confirm-external-effect", 0);
  await approveGate(binding, plan, "risk", "confirm-residual-risk", 1);
  return { binding, plan };
}

/** Record a durable start at one effect/broker-request index and return its context. */
async function startEffectAt(binding: PreparationRunBinding, plan: NormalizedPreparationPlanV1, index: number): Promise<EffectStartContext> {
  const started = await recordEffectStartLocked({
    root: root.dir, binding, principal: cli, at: AT, phaseInstanceId: PHASE, attemptId: ATT, leaseNonce: NONCE,
    effectIndex: index, brokerRequestIndex: index, externalEffectGateId: GATE_ID, effectPlan, currentInputDigest: plan.initialInputSet.digest,
  });
  return started.context;
}

/** Record the first durable start against a fully prepared run and return its context. */
async function startEffect(binding: PreparationRunBinding, plan: NormalizedPreparationPlanV1): Promise<EffectStartContext> {
  const context = await startEffectAt(binding, plan, 0);
  const read = await readPreparationRun(root.dir, binding);
  if (read.status !== "ok") throw new Error(read.status);
  expect(read.run.effectSummaries[0]?.outcome).toBe("started");
  expect(read.run.brokerRequestSummaries[0]?.state).toBe("started");
  return context;
}

function receipt(context: EffectStartContext, outcome: ExternalEffectReceiptV1["outcome"], overrides: Record<string, unknown> = {}): ExternalEffectReceiptV1 {
  return mintExternalEffectReceipt({
    effectId: context.effectId, invocationId: context.claimFacts.invocationId, providerPinDigest: DIGEST,
    grantSnapshotDigest: DIGEST, effectPlanEntryDigest: context.claimFacts.effectPlanEntryDigest, brokerId: context.claimFacts.brokerId,
    brokerContractVersion: context.claimFacts.brokerContractVersion, effectClass: "email.send", targetIdentity: "mailbox:ops",
    requestDigest: DIGEST, approvedRequestDigest: DIGEST, idempotencyKey: "idem-1", startedAt: AT, outcome, rollbackSemantics: "none", ...overrides,
  });
}

function commitInput(binding: PreparationRunBinding, context: EffectStartContext, receiptValue: ExternalEffectReceiptV1) {
  return { root: root.dir, binding, principal: cli, at: AT, phaseInstanceId: PHASE, attemptId: ATT, leaseNonce: NONCE, effectIndex: 0, context, receipt: receiptValue };
}

/** Rotate the run's execution-owner lease nonce, as cancellation/recovery would. */
async function rotateOwner(binding: PreparationRunBinding) {
  await appendProjectedTransitionLocked(root.dir, binding, await pred(binding), {
    type: "phase-progressed", stateAfter: "running", actor: cli, at: AT, payload: { kind: "phase", phaseInstanceId: PHASE, phaseState: "running" },
  }, (next) => ({ ...next, executionOwner: { pid: process.pid, leaseNonce: "rotated-nonce", attemptId: ATT, acquiredAt: AT } }));
}

describe("durable external effect start and receipt commit", () => {
  it("records a durable start then commits only an applied host receipt", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    const committed = await commitEffectReceiptLocked(commitInput(binding, context, receipt(context, "applied")));
    expect(committed.effectSummaries).toHaveLength(1);
    expect(committed.effectSummaries[0].outcome).toBe("applied");
    expect(committed.brokerRequestSummaries[0].state).toBe("settled");
  });

  it("parks the run at recovery-required on an outcome-unknown receipt", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    const parked = await commitEffectReceiptLocked(commitInput(binding, context, receipt(context, "outcome-unknown")));
    expect(parked.state).toBe("recovery-required");
    expect(parked.effectSummaries[0].outcome).toBe("outcome-unknown");
  });

  it("refuses a receipt that drifts on any bound authority dimension", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    const drifted = receipt(context, "applied", { grantSnapshotDigest: `sha256:${"b".repeat(64)}` });
    await expect(commitEffectReceiptLocked(commitInput(binding, context, drifted))).rejects.toThrow(EffectAuthorityError);
    await expect(commitEffectReceiptLocked(commitInput(binding, context, drifted))).rejects.toThrow(/receipt-mismatch/);
  });

  it("refuses to commit a receipt with no matching durable start in the run", async () => {
    const { binding } = await preparedRun();
    const context = buildEffectStartContext({ preparationRunId: binding.runId, attemptId: ATT, brokerRequestIndex: 0, startedAt: AT, effectPlan, boundEffectPlanDigest: EFFECT_ENTRY });
    await expect(commitEffectReceiptLocked(commitInput(binding, context, receipt(context, "applied")))).rejects.toThrow(/effect-not-started/);
  });

  it("captures the receipt once, rejecting a proxied receipt at entry", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    const proxied = new Proxy(receipt(context, "applied"), {}) as unknown as ExternalEffectReceiptV1;
    await expect(commitEffectReceiptLocked(commitInput(binding, context, proxied))).rejects.toThrow();
  });

  it("refuses a receipt whose lease no longer fences the run's active attempt", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    await rotateOwner(binding);
    await expect(commitEffectReceiptLocked(commitInput(binding, context, receipt(context, "applied")))).rejects.toThrow(/effect-not-fenced/);
  });

  it("refuses a receipt under a substituted (unauthenticated) effect id", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    // Swap the caller-supplied effect id and mint a receipt that matches every
    // claim dimension: the commit binds against the PERSISTED authentic id, so it fails.
    const swapped = { ...context, effectId: parseEffectId(`effect-${"f".repeat(64)}`) };
    await expect(commitEffectReceiptLocked(commitInput(binding, swapped, receipt(swapped, "applied")))).rejects.toThrow(/receipt-mismatch/);
  });
});

describe("commit binds the durable effect to its broker request", () => {
  it("fails closed committing one effect under another effect's broker request", async () => {
    const { binding, plan } = await preparedRun();
    const context0 = await startEffect(binding, plan);
    const context1 = await startEffectAt(binding, plan, 1);
    // Cross-wire: commit effect 0 but name effect 1's broker request. The commit
    // authenticates the association from effect 0's durable start, so the
    // substituted broker-request identity is rejected and settles nothing.
    const crossWired = { ...context0, brokerRequestId: context1.brokerRequestId, brokerRequestIndex: context1.brokerRequestIndex };
    await expect(commitEffectReceiptLocked(commitInput(binding, crossWired, receipt(context0, "applied")))).rejects.toThrow(/receipt-mismatch/);
    // The honest commit settles only effect 0's own broker request.
    const committed = await commitEffectReceiptLocked(commitInput(binding, context0, receipt(context0, "applied")));
    expect(committed.effectSummaries.find((effect) => effect.effectIndex === 0)?.outcome).toBe("applied");
    const settled = committed.brokerRequestSummaries.filter((request) => request.state === "settled");
    expect(settled.map((request) => request.brokerRequestId)).toEqual([context0.brokerRequestId]);
  });
});

describe("plan load rejects duplicate gate ids", () => {
  it("refuses a plan whose two gates share an id", () => {
    expect(() => externalEffectPlan(EFFECT_ENTRY, "send")).toThrow(/duplicate gate id/);
  });
});

describe("effect claim completeness invariant", () => {
  it("binds every authority-bearing receipt field and classifies every field", async () => {
    const { binding, plan } = await preparedRun();
    const context = await startEffect(binding, plan);
    const full = receipt(context, "applied", { completedAt: "2026-07-20T00:01:00.000Z", observedExternalIdentity: "ext-1", responseDigest: `sha256:${"c".repeat(64)}` });
    const classified = new Set<string>([...EFFECT_CLAIM_DIMENSIONS, ...EFFECT_CLAIM_EXCLUSIONS]);
    // Every field on a fully-populated host receipt is either a bound claim
    // dimension or an explicit exclusion — a new field cannot escape unclassified.
    expect(Object.keys(full).sort()).toEqual([...classified].sort());
    // Every bound dimension is actually present on the receipt (nothing binds a hole).
    for (const dimension of EFFECT_CLAIM_DIMENSIONS) expect(dimension in full).toBe(true);
  });
});

describe("effect start binds authenticated authority", () => {
  const startInput = (binding: PreparationRunBinding, plan: NormalizedPreparationPlanV1, over: Record<string, unknown> = {}) => ({
    root: root.dir, binding, principal: cli, at: AT, phaseInstanceId: PHASE, attemptId: ATT, leaseNonce: NONCE,
    effectIndex: 0, brokerRequestIndex: 0, externalEffectGateId: GATE_ID, effectPlan, currentInputDigest: plan.initialInputSet.digest, ...over,
  });

  it("refuses a start whose lease does not fence the run's active attempt", async () => {
    const { binding, plan } = await preparedRun({ owner: false });
    await expect(recordEffectStartLocked(startInput(binding, plan))).rejects.toThrow(/effect-not-fenced/);
  });

  it("refuses a start whose phase is not an authenticated effect phase", async () => {
    const { binding, plan } = await preparedRun({ phase: false });
    await expect(recordEffectStartLocked(startInput(binding, plan))).rejects.toThrow(/effect-not-started/);
  });

  it("refuses a start without the effect-approval grant", async () => {
    const { binding, plan } = await preparedRun();
    const sdk: PreparationPrincipal = { id: "svc", surface: "sdk", grants: [] };
    await expect(recordEffectStartLocked(startInput(binding, plan, { principal: sdk }))).rejects.toThrow(/missing-grant/);
  });

  it("refuses a start whose current input digest drifts from the approved gate", async () => {
    const { binding, plan } = await preparedRun();
    await expect(recordEffectStartLocked(startInput(binding, plan, { currentInputDigest: `sha256:${"b".repeat(64)}` }))).rejects.toThrow(/not-fresh/);
  });
});
