/**
 * @file src/preparations/handoff.ts
 * @description The network-free, idempotent, crash-resumable handoff that converts
 * a settled preparation into one immutable Milestone A operation bundle (design
 * section 22.3). It runs entirely under the project lock after the shared recovery
 * gate and invokes NO provider, broker, model, network, external command,
 * renderer, or compiler process — the only "compiler" it calls is the synchronous
 * pure Task 7 intent compiler, which it CONSTRUCTS itself so the no-network
 * guarantee is structural rather than a caller-trusted injection.
 *
 * The flow is a sequence of crash-idempotent boundaries. It revalidates the
 * DURABLE run and manifest (never a caller snapshot), reserves the exact bundle
 * and operation-run identities, compiles the bundle in memory, verifies the exact
 * downstream caps and current headroom through a zero-write dry-run stage, durably
 * records `handoff-started` (the reserved-identity recovery authority), stages the
 * bundle through the hardened idempotent `stageOperationBundleLocked`, verifies the
 * created manifest/run, and records `handed-off`. A crash at any boundary resumes
 * the EXACT same creation from the durable `handoff-started` record or parks — it
 * never duplicates or overwrites, because the reserved identities and the
 * deterministic bundle-manifest digest are fixed before the first Milestone A byte.
 */

import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { readOperationKey } from "../operation-bundles/key-epoch.js";
import { readOperationManifest } from "../operation-bundles/manifest-store.js";
import { operationManifestDigest } from "../operation-bundles/manifest-parse.js";
import { readOperationRun } from "../operation-bundles/run-store.js";
import { assertBundleId, assertOperationRunId, mintBundleId, mintOperationRunId, type BundleId, type OperationRunId } from "../operation-bundles/ids.js";
import { stageOperationBundleLocked, type Clock } from "../operation-bundles/stage.js";
import { releaseLock } from "../utils/lock.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import type { OperationDigest } from "../operation-bundles/types.js";
import type { Sha256Digest } from "./types.js";
import { preparationCancellationRequested } from "./cancellation.js";
import { deriveHandoffId, type HandoffId } from "./ids.js";
import { readPreparationManifest } from "./manifest-store.js";
import { preparationManifestDigest } from "./manifest-parse.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import {
  appendHandoffStartedTransitionLocked, appendHandoffTransitionLocked,
  handoffStartBinding, readPreparationRun,
} from "./run-store.js";
import {
  buildHandoffBundle, createdGenesisAuthorityDigest, handoffGenesisAuthorityDigest,
  type HandoffBundleAuthoritiesV1,
} from "./handoff-bundle.js";
import type { IntentCompilationRequestV1 } from "./intent-request.js";
import { createOperationIntentCompilerV1 } from "./intent-compiler.js";
import type { PreparationEvidenceRef } from "../operation-bundles/types.js";
import type {
  HandoffStartBindingV1, PreparationPrincipalV1, PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";

/** Closed reason a handoff failed closed rather than duplicating or laundering. */
export type HandoffCode =
  | "not-handoff-ready" | "key-unavailable" | "manifest-unavailable" | "manifest-drift"
  | "cancelled" | "superseded" | "digest-conflict" | "bundle-unverifiable";

/** Typed refusal raised for every handoff failure. */
export class HandoffError extends Error {
  constructor(readonly code: HandoffCode, message: string) {
    super(`preparation handoff: ${code}: ${message}`);
    this.name = "HandoffError";
  }
}

/** Everything one handoff reads; the compilation carries no reserved bundle id. */
export interface PreparationHandoffRequestV1 {
  readonly binding: PreparationRunBinding;
  readonly compilation: Omit<IntentCompilationRequestV1, "bundleId">;
  readonly authorities: HandoffBundleAuthoritiesV1;
  readonly preparationEvidence: readonly PreparationEvidenceRef[];
  readonly payloads: ReadonlyMap<string, Buffer>;
  readonly actor: PreparationPrincipalV1;
  readonly at: string;
  readonly supersedesBundleId?: BundleId;
  /** Deterministic crash seams placed immediately after durable handoff boundaries. */
  readonly faultsForTest?: {
    afterHandoffStarted?: () => Promise<void>;
    afterStage?: () => Promise<void>;
  };
}

/** The verified terminal binding of one settled handoff. */
export interface PreparationHandoffResultV1 {
  readonly outcome: "handed-off" | "resumed";
  readonly handoffId: HandoffId;
  readonly bundleId: BundleId;
  readonly operationRunId: OperationRunId;
  readonly bundleManifestDigest: OperationDigest;
}

/** The reserved identities and deterministic timestamp of a fresh or resumed handoff. */
interface HandoffStartState {
  readonly resuming: boolean;
  readonly reservedBundleId: BundleId;
  readonly reservedOperationRunId: OperationRunId;
  readonly handoffId: HandoffId;
  readonly preHandoffTransitionHash: Sha256Digest;
  readonly bundleClockAt: string;
}

/**
 * The two durable states a handoff may be driven from.
 *
 * EXPORTED so the service surface refuses an inadmissible run BEFORE it takes
 * this module's lock, reading the same set this module enforces. A second copy
 * would be a check that can disagree with its executor — either refusing a run
 * the substrate would accept, or acquiring the lock only to throw.
 */
export const HANDOFF_STARTABLE_RUN_STATES: ReadonlySet<PreparationRunV1["state"]> =
  new Set<PreparationRunV1["state"]>(["handoff-ready", "handoff-started"]);

/** Read and authenticate the durable run, refusing every non-startable state. */
async function loadHandoffRun(root: string, binding: PreparationRunBinding): Promise<PreparationRunV1> {
  const read = await readPreparationRun(root, binding);
  if (read.status === "unavailable" && read.code.startsWith("integrity-key")) {
    throw new HandoffError("key-unavailable", "preparation integrity key is unavailable");
  }
  if (read.status !== "ok") throw new HandoffError("not-handoff-ready", `run is ${read.status}`);
  if (read.run.supersededByPreparationId !== undefined) throw new HandoffError("superseded", "run is superseded");
  if (!HANDOFF_STARTABLE_RUN_STATES.has(read.run.state)) {
    throw new HandoffError("not-handoff-ready", `run state is ${read.run.state}`);
  }
  return read.run;
}

/** Resolve reserved identities: fresh mints them; a resume reuses durable ones. */
function resolveStartState(run: PreparationRunV1, at: string): HandoffStartState {
  if (run.state === "handoff-started") return resumeStartState(run);
  const preHandoffTransitionHash = preparationRunPredecessor(run).chainTip;
  return {
    resuming: false, reservedBundleId: mintBundleId(), reservedOperationRunId: mintOperationRunId(),
    handoffId: deriveHandoffId(run.runId, preHandoffTransitionHash), preHandoffTransitionHash, bundleClockAt: at,
  };
}

/** Reconstruct the exact reserved identities recorded by a prior handoff-started. */
function resumeStartState(run: PreparationRunV1): HandoffStartState {
  const start = handoffStartBinding(run);
  if (start === undefined) throw new HandoffError("bundle-unverifiable", "handoff-started record is missing");
  const startedAt = run.transitions.find((transition) => transition.type === "handoff-started")?.at;
  if (startedAt === undefined) throw new HandoffError("bundle-unverifiable", "handoff-started timestamp is missing");
  return {
    resuming: true, reservedBundleId: assertBundleId(start.reservedBundleId),
    reservedOperationRunId: assertOperationRunId(start.reservedOperationRunId), handoffId: start.handoffId,
    preHandoffTransitionHash: start.preHandoffTransitionHash, bundleClockAt: startedAt,
  };
}

/** A fixed clock so a resumed create reproduces the exact bundle-manifest digest. */
function fixedClock(at: string): Clock {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) throw new HandoffError("bundle-unverifiable", "handoff timestamp is invalid");
  return { now: () => when };
}

