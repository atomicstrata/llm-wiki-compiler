/**
 * @file test/preparations/journey-fixture.ts
 * @description Shared harness for the Chunk 3 pack JOURNEYS — the research and
 * editorial packs driven end to end through the public `runPreparation`. The two
 * packs are deliberately DISSIMILAR (design v3 §1, PO-INV-40): research fans out
 * over a map and gates once; editorial is linear with an optional render phase.
 * Genericity is proven by running both through the UNCHANGED runner, so their one
 * shared need — a leg that publishes output evidence, a capabilities-only runner
 * input, a gate approval, and an optional completeness class — lives here, and
 * each pack supplies only its own graph, legs, and materializer.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { gatePreparationOperation } from "../../src/preparations/service-gate.js";
import { deriveCompleteness } from "../../src/preparations/completeness.js";
import type { AttemptLegOutcomeV1 } from "../../src/preparations/attempts/types.js";
// Drive through the PUBLIC package entry (the public adapter), not the internal
// runner module — the journeys exercise the same surface a host consumer calls.
import { runPreparation } from "../../src/index.js";
import type {
  RunPreparationInputV1, RunPreparationResultV1, PreparationMaterializerV1,
} from "../../src/preparations/runner.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { PreparationPrincipal } from "../../src/preparations/principals.js";
import { PIN, fixedResolver, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";
import { fixturePlan } from "./store-fixture.js";
import { COMPLETENESS_IDENTITY_REF, declareMaterializationCapacity } from "./materialization-fixture.js";

/** The runner's operation-bundle principal (operation grants only). */
const OP_PRINCIPAL: OperationPrincipal = { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] };
/** The gate operator's preparation principal (preparation grants only). */
const GATE_PRINCIPAL: PreparationPrincipal = { id: "operator", surface: "cli", grants: ["preparation.gate.decide"] };

const bare = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A leg that publishes `bytes` as this phase's output evidence. */
export function evidenceLeg(runId: string, label: string, bytes: Buffer): () => Promise<AttemptLegOutcomeV1> {
  return async () => {
    const digest = bare(bytes);
    const tempPath = path.join(os.tmpdir(), `${label}-${runId}-${digest.slice(0, 12)}`);
    await writeFile(tempPath, bytes);
    return {
      ...succeededLeg(),
      outputEvidenceDigest: parseSha256Digest(`sha256:${digest}`),
      pendingEvidence: [{ tempPath, ref: {
        kind: "provider-output", mediaType: "application/json", provenanceLabel: "draft",
        digest: parseSha256Digest(`sha256:${digest}`), byteCount: bytes.byteLength,
        sensitivity: "ordinary", retention: "until-handoff",
        producer: { kind: "provider", providerPinDigest: parseSha256Digest(PIN), attemptId: "att-1" },
        untrusted: true,
      } }],
    };
  };
}

/** The argument the runner hands a materializer — the durable run and its evidence. */
export type MaterializeInput = Parameters<PreparationMaterializerV1["materialize"]>[0];

/** The pack-specific fields of one materialized obligation; the rest is shared shape. */
export interface JourneyObligation {
  readonly targetIdentity: string;
  readonly completeness: unknown;
  /** The prior bundle this preparation supersedes (unit G); absent for a fresh one. */
  readonly supersedesBundleId?: string;
}

/**
 * Build a materializer whose result envelope (targets, empty proposals/
 * reconciliations/selections, one payload ref over the first evidence object) is
 * identical across packs; each pack supplies only its target identity and its own
 * completeness record, derived from the durable evidence the runner hands it.
 */
export function journeyMaterializer(
  derive: (input: MaterializeInput) => JourneyObligation,
): PreparationMaterializerV1 {
  return {
    handlerContractDigest: parseSha256Digest(PIN),
    materialize: (input) => {
      const first = [...input.evidence.entries()][0];
      if (first === undefined) throw new Error("no durable evidence");
      const obligation = derive(input);
      return { result: {
        targets: [{ logicalIdentity: obligation.targetIdentity, draft: { kind: "lifecycle-transition" } }],
        proposals: [], reconciliations: [], selections: [], completeness: obligation.completeness,
        authorityInputs: [], authorityBounds: [],
        operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
        payloadRefs: [{ role: "proposal-payload", digest: first[0], byteCount: first[1].byteLength, mediaType: "application/json" }],
        ...(obligation.supersedesBundleId === undefined ? {} : { supersedesBundleId: obligation.supersedesBundleId }),
      }, payloads: new Map([[first[0], first[1]]]) };
    },
  };
}

/** The pack-specific capabilities a journey wires into the shared runner input. */
export interface JourneyCapabilities {
  readonly legFor: (logicalPhaseId: string) => () => Promise<AttemptLegOutcomeV1>;
  readonly materializer: PreparationMaterializerV1;
  readonly decodeExpansionItems?: (logicalPhaseId: string, evidence: Buffer) => unknown[];
  /** A real policy contract + adapters when the materializer emits compilable proposals. */
  readonly policyContract?: RunPreparationInputV1["policyContract"];
  readonly adapters?: RunPreparationInputV1["adapters"];
}

