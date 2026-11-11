/**
 * @file src/operation-bundles/run-session.ts
 * @description The per-run session the executor, compensation and recovery
 * share, and the one port they reach the project's run stores through.
 *
 * ONE PORT, NO ROOT. {@link OperationRunStores} is every project read and write
 * the run domain makes: the manifest, the key epoch, the authenticated run, the
 * fenced transition append, the run evidence, the cancellation advisory and the
 * pending-embedding marker. {@link diskOperationRunStores} answers each one with
 * the incumbent root form, called when asked, so module spies and mocks still
 * intercept and every byte, order and error is the incumbent's. Each of those
 * root forms already runs its own bound body.
 *
 * ONE BODY EACH. {@link loadRunSessionWith} (manifest, digest, key, run, in that
 * order, each with its own problem code) and {@link loadApprovedActionWith} (the
 * grant, then the required state) decide over the stores; every root-form
 * entry (apply, compensate, recover, resume) passes the disk stores to them.
 * {@link appendRunStep} appends through the session's stores.
 *
 * THE ROOT IS A CAPABILITY HANDLE. {@link RunSession.root} stays, because the
 * injected runtime receives it: the authority provider as
 * `AuthoritySnapshotRequest.root` and every adapter as `AdapterContext.root`
 * (public compatibility contracts for host-supplied providers and adapters).
 * The session's own decisions never read through it.
 */

import type { OperationRuntime } from "./adapter-registry.js";
import { readCancelRequest, removeCancelRequestLocked, type CancelRequestRead } from "./cancel-request.js";
import { writeRunEvidenceCreateOnly, type RunEvidenceLocation, type RunEvidenceWriteResult } from "./evidence-store.js";
import type { BundleId, OperationRunId } from "./ids.js";
import { readOperationKey, type OperationKeyRead } from "./key-epoch.js";
import { operationManifestDigest } from "./manifest-parse.js";
import { readOperationManifest, type OperationManifestRead } from "./manifest-store.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationProblem, OperationProblemCode } from "./problems.js";
import { appendOperationTransitionLocked, readOperationRun, type OperationRunRead } from "./run-store.js";
import { once } from "../utils/pass-memo.js";
import type {
  AppendOperationTransitionInput, OperationRun, OperationRunBinding, OperationRunCounters, OperationRunPredecessor, OperationRunState,
} from "./run-types.js";
import { computeTransition, type OperationTransitionStep } from "./transitions.js";
import type { OperationBundleManifest, OperationDigest } from "./types.js";
import {
  readPendingMarker, writePendingEmbeddingsStrict, type PendingEmbedding, type PendingMarkerRead,
} from "../utils/pending-embeddings.js";

/** The request to approve-and-apply (or resume) one operation bundle. */
export interface ApproveOperationBundleRequest {
  workspaceId: string;
  bundleId: BundleId;
  manifestDigest: OperationDigest;
  principal: OperationPrincipal;
  runtime: OperationRuntime;
}

/** The bounded outcome of one executor/recovery action. */
export interface OperationActionResult {
  bundleId: BundleId;
  runId?: OperationRunId;
  state?: OperationRunState;
  counters?: OperationRunCounters;
  problems: OperationProblem[];
}

/** Every project read and write the run domain makes. No member takes a project root. */
export interface OperationRunStores {
  /** The handle the injected runtime receives (authority provider and adapters); never read by the run domain itself. */
  readonly capabilityRoot: string;
  /** One staged manifest. */
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
  /** The current operation key epoch. */
  readKey(): Promise<OperationKeyRead>;
  /** The authenticated run at its exact binding. */
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  /** Append one transition fenced to `expected`; the caller holds the project lock. */
  appendTransition(binding: OperationRunBinding, expected: OperationRunPredecessor, input: AppendOperationTransitionInput): Promise<OperationRun>;
  /** Persist one run-evidence blob, or answer its over-limit reference. */
  writeEvidence(location: RunEvidenceLocation, bytes: Buffer): Promise<RunEvidenceWriteResult>;
  /** The run's cancellation advisory. */
  readCancel(workspaceId: string, runId: OperationRunId): Promise<CancelRequestRead>;
  /** Remove the run's cancellation advisory, best effort; the caller holds the project lock. */
  removeCancel(workspaceId: string, runId: OperationRunId): Promise<void>;
  /** The pending-embedding marker, read strictly. */
  readPendingMarker(): Promise<PendingMarkerRead>;
  /** Replace the pending-embedding marker, strictly. */
  writePendingMarker(entries: PendingEmbedding[]): Promise<void>;
}

/**
 * LOCAL DISK. The incumbent root forms for `root`, each called when asked with
 * its old arguments. ONE KEY READ PER LOCKED ACTION: the stores serve one
 * `…Locked` action, whose caller holds the project lock throughout, and nothing
 * the run domain does writes the key. So the key is read once, and that read
 * authenticates every run read and signs every append of the action; the run
 * record itself is still read afresh for each read and each append's fence.
 */
