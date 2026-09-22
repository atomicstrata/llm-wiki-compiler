/**
 * @file test/fixtures/preparations/synthetic-research-pack.ts
 * @description The research-flavored synthetic preparation pack, and the
 * vocabulary-neutral skeleton both synthetic packs are built from.
 *
 * WHY A PAIR OF PACKS EXISTS. One pack cannot show that the preparation engine
 * is generic: a plan whose phases are called `collect`/`expand`/`review` proves
 * only that the engine runs the plan its own fixtures were written around. Two
 * packs with IDENTICAL MECHANICS and DISJOINT VOCABULARIES can — whatever the
 * engine does to one it must do to the other, and no behaviour can be keyed to a
 * research word.
 *
 * So "identical mechanics" is not a convention maintained by hand.
 * `buildSyntheticPack` is the one skeleton; a pack supplies nothing but its
 * names and its seed. The editorial pack imports that skeleton from here instead
 * of restating it, which is why the shared code lives in a pack file rather than
 * a third module: two hand-copied skeletons can drift into different shapes
 * while both still claim to differ only in vocabulary, and nothing would catch
 * it. Task 11 may want the skeleton in a neutral module of its own; that is a
 * move, not a rewrite.
 *
 * These are REAL documents, not shapes invented to satisfy an assertion. Each
 * one parses through `parsePreparationPlan`, satisfies the closed graph
 * validation and the worst-case bounds arithmetic, and stages end to end through
 * the built binary — proven in `test/preparation-synthetic-packs.test.ts`.
 */

import { createHash } from "node:crypto";
import { MILESTONE_A_DESIGN_DIGEST } from "../../../src/preparations/constants.js";
import { canonicalBytes } from "../../../src/profile/templates/signing/canonical.js";

/** The pinned digest every authority, executor, and contract reference carries. */
const PIN_DIGEST = `sha256:${"a".repeat(64)}`;

// --- The mechanics, named once and shared by every synthetic pack -----------

/** Worst-case items the bounded fan-out phase may expand into. */
const FAN_OUT_ITEMS = 4;
/** Worst-case iterations the checkpointed repeat phase may run. */
const REPEAT_ITERATIONS = 3;
const ATTEMPTS_PER_INSTANCE = 2;
const INVOCATIONS_PER_ATTEMPT = 1;
const TRANSITIONS_PER_INSTANCE = 4;
const OUTPUT_EVIDENCE_BYTES = 1024;
const CHECKPOINT_BYTES = 512;
const TOKENS_PER_ATTEMPT = 100;
const TIME_MS_PER_INSTANCE = 1000;
const COST_MICROS_PER_ATTEMPT = 10;

/**
 * The declared worst case, derived rather than hand-written.
 *
 * `assertPreparationBounds` recomputes this fold from the graph and rejects any
 * declared bound below it, so a hand-written number here would be a second
 * source of truth that silently rots the moment a mechanics constant changes.
 * Instances: origin (1) + fan-out (4) + gate (1) + repeat (3) + join (1).
 */
const PHASE_INSTANCES = 1 + FAN_OUT_ITEMS + 1 + REPEAT_ITERATIONS + 1;
const ATTEMPTS = PHASE_INSTANCES * ATTEMPTS_PER_INSTANCE;

/** The Milestone A handoff subset every synthetic pack declares. */
const HANDOFF_ITEM_BYTES = 1_048_576;
const HANDOFF_AGGREGATE_BYTES = 4_194_304;
const HANDOFF_ITEMS = 10;
const HANDOFF_BUNDLE_PAYLOAD_BYTES = 33_554_432;
const HANDOFF_MANIFEST_BYTES = 1_048_576;
const HANDOFF_RUN_EVIDENCE_ITEM_BYTES = 131_072;
const HANDOFF_RUN_EVIDENCE_BYTES = 8_388_608;
const HANDOFF_ACTIVE_STORE_BYTES = 268_435_456;