/** Re-read the created bundle manifest and run, refusing any mismatch or absence. */
async function verifyCreatedBundle(
  root: string, workspaceId: string, state: HandoffStartState, expectedDigest: OperationDigest,
): Promise<void> {
  const manifest = await readOperationManifest(root, workspaceId, state.reservedBundleId);
  if (manifest.status !== "ok") throw new HandoffError("bundle-unverifiable", `created manifest is ${manifest.status}`);
  const digest = operationManifestDigest(manifest.manifest) as OperationDigest;
  if (digest !== expectedDigest || manifest.manifest.runId !== state.reservedOperationRunId) {
    throw new HandoffError("digest-conflict", "created manifest does not match the reserved binding");
  }
  const key = await readOperationKey(root);
  if (key.status !== "ok") throw new HandoffError("bundle-unverifiable", "operation key is unavailable");
  const run = await readOperationRun(root, {
    runId: state.reservedOperationRunId, bundleId: state.reservedBundleId,
    manifestDigest: digest, workspaceId, keyEpochId: key.keyEpochId,
  });
  if (run.status !== "ok") throw new HandoffError("bundle-unverifiable", `created run is ${run.status}`);
}

/** Run the complete handoff flow while the caller holds the project lock. */
async function runHandoffLocked(
  root: string, request: PreparationHandoffRequestV1,
): Promise<PreparationHandoffResultV1> {
  const run = await loadHandoffRun(root, request.binding);
  // AN ADVISORY BLOCKS A HANDOFF THAT HAS NOT COMMITTED, AND ONLY THAT ONE.
  //
  // Before `handoff-started` nothing is reserved, so honoring the operator's
  // cancel costs nothing and the coordinator carries the run to `cancelling` from
  // `handoff-ready` on its next pass — the request has a consumer and the run has
  // an exit.
  //
  // AFTER `handoff-started` the run has DURABLY committed to exact reserved
  // bundle and operation-run identities, and a Milestone A bundle may already
  // exist under them. Refusing there refused FOREVER: `handoff-started` admits no
  // edge to `cancelling`, the coordinator's cancel leg does not select it, the
  // terminal residue collector skips it, and no verb retracts an advisory — so a
  // cancel that landed in the window after this check and before the reserved
  // identities were recorded wedged the run permanently, with the operator told
  // their cancellation was requested. A refusal that leaves a legitimate state
  // unrecoverable is a defect, not a safety property.
  //
  // Resuming is not ignoring the cancel: the resume creates nothing new — the
  // reserved identities and the deterministic manifest digest are fixed and
  // re-asserted — and once the run is `handed-off` the coordinator's terminal
  // residue leg consumes the advisory. The cancel arrived after the point of no
  // return, which is exactly the after-completion case the design contemplates.
  if (run.state !== "handoff-started"
    && await preparationCancellationRequested(root, run.workspaceId, run.runId)) {
    throw new HandoffError("cancelled", "an advisory cancellation blocks handoff");
  }
  const manifest = await readPreparationManifest(root, run.workspaceId, run.preparationId);
  if (manifest.status !== "ok") throw new HandoffError("manifest-unavailable", `manifest is ${manifest.status}`);
  if (preparationManifestDigest(manifest.manifest) !== request.binding.manifestDigest) {
    throw new HandoffError("manifest-drift", "durable manifest digest changed");
  }
  const state = resolveStartState(run, request.at);
  // A RESUME RE-VERIFIES IDENTITY, NOT AUTHORITY — and this is the branch that
  // makes that true rather than merely stated.
  //
  // Design 17.3 is explicit that a gate rejection "cannot undo a settled external
  // effect or AN ALREADY STAGED BUNDLE". Once the bundle exists under the
  // reserved identities, recompiling it would re-run the intent compiler's
  // settlement authority — including the gate-proof check — and a rejection
  // recorded in the crash window would refuse the resume forever, undoing
  // exactly what 17.3 protects. `handoff-started` admits no edge to `cancelling`,
  // so that refusal is a strand rather than an inconvenience.
  //
  // Section 22.3 already describes the right shape: the reserved identities and
  // the deterministic manifest digest are FIXED before the first Milestone A
  // byte, so a resume's remaining work is to prove the created bundle is the one
  // that was reserved and then record the terminal. It is the same classification
  // the under-lock recovery leg makes automatically, now made on the command path
  // too rather than only there.
  //
  // NOTHING IS RELAXED. The created manifest digest, the reserved run id, the
  // operation run's readability and the recorded GENESIS AUTHORITY are all still
  // proved, through the same helpers the recovery leg uses. A bundle that is
  // absent falls through and compiles normally — there is no staged bundle to
  // protect, and the authority check that a fresh compile runs is exactly right.
  if (state.resuming) {
    const settled = await settleAlreadyCreatedHandoff(root, request, run, state);
    if (settled !== null) return settled;
  }
  const bundle = buildHandoffBundle({
    manifest: manifest.manifest, reservedBundleId: state.reservedBundleId, compilation: request.compilation,
    authorities: request.authorities, preparationEvidence: request.preparationEvidence, payloads: request.payloads,
    intentCompiler: createOperationIntentCompilerV1(), handoffId: state.handoffId,
    preHandoffTransitionHash: state.preHandoffTransitionHash,
    ...(request.supersedesBundleId === undefined ? {} : { supersedesBundleId: request.supersedesBundleId }),
  });
  return settleHandoff(root, request, run, state, bundle);
}

