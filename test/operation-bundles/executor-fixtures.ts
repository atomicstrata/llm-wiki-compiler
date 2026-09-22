/**
 * @file test/operation-bundles/executor-fixtures.ts
 * @description Shared fixtures for the executor/recovery tests: stage a real
 * source-retain bundle (genesis run + manifest + payload + key), build a runtime
 * over the seven real adapters with a deterministic domain-neutral authority
 * provider, and construct an approve request. Not a test file.
 */

import { createHash } from "node:crypto";
import { stat, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { authoritySnapshotDigest, type AuthoritySnapshotRequest, type OperationAuthorityProvider, type OperationAuthoritySnapshot } from "../../src/operation-bundles/authority.js";
import { createOperationAdapterRegistry, type OperationRuntime } from "../../src/operation-bundles/adapter-registry.js";
import { defineOperationStoreAdapter, type OperationFaultInjector, type OperationStoreAdapter } from "../../src/operation-bundles/adapter-types.js";
import { sourceAdapter } from "../../src/operation-bundles/adapters/source.js";
import { pageAdapter } from "../../src/operation-bundles/adapters/page.js";
import { relationAdapter } from "../../src/operation-bundles/adapters/relation.js";
import { lifecycleAdapter } from "../../src/operation-bundles/adapters/lifecycle.js";
import { artifactAdapter } from "../../src/operation-bundles/adapters/artifact.js";
import { catalogAdapter } from "../../src/operation-bundles/adapters/catalog.js";
import { projectionAdapter } from "../../src/operation-bundles/adapters/projection.js";
import { stageOperationBundleLocked, type OperationBundleDraft, type OperationMutationDraft } from "../../src/operation-bundles/stage.js";
import { approveAndApplyOperationBundleLocked, type ApproveOperationBundleRequest } from "../../src/operation-bundles/executor.js";
import { writeCancelRequestLockFree } from "../../src/operation-bundles/cancel-request.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import type { OperationRun } from "../../src/operation-bundles/run-types.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import type { HostRecoveryPlanner } from "../../src/operation-bundles/recovery-plan.js";
import type { OperationRunId } from "../../src/operation-bundles/ids.js";
import type { OperationPrincipal } from "../../src/operation-bundles/principal.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";

export const WORKSPACE = "research";
const AT = "2026-07-19T00:00:00.000Z";
const DIGEST = `sha256:${"0".repeat(64)}` as OperationDigest;

/** Lowercase SHA-256 name for payload bytes. */
export function payloadDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The genesis run draft shared by staged fixtures (optionally declaring compensators). */
function fixtureRunDraft(declaredCompensatorIndexes: number[] = []): OperationBundleDraft["run"] {
  return { actor: { id: "planner", surface: "sdk", grants: [] }, declaredCompensatorIndexes, controlTransitionAllowance: 32 };
}

/** One source-retain draft whose identities are derived during staging. */
function sourceDraft(bytes: Buffer): OperationMutationDraft {
  const ref = payloadDigest(bytes), bound = `sha256:${ref}` as OperationDigest;
  return {
    kind: "source-retain", operation: "create", target: { digest: ref }, payloadRef: ref,
    dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "absent-or-same", digest: bound, byteCount: bytes.length },
    postcondition: { digest: bound, byteCount: bytes.length },
  };
}

/** A staged bundle's external identities. */
export interface StagedBundle {
  bundleId: `bnd_${string}`;
  manifestDigest: OperationDigest;
  workspaceId: string;
}

/** Stage a bundle from the given mutation drafts + payload map, optional compensators. */
async function stageBundle(
  root: string,
  mutations: OperationMutationDraft[],
  payloads: Map<string, Buffer>,
  compensatorIndexes: number[] = [],
  bounds: OperationBundleDraft["bounds"] = [],
): Promise<StagedBundle> {
  const draft: OperationBundleDraft = {
    workspaceId: WORKSPACE, createdBy: "planner",
    knowledgeAuthority: { id: "k", digest: DIGEST },
    operationsAuthority: { packId: "p", packDigest: DIGEST, actionId: "a", actionDescriptorDigest: DIGEST },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST,
    inputs: [], preparationEvidence: [], bounds,
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0, requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST },
    reconciliations: [], planningWarnings: [], mutations, run: fixtureRunDraft(compensatorIndexes),
  };
  const result = await stageOperationBundleLocked(root, { draft, payloads, clock: { now: () => new Date(AT) } });
  return { bundleId: result.manifest.bundleId, manifestDigest: result.manifestDigest, workspaceId: WORKSPACE };
}

