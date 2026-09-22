/**
 * @file src/preparations/handoff-bundle.ts
 * @description Pure, network-free assembly of the self-contained Milestone A
 * bundle a handoff hands over (design section 22.2/22.3). It derives the bundle's
 * authority fields from the DURABLE preparation manifest (never a caller
 * snapshot), compiles the local mutation intent through the Task 7 host authority
 * (the intent compiler, which authenticates every evidence record it reads), mints
 * the host-authored `preparation-handoff-origin-v1` entry, and returns the exact
 * immutable draft plus the complete content-addressed payload set. It writes
 * nothing and calls no provider, broker, model, command, renderer, or compiler
 * process: the intent compiler is a synchronous pure function. Every payload the
 * bundle needs — each mutation payload, each copied preparation-evidence object,
 * and the origin blob — is present in the returned map, so the bundle is
 * self-contained by construction.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import {
  buildPreparationHandoffOrigin, type BuiltPreparationHandoffOrigin,
} from "../operation-bundles/preparation-origin.js";
import type { BundleId } from "../operation-bundles/ids.js";
import type {
  OperationBundleDraft, OperationMutationDraft, OperationRunDraft,
} from "../operation-bundles/stage.js";
import type {
  KnowledgeAuthorityRef, OperationBound, OperationBundleManifest, OperationDigest,
  OperationInputRef, OperationMutation, OperationsAuthorityRef, PreparationEvidenceRef,
} from "../operation-bundles/types.js";
import type { OperationRun } from "../operation-bundles/run-types.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import type {
  IntentCompilationResultV1, OperationIntentCompilerV1,
} from "./intent-compiler.js";
import type { IntentCompilationRequestV1 } from "./intent-request.js";

/** The settled, host-authored bundle authority the caller supplies. */
export interface HandoffBundleAuthoritiesV1 {
  readonly grantDigest: OperationDigest;
  readonly inputs: readonly OperationInputRef[];
  readonly bounds: readonly OperationBound[];
  readonly operationRun: OperationRunDraft;
}

/** Everything one bundle assembly reads; the compilation carries no bundle id. */
export interface HandoffBundleInputV1 {
  readonly manifest: PreparationManifestV1;
  readonly reservedBundleId: BundleId;
  readonly compilation: Omit<IntentCompilationRequestV1, "bundleId">;
  readonly authorities: HandoffBundleAuthoritiesV1;
  readonly preparationEvidence: readonly PreparationEvidenceRef[];
  readonly payloads: ReadonlyMap<string, Buffer>;
  readonly intentCompiler: OperationIntentCompilerV1;
  readonly handoffId: string;
  readonly preHandoffTransitionHash: OperationDigest;
  readonly supersedesBundleId?: BundleId;
}

/** The assembled immutable draft, complete payload set, and origin provenance. */
export interface HandoffBundleV1 {
  readonly draft: OperationBundleDraft;
  readonly payloads: ReadonlyMap<string, Buffer>;
  readonly origin: BuiltPreparationHandoffOrigin;
  readonly evidenceCopyDigest: OperationDigest;
}

/** Project the durable plan's knowledge authority onto Milestone A's ref shape. */
function knowledgeAuthority(manifest: PreparationManifestV1): KnowledgeAuthorityRef {
  return { id: manifest.plan.knowledgeAuthority.id, digest: manifest.plan.knowledgeAuthority.digest };
}

/** Project the durable plan's operations/action authority onto Milestone A's ref. */
function operationsAuthority(manifest: PreparationManifestV1): OperationsAuthorityRef {
  return {
    packId: manifest.plan.operationsAuthority.id, packDigest: manifest.plan.operationsAuthority.digest,
    actionId: manifest.plan.actionAuthority.actionId,
    actionDescriptorDigest: manifest.plan.actionAuthority.actionDescriptorDigest,
  };
}

/** Strip the compiler-stamped envelope so staging re-derives it from the bundle id. */
function toMutationDraft(mutation: OperationMutation): OperationMutationDraft {
  const { index: _index, mutationId: _mutationId, ...rest } = mutation;
  if (rest.kind === "catalog-record") {
    const { recordId: _recordId, ...postcondition } = rest.postcondition;
    return { ...rest, postcondition } as unknown as OperationMutationDraft;
  }
  return rest as unknown as OperationMutationDraft;
}

/** Digest the exact sorted content-address set the bundle copies (recovery aid). */
function evidenceCopyDigest(payloads: ReadonlyMap<string, Buffer>): OperationDigest {
  const digests = [...payloads.keys()].sort();
  return parseSha256Digest(canonicalDigest({ domain: "llmwiki-preparation-handoff-evidence-copy-v1", digests }));
}

/**
 * Digest the exact genesis-run authority the reserved bundle will be created with
 * — the control-transition allowance, declared compensator indexes, and actor,
 * i.e. every field `run` contributes to the genesis run but the manifest digest
 * omits. Recorded at `handoff-started` and re-asserted on resume so a divergent
 * control budget or compensation topology fails closed rather than landing a
 * different genesis run under the reserved identity.
 */