export function diskOperationRunStores(root: string): OperationRunStores {
  const readKey = once(() => readOperationKey(root));
  return {
    capabilityRoot: root,
    readManifest: (workspaceId, bundleId) => readOperationManifest(root, workspaceId, bundleId),
    readKey,
    readRun: (binding) => readOperationRun(root, binding, readKey),
    appendTransition: (binding, expected, input) => appendOperationTransitionLocked(root, binding, expected, input, readKey),
    writeEvidence: (location, bytes) => writeRunEvidenceCreateOnly(root, location, bytes),
    readCancel: (workspaceId, runId) => readCancelRequest(root, workspaceId, runId),
    removeCancel: (workspaceId, runId) => removeCancelRequestLocked(root, workspaceId, runId),
    readPendingMarker: () => readPendingMarker(root),
    writePendingMarker: (entries) => writePendingEmbeddingsStrict(root, entries),
  };
}

/** The immutable per-run context shared by every step (the run threads separately). */
export interface RunSession {
  /** The capability handle passed to the injected runtime; equals `stores.capabilityRoot`. */
  root: string;
  /** The project's run stores every step reads and writes through. */
  stores: OperationRunStores;
  binding: OperationRunBinding;
  request: ApproveOperationBundleRequest;
  manifest: OperationBundleManifest;
}

/** A loaded session and its run, or the bounded problem that stopped the load. */
type RunSessionLoad = { status: "ok"; session: RunSession; run: OperationRun } | { status: "problem"; result: OperationActionResult };

/** Build a bounded problem-only action result (no run identity resolved). */
function bundleProblem(request: ApproveOperationBundleRequest, code: OperationProblemCode): OperationActionResult {
  return { bundleId: request.bundleId, problems: [{ code, message: code }] };
}

/** Build an action result from a resolved run, optionally noting a problem. */
export function runResult(run: OperationRun, code?: OperationProblemCode): OperationActionResult {
  return {
    bundleId: run.bundleId, runId: run.runId, state: run.state, counters: run.counters,
    problems: code === undefined ? [] : [{ code, message: code }],
  };
}

/** Load the manifest, key epoch, and run for a bundle, or a typed problem: THE ONE BODY. */
export async function loadRunSessionWith(stores: OperationRunStores, request: ApproveOperationBundleRequest): Promise<RunSessionLoad> {
  const manifestRead = await stores.readManifest(request.workspaceId, request.bundleId);
  if (manifestRead.status === "absent") return { status: "problem", result: bundleProblem(request, "review-item-not-found") };
  if (manifestRead.status !== "ok") return { status: "problem", result: bundleProblem(request, "review-store-unavailable") };
  const manifest = manifestRead.manifest;
  if (operationManifestDigest(manifest) !== request.manifestDigest) return { status: "problem", result: bundleProblem(request, "review-digest-mismatch") };
  const key = await stores.readKey();
  if (key.status === "absent") return { status: "problem", result: bundleProblem(request, "integrity-key-missing") };
  if (key.status === "unavailable") return { status: "problem", result: bundleProblem(request, "integrity-key-unreadable") };
  const binding: OperationRunBinding = {
    runId: manifest.runId, bundleId: manifest.bundleId, manifestDigest: request.manifestDigest,
    workspaceId: request.workspaceId, keyEpochId: key.keyEpochId,
  };
  const runRead = await stores.readRun(binding);
  if (runRead.status === "absent") return { status: "problem", result: bundleProblem(request, "review-item-not-found") };
  if (runRead.status !== "ok") return { status: "problem", result: bundleProblem(request, runRead.code ?? "review-store-unavailable") };
  return { status: "ok", session: { root: stores.capabilityRoot, stores, binding, request, manifest }, run: runRead.run };
}

/** A loaded session and its run in the required state, or the bounded result that stopped it. */
type ApprovedActionLoad = { status: "ok"; session: RunSession; run: OperationRun } | { status: "stop"; result: OperationActionResult };

/**
 * Load a run, require the approve grant, and require the caller's expected state —
 * the shared preamble for the two operator actions (approve-and-apply, resume). A
 * load fault, missing grant, or wrong state short-circuits to a bounded result;
 * otherwise the session and run are returned. THE ONE BODY.
 */
export async function loadApprovedActionWith(
  stores: OperationRunStores,
  request: ApproveOperationBundleRequest,
  requiredState: OperationRunState,
): Promise<ApprovedActionLoad> {
  const loaded = await loadRunSessionWith(stores, request);
  if (loaded.status === "problem") return { status: "stop", result: loaded.result };
  if (!request.principal.grants.includes("operation-bundle.approve")) {
    return { status: "stop", result: runResult(loaded.run, "approval-grant-missing") };
  }
  if (loaded.run.state !== requiredState) return { status: "stop", result: runResult(loaded.run) };
  return { status: "ok", session: loaded.session, run: loaded.run };
}

/** Append one computed transition through the session's stores, with fault seams. */
export async function appendRunStep(session: RunSession, run: OperationRun, step: OperationTransitionStep): Promise<OperationRun> {
  const at = session.request.runtime.clock.now().toISOString();
  const planned = computeTransition(run, session.request.principal, at, step);
  await session.request.runtime.fault?.beforeTransitionWrite?.(planned.input.type);
  const next = await session.stores.appendTransition(session.binding, planned.expected, planned.input);
  await session.request.runtime.fault?.afterTransitionWrite?.(planned.input.type);
  return next;
}