/** Read one staged bundle's persisted run off disk for assertions. */
export async function readStagedRun(root: string, staged: StagedBundle): Promise<OperationRun> {
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  const key = await readOperationKey(root);
  if (manifest.status !== "ok" || key.status !== "ok") throw new Error("run unreadable");
  const read = await readOperationRun(root, {
    runId: manifest.manifest.runId, bundleId: staged.bundleId,
    manifestDigest: staged.manifestDigest as `sha256:${string}`,
    workspaceId: WORKSPACE, keyEpochId: key.keyEpochId,
  });
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

/** Stage a one-mutation relation bundle (relation content travels inline). */
export function stageRelationBundle(root: string, mutation: OperationMutationDraft): Promise<StagedBundle> {
  return stageBundle(root, [mutation], new Map());
}

/** The update draft of one page (raw or entity target): a digest precondition over its current bytes and the new postcondition. */
function pageUpdateDraft(
  target: { kind: "raw"; directory: string; slug: string } | { kind: "entity"; entityType: string; slug: string }, fromBytes: Buffer, toBytes: Buffer,
): OperationMutationDraft {
  const from = `sha256:${payloadDigest(fromBytes)}` as OperationDigest;
  const to = `sha256:${payloadDigest(toBytes)}` as OperationDigest;
  return {
    kind: "page", operation: "update", target,
    payloadRef: payloadDigest(toBytes), dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "digest", digest: from },
    postcondition: { digest: to, byteCount: toBytes.length },
  };
}

/**
 * Stage a one-mutation page UPDATE bundle the way the materializer authors one:
 * a `{kind:"digest"}` precondition over `fromBytes` (the bytes assumed on disk)
 * and the new `toBytes` as the payload/postcondition. Applying it drives the real
 * executor's observe→park-or-apply, so a page that changed to neither the
 * precondition nor the postcondition parks instead of blind-overwriting.
 */
export function stagePageUpdateBundle(
  root: string, directory: string, slug: string, fromBytes: Buffer, toBytes: Buffer,
): Promise<StagedBundle> {
  return stageBundle(root, [pageUpdateDraft({ kind: "raw", directory, slug }, fromBytes, toBytes)], new Map([[payloadDigest(toBytes), toBytes]]));
}

/** Stage a one-mutation ENTITY page UPDATE bundle (target keyed by entity type, not directory). */
export function stageEntityPageUpdateBundle(
  root: string, entityType: string, slug: string, fromBytes: Buffer, toBytes: Buffer,
): Promise<StagedBundle> {
  return stageBundle(root, [pageUpdateDraft({ kind: "entity", entityType, slug }, fromBytes, toBytes)], new Map([[payloadDigest(toBytes), toBytes]]));
}

/** The delete draft of one raw page: a digest precondition over its CURRENT bytes and an absent postcondition. */
function pageDeleteDraft(directory: string, slug: string, currentBytes: Buffer): OperationMutationDraft {
  const digest = `sha256:${payloadDigest(currentBytes)}` as OperationDigest;
  return {
    kind: "page", operation: "delete", target: { kind: "raw", directory, slug },
    payloadRef: payloadDigest(currentBytes), dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "digest", digest },
    postcondition: { kind: "absent" },
  };
}

/** Stage a page DELETE followed by a source-retain mutation (the second can be made to park). */
export function stagePageDeleteThenSourceBundle(
  root: string, directory: string, slug: string, currentBytes: Buffer, sourceBytes = Buffer.from("retained source\n"),
): Promise<StagedBundle> {
  return stageBundle(root, [pageDeleteDraft(directory, slug, currentBytes), sourceDraft(sourceBytes)],
    new Map([[payloadDigest(currentBytes), currentBytes], [payloadDigest(sourceBytes), sourceBytes]]));
}