/**
 * Settle a resume whose Milestone A bundle ALREADY EXISTS, or report that it does
 * not.
 *
 * @returns The settled handoff, or `null` when no bundle was created yet — in
 *   which case the caller compiles and stages normally.
 */
async function settleAlreadyCreatedHandoff(
  root: string, request: PreparationHandoffRequestV1, run: PreparationRunV1, state: HandoffStartState,
): Promise<PreparationHandoffResultV1 | null> {
  const recorded = handoffStartBinding(run);
  if (recorded === undefined) throw new HandoffError("bundle-unverifiable", "handoff-started record is missing");
  const manifest = await readOperationManifest(root, run.workspaceId, state.reservedBundleId);
  // ABSENT is the only fall-through. An `unavailable` manifest is a read this
  // host could not trust, and treating it as "not created yet" would recompile
  // and re-stage over durable bytes it simply failed to see.
  if (manifest.status === "absent") return null;
  const bundleManifestDigest = recorded.bundleManifestDigest as unknown as OperationDigest;
  await verifyCreatedBundle(root, run.workspaceId, state, bundleManifestDigest);
  await assertCreatedGenesisAuthority(root, run, state, recorded.genesisAuthorityDigest);
  await appendHandoffTransitionLocked(root, request.binding, await currentPredecessor(root, request.binding), {
    actor: request.actor, at: request.at,
  });
  return {
    outcome: "resumed", handoffId: state.handoffId, bundleId: state.reservedBundleId,
    operationRunId: state.reservedOperationRunId, bundleManifestDigest,
  };
}

