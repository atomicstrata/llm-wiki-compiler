/**
 * @file src/preparations/intent-compiler.ts
 * @description `OperationIntentCompilerV1` — the ONLY path from settled
 * preparation evidence to local intent (design section 21.3). It reads immutable
 * proposal, reconciliation, selection, and completeness evidence plus the host's
 * current target authority, and emits nothing but Milestone A's CLOSED mutation
 * grammar: drafts, preconditions, payload references, and provenance. Three
 * properties make it safe. First, it WRITES NOTHING — the compile call is
 * synchronous, pure, and performs no IO; it imports no filesystem, store,
 * network, or command surface DIRECTLY, though its transitive imports (the
 * canonical digest and the host authority modules) reach `node:crypto` and
 * `node:util`, which read and write nothing. Second, every emitted mutation is
 * routed through the registered Milestone A store-adapter registry, so an intent
 * with no closed mutation kind fails closed instead of growing a parallel writer.
 * Third, provider text can never choose a writer or a path: a proposal
 * contributes only a LOGICAL identity, which must already resolve inside the
 * host's own target authority, and the compiler stamps every envelope field
 * itself rather than accepting one from a draft.
 *
 * Nothing here reads the caller's request objects. {@link captureIntentRequest}
 * captures every container and authenticates every evidence record against its
 * own recomputed digest first, so the settlement gates below act on records the
 * host actually authored rather than on records merely shaped like them.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { captureOwnDataRecord, deepCaptureData } from "../utils/runtime-capture.js";
import {
  OPERATION_MUTATION_KINDS, requireOperationAdapter,
  type OperationAdapterMap, type OperationMutationKind,
} from "../operation-bundles/adapter-registry.js";
import { MAX_MUTATIONS_PER_BUNDLE } from "../operation-bundles/constants.js";
import { catalogRecordId, mutationId, type MutationId } from "../operation-bundles/ids.js";
import type {
  OperationCompleteness, OperationMutation, OperationPlanningWarning, OperationReconciliation,
} from "../operation-bundles/types.js";
import {
  OPTIONAL_DEFICIT_CODE, completenessTotal, type PreparationCompletenessV1,
} from "./completeness.js";
import {
  ENVELOPE_KEYS, IntentCompilerError, captureIntentRequest,
  type CapturedIntentRequestV1, type CapturedTargetV1, type IntentCompilationRequestV1,
} from "./intent-request.js";
import type { PreparationProposalV1 } from "./proposals.js";
import { resolutionForDecision, type PreparationReconciliationV1 } from "./reconciliation.js";
import type { SelectionDecisionV1 } from "./selection.js";
import type { Sha256Digest } from "./types.js";

export {
  ENVELOPE_KEYS, IntentCompilerError, captureIntentRequest,
  type CapturedIntentRequestV1, type CapturedTargetV1, type HostMutationTargetV1,
  type IntentCompilationRequestV1, type IntentCompilerCode, type IntentSettlementV1,
} from "./intent-request.js";

/** The settled decisions that compile into local mutation intent. */
const MUTATING_DECISIONS = Object.freeze(["accept", "merge", "supersede"] as const);

/** The fixed planning-warning code recorded for a deferred proposal set. */
export const DEFERRED_PROPOSAL_CODE = "preparation-deferred-proposal";

const FINDING_DOMAIN = "llmwiki-preparation-intent-finding-v1";

/** The audit trail from one compiled mutation back to the evidence behind it. */
export interface IntentProvenanceV1 {
  readonly mutationId: MutationId;
  readonly reconciliationId: string;
  readonly proposalIds: readonly string[];
  readonly sourceEvidenceDigests: readonly Sha256Digest[];
  readonly selectionDigests: readonly Sha256Digest[];
}

/** The compiled local intent: Milestone A drafts and nothing executable. */
export interface IntentCompilationResultV1 {
  readonly mutations: readonly OperationMutation[];
  readonly reconciliations: readonly OperationReconciliation[];
  readonly completeness: OperationCompleteness;
  readonly planningWarnings: readonly OperationPlanningWarning[];
  readonly provenance: readonly IntentProvenanceV1[];
}

/** The registered host compiler; WOP installs it, Task 10 surfaces its output. */
export interface OperationIntentCompilerV1 {
  compile(request: IntentCompilationRequestV1): IntentCompilationResultV1;
}

/** One planned mutation: the evidence, the host target, and the decision. */
interface PlannedMutation {
  readonly reconciliation: PreparationReconciliationV1;
  readonly proposal: PreparationProposalV1;
  readonly target: CapturedTargetV1;
}