/**
 * Stage a one-mutation page DELETE bundle: a `{kind:"digest"}` precondition over
 * the page's CURRENT bytes and an absent postcondition. Applying it drives the
 * real executor's observe→park-or-apply — a page changed to other bytes PARKS
 * instead of blind-deleting — and a crash mid-apply replays on recovery to a
 * single completed deletion. The current bytes ride the payload map because the
 * adapter reads the payload before an (inert) delete.
 */
export function stagePageDeleteBundle(
  root: string, directory: string, slug: string, currentBytes: Buffer,
): Promise<StagedBundle> {
  return stageBundle(root, [pageDeleteDraft(directory, slug, currentBytes)], new Map([[payloadDigest(currentBytes), currentBytes]]));
}

/** Stage the simplest one-mutation source-retain bundle. */
export function stageSourceBundle(root: string, bytes = Buffer.from("retained source\n")): Promise<StagedBundle> {
  return stageBundle(root, [sourceDraft(bytes)], new Map([[payloadDigest(bytes), bytes]]));
}

/** Stage a two-source bundle whose first mutation declares a host compensator. */
export function stageCompensatableBundle(root: string): Promise<StagedBundle> {
  const first = Buffer.from("compensatable a\n"), second = Buffer.from("compensatable b\n");
  return stageBundle(root, [sourceDraft(first), sourceDraft(second)], new Map([[payloadDigest(first), first], [payloadDigest(second), second]]), [0, 1]);
}

/** Stage one source mutation followed by one OPTIONAL projection. */
export function stageSourceAndOptionalProjection(root: string): Promise<StagedBundle> {
  const bytes = Buffer.from("src for projection\n");
  const projection: OperationMutationDraft = {
    kind: "projection", operation: "render",
    target: { recipeId: "recipe", recipeDigest: DIGEST, output: "out.json", criticality: "optional" },
    dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" }, postcondition: { digest: DIGEST },
  };
  return stageBundle(root, [sourceDraft(bytes), projection], new Map([[payloadDigest(bytes), bytes]]), [], [{ name: "projection-1-bytes", unit: "bytes", maximum: 4096 }]);
}

/** A source adapter double that always parks (observe/apply return conflict). */
export function parkingSourceAdapter(): OperationStoreAdapter {
  return defineOperationStoreAdapter<"source-retain">({
    kind: "source-retain",
    async preflight() { return { status: "ready" }; },
    async observe() { return { outcome: "conflict", detail: "planted conflict" }; },
    async apply() { return { status: "conflict", detail: "planted conflict" }; },
    async verify() { return { status: "mismatch", detail: "planted" }; },
  });
}

/**
 * A source adapter double whose present effect is UNBOUND to the mutation (as a
 * content-addressed target with no per-mutation binding is) — observe reports
 * applied with boundToMutation:false, so crash recovery must NOT upgrade it to
 * applied.
 */
export function unboundSourceAdapter(): OperationStoreAdapter {
  let applied = false;
  return defineOperationStoreAdapter<"source-retain">({
    kind: "source-retain",
    async preflight() { return { status: "ready" }; },
    async observe(ctx) { return applied ? { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: false } : { outcome: "not-applied" }; },
    async apply(ctx) { applied = true; return { status: "applied", postStateDigest: ctx.mutation.postcondition.digest }; },
    async verify(ctx) { return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest }; },
  });
}

/** A projection adapter double whose render always fails (apply returns conflict). */
export function failingProjectionAdapter(): OperationStoreAdapter {
  return defineOperationStoreAdapter<"projection">({
    kind: "projection",
    async preflight() { return { status: "ready" }; },
    async observe() { return { outcome: "not-applied" }; },
    async apply() { return { status: "conflict", detail: "planted projection failure" }; },
    async verify() { return { status: "mismatch", detail: "planted" }; },
  });
}

/**
 * A stateful source adapter double whose observed state tracks apply/compensate,
 * so the compensation protocol can be exercised without a real store: it observes
 * not-applied until applied, applied afterwards, and not-applied again once its
 * idempotent compensator runs.
 */