/**
 * The names one pack substitutes into the shared skeleton.
 *
 * Every field here is a DISTINCTIVE noun: the packs' vocabularies are asserted
 * disjoint, so a term that also appears in the closed grammar (`selection`,
 * `checkpoint`, `source`, `review`) cannot be used, however natural it reads.
 */
export interface SyntheticPackVocabulary {
  workspaceId: string;
  knowledgeAuthorityId: string;
  operationsAuthorityId: string;
  actionId: string;
  originPhaseId: string;
  originCapabilityId: string;
  fanOutPhaseId: string;
  fanOutHandlerId: string;
  gatePhaseId: string;
  repeatPhaseId: string;
  repeatCapabilityId: string;
  joinPhaseId: string;
  seedBindingId: string;
  originOutputBindingId: string;
  fanOutOutputBindingId: string;
  gateOutputBindingId: string;
  repeatOutputBindingId: string;
  deficitClassId: string;
  continuationField: string;
  evidenceClassId: string;
}

/** One synthetic pack: its vocabulary, its seed document, and its plan. */
export interface SyntheticPack {
  readonly name: string;
  readonly vocabulary: SyntheticPackVocabulary;
  /** The bytes the plan's declared initial input set hashes to. */
  readonly seed: Record<string, unknown>;
  /** A fresh, independently mutable plan document. */
  planDocument(): Record<string, unknown>;
}

/** Per-instance worst-case bounds; only the repeat phase checkpoints. */
function phaseBounds(checkpointBytes = 0): Record<string, number> {
  return {
    maximumAttempts: ATTEMPTS_PER_INSTANCE,
    maximumInvocationsPerAttempt: INVOCATIONS_PER_ATTEMPT,
    maximumBrokerRequestsPerAttempt: 0,
    maximumEffectsPerAttempt: 0,
    maximumTransitionsPerInstance: TRANSITIONS_PER_INSTANCE,
    maximumOutputEvidenceBytes: OUTPUT_EVIDENCE_BYTES,
    maximumCheckpointBytes: checkpointBytes,
    maximumTokensPerAttempt: TOKENS_PER_ATTEMPT,
    maximumTimeMsPerInstance: TIME_MS_PER_INSTANCE,
    maximumCostMicrosPerAttempt: COST_MICROS_PER_ATTEMPT,
  };
}

/** The entry phase: one provider capability reading the frozen initial input. */
function originPhase(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    logicalPhaseId: v.originPhaseId, role: "work", dependsOn: [], disposition: "required",
    executor: {
      kind: "provider-capability", providerPinDigest: PIN_DIGEST,
      capabilityId: v.originCapabilityId, capabilityContractDigest: PIN_DIGEST,
    },
    inputBindings: [{ bindingId: v.seedBindingId, sourceKind: "initial-input" }],
    expansion: { kind: "single" }, bounds: phaseBounds(),
  };
}

/** The bounded fan-out: a host handler mapped over the entry phase's output. */
function fanOutPhase(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    logicalPhaseId: v.fanOutPhaseId, role: "work", dependsOn: [v.originPhaseId], disposition: "required",
    executor: {
      kind: "host-handler", handlerId: v.fanOutHandlerId,
      handlerContractVersion: "1", handlerContractDigest: PIN_DIGEST,
    },
    inputBindings: [{ bindingId: v.originOutputBindingId, sourceKind: "phase-output", sourcePhaseId: v.originPhaseId }],
    expansion: {
      kind: "map", sourceEvidenceBinding: v.originOutputBindingId, maximumItems: FAN_OUT_ITEMS,
      itemIdentity: "canonical-item-digest", duplicateDisposition: "deduplicate",
      // An overflowing fan-out is COUNTED, not failed: the pack's point is that a
      // deficit class travels with the run, and the class id is vocabulary.
      overflowDisposition: { kind: "count-as-incomplete", completenessClassId: v.deficitClassId },
    },
    bounds: phaseBounds(),
  };
}

