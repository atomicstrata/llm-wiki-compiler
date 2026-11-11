/**
 * @file src/operation-bundles/record-effect-steps.ts
 * @description The one port the record-effect family (prepare, observe,
 * retire) reaches the project through.
 *
 * ONE PORT, NO ROOT. {@link RecordEffectSteps} is every read, write and lock the
 * family uses: the preparation lock, the inventory, the bundle observation, the
 * profile, the page samples and the entity leaf the lifecycle check rehashes,
 * the trust planner, the effect reservation, staging, the manifest and its
 * retained payloads, the authenticated run and the fenced append.
 * {@link diskRecordEffectSteps} answers each one with the incumbent root form,
 * called when asked with its old arguments, so module spies and mocks still
 * intercept. The decisions stay in `prepare-record.ts` and `record-effect.ts`.
 */

import path from "node:path";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { LoadedProfile } from "../profile/types.js";
import { planPageMutation, type PlanPageInput, type PlanResult } from "../trust/planner.js";
import { readConfinedLeafBuffer, type CappedLeafReadBuffer } from "../utils/confined-read.js";
import { readBundlePayload, readPageDigest, type LeafDigest, type PayloadRead } from "./adapters/shared.js";
import { scanOperationInventory, type OperationInventory } from "./capacity.js";
import { MAX_PAYLOAD_BYTES } from "./constants.js";
import { reserveRecordEffectLocked, type EffectReservation } from "./effect-reservation.js";
import type { BundleId } from "./ids.js";
import type { OperationManifestRead } from "./manifest-store.js";
import { diskOperationObservationReads, observeOperationBundleWith, type OperationBundleObservationV1 } from "./observe.js";
import { operationPassReads } from "./pass-reads.js";
import { once } from "../utils/pass-memo.js";
import { diskRecordPreparationLock, type RecordPreparationLock } from "./record-authority.js";
import type { RecordIntentV1 } from "./record-intent.js";
import { appendOperationTransitionLocked, type OperationRunRead } from "./run-store.js";
import type { AppendOperationTransitionInput, OperationRun, OperationRunBinding, OperationRunPredecessor } from "./run-types.js";
import { stageOperationBundleLocked, type StageOperationBundleRequest, type StageOperationBundleResult } from "./stage.js";
import type { PageOperationMutation } from "./types.js";

/** Every read, write and lock the record-effect family uses. No member takes a project root. */
export interface RecordEffectSteps {
  /** The project lock preparation and retirement serialize under. */
  readonly lock: RecordPreparationLock;
  /** The whole operation inventory. */
  scanInventory(): Promise<OperationInventory>;
  /** The authenticated observation of one bundle, by manifest digest. */
  observe(manifestDigest: string): Promise<OperationBundleObservationV1>;
  /** The active non-default profile, or undefined. */
  loadProfile(): Promise<LoadedProfile | undefined>;
  /** One page mutation's current confined bytes, as a digest. */
  readPageDigest(mutation: PageOperationMutation): Promise<LeafDigest>;
  /** One entity page's bytes, confined to its type's directory, single-link and capped at the payload limit. */
  readEntityLeaf(entityType: string, slug: string): Promise<CappedLeafReadBuffer>;
  /** The trust planner's verdict on one page write. */
  planPage(input: Omit<PlanPageInput, "root">): Promise<PlanResult>;
  /** Reserve the effect's bundle and run identities; the caller holds the lock. */
  reserve(preparerId: string, intent: RecordIntentV1): Promise<EffectReservation>;
  /** The staging transaction; the caller holds the lock. */
  stage(request: StageOperationBundleRequest): Promise<StageOperationBundleResult>;
  /** One staged manifest. */
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
  /** One retained bundle payload. */
  readPayload(workspaceId: string, bundleId: BundleId, payloadRef: string): Promise<PayloadRead>;
  /** The authenticated run at its exact binding. */
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  /** Append one transition fenced to `expected`; the caller holds the lock. */
  appendTransition(binding: OperationRunBinding, expected: OperationRunPredecessor, input: AppendOperationTransitionInput): Promise<OperationRun>;
}

/** The preparation lock, with `renew` called once it is taken: the hold's reads start a new pass. */
function renewingLock(root: string, renew: () => void): RecordPreparationLock {
  const lock = diskRecordPreparationLock(root);
  return { acquire: async () => { const acquired = await lock.acquire(); renew(); return acquired; }, release: () => lock.release() };
}

/**
 * LOCAL DISK. The incumbent root forms for `root`, each called when asked with
 * its old arguments. The store reads (inventory, observation, manifest, run) are
 * ONE PASS (`pass-reads.ts`) between writes, the inventory scanned at most once
 * in it: a fresh pass is taken when the lock is taken and again after every
 * reservation, staging or append, so a reuse check's inventory and the
 * observation that follows share one walk and one key read, and no answer
 * survives the write that could change it.
 */
export function diskRecordEffectSteps(root: string): RecordEffectSteps {
  let pass = operationPassReads(root);
  let scanInventory = once(() => scanOperationInventory(root, {}, pass));
  const renew = () => {
    pass = operationPassReads(root);
    scanInventory = once(() => scanOperationInventory(root, {}, pass));
  };
  const afterWrite = async <T>(write: Promise<T>): Promise<T> => { try { return await write; } finally { renew(); } };
  return {
    lock: renewingLock(root, renew),
    scanInventory: () => scanInventory(),
    observe: (manifestDigest) => observeOperationBundleWith({ ...diskOperationObservationReads(root, pass), scanInventory }, manifestDigest),
    loadProfile: () => loadNonDefaultProfile(root),
    readPageDigest: (mutation) => readPageDigest(root, mutation),
    readEntityLeaf: (entityType, slug) => {
      const parent = path.join(root, "wiki", entityType);
      return readConfinedLeafBuffer(root, path.join(parent, `${slug}.md`), parent, MAX_PAYLOAD_BYTES, { requireSingleLink: true });
    },
    planPage: (input) => planPageMutation({ root, ...input }),
    reserve: (preparerId, intent) => afterWrite(reserveRecordEffectLocked(root, preparerId, intent)),
    stage: (request) => afterWrite(stageOperationBundleLocked(root, request)),
    readManifest: (workspaceId, bundleId) => pass.readManifest(workspaceId, bundleId),
    readPayload: (workspaceId, bundleId, payloadRef) => readBundlePayload(root, workspaceId, bundleId, payloadRef),
    readRun: (binding) => pass.readRun(binding),
    appendTransition: (binding, expected, input) => afterWrite(appendOperationTransitionLocked(root, binding, expected, input)),
  };
}