/** The capabilities-and-identity runner input every journey shares, plus one pack's legs. */
export function journeyInput(staged: StagedPreparation, caps: JourneyCapabilities): RunPreparationInputV1 {
  let tick = 0;
  const stubContract = { handlerId: "journey", handlerContractVersion: "1.0.0", handlerContractDigest: PIN,
    exclusionReasonCodes: [], reconciliationReasonCodes: [], proposalKinds: [] } as unknown as RunPreparationInputV1["policyContract"];
  return {
    root: staged.root, binding: staged.binding, materializer: caps.materializer, legFor: caps.legFor,
    ...(caps.decodeExpansionItems === undefined ? {} : { decodeExpansionItems: caps.decodeExpansionItems }),
    authorityResolver: fixedResolver(),
    adapters: (caps.adapters ?? new Map()) as RunPreparationInputV1["adapters"],
    policyContract: (caps.policyContract ?? stubContract) as RunPreparationInputV1["policyContract"],
    principal: { id: "operator", surface: "cli" }, operationPrincipal: OP_PRINCIPAL,
    handlerContractDigest: parseSha256Digest(PIN),
    clock: { now: () => new Date(Date.UTC(2026, 6, 21, 1, 0, tick++)).toISOString() },
  };
}

/** A `sha256:`-prefixed placeholder digest for pack executor/authority pins. */
export const JOURNEY_DIGEST = `sha256:${"a".repeat(64)}`;

/** Build a validated, materialization-funded pack plan; `build` shapes its phases. */
export function journeyPlan(build: (object: Record<string, unknown>) => void) {
  return fixturePlan((plan) => {
    const object = plan as Record<string, unknown>;
    build(object);
    declareMaterializationCapacity(object);
  });
}

/** Attempt one operator gate decision, returning the raw result (recorded or refused). */
export function tryDecideGate(
  staged: StagedPreparation, gateId: string, decision: "approved" | "rejected" | "revised" = "approved",
): ReturnType<typeof gatePreparationOperation> {
  return gatePreparationOperation(staged.root, GATE_PRINCIPAL, { runId: staged.binding.runId, gateId, decision });
}

/** Record one operator gate decision (approved/rejected/revised), failing loudly on refusal. */
export async function decideGate(
  staged: StagedPreparation, gateId: string, decision: "approved" | "rejected" | "revised",
): Promise<void> {
  const decided = await tryDecideGate(staged, gateId, decision);
  if (decided.status !== "recorded") throw new Error(`gate ${gateId} ${decision}: ${decided.reason}`);
}

/** Record an operator's approval for one gate. */
const approveGate = (staged: StagedPreparation, gateId: string): Promise<void> => decideGate(staged, gateId, "approved");

/** A leg that settles its phase `failed`, for exercising failed-predecessor handling. */
export function failingLeg(): () => Promise<AttemptLegOutcomeV1> {
  return async () => ({ ...succeededLeg(), phaseState: "failed" as const });
}

/** Drive a run to its gate, approve it, and re-drive to the terminal result. */
export async function resumeThroughGate(
  staged: StagedPreparation, input: RunPreparationInputV1, gateId: string,
): Promise<RunPreparationResultV1> {
  await runPreparation(input);
  await approveGate(staged, gateId);
  return runPreparation(input);
}

/**
 * One OPTIONAL completeness class where the planned identities not in `included`
 * become a deficit — routed to `overflow` (dropped BEFORE eligibility, as a map
 * cap does) or `skipped` (eligible but not produced, as an optional render does).
 * Optional means the deficit warns rather than blocks handoff. The identity-set
 * equations require overflow OUTSIDE eligible and skipped INSIDE it, so the two
 * cases carry different eligible sets.
 */
export function optionalClassRecord(
  classId: string, planned: readonly string[], included: readonly string[],
  missingCategory: "overflow" | "skipped" = "overflow",
) {
  const missing = planned.filter((identity) => !included.includes(identity));
  const eligible = missingCategory === "overflow" ? included : planned;
  // Every ELIGIBLE identity was attempted; the missing ones then landed in the
  // missing category (skipped items were attempted-then-skipped, so the derived
  // warning's attempted = completed + skipped + failed stays balanced). Overflow
  // items were never eligible, so they are neither attempted nor in this sum.
  const sets = {
    planned, eligible, attempted: eligible, completed: included, included,
    skipped: [] as readonly string[], unavailable: [], failed: [], cancelled: [],
    overflow: [] as readonly string[], nonConverged: [], [missingCategory]: missing,
  };
  return deriveCompleteness({ scopeId: "final", classes: [{
    classId, disposition: "optional", identitySetRef: COMPLETENESS_IDENTITY_REF, identitySets: sets,
  }] }).record;
}