/** The operator gate deciding which fanned-out items proceed. */
function gatePhase(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    logicalPhaseId: v.gatePhaseId, role: "gate", dependsOn: [v.fanOutPhaseId], disposition: "required",
    gate: { gateId: v.gatePhaseId, gateKind: "review-selection" },
    inputBindings: [{ bindingId: v.fanOutOutputBindingId, sourceKind: "phase-output", sourcePhaseId: v.fanOutPhaseId }],
    expansion: { kind: "single" }, bounds: phaseBounds(),
  };
}

/** The checkpointed bounded repeat, draining the vocabulary's own work queue. */
function repeatPhase(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    logicalPhaseId: v.repeatPhaseId, role: "work", dependsOn: [v.gatePhaseId], disposition: "required",
    executor: {
      kind: "provider-capability", providerPinDigest: PIN_DIGEST,
      capabilityId: v.repeatCapabilityId, capabilityContractDigest: PIN_DIGEST,
    },
    inputBindings: [{ bindingId: v.gateOutputBindingId, sourceKind: "phase-output", sourcePhaseId: v.gatePhaseId }],
    expansion: {
      kind: "bounded-repeat", maximumIterations: REPEAT_ITERATIONS,
      continuation: { kind: "until-empty", outputField: v.continuationField },
      limitDisposition: { kind: "fail-closed" },
    },
    bounds: phaseBounds(CHECKPOINT_BYTES),
  };
}

/** The join that produces the plan's declared output. */
function joinPhase(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    logicalPhaseId: v.joinPhaseId, role: "join", dependsOn: [v.repeatPhaseId], disposition: "required",
    inputBindings: [{ bindingId: v.repeatOutputBindingId, sourceKind: "phase-output", sourcePhaseId: v.repeatPhaseId }],
    expansion: { kind: "single" }, bounds: phaseBounds(),
  };
}

/**
 * The frozen initial input set, content-addressed to the pack's own seed.
 *
 * The digest is computed from the seed rather than written down: a plan whose
 * declared digest does not match the seed document beside it is refused at
 * staging on evidence coverage, which is the mismatch that has to be impossible
 * to introduce here.
 */
function initialInputSet(seed: Record<string, unknown>): Record<string, unknown> {
  const bytes = canonicalBytes(seed);
  return {
    kind: "seed", mediaType: "application/json", provenanceLabel: "caller",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteCount: bytes.byteLength, sensitivity: "ordinary", retention: "until-handoff",
    producer: { kind: "host", contractDigest: PIN_DIGEST }, untrusted: true,
  };
}

/** The declared output contract and its pinned Milestone A handoff subset. */
function outputContract(v: SyntheticPackVocabulary): Record<string, unknown> {
  return {
    producingPhaseIds: [v.joinPhaseId],
    handoffCapacity: {
      milestoneADesignDigest: MILESTONE_A_DESIGN_DIGEST,
      includedEvidenceClasses: [{
        classId: v.evidenceClassId, maximumItems: HANDOFF_ITEMS,
        maximumItemBytes: HANDOFF_ITEM_BYTES, maximumAggregateBytes: HANDOFF_AGGREGATE_BYTES,
      }],
      maximumBundlePayloadBytes: HANDOFF_BUNDLE_PAYLOAD_BYTES,
      maximumManifestBytes: HANDOFF_MANIFEST_BYTES,
      maximumRunEvidenceItemBytes: HANDOFF_RUN_EVIDENCE_ITEM_BYTES,
      maximumRunEvidenceBytes: HANDOFF_RUN_EVIDENCE_BYTES,
      maximumActiveStoreContributionBytes: HANDOFF_ACTIVE_STORE_BYTES,
    },
  };
}