/**
 * Re-derive the created bundle's genesis authority and require the exact digest
 * the durable `handoff-started` record pinned.
 *
 * THE MANIFEST DIGEST IS INVARIANT TO THIS AUTHORITY, so a bundle staged under
 * the reserved identity with a divergent control budget or compensation topology
 * passes every other check here. It is the one thing that catches it, and it goes
 * through the SAME derivation the under-lock recovery leg uses rather than a
 * second copy of the field list.
 */
async function assertCreatedGenesisAuthority(
  root: string, run: PreparationRunV1, state: HandoffStartState, expected: Sha256Digest,
): Promise<void> {
  const manifest = await readOperationManifest(root, run.workspaceId, state.reservedBundleId);
  const key = await readOperationKey(root);
  if (manifest.status !== "ok" || key.status !== "ok") {
    throw new HandoffError("bundle-unverifiable", "created bundle authority is unreadable");
  }
  const opRun = await readOperationRun(root, {
    runId: state.reservedOperationRunId, bundleId: state.reservedBundleId,
    manifestDigest: operationManifestDigest(manifest.manifest) as OperationDigest,
    workspaceId: run.workspaceId, keyEpochId: key.keyEpochId,
  });
  if (opRun.status !== "ok") throw new HandoffError("bundle-unverifiable", `created run is ${opRun.status}`);
  if (createdGenesisAuthorityDigest(opRun.run, manifest.manifest) !== expected) {
    throw new HandoffError("digest-conflict", "created genesis authority diverges from the reserved record");
  }
}

