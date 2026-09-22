/**
 * @file src/operation-bundles/stage.ts
 * @description Internal locked staging transaction for immutable operation
 * bundles. It snapshots all caller memory, completes every read-only preflight,
 * then durably publishes payloads, canonical manifest, and HMAC genesis run in
 * that exact order. It intentionally exposes no CLI, SDK, or MCP surface.
 */

import { captureCandidateCustody } from "../compiler/candidate-custody.js";
import { inventoryHasRetainedState } from "../utils/inventory-arithmetic.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import {
  assertStageCapacity, scanOperationInventory,
  StageCapacityError, type OperationInventory,
} from "./capacity.js";
import { MAX_MUTATIONS_PER_BUNDLE } from "./constants.js";
import {
  assertBundleId, assertOperationRunId, catalogRecordId, mintBundleId,
  mintOperationRunId, mutationId, type BundleId,
  type OperationRunId,
} from "./ids.js";
import {
  createOperationKeyForEmptyEpochLocked, readOperationKey,
  type OperationKeyRead,
} from "./key-epoch.js";
import { validateBundleGraphSet } from "./manifest-graph.js";
import { operationManifestDigest, parseOperationManifest } from "./manifest-parse.js";
import { writeOperationManifestCreateOnly } from "./manifest-store.js";
import { operationPaths } from "./paths.js";
import { writePayloadCreateOnly } from "./payload-store.js";
import { OPERATION_GRANTS, OPERATION_PRINCIPAL_SURFACES } from "./principal.js";
import { projectRunBudget, type RunBudget } from "./run-budget.js";
import {
  createInitialOperationRun, operationKeyEpochId, operationRunBinding,
  signOperationRun,
} from "./run-integrity.js";
import { parseOperationRun } from "./run-parse.js";
import { createOperationRunLocked, readOperationRun } from "./run-store.js";
import { projectStageCapacity } from "./stage-capacity.js";
import { assertStageIntent } from "./stage-intent.js";
import {
  inspectStageMaterialization, type StageMaterialization,
} from "./stage-materialization.js";
import type { InitialOperationRunInput, OperationRun } from "./run-types.js";
import type {
  CatalogOperationMutation, OperationBundleManifest, OperationDigest,
  OperationMutation,
} from "./types.js";

/** Synchronous wall clock used to bind manifest and genesis timestamps. */
export interface Clock { now(): Date }

type MutationDraft<T extends OperationMutation> = T extends CatalogOperationMutation
  ? Omit<T, "index" | "mutationId" | "postcondition"> & {
    postcondition: Omit<T["postcondition"], "recordId">;
  }
  : Omit<T, "index" | "mutationId">;

/** One mutation before staging derives its bundle-bound identities. */
export type OperationMutationDraft = MutationDraft<OperationMutation>;

/** Data-only genesis authority captured with an internal bundle draft. */
export interface OperationRunDraft {
  actor: InitialOperationRunInput["actor"];
  declaredCompensatorIndexes: number[];
  controlTransitionAllowance: number;
}

/** Immutable intent before core mints IDs and the common creation timestamp. */
export type OperationBundleDraft = Omit<
  OperationBundleManifest,
  "schemaVersion" | "bundleId" | "runId" | "createdAt" | "mutations"
> & {
  mutations: readonly OperationMutationDraft[];
  run: OperationRunDraft;
};

/** Deterministic crash seams placed immediately after durable boundaries. */
export interface StageFaultsForTest {
  afterPayloadSync?: (index: number) => Promise<void>;
  afterManifestSync?: () => Promise<void>;
  beforeInitialRunSync?: () => Promise<void>;
  afterInitialRunSync?: () => Promise<void>;
}

/** Complete internal request; callers already hold the project lock. */
export interface StageOperationBundleRequest {
  draft: OperationBundleDraft;
  payloads: ReadonlyMap<string, Buffer>;
  dryRun?: boolean;
  clock?: Clock;
  /**
   * Core-minted identities a trusted internal caller (the preparation handoff)
   * reserves so a crash-interrupted create RESUMES the exact same bundle rather
   * than mints a duplicate. Unlike `idsForTest` this is a production path; both
   * are re-asserted through the branded ULID validators before use.
   */
  reservedIds?: { bundleId: BundleId; runId: OperationRunId };
  idsForTest?: { bundleId: BundleId; runId: OperationRunId };
  faultsForTest?: StageFaultsForTest;
}

/** Canonical intent and exact whole-run projection returned by staging. */
export interface StageOperationBundleResult {
  manifest: OperationBundleManifest;
  manifestDigest: OperationDigest;
  projectedRunBudget: RunBudget;
  wrote: boolean;
}

interface PreparedStage {
  manifest: OperationBundleManifest;
  manifestBytes: Buffer;
  manifestDigest: OperationDigest;
  payloads: ReadonlyMap<string, Buffer>;
  run: OperationRunDraft;
  projectedRunBudget: RunBudget;
  dryRun: boolean;
  faults: StageFaultsForTest;
}

