/**
 * @file src/profile/templates/update-apply.ts
 * @description Under-lock remote template update executor. Unlocked plans are
 * advisory; this module re-verifies and re-audits every condition before write.
 *
 * ONE LOCKED BODY: {@link applyRemoteUpdateLockedWith} owns, under the held project
 * and tap locks, the current-provenance requirement, the prefetched-versus-current
 * comparison, the fresh plan and its incompatibility refusal, the next lock, and
 * the journalled transaction (lock pre-state, profile pre-state, advisory lock,
 * profile, commit; on any failure recover-or-refuse BEFORE rethrowing) over
 * {@link RemoteUpdateLockedSteps}. Remote tap resolution is a HOST step there; the
 * root form keeps the recovery gate before the prefetch, the test seam after it,
 * the re-acquire and recovery, then the tap lock, exactly as before.
 */
import { assertProfileChangeAllowed } from "../../indexed/profile-guard.js";
import path from "node:path";
import { releaseLock } from "../../utils/lock.js";
import { acquireMutationLockBlocking } from "../../operation-bundles/lock-gate.js";
import { PROFILE_FILE } from "../../utils/constants.js";
import { openBatch, recordPreState, commitBatch, type JournalBatch } from "../../trust/journal.js";
import { recoverJournalBeforeCompile } from "../../trust/journal-recovery.js";
import { loadProfile } from "../load.js";
import {
  buildTemplateLock,
  writeAdvisoryTemplateLock,
  writeInstalledProfile,
} from "./install.js";
import { readTemplateLock, TEMPLATE_LOCK_FILE, type TemplateLockRead } from "./lock.js";
import {
  remoteProvenanceForResolved,
  resolveRemotePairFromLock,
  resolveRemoteUpdatePairForRoot,
  type RemoteTemplateUpdatePlan,
  type RemoteUpdatePair,
} from "./remote-lifecycle.js";
import { withTapStateLock } from "./taps/operator-lock.js";
import type { TapPaths } from "./taps/paths.js";
import type { LoadedProfile } from "../types.js";
import type { TemplateLock, TemplateLockV2 } from "./types.js";
import { planTemplateUpdate, type TemplateUpdatePlan } from "./update.js";

/** Test seams for deterministic pre-lock mutation and write-failure coverage. */
export interface RemoteUpdateApplyOptions {
  afterPrefetchForTest?: () => Promise<void>;
  writeProfileForTest?: typeof writeInstalledProfile;
}

/** Successful remote update result and the fresh plan that authorized it. */
export interface RemoteUpdateResult {
  kind: "updated";
  fromCoordinate: string;
  toCoordinate: string;
  plan: RemoteTemplateUpdatePlan;
}

/** Apply one compatible remote update after complete under-lock revalidation. */
export async function applyRemoteTemplateUpdate(
  root: string,
  paths: TapPaths,
  toVersion: string,
  options: RemoteUpdateApplyOptions = {},
): Promise<RemoteUpdateResult> {
  await recoverBeforePlanning(root);
  await assertProfileChangeAllowed(root);
  const prefetched = await resolveRemoteUpdatePairForRoot(root, paths, toVersion, false);
  await options.afterPrefetchForTest?.();
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    await assertProfileChangeAllowed(root);
    await recoverOrRefuse(root);
    return await withTapStateLock(paths, async () =>
      applyRemoteUpdateLockedWith(localRemoteUpdateSteps(root, paths, options), toVersion, prefetched));
  } finally {
    await releaseLock(root);
  }
}

/** What the locked update asks of the project and the host. No member takes a project root. */
export interface RemoteUpdateLockedSteps {
  /** The advisory provenance lock. Local: `readTemplateLock(root)`. */
  readTemplateLock(): Promise<TemplateLockRead>;
  /** HOST. Re-resolve the base and candidate pair from the lock, offline. Local: `resolveRemotePairFromLock(paths, lock, toVersion, true)`. */
  resolvePairFromLock(lock: TemplateLockV2, toVersion: string): Promise<RemoteUpdatePair>;
  /** The active profile. Local: `loadProfile(root)`. */
  loadProfile(): Promise<LoadedProfile>;
  /** DOMAIN. The fresh compatibility plan. Local: `planTemplateUpdate(root, ...)`. */
  planUpdate(active: LoadedProfile["profile"], base: RemoteUpdatePair["base"]["package"], candidate: RemoteUpdatePair["candidate"]["package"]): Promise<TemplateUpdatePlan>;
  /** Journal recovery's verdict. Local: `recoverJournalBeforeCompile(root)`. */
  recoverJournal(): Promise<{ status: string }>;
  /** Open one journal batch. Local: `openBatch(root)`. */
  openBatch(): Promise<JournalBatch>;
  /** Record one leaf's pre-state into the batch. Local: `recordPreState(batch, <root>/<leaf>)`. */
  recordPreState(batch: JournalBatch, leaf: "template-lock" | "profile"): Promise<void>;
  /** Durably write the advisory lock. Local: `writeAdvisoryTemplateLock(root, lock)`. */
  writeTemplateLock(lock: TemplateLock): Promise<void>;
  /** Durably write the profile. Local: the `writeProfileForTest` seam, read now, else `writeInstalledProfile(root, pkg)`. */
  writeProfile(pkg: RemoteUpdatePair["candidate"]["package"]): Promise<void>;
  /** Commit the batch. Local: `commitBatch(batch)`. */
  commitBatch(batch: JournalBatch): Promise<void>;
}