/** Verify caps, record handoff-started (or re-verify a resume), stage, and settle. */
async function settleHandoff(
  root: string, request: PreparationHandoffRequestV1, run: PreparationRunV1,
  state: HandoffStartState, bundle: ReturnType<typeof buildHandoffBundle>,
): Promise<PreparationHandoffResultV1> {
  const reservedIds = { bundleId: state.reservedBundleId, runId: state.reservedOperationRunId };
  const clock = fixedClock(state.bundleClockAt);
  const preview = await stageOperationBundleLocked(root, {
    draft: bundle.draft, payloads: bundle.payloads, reservedIds, clock, dryRun: true,
  });
  const bundleManifestDigest = preview.manifestDigest as OperationDigest;
  await recordOrVerifyStart(root, request, run, state, bundle, bundleManifestDigest);
  await request.faultsForTest?.afterHandoffStarted?.();
  const staged = await stageOperationBundleLocked(root, {
    draft: bundle.draft, payloads: bundle.payloads, reservedIds, clock,
  });
  if ((staged.manifestDigest as OperationDigest) !== bundleManifestDigest) {
    throw new HandoffError("digest-conflict", "staged manifest digest drifted from the reserved digest");
  }
  await verifyCreatedBundle(root, run.workspaceId, state, bundleManifestDigest);
  await request.faultsForTest?.afterStage?.();
  await appendHandoffTransitionLocked(root, request.binding, await currentPredecessor(root, request.binding), {
    actor: request.actor, at: request.at,
  });
  return {
    outcome: state.resuming ? "resumed" : "handed-off", handoffId: state.handoffId,
    bundleId: state.reservedBundleId, operationRunId: state.reservedOperationRunId, bundleManifestDigest,
  };
}

/** Durably record handoff-started when fresh; on resume assert the recorded digests. */
async function recordOrVerifyStart(
  root: string, request: PreparationHandoffRequestV1, run: PreparationRunV1,
  state: HandoffStartState, bundle: ReturnType<typeof buildHandoffBundle>, bundleManifestDigest: OperationDigest,
): Promise<void> {
  const genesisAuthorityDigest = parseSha256Digest(handoffGenesisAuthorityDigest(bundle.draft.run));
  const start: HandoffStartBindingV1 = {
    handoffId: state.handoffId, reservedBundleId: state.reservedBundleId,
    reservedOperationRunId: state.reservedOperationRunId, bundleManifestDigest: parseSha256Digest(bundleManifestDigest),
    genesisAuthorityDigest, preHandoffTransitionHash: state.preHandoffTransitionHash,
    originEvidenceDigest: parseSha256Digest(bundle.origin.evidenceRef.digest),
    evidenceCopyDigest: parseSha256Digest(bundle.evidenceCopyDigest),
  };
  if (!state.resuming) {
    await appendHandoffStartedTransitionLocked(root, request.binding, preparationRunPredecessor(run), {
      actor: request.actor, at: request.at, start,
    });
    return;
  }
  const recorded = handoffStartBinding(run);
  if (recorded === undefined || recorded.bundleManifestDigest !== bundleManifestDigest ||
      recorded.genesisAuthorityDigest !== genesisAuthorityDigest) {
    throw new HandoffError("digest-conflict", "resumed compilation does not reproduce the reserved bundle digest");
  }
}

/** Read the current authenticated predecessor for an under-lock append. */
async function currentPredecessor(root: string, binding: PreparationRunBinding) {
  const read = await readPreparationRun(root, binding);
  if (read.status !== "ok") throw new HandoffError("bundle-unverifiable", `run is ${read.status}`);
  return preparationRunPredecessor(read.run);
}

/**
 * Acquire the project lock through the shared recovery gate (page journal →
 * Milestone A recovery, with preparation recovery deferred to this handoff for its
 * own run) and run the complete flow, releasing the lock before returning.
 */
export async function handoffPreparation(
  root: string, request: PreparationHandoffRequestV1,
): Promise<PreparationHandoffResultV1> {
  await acquireMutationLockBlocking(root, "handoff");
  try {
    return await runHandoffLocked(root, request);
  } finally {
    await releaseLock(root);
  }
}
