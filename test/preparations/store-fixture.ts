/**
 * @file test/preparations/store-fixture.ts
 * @description Shared staging fixtures for the Task 2/3 preparation store suites.
 * Builds a validated normalized plan whose initial input set is content-addressed
 * to a canonical structured seed, plus a complete staging request declaring that
 * seed as a structured prepared input, so a store test can stage a durable
 * preparation and read its manifest, run, and evidence back. Evidence enters
 * staging only by materializing the declared prepared input — never a caller
 * buffer.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import type { NormalizedPreparationPlanV1 } from "../../src/preparations/plan-types.js";
import type { PreparationInitialInputV1 } from "../../src/preparations/initial-inputs.js";
import type { StructuredValueSourceV1 } from "../../src/preparations/inputs.js";
import type { PreparationPrincipalV1, PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { StagePreparationRequest } from "../../src/preparations/stage.js";
import { validPlan } from "./plan-fixture.js";
import { declareMaterializationCapacity } from "./materialization-fixture.js";

/** The one canonical structured seed every fixture preparation freezes into evidence. */
export const SEED_VALUE = { seed: "initial-input", version: 1 };
const SEED_BYTES = canonicalBytes(SEED_VALUE);

/** The bare lowercase SHA-256 of the canonical seed bytes (the evidence filename). */
export function seedDigest(): string {
  return createHash("sha256").update(SEED_BYTES).digest("hex");
}

/**
 * The declared structured initial input that materializes to the seed evidence.
 *
 * `overrides` exists for descriptor-validation probes and is deliberately
 * untyped: a probe's whole point is a field value the descriptor's own types
 * forbid. The digest coupling to `fixturePlan` is why this lives here rather
 * than being retyped per suite — a copy that drifted from `SEED_VALUE` would
 * stop covering the plan's declared input set and fail for the wrong reason.
 */
export function seedInput(overrides: Record<string, unknown> = {}): PreparationInitialInputV1 {
  return {
    kind: "structured",
    source: {
      value: SEED_VALUE, sourceIdentity: "seed", provenanceLabel: "caller", mediaType: "application/json",
      sensitivity: "ordinary", retention: "until-handoff", evidenceKind: "seed", ...overrides,
    } as StructuredValueSourceV1,
  };
}

/** Build one validated plan whose initial input set hashes to the seed bytes. */
export function fixturePlan(overrides: (plan: Record<string, unknown>) => void = () => {}): NormalizedPreparationPlanV1 {
  const object = validPlan();
  object.initialInputSet = {
    kind: "seed", mediaType: "application/json", provenanceLabel: "caller", digest: `sha256:${seedDigest()}`,
    byteCount: SEED_BYTES.byteLength, sensitivity: "ordinary", retention: "until-handoff",
    producer: { kind: "host", contractDigest: `sha256:${"a".repeat(64)}` }, untrusted: true,
  };
  overrides(object);
  return parsePreparationPlan(JSON.stringify(object));
}

/** Default per-instance bounds mirroring the base plan fixture. */
function phaseBounds(): Record<string, number> {
  return {
    maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0,
    maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes: 1024,
    maximumCheckpointBytes: 0, maximumTokensPerAttempt: 100, maximumTimeMsPerInstance: 1000,
    maximumCostMicrosPerAttempt: 10,
  };
}

/**
 * A validated `non-atomic-external-before-local` plan: the `collect` work phase
 * declares the given effect-plan entry digest, a `send` gate confirms the external
 * effect, a `risk` gate confirms residual non-atomicity, and the local bundle is
 * retained — so an effect start can be authorized against a real authenticated
 * manifest, not a caller-fabricated plan.
 */
export function externalEffectPlan(
  effectPlanDigest: string, residualGateId = "risk", opts: { withMaterialization?: boolean } = {},
): NormalizedPreparationPlanV1 {
  return fixturePlan((object) => {
    object.atomicityClass = "non-atomic-external-before-local";
    const phases = object.phases as Record<string, unknown>[];
    phases[0].effectPlanDigest = effectPlanDigest;
    phases[0].brokerPlanDigest = `sha256:${"a".repeat(64)}`;
    (phases[0].bounds as Record<string, number>).maximumEffectsPerAttempt = 1;
    (phases[0].bounds as Record<string, number>).maximumBrokerRequestsPerAttempt = 1;
    phases[1].expansion = { kind: "single" };
    phases[2].gate = { gateId: "send", gateKind: "confirm-external-effect" };
    phases[3].dependsOn = ["risk"];
    phases[3].inputBindings = [{ bindingId: "gated", sourceKind: "phase-output", sourcePhaseId: "risk" }];
    phases.splice(3, 0, {
      logicalPhaseId: "risk", role: "gate", dependsOn: ["review"], disposition: "required",
      gate: { gateId: residualGateId, gateKind: "confirm-residual-risk" },
      inputBindings: [{ bindingId: "sent", sourceKind: "phase-output", sourcePhaseId: "review" }],
      expansion: { kind: "single" }, bounds: phaseBounds(),
    });
    Object.assign(object.bounds as Record<string, number>, {
      maximumEffects: 4, maximumBrokerRequests: 4, maximumPhaseInstances: 8, maximumAttempts: 16,
      maximumInvocations: 16, maximumTransitions: 40, maximumEvidenceRefs: 32, maximumEvidenceBytes: 8192,
      maximumTokens: 1600, maximumTimeMs: 8000, maximumCostMicros: 160,
    });
    // The runner refuses to DRIVE a plan without the materialization triple, so a
    // journey that drives an effect through runPreparation must declare it — even
    // though an effect-then-cancel run terminates before it ever materializes.
    if (opts.withMaterialization === true) declareMaterializationCapacity(object);
  });
}

const PRINCIPAL: PreparationPrincipalV1 = { id: "operator", surface: "cli" };

/** Build one complete staging request for the fixture plan. */
export function stageRequest(
  plan: NormalizedPreparationPlanV1 = fixturePlan(),
  overrides: Partial<StagePreparationRequest> = {},
): StagePreparationRequest {
  return {
    plan, createdBy: PRINCIPAL, actor: PRINCIPAL,
    initialInputs: [seedInput()],
    controlTransitionAllowance: 16,
    ...overrides,
  };
}

/**
 * Stage one durable preparation and return its authenticated run binding.
 *
 * ONE HOME for the four steps every fixture that needs a bound run repeats:
 * stage, require the `staged` status, read the key, and bind through the
 * PRODUCTION binder rather than re-typing five fields. Two fixtures had grown
 * their own copy of it, which is the copy that keeps compiling when the binding
 * rule changes.
 *
 * @param root - An initialized project root to stage into.
 * @param plan - The plan to stage; defaults to the shared fixture plan.
 * @returns The staged run's authenticated binding.
 */
export async function stageBoundPreparation(
  root: string, plan: NormalizedPreparationPlanV1 = fixturePlan(),
): Promise<PreparationRunBinding> {
  const { stagePreparationLocked } = await import("../../src/preparations/stage.js");
  const { readPreparationKey } = await import("../../src/preparations/key-epoch.js");
  const { bindingFor } = await import("../../src/preparations/references.js");
  const staged = await stagePreparationLocked(root, stageRequest(plan));
  if (staged.status !== "staged") throw new Error(`staging failed: ${staged.status}`);
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("staged key unavailable");
  return bindingFor(staged.manifest, key.keyEpochId);
}