/** Index the host target authority, refusing a doubly claimed logical identity. */
function indexTargets(targets: readonly CapturedTargetV1[]): ReadonlyMap<string, CapturedTargetV1> {
  const index = new Map<string, CapturedTargetV1>();
  for (const target of targets) {
    if (index.has(target.logicalIdentity)) throw new IntentCompilerError("duplicate-target");
    index.set(target.logicalIdentity, target);
  }
  return index;
}

/** The resolution state one planning pass threads across its proposals. */
interface PlanContext {
  readonly proposals: ReadonlyMap<string, PreparationProposalV1>;
  readonly targets: ReadonlyMap<string, CapturedTargetV1>;
  readonly claimed: Set<string>;
}

/**
 * Resolve ONE accepted proposal to the host target authority. A proposal without
 * a logical identity, one naming an identity the host never resolved, or one
 * re-claiming a target already spoken for fails closed here — this is the exact
 * point at which provider text stops being able to select a target.
 */
function resolvePlanned(
  reconciliation: PreparationReconciliationV1, proposalId: string, context: PlanContext,
): PlannedMutation {
  const proposal = context.proposals.get(proposalId);
  if (proposal === undefined) throw new IntentCompilerError("unknown-proposal");
  if (proposal.targetLogicalIdentity === undefined) throw new IntentCompilerError("missing-target-identity");
  const target = context.targets.get(proposal.targetLogicalIdentity);
  if (target === undefined) throw new IntentCompilerError("unresolved-target");
  if (context.claimed.has(target.logicalIdentity)) throw new IntentCompilerError("duplicate-target");
  context.claimed.add(target.logicalIdentity);
  return { reconciliation, proposal, target };
}

/**
 * Plan one mutation per accepted proposal, in the host-authored order the
 * reconciliations declare. Unsettled and non-mutating decisions contribute
 * nothing; the bundle-wide mutation cap is enforced before anything is built.
 */
function planMutations(
  request: CapturedIntentRequestV1, targets: ReadonlyMap<string, CapturedTargetV1>,
): readonly PlannedMutation[] {
  const context: PlanContext = {
    proposals: new Map(request.proposals.map((proposal) => [proposal.proposalId, proposal])),
    targets, claimed: new Set<string>(),
  };
  const planned = request.reconciliations
    .filter((reconciliation) => (MUTATING_DECISIONS as readonly string[]).includes(reconciliation.decision))
    .flatMap((reconciliation) => reconciliation.proposalIds
      .map((proposalId) => resolvePlanned(reconciliation, proposalId, context)));
  if (planned.length > MAX_MUTATIONS_PER_BUNDLE) throw new IntentCompilerError("mutation-cap-exceeded");
  return planned;
}

/** Deep-capture one host draft and refuse any caller-supplied envelope field. */
function captureDraft(value: unknown): Readonly<Record<string, unknown>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(deepCaptureData(value));
  } catch {
    throw new IntentCompilerError("invalid-draft");
  }
  if (ENVELOPE_KEYS.some((key) => record[key] !== undefined)) {
    throw new IntentCompilerError("envelope-field-supplied");
  }
  if (typeof record.kind !== "string") throw new IntentCompilerError("invalid-draft");
  return record;
}

/**
 * Prove a REGISTERED Milestone A store adapter owns this mutation kind. The
 * adapter is never invoked — compilation writes nothing — but an intent with no
 * closed adapter is refused rather than routed around.
 */
function assertMilestoneAdapter(adapters: OperationAdapterMap, kind: string): void {
  if (!(OPERATION_MUTATION_KINDS as readonly string[]).includes(kind)) {
    throw new IntentCompilerError("unknown-mutation-kind");
  }
  let adapterKind: string;
  try {
    adapterKind = requireOperationAdapter(adapters, kind as OperationMutationKind).kind;
  } catch {
    throw new IntentCompilerError("unknown-mutation-kind");
  }
  if (adapterKind !== kind) throw new IntentCompilerError("unknown-mutation-kind");
}

/**
 * Resolve the host-declared dependencies of one target to compiled indexes. A
 * dependency on the mutation ITSELF or on one compiled LATER is refused at this
 * boundary: Milestone A rejects both at stage time, and the earlier boundary is
 * the honest place to fail because the compiler already holds the whole index.
 */
function resolveDependsOn(
  target: CapturedTargetV1, index: number, indexByIdentity: ReadonlyMap<string, number>,
): readonly number[] {
  return Object.freeze(target.dependsOnLogicalIdentities.map((identity) => {
    const dependency = indexByIdentity.get(identity);
    if (dependency === undefined) throw new IntentCompilerError("unknown-dependency");
    if (dependency === index) throw new IntentCompilerError("self-dependency");
    if (dependency > index) throw new IntentCompilerError("forward-dependency");
    return dependency;
  }));
}