/** Derive catalog physical identity while adding the common mutation envelope. */
function materializeMutation(
  value: OperationMutationDraft,
  bundleId: BundleId,
  index: number,
): OperationMutation {
  const id = mutationId(bundleId, index);
  if (value.kind === "catalog-record") {
    return {
      ...value, index, mutationId: id,
      postcondition: { ...value.postcondition, recordId: catalogRecordId(id) },
    } as CatalogOperationMutation;
  }
  return { ...value, index, mutationId: id } as OperationMutation;
}

/** Rebuild the closed manifest synchronously before the first await. */
function materializeManifest(
  draft: OperationBundleDraft,
  bundleId: BundleId,
  runId: OperationRunId,
  createdAt: string,
): OperationBundleManifest {
  const { run: _run, mutations, ...intent } = draft;
  const candidate = {
    ...intent, schemaVersion: 1, bundleId, runId, createdAt,
    mutations: mutations.map((item, index) => materializeMutation(item, bundleId, index)),
  };
  return parseOperationManifest(canonicalBytes(candidate).toString("utf8"));
}

/** Capture and validate mutable genesis authority without retaining aliases. */
function snapshotRun(run: OperationRunDraft, mutationCount: number): OperationRunDraft {
  const actor = {
    id: run.actor.id, surface: run.actor.surface, grants: [...run.actor.grants],
  };
  if (typeof actor.id !== "string" || actor.id.length === 0 ||
      !OPERATION_PRINCIPAL_SURFACES.includes(actor.surface) ||
      actor.grants.some((grant) => !OPERATION_GRANTS.includes(grant))) {
    throw new Error("operation run actor is invalid");
  }
  const indexes = [...run.declaredCompensatorIndexes];
  if (new Set(indexes).size !== indexes.length || indexes.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= mutationCount)) {
    throw new Error("declared compensator index is invalid");
  }
  if (!Number.isSafeInteger(run.controlTransitionAllowance) ||
      run.controlTransitionAllowance <= 0) {
    throw new Error("operation run requires positive control transition headroom");
  }
  return { actor, declaredCompensatorIndexes: indexes,
    controlTransitionAllowance: run.controlTransitionAllowance };
}

/** Copy every payload buffer and reject mutable or malformed map entries. */
function snapshotPayloads(payloads: ReadonlyMap<string, Buffer>): ReadonlyMap<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const [digest, bytes] of payloads) {
    if (!/^[0-9a-f]{64}$/.test(digest) || !Buffer.isBuffer(bytes) || result.has(digest)) {
      throw new Error("operation payload map is invalid");
    }
    result.set(digest, Buffer.from(bytes));
  }
  return result;
}

/** Snapshot every caller-owned value and calculate the exact run budget. */
function prepareStage(request: StageOperationBundleRequest): PreparedStage {
  const payloads = snapshotPayloads(request.payloads);
  const draft = request.draft;
  const reserved = request.reservedIds ?? request.idsForTest;
  const bundleId = reserved === undefined ? mintBundleId() : assertBundleId(reserved.bundleId);
  const runId = reserved === undefined ? mintOperationRunId() : assertOperationRunId(reserved.runId);
  if (draft.mutations.length > MAX_MUTATIONS_PER_BUNDLE) {
    throw new StageCapacityError("mutations");
  }
  const now = request.clock?.now() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("operation staging clock is invalid");
  }
  const manifest = materializeManifest(draft, bundleId, runId, now.toISOString());
  const run = snapshotRun(draft.run, manifest.mutations.length);
  const projectionCount = manifest.mutations.filter((item) => item.kind === "projection").length;
  const projectedRunBudget = projectRunBudget({
    mutationCount: manifest.mutations.length - projectionCount,
    declaredCompensatorCount: run.declaredCompensatorIndexes.length,
    projectionCount, controlTransitionAllowance: run.controlTransitionAllowance,
  });
  const manifestBytes = canonicalBytes(manifest);
  const prepared: PreparedStage = {
    manifest, manifestBytes,
    manifestDigest: operationManifestDigest(manifest) as OperationDigest,
    payloads, run, projectedRunBudget, dryRun: request.dryRun === true,
    faults: { ...request.faultsForTest },
  };
  assertGenesisPreflight(prepared);
  return prepared;
}

/** Parse an exact signed genesis in memory so no run defect follows a write. */
function assertGenesisPreflight(prepared: PreparedStage): void {
  const key = Buffer.alloc(32, 0xa5);
  const input = genesisInput(prepared, operationKeyEpochId(key));
  const signed = signOperationRun(key, createInitialOperationRun(input));
  parseOperationRun(canonicalBytes(signed).toString("utf8"), operationRunBinding(signed));
}

/** Reject any legacy review record sharing the reserved bundle namespace. */
export async function assertReviewIdentityAvailable(root: string, bundleId: BundleId): Promise<void> {
  const candidate = await captureCandidateCustody(root, bundleId);
  if (candidate !== null) throw new Error("ambiguous legacy candidate and operation bundle identity");
}

/** Validate the retained graph and proposed node in one bounded indexed pass. */
function assertGraph(prepared: PreparedStage, inventory: OperationInventory): void {
  const retained = inventory.manifests.filter((manifest) =>
    manifest.bundleId !== prepared.manifest.bundleId);
  validateBundleGraphSet([...retained, prepared.manifest]);
}