/** The whole-run worst case, folded exactly as `plan-bounds.ts` folds it. */
function runBounds(): Record<string, number> {
  return {
    maximumPhaseInstances: PHASE_INSTANCES,
    maximumAttempts: ATTEMPTS,
    maximumInvocations: ATTEMPTS * INVOCATIONS_PER_ATTEMPT,
    maximumBrokerRequests: 0,
    maximumEffects: 0,
    maximumTransitions: PHASE_INSTANCES * TRANSITIONS_PER_INSTANCE,
    maximumEvidenceRefs: ATTEMPTS + PHASE_INSTANCES,
    maximumEvidenceBytes: PHASE_INSTANCES * OUTPUT_EVIDENCE_BYTES,
    maximumCheckpointBytes: REPEAT_ITERATIONS * CHECKPOINT_BYTES,
    maximumTokens: ATTEMPTS * TOKENS_PER_ATTEMPT,
    maximumTimeMs: PHASE_INSTANCES * TIME_MS_PER_INSTANCE,
    maximumCostMicros: ATTEMPTS * COST_MICROS_PER_ATTEMPT,
  };
}

/** One authority reference under the given pack-supplied identity. */
function authority(id: string): Record<string, unknown> {
  return { id, version: "1.0.0", digest: PIN_DIGEST, runtimeIdentityDigest: PIN_DIGEST };
}

/** Build one complete plan document: shared mechanics, pack-supplied names. */
function planDocumentFor(v: SyntheticPackVocabulary, seed: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1, executionMode: "durable-preparation", atomicityClass: "local-bundle-only",
    workspaceId: v.workspaceId,
    knowledgeAuthority: authority(v.knowledgeAuthorityId),
    operationsAuthority: authority(v.operationsAuthorityId),
    actionAuthority: {
      actionId: v.actionId, actionDescriptorDigest: PIN_DIGEST, handlerContractDigest: PIN_DIGEST,
      requestedSurface: "cli", capabilityClassCeiling: "read-only",
    },
    recipeDigest: PIN_DIGEST,
    initialInputSet: initialInputSet(seed),
    phases: [originPhase(v), fanOutPhase(v), gatePhase(v), repeatPhase(v), joinPhase(v)],
    outputContract: outputContract(v),
    bounds: runBounds(),
    safetyFloorDigest: PIN_DIGEST,
  };
}

/** Assemble one pack from its vocabulary and seed over the shared skeleton. */
export function buildSyntheticPack(
  name: string, vocabulary: SyntheticPackVocabulary, seed: Record<string, unknown>,
): SyntheticPack {
  return { name, vocabulary, seed, planDocument: () => planDocumentFor(vocabulary, seed) };
}

/**
 * The research vocabulary: discovery, a bounded fan-out over what it found, an
 * operator shortlist, and a checkpointed analysis that drains its own frontier.
 */
const RESEARCH_VOCABULARY: SyntheticPackVocabulary = {
  workspaceId: "research",
  knowledgeAuthorityId: "literature",
  operationsAuthorityId: "corpus",
  actionId: "survey",
  originPhaseId: "discovery",
  originCapabilityId: "harvest",
  fanOutPhaseId: "citations",
  fanOutHandlerId: "indexer",
  gatePhaseId: "shortlist",
  repeatPhaseId: "analysis",
  repeatCapabilityId: "annotate",
  joinPhaseId: "synthesis",
  seedBindingId: "hypothesis",
  originOutputBindingId: "harvested",
  fanOutOutputBindingId: "indexed",
  gateOutputBindingId: "shortlisted",
  repeatOutputBindingId: "annotated",
  deficitClassId: "unreadPapers",
  continuationField: "frontier",
  evidenceClassId: "findings",
};

/** The research pack's seed document, in its own vocabulary. */
const RESEARCH_SEED: Record<string, unknown> = { hypothesis: "photocatalysis", frontier: "preprints" };

/** The research-flavored synthetic preparation pack. */
export const syntheticResearchPack: SyntheticPack =
  buildSyntheticPack("research", RESEARCH_VOCABULARY, RESEARCH_SEED);