/** LOCAL. The incumbent project collaborators and the host tap resolution for one root, built per call. */
function localRemoteUpdateSteps(root: string, paths: TapPaths, options: RemoteUpdateApplyOptions): RemoteUpdateLockedSteps {
  return {
    readTemplateLock: () => readTemplateLock(root),
    resolvePairFromLock: (lock, toVersion) => resolveRemotePairFromLock(paths, lock, toVersion, true),
    loadProfile: () => loadProfile(root),
    planUpdate: (active, base, candidate) => planTemplateUpdate(root, active, base, candidate),
    recoverJournal: () => recoverJournalBeforeCompile(root),
    openBatch: () => openBatch(root),
    recordPreState: (batch, leaf) => recordPreState(batch, path.join(root, leaf === "template-lock" ? TEMPLATE_LOCK_FILE : PROFILE_FILE)),
    writeTemplateLock: (lock) => writeAdvisoryTemplateLock(root, lock),
    writeProfile: (pkg) => (options.writeProfileForTest ?? writeInstalledProfile)(root, pkg),
    commitBatch: (batch) => commitBatch(batch),
  };
}

/** Under the held project and tap locks: THE ONE LOCKED UPDATE BODY. */
export async function applyRemoteUpdateLockedWith(
  steps: RemoteUpdateLockedSteps,
  toVersion: string,
  prefetched: RemoteUpdatePair,
): Promise<RemoteUpdateResult> {
  const lock = await currentRemoteLock(steps);
  const current = await steps.resolvePairFromLock(lock, toVersion);
  assertResolutionUnchanged(prefetched, current);
  const active = (await steps.loadProfile()).profile;
  const basePlan = await steps.planUpdate(active, current.base.package, current.candidate.package);
  const plan: RemoteTemplateUpdatePlan = {
    ...basePlan,
    fromCoordinate: current.fromCoordinate,
    toCoordinate: current.toCoordinate,
  };
  if (!plan.compatible) throw new Error(`remote template update is incompatible:\n- ${formatReasons(plan)}`);
  const nextLock = buildTemplateLock(current.candidate.package, {
    sourceType: "remote",
    remote: remoteProvenanceForResolved(current.candidate),
  });
  await writeUpdateTransaction(steps, current.candidate.package, nextLock);
  return { kind: "updated", fromCoordinate: current.fromCoordinate, toCoordinate: current.toCoordinate, plan };
}

async function recoverBeforePlanning(root: string): Promise<void> {
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    await recoverOrRefuse(root);
  } finally {
    await releaseLock(root);
  }
}

async function writeUpdateTransaction(
  steps: RemoteUpdateLockedSteps,
  pkg: RemoteUpdatePair["candidate"]["package"],
  nextLock: TemplateLock,
): Promise<void> {
  const batch = await steps.openBatch();
  try {
    await steps.recordPreState(batch, "template-lock");
    await steps.recordPreState(batch, "profile");
    await steps.writeTemplateLock(nextLock);
    await steps.writeProfile(pkg);
    await steps.commitBatch(batch);
  } catch (error) {
    refuseUnsafeRecovery(await steps.recoverJournal());
    throw error;
  }
}

async function recoverOrRefuse(root: string): Promise<void> {
  refuseUnsafeRecovery(await recoverJournalBeforeCompile(root));
}

/** Refuse to continue over a journal that recovery found unsafe. */
function refuseUnsafeRecovery(recovery: { status: string }): void {
  if (recovery.status === "unsafe") {
    throw new Error("project journal is unsafe; refusing remote template update");
  }
}

async function currentRemoteLock(steps: Pick<RemoteUpdateLockedSteps, "readTemplateLock">): Promise<TemplateLockV2> {
  const read = await steps.readTemplateLock();
  if (read.kind !== "ok" || read.lock.schemaVersion !== 2 || read.lock.sourceType !== "remote") {
    throw new Error(`remote update provenance is ${read.kind}`);
  }
  return read.lock;
}

function assertResolutionUnchanged(expected: RemoteUpdatePair, current: RemoteUpdatePair): void {
  for (const field of ["base", "candidate"] as const) {
    const left = expected[field];
    const right = current[field];
    if (left.coordinate !== right.coordinate
      || left.payloadDigest !== right.payloadDigest
      || left.publisherKeyId !== right.publisherKeyId
      || left.tapSequence !== right.tapSequence) {
      throw new Error("remote template evidence changed after review; retry the update");
    }
  }
}

function formatReasons(plan: RemoteTemplateUpdatePlan): string {
  return plan.reasons.map((reason) => `${reason.kind}: ${reason.path ? `${reason.path}: ` : ""}${reason.message}`).join("\n- ");
}