/** Refuse missing key reuse unless all active and quarantine state is empty. */
function assertKeyCompatible(key: OperationKeyRead, inventory: OperationInventory): void {
  if (key.status === "unavailable") throw new Error("operation integrity key is unreadable");
  if (key.status === "ok") return;
  if (inventoryHasRetainedState(Object.values(inventory.epoch), inventory.quarantine)) {
    throw new Error("operation integrity key is missing for an active epoch");
  }
}

/** Build exact genesis inputs from snapshotted staging authority. */
function genesisInput(
  prepared: PreparedStage,
  keyEpochId: OperationDigest,
): InitialOperationRunInput {
  const declaredCompensatorMutationIds = prepared.run.declaredCompensatorIndexes
    .map((index) => prepared.manifest.mutations[index]!.mutationId);
  return {
    manifest: prepared.manifest, manifestDigest: prepared.manifestDigest,
    keyEpochId, actor: prepared.run.actor, at: prepared.manifest.createdAt,
    declaredCompensatorMutationIds,
    controlTransitionAllowance: prepared.run.controlTransitionAllowance,
  };
}

/** Serialize the exact candidate genesis when the current key is readable. */
function expectedGenesisBytes(
  prepared: PreparedStage,
  key: OperationKeyRead,
): Buffer | undefined {
  if (key.status !== "ok") return undefined;
  const input = genesisInput(prepared, key.keyEpochId);
  return canonicalBytes(signOperationRun(key.key, createInitialOperationRun(input)));
}

/** Accept an exact fully-staged replay before invoking create-only run genesis. */
async function createOrReplayRun(
  root: string,
  input: InitialOperationRunInput,
  key: Buffer,
): Promise<OperationRun> {
  const expected = signOperationRun(key, createInitialOperationRun(input));
  const binding = operationRunBinding(expected);
  const existing = await readOperationRun(root, binding);
  if (existing.status === "ok") {
    if (!canonicalBytes(existing.run).equals(canonicalBytes(expected))) {
      throw new Error("operation run genesis replay conflict");
    }
    return existing.run;
  }
  if (existing.status === "unavailable") throw new Error("operation run target is unavailable");
  return createOperationRunLocked(root, input);
}

/** Publish one completely preflighted bundle in the required durable order. */
async function publishStage(
  root: string,
  prepared: PreparedStage,
  key: { key: Buffer; keyEpochId: OperationDigest },
  materialization: StageMaterialization,
): Promise<void> {
  const payloads = [...prepared.payloads.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let index = 0; index < payloads.length; index++) {
    const [digest, bytes] = payloads[index]!;
    if (!materialization.missingPayloads.has(digest)) continue;
    await writePayloadCreateOnly(root, {
      workspaceId: prepared.manifest.workspaceId,
      bundleId: prepared.manifest.bundleId, digest,
    }, bytes);
    await prepared.faults.afterPayloadSync?.(index);
  }
  if (materialization.missingManifest) {
    await writeOperationManifestCreateOnly(root, prepared.manifest);
    await prepared.faults.afterManifestSync?.();
  }
  if (materialization.missingRun) {
    await prepared.faults.beforeInitialRunSync?.();
    await createOrReplayRun(root, genesisInput(prepared, key.keyEpochId), key.key);
    await prepared.faults.afterInitialRunSync?.();
  }
}

/** Stage one immutable bundle while the caller holds the project lock. */
export async function stageOperationBundleLocked(
  root: string,
  request: StageOperationBundleRequest,
): Promise<StageOperationBundleResult> {
  const prepared = prepareStage(request);
  assertStageIntent(prepared.manifest, prepared.payloads);
  operationPaths(root, prepared.manifest.workspaceId).bundleRoot(prepared.manifest.bundleId);
  const inventory = await scanOperationInventory(root);
  if (inventory.problems.length > 0) {
    throw new Error(`operation inventory unavailable: ${inventory.problems[0]!.dimension}`);
  }
  const currentKey = await readOperationKey(root);
  assertKeyCompatible(currentKey, inventory);
  const materialization = await inspectStageMaterialization(
    root, prepared.manifest, prepared.manifestBytes, prepared.payloads, inventory,
    expectedGenesisBytes(prepared, currentKey),
  );
  await assertReviewIdentityAvailable(root, prepared.manifest.bundleId);
  assertGraph(prepared, inventory);
  assertStageCapacity(projectStageCapacity(prepared, inventory, materialization));
  const result = {
    manifest: prepared.manifest, manifestDigest: prepared.manifestDigest,
    projectedRunBudget: prepared.projectedRunBudget,
  };
  if (prepared.dryRun || (materialization.complete && materialization.settled)) {
    return { ...result, wrote: false };
  }
  const key = currentKey.status === "ok" ? currentKey
    : await createOperationKeyForEmptyEpochLocked(root, inventory.epoch);
  await publishStage(root, prepared, key, materialization);
  return { ...result, wrote: true };
}