export function compensatingSourceAdapter(): OperationStoreAdapter {
  let applied = false, reverted = false;
  return defineOperationStoreAdapter<"source-retain">({
    kind: "source-retain",
    async preflight() { return { status: "ready" }; },
    async observe(ctx) { return applied && !reverted ? { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true } : { outcome: "not-applied" }; },
    async apply(ctx) { applied = true; return { status: "applied", postStateDigest: ctx.mutation.postcondition.digest }; },
    async verify(ctx) { return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest }; },
    async compensate() { reverted = true; return { status: "reverted" }; },
  });
}

/**
 * A source adapter double whose compensator LIES: it reports `reverted` but never
 * changes observed state, so observe still returns applied after `compensate`. Used
 * to prove compensation re-observes the effect and refuses a false-success outcome.
 */
export function falselyRevertingSourceAdapter(): OperationStoreAdapter {
  let applied = false;
  return defineOperationStoreAdapter<"source-retain">({
    kind: "source-retain",
    async preflight() { return { status: "ready" }; },
    async observe(ctx) { return applied ? { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: true } : { outcome: "not-applied" }; },
    async apply(ctx) { applied = true; return { status: "applied", postStateDigest: ctx.mutation.postcondition.digest }; },
    async verify(ctx) { return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest }; },
    async compensate() { return { status: "reverted" }; },
  });
}

const authorityComponent = (seed: string): OperationDigest => `sha256:${createHash("sha256").update(seed).digest("hex")}` as OperationDigest;

/** The deterministic domain-neutral snapshot for one request (a given precondition seed). */
export function fixtureSnapshot(request: AuthoritySnapshotRequest, preconditionSeed = "precondition"): { snapshot: OperationAuthoritySnapshot; digest: OperationDigest } {
  const snapshot: OperationAuthoritySnapshot = {
    profileDigest: authorityComponent("profile"), operationsAuthorityDigest: authorityComponent("ops"),
    actionDescriptorDigest: authorityComponent("action"), grantDigest: authorityComponent("grant"),
    safetyFloorDigest: authorityComponent("safety"), manifestDigest: request.manifestDigest,
    payloadSetDigest: authorityComponent("payloads"), boundsDigest: authorityComponent("bounds"),
    adapterCapabilityDigest: request.adapterCapabilityDigest, keyEpochId: request.keyEpochId,
    storeHealthDigest: authorityComponent("health"), preconditionDigest: authorityComponent(preconditionSeed),
  };
  return { snapshot, digest: authoritySnapshotDigest(snapshot) };
}

/** A deterministic, domain-neutral authority provider (stable digest across calls). */
export function fixtureAuthority(): OperationAuthorityProvider {
  return { async computeSnapshot(request) { return { status: "ok", ...fixtureSnapshot(request) }; } };
}

/** Ok at approval, unavailable at the apply recompute, ok afterwards. */
export function outageAtApplyAuthority(): OperationAuthorityProvider {
  let calls = 0;
  return {
    async computeSnapshot(request) {
      calls += 1;
      if (calls === 2) return { status: "unavailable", reason: "apply-time outage" };
      return { status: "ok", ...fixtureSnapshot(request) };
    },
  };
}

/** Build a runtime over the seven real adapters (the source adapter is overridable). */
export function buildRuntime(options: { authority?: OperationAuthorityProvider; fault?: OperationFaultInjector; source?: OperationStoreAdapter; projection?: OperationStoreAdapter } = {}): OperationRuntime {
  const adapters = createOperationAdapterRegistry({
    "source-retain": options.source ?? sourceAdapter, page: pageAdapter, relation: relationAdapter,
    "lifecycle-transition": lifecycleAdapter, artifact: artifactAdapter,
    "catalog-record": catalogAdapter, projection: options.projection ?? projectionAdapter,
  });
  return {
    authority: options.authority ?? fixtureAuthority(), adapters, clock: { now: () => new Date() },
    ...(options.fault === undefined ? {} : { fault: options.fault }),
  };
}

/** Stage a source bundle and drive it to recovery-required via an apply-time outage. */
export async function parkedSourceBundle(root: string, bytes = Buffer.from("retained source\n")): Promise<StagedBundle> {
  const staged = await stageSourceBundle(root, bytes);
  await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ authority: outageAtApplyAuthority() })));
  return staged;
}