export function handoffGenesisAuthorityDigest(run: OperationRunDraft): OperationDigest {
  return parseSha256Digest(canonicalDigest({
    domain: "llmwiki-preparation-handoff-genesis-authority-v1",
    actor: { id: run.actor.id, surface: run.actor.surface, grants: [...run.actor.grants] },
    declaredCompensatorIndexes: [...run.declaredCompensatorIndexes],
    controlTransitionAllowance: run.controlTransitionAllowance,
  }));
}

/**
 * Recompute {@link handoffGenesisAuthorityDigest} from an ALREADY-CREATED,
 * authenticated genesis run and its manifest, so the recovery gate verifies the
 * exact same authority the command path recorded at `handoff-started` from the
 * SINGLE source of truth above — never a second copy of the field list. The
 * created run stores compensators as manifest mutation ids and the creating actor
 * on its genesis (`run-staged`, sequence 0) transition; this reverses both back
 * into the draft the digest is defined over. A compensator naming no manifest
 * mutation, or a missing genesis transition, is a corrupt pairing and throws.
 */
export function createdGenesisAuthorityDigest(
  opRun: OperationRun, manifest: OperationBundleManifest,
): OperationDigest {
  const genesis = opRun.transitions[0];
  if (genesis === undefined || genesis.sequence !== 0) {
    throw new Error("created operation run is missing its genesis transition");
  }
  const indexByMutationId = new Map(manifest.mutations.map((mutation) => [mutation.mutationId, mutation.index]));
  const declaredCompensatorIndexes = opRun.obligations.compensations.map((compensation) => {
    const index = indexByMutationId.get(compensation.mutationId);
    if (index === undefined) throw new Error("created run compensator does not name a manifest mutation");
    return index;
  });
  return handoffGenesisAuthorityDigest({
    actor: genesis.actor, declaredCompensatorIndexes,
    controlTransitionAllowance: opRun.controlTransitionAllowance,
  });
}

/**
 * Deep-snapshot the caller's genesis-run authority so the assembled draft OWNS an
 * immutable copy. Staging reads `draft.run` twice — once for the dry-run digest
 * the recovery record pins and once for the real genesis — with awaits between, so
 * a copy shared with the caller could be mutated after the digest is recorded and
 * before the genesis is created, landing a divergent genesis under the reserved
 * identity. Owning a frozen copy makes the recorded digest and the created genesis
 * provably the same authority regardless of what the caller does with its object.
 */
function snapshotOperationRun(run: OperationRunDraft): OperationRunDraft {
  return Object.freeze({
    actor: Object.freeze({
      id: run.actor.id, surface: run.actor.surface, grants: Object.freeze([...run.actor.grants]),
    }),
    declaredCompensatorIndexes: Object.freeze([...run.declaredCompensatorIndexes]),
    controlTransitionAllowance: run.controlTransitionAllowance,
  }) as unknown as OperationRunDraft;
}

/** Merge the caller payloads with the minted origin blob into one exact map. */
function assemblePayloads(
  payloads: ReadonlyMap<string, Buffer>, origin: BuiltPreparationHandoffOrigin,
): ReadonlyMap<string, Buffer> {
  const merged = new Map<string, Buffer>();
  for (const [digest, bytes] of payloads) merged.set(digest, Buffer.from(bytes));
  const existing = merged.get(origin.digest);
  if (existing !== undefined && !existing.equals(origin.bytes)) {
    throw new Error("preparation handoff origin digest collides with a supplied payload");
  }
  merged.set(origin.digest, origin.bytes);
  return merged;
}

/** Assemble the self-contained immutable bundle draft and its complete payloads. */
export function buildHandoffBundle(input: HandoffBundleInputV1): HandoffBundleV1 {
  const compiled: IntentCompilationResultV1 = input.intentCompiler.compile({
    ...input.compilation, bundleId: input.reservedBundleId,
  });
  const origin = buildPreparationHandoffOrigin({
    workspaceId: input.manifest.workspaceId, preparationId: input.manifest.preparationId,
    preparationRunId: input.manifest.runId, preparationManifestDigest: preparationManifestDigest(input.manifest),
    preparationPlanDigest: input.manifest.planDigest, preHandoffTransitionHash: input.preHandoffTransitionHash,
    handoffId: input.handoffId,
  });
  const payloads = assemblePayloads(input.payloads, origin);
  const draft: OperationBundleDraft = {
    workspaceId: input.manifest.workspaceId,
    createdBy: `${input.manifest.createdBy.surface}:${input.manifest.createdBy.id}`,
    knowledgeAuthority: knowledgeAuthority(input.manifest), operationsAuthority: operationsAuthority(input.manifest),
    grantDigest: input.authorities.grantDigest, safetyFloorDigest: input.manifest.plan.safetyFloorDigest,
    inputs: input.authorities.inputs, preparationEvidence: [...input.preparationEvidence, origin.evidenceRef],
    bounds: input.authorities.bounds, completeness: compiled.completeness,
    reconciliations: compiled.reconciliations, mutations: compiled.mutations.map(toMutationDraft),
    planningWarnings: compiled.planningWarnings, run: snapshotOperationRun(input.authorities.operationRun),
    ...(input.supersedesBundleId === undefined ? {} : { supersedesBundleId: input.supersedesBundleId }),
  };
  return { draft, payloads, origin, evidenceCopyDigest: evidenceCopyDigest(payloads) };
}
