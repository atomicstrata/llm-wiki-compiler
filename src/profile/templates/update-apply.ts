/**
 * @file src/profile/templates/update-apply.ts
 * @description Under-lock remote template update executor. Unlocked plans are
 * advisory; this module re-verifies and re-audits every condition before write.
 */
import { acquireLockBlocking, releaseLock } from "../../utils/lock.js";
import { loadProfile } from "../load.js";
import {
  buildTemplateLock,
  writeAdvisoryTemplateLock,
  writeInstalledProfile,
} from "./install.js";
import { readTemplateLock } from "./lock.js";
import {
  remoteProvenanceForResolved,
  resolveRemotePairFromLock,
  resolveRemoteUpdatePairForRoot,
  type RemoteTemplateUpdatePlan,
  type RemoteUpdatePair,
} from "./remote-lifecycle.js";
import { withTapStateLock } from "./taps/operator-lock.js";
import type { TapPaths } from "./taps/paths.js";
import type { TemplateLockV2 } from "./types.js";
import { planTemplateUpdate } from "./update.js";

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
  const prefetched = await resolveRemoteUpdatePairForRoot(root, paths, toVersion, false);
  await options.afterPrefetchForTest?.();
  await acquireLockBlocking(root);
  try {
    return await withTapStateLock(paths, async () => applyLocked(root, paths, toVersion, prefetched, options));
  } finally {
    await releaseLock(root);
  }
}

async function applyLocked(
  root: string,
  paths: TapPaths,
  toVersion: string,
  prefetched: RemoteUpdatePair,
  options: RemoteUpdateApplyOptions,
): Promise<RemoteUpdateResult> {
  const lock = await currentRemoteLock(root);
  const current = await resolveRemotePairFromLock(paths, lock, toVersion, true);
  assertResolutionUnchanged(prefetched, current);
  const active = (await loadProfile(root)).profile;
  const basePlan = await planTemplateUpdate(root, active, current.base.package, current.candidate.package);
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
  await writeAdvisoryTemplateLock(root, nextLock);
  await (options.writeProfileForTest ?? writeInstalledProfile)(root, current.candidate.package);
  return { kind: "updated", fromCoordinate: current.fromCoordinate, toCoordinate: current.toCoordinate, plan };
}

async function currentRemoteLock(root: string): Promise<TemplateLockV2> {
  const read = await readTemplateLock(root);
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