/**
 * Approve-and-apply a two-mutation bundle, planting a cancellation request between
 * the two mutations so the run parks at recovery-required with the first mutation
 * applied. The provided source adapter's state persists for a later compensation.
 */
export async function parkViaMidApplyCancel(root: string, staged: StagedBundle, source?: OperationStoreAdapter): Promise<void> {
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (manifest.status !== "ok") throw new Error("staged manifest is unreadable");
  const runId = manifest.manifest.runId;
  let calls = 0;
  const fault: OperationFaultInjector = {
    async atCancelSafePoint() {
      calls += 1;
      if (calls === 2) await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "operator", at: AT });
    },
  };
  await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ fault, ...(source === undefined ? {} : { source }) })));
}

/** A stock operator principal carrying the approve grant. */
export const OPERATOR_PRINCIPAL: OperationPrincipal = { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] };

/** A host recovery planner returning a single source-retain recovery mutation. */
export function sourceRecoveryPlanner(bytes = Buffer.from("recovery source payload\n")): HostRecoveryPlanner {
  return {
    async planRecovery() {
      return { mutations: [sourceDraft(bytes)], payloads: new Map([[payloadDigest(bytes), bytes]]), run: fixtureRunDraft() };
    },
  };
}

/** Build an approve request for a staged bundle with the given grants. */
export function approveRequest(staged: StagedBundle, runtime: OperationRuntime, grants: readonly string[] = ["operation-bundle.approve"]): ApproveOperationBundleRequest {
  return {
    workspaceId: staged.workspaceId, bundleId: staged.bundleId, manifestDigest: staged.manifestDigest,
    principal: { id: "operator", surface: "cli", grants: grants as never }, runtime,
  };
}

/**
 * Build an {@link AuthoritySnapshotRequest} for a staged bundle, reading the
 * store-loaded manifest. The `manifestDigest`/`adapterCapabilityDigest`/`keyEpochId`
 * copies default to a placeholder because the resolver recomputes them from source
 * and ignores the request copies; tests override them to prove that rejection.
 */
export async function authorityRequestFor(
  root: string, staged: StagedBundle,
  options: { grants?: readonly string[]; principalId?: string } = {},
): Promise<AuthoritySnapshotRequest> {
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (manifest.status !== "ok") throw new Error("staged manifest is unreadable");
  return {
    root, workspaceId: WORKSPACE, manifest: manifest.manifest, manifestDigest: staged.manifestDigest,
    principal: { id: options.principalId ?? "operator", surface: "cli", grants: (options.grants ?? ["operation-bundle.approve"]) as never },
    adapterCapabilityDigest: DIGEST, keyEpochId: DIGEST,
  };
}

/** The run id staged for a bundle — the shared handle for cancellation tests. */
export async function runIdOf(root: string, staged: StagedBundle): Promise<OperationRunId> {
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (manifest.status !== "ok") throw new Error("manifest unreadable");
  return manifest.manifest.runId;
}

/** Whether the advisory cancel file for a run currently exists (follows symlinks). */
export async function cancelFileExists(root: string, runId: OperationRunId): Promise<boolean> {
  try {
    await stat(operationPaths(root, WORKSPACE).cancelFile(runId));
    return true;
  } catch {
    return false;
  }
}

/** Plant an unreadable (symlinked) advisory at a run's cancel path; returns its path. */
export async function plantSymlinkAdvisory(root: string, runId: OperationRunId): Promise<string> {
  const cancelFile = operationPaths(root, WORKSPACE).cancelFile(runId);
  await mkdir(path.dirname(cancelFile), { recursive: true });
  await symlink("/etc/hostname", cancelFile);
  return cancelFile;
}

/** Plant a directory (with content) at a run's cancel advisory path; returns its path. */
export async function plantDirectoryAdvisory(root: string, runId: OperationRunId): Promise<string> {
  const cancelFile = operationPaths(root, WORKSPACE).cancelFile(runId);
  await mkdir(path.join(cancelFile, "nested"), { recursive: true });
  return cancelFile;
}