/** Build one closed mutation: host body plus the compiler-stamped envelope. */
function buildMutation(
  planned: PlannedMutation, index: number, request: CapturedIntentRequestV1,
  indexByIdentity: ReadonlyMap<string, number>,
): OperationMutation {
  const draft = captureDraft(planned.target.draft);
  assertMilestoneAdapter(request.adapters, draft.kind as string);
  const id = mutationId(request.bundleId, index);
  const completedDraft = draft.kind === "catalog-record"
    ? { ...draft, postcondition: { ...(draft.postcondition as Record<string, unknown>), recordId: catalogRecordId(id) } }
    : draft;
  return Object.freeze({
    ...completedDraft,
    index,
    mutationId: id,
    dependsOn: resolveDependsOn(planned.target, index, indexByIdentity),
    reconciliationRefs: Object.freeze([planned.reconciliation.reconciliationId]),
  }) as OperationMutation;
}

/** Project the host completeness authority onto Milestone A's counted record. */
function compileCompleteness(record: PreparationCompletenessV1): OperationCompleteness {
  return {
    attempted: completenessTotal(record, "attempted"),
    completed: completenessTotal(record, "completed"),
    skipped: completenessTotal(record, "skipped"),
    failed: completenessTotal(record, "failed"),
    requiredMissing: record.requiredDeficitCount,
    optionalMissing: record.optionalDeficitCount,
    rationaleDigest: record.identitySetsDigest,
  };
}

/** Emit exact planning warnings for optional incompleteness and deferrals. */
function compileWarnings(request: CapturedIntentRequestV1): readonly OperationPlanningWarning[] {
  const warnings: OperationPlanningWarning[] = [];
  for (const entry of request.completeness.classes) {
    const deficit = entry.planned - entry.included;
    if (entry.disposition === "optional" && deficit > 0) {
      warnings.push({ code: OPTIONAL_DEFICIT_CODE, message: `class ${entry.classId} is missing ${deficit} identities` });
    }
  }
  for (const reconciliation of request.reconciliations) {
    if (reconciliation.decision !== "defer") continue;
    warnings.push({
      code: DEFERRED_PROPOSAL_CODE,
      message: `reconciliation ${reconciliation.reconciliationId} deferred ${reconciliation.proposalIds.length} proposals`,
    });
  }
  return Object.freeze(warnings);
}

/** Project each settled reconciliation onto Milestone A's closed resolution. */
function compileReconciliations(
  records: readonly PreparationReconciliationV1[],
): readonly OperationReconciliation[] {
  return Object.freeze(records.flatMap((record) => {
    const resolution = resolutionForDecision(record.decision);
    return resolution === undefined ? [] : [{
      id: record.reconciliationId,
      findingDigest: parseSha256Digest(canonicalDigest({
        domain: FINDING_DOMAIN, proposalIds: record.proposalIds, reasonCodes: record.reasonCodes,
      })),
      resolution,
      rationaleDigest: record.policyDigest,
    }];
  }));
}

/** Link one compiled mutation back to the exact evidence that justified it. */
function provenanceFor(
  planned: PlannedMutation, mutation: OperationMutation, selections: readonly SelectionDecisionV1[],
): IntentProvenanceV1 {
  return Object.freeze({
    mutationId: mutation.mutationId,
    reconciliationId: planned.reconciliation.reconciliationId,
    proposalIds: Object.freeze([planned.proposal.proposalId]),
    sourceEvidenceDigests: Object.freeze(planned.proposal.sourceEvidenceRefs.map((ref) => ref.digest)),
    selectionDigests: Object.freeze(selections.map((selection) => selection.selectionDigest)),
  });
}

/** Compile settled evidence into local intent; see the file header for why. */
function compileIntent(input: IntentCompilationRequestV1): IntentCompilationResultV1 {
  const request = captureIntentRequest(input);
  const planned = planMutations(request, indexTargets(request.targets));
  const indexByIdentity = new Map(planned.map((entry, index) => [entry.target.logicalIdentity, index]));
  const mutations = planned.map((entry, index) => buildMutation(entry, index, request, indexByIdentity));
  return Object.freeze({
    mutations: Object.freeze(mutations),
    reconciliations: compileReconciliations(request.reconciliations),
    completeness: compileCompleteness(request.completeness),
    planningWarnings: compileWarnings(request),
    provenance: Object.freeze(planned.map((entry, index) =>
      provenanceFor(entry, mutations[index]!, request.selections))),
  });
}

/**
 * Build the registered host intent compiler. It is a frozen object with one
 * synchronous, side-effect-free method; there is deliberately no seam through
 * which a caller could install an alternative writer.
 */
export function createOperationIntentCompilerV1(): OperationIntentCompilerV1 {
  return Object.freeze({ compile: compileIntent });
}
