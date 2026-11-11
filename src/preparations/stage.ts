/**
 * @file src/preparations/stage.ts
 * @description Internal locked staging transaction for one immutable durable
 * preparation (design section 8.4). Under the project lock it plans the declared
 * initial input set (read-only), completes every read-only preflight — inventory
 * health, supersession resolution, capacity (including the PO-INV-10
 * prepared-inputs dimension), key compatibility, and workflow-parent
 * verification — then materializes each declared prepared input into immutable
 * create-only evidence and durably publishes the canonical manifest and the HMAC
 * genesis run in that exact order, only after every cap and authority check.
 * Evidence enters staging ONLY by materializing a declared prepared input; there
 * is no caller-supplied evidence buffer or caller-declared prepared-input count.
 * Incomplete pairs left by a crash are inert orphans; a fixed-id replay completes
 * them idempotently. It exposes no surface.
 *
 * NO preflight refusal writes to the project. A first-ever staging needs a key
 * epoch before it can preflight at all, because the manifest every remaining
 * gate measures binds the epoch id — so the epoch is minted in memory here and
 * its durable write is carried into `publishStage`, where it lands first among
 * the durable writes. A refused first-ever staging therefore leaves the project
 * byte-identical, whether it refused on the run budget, on capacity, or on an
 * unresolvable supersession edge.
 *
 * ONE BODY, {@link stagePreparationLockedWith}, over {@link StageLockedSteps}: the
 * parent, inventory, key, evidence, manifest and run reads, the key-epoch mint
 * (a MECHANISM returning the id and a deferred publication), and the three
 * writes, none of which takes a project root. Every park, refusal, reuse and
 * dry-run decision is in the body, in the incumbent's order, so a dry run still
 * reaches no mint, publication or write. The root form keeps its signature and
 * passes the local steps, which call the incumbents when asked;
 * {@link stageLockedStepsOver} composes the reads from each store's own body and
 * takes the caller's mint and writes.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { inventoryHasRetainedState } from "../utils/inventory-arithmetic.js";
import {
  assertStageCapacity, scanPreparationInventoryBorrowingFrom,
  type PreparationInventory, type PreparationInventoryLifecycleReads, type StageCapacityProjection,
} from "./capacity.js";
import type { PreparationScanOptions } from "./orphan-scan.js";
import { commandPreparationPass, type WriteFreePreparationPass } from "./recovery.js";
import { mintPreparationId, mintPreparationRunId, type PreparationId, type PreparationRunId } from "./ids.js";
import {
  prepareKeyForEmptyEpochLocked, readPreparationKeyFrom,
  type PreparationKeyLeafReads, type PreparationKeyRead,
} from "./key-epoch.js";
import {
  materializePlannedInitialInputs, planInitialInputs,
  type MaterializeInitialInputsOutcome, type PlannedInitialInputSetV1, type PreparationInitialInputV1,
} from "./initial-inputs.js";
import { validatePreparationSupersessionSet } from "./manifest-graph.js";
import { parsePreparationManifest, preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import { preparationPlanDigest } from "./plan-parse.js";
import {
  readPreparationManifest, readPreparationManifestFrom, writePreparationManifestCreateOnly,
  type PreparationManifestLeafReads, type PreparationManifestRead,
} from "./manifest-store.js";
import {
  readPreparationEvidence, readPreparationEvidenceFrom,
  type PreparationEvidenceLeafReads, type PreparationEvidenceLocation, type PreparationEvidenceRead,
} from "./evidence-store.js";
import { projectPreparationRunBudget, type RunBudget, type RunBudgetInput } from "./run-budget.js";
import {
  createPreparationRunLocked, readPreparationRun, readPreparationRunFrom, type PreparationRunLeafReads, type PreparationRunRead,
} from "./run-store.js";
import { verifyWorkflowParent, verifyWorkflowParentFrom, type WorkflowParentVerification } from "./workflow-parent.js";
import type { WorkflowRunReads } from "../workflow-history/store.js";
import type { WorkflowParentRefV1 } from "./types.js";
import type { NormalizedPreparationPlanV1 } from "./plan-types.js";
import type { InitialPreparationRunInput, PreparationPrincipalV1, PreparationRunBinding } from "./run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/** Synchronous wall clock used to bind manifest and genesis timestamps. */
interface Clock { now(): Date }

/** What one locked staging asks for, in order. No member takes a project root. */
export interface StageLockedSteps {
  /** The workflow parent's verification, raw: the park ladder over it is the body's. */
  verifyParent(ref: WorkflowParentRefV1): Promise<WorkflowParentVerification>;
  /**
   * The preparation inventory under the scan options. It must describe the same
   * store the reads below answer for: the body takes every leg's absence from it
   * when it saw neither the preparation nor its run.
   */
  scanInventory(options?: PreparationScanOptions): Promise<PreparationInventory>;
  /** The current integrity key. */
  readKey(): Promise<PreparationKeyRead>;
  /** MECHANISM: mint a key for an empty epoch, returning its id and the deferred durable publication. */
  mintEmptyEpochKey(epoch: PreparationInventory["epoch"]): Promise<ResolvedKeyEpoch>;
  /** One evidence object's presence. */
  readEvidence(location: PreparationEvidenceLocation, digest: string): Promise<PreparationEvidenceRead>;
  /** The preparation's manifest. */
  readManifest(workspaceId: string, preparationId: PreparationId): Promise<PreparationManifestRead>;
  /** The run at `binding`, authenticated. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /** Materialize the missing initial inputs. */
  materializeInputs(location: PreparationEvidenceLocation, set: PlannedInitialInputSetV1, missing: ReadonlySet<string>): Promise<MaterializeInitialInputsOutcome>;
  /** Create the immutable manifest, or prove its exact replay. */
  writeManifest(manifest: PreparationManifestV1): Promise<unknown>;
  /** Create the run's genesis. */
  createRun(input: InitialPreparationRunInput, budgetInput: RunBudgetInput): Promise<unknown>;
}

/**
 * LOCAL DISK. The incumbent readers, mint and writers for `root`, each called
 * when asked. The inventory scan and the key read are ONE PASS
 * (`pass-reads.ts`): both come before the first write, under one hold of the
 * lock, so the key the scan authenticated every run under is the key the
 * staging binds. The pass's KEY read also answers the two later asks of the
 * key in the same hold: the mint's read of the current key, which precedes
 * every write, and the genesis signing key, unless this staging published a
 * minted key, in which case the genesis reads the disk. The evidence and the
 * manifest written before the genesis are not the key.
 *
 * THE GATE'S PASS, WHEN IT WROTE NOTHING. `gated` is the recovery gate's
 * settlement pass under this same hold, handed over only when nothing has
 * written since its scan (`acquireMutationLockHandingOver`). Its reads are this
 * staging's pass, and its inventory the staging's scan at the default options
 * (`commandPreparationPass`); a scan at other options reads the disk.
 */
function diskStageLockedSteps(root: string, gated: WriteFreePreparationPass | null): StageLockedSteps {
  const command = commandPreparationPass(root, gated);
  const pass = command.reads;
  let keyWritten = false;
  return {
    verifyParent: (ref) => verifyWorkflowParent(root, ref),
    scanInventory: command.scanInventory,
    readKey: pass.readKey,
    mintEmptyEpochKey: async (epoch) => {
      const minted = await prepareKeyForEmptyEpochLocked(root, epoch, {}, pass.readKey);
      return { keyEpochId: minted.keyEpochId, publish: () => { keyWritten = true; return minted.publish(); } };
    },
    readEvidence: (location, digest) => readPreparationEvidence(root, location, digest),
    readManifest: (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
    readRun: (binding) => readPreparationRun(root, binding),
    materializeInputs: (location, set, missing) => materializePlannedInitialInputs(root, location, set, missing),
    writeManifest: (manifest) => writePreparationManifestCreateOnly(root, manifest),
    createRun: (input, budgetInput) => createPreparationRunLocked(root, input, budgetInput,
      keyWritten ? undefined : { readKey: pass.readKey, readRun: (binding) => readPreparationRun(root, binding) }),
  };
}

/** The same reads over each store's own body, with the caller's mint and writes. Building it does no I/O. */
export function stageLockedStepsOver(sources: {
  parents: WorkflowRunReads; lifecycle: PreparationInventoryLifecycleReads; keys: PreparationKeyLeafReads;
  evidence: PreparationEvidenceLeafReads; manifests: PreparationManifestLeafReads; runs: PreparationRunLeafReads;
}, writes: Pick<StageLockedSteps, "mintEmptyEpochKey" | "materializeInputs" | "writeManifest" | "createRun">): StageLockedSteps {
  return {
    ...writes,
    verifyParent: (ref) => verifyWorkflowParentFrom(sources.parents, ref),
    scanInventory: (options) => scanPreparationInventoryBorrowingFrom(sources.lifecycle, options),
    readKey: () => readPreparationKeyFrom(sources.keys),
    readEvidence: (location, digest) => readPreparationEvidenceFrom(sources.evidence, location, digest),
    readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(sources.manifests, workspaceId, preparationId),
    readRun: (binding) => readPreparationRunFrom(sources.runs, binding),
  };
}

/** Deterministic crash seams placed immediately after durable boundaries. */
export interface StageFaultsForTest {
  /** Fires with the key epoch durable and nothing else written yet. */
  beforeEvidenceSync?: () => Promise<void>;
  afterEvidenceSync?: () => Promise<void>;
  afterManifestSync?: () => Promise<void>;
  beforeInitialRunSync?: () => Promise<void>;
  afterInitialRunSync?: () => Promise<void>;
}

/** Complete internal request; callers already hold the project lock. */
export interface StagePreparationRequest {
  plan: NormalizedPreparationPlanV1;
  createdBy: PreparationPrincipalV1;
  actor: PreparationPrincipalV1;
  initialInputs: readonly PreparationInitialInputV1[];
  controlTransitionAllowance: number;
  dryRun?: boolean;
  clock?: Clock;
  idsForTest?: { preparationId: PreparationId; runId: PreparationRunId };
  faultsForTest?: StageFaultsForTest;
  /** Test-only monotonic tightening of the pre-write inventory ceiling. */
  capacityOptionsForTest?: PreparationScanOptions;
}

/** Canonical manifest, whole-run projection, and park classification. */
export type StagePreparationResult =
  | { status: "staged"; manifest: PreparationManifestV1; manifestDigest: Sha256Digest; projectedRunBudget: RunBudget; wrote: boolean }
  | { status: "parked"; reason: string };

interface PreparedStage {
  manifest: PreparationManifestV1;
  manifestBytes: Buffer;
  manifestDigest: Sha256Digest;
  inputs: PlannedInitialInputSetV1;
  projectedRunBudget: RunBudget;
  budgetInput: RunBudgetInput;
  preparedInputsCount: number;
  actor: PreparationPrincipalV1;
  dryRun: boolean;
  faults: StageFaultsForTest;
}

/** The staging facts proven before the key epoch is resolved. */
interface PlannedStage {
  inputs: PlannedInitialInputSetV1;
  budgetInput: RunBudgetInput;
  projectedRunBudget: RunBudget;
  at: string;
}

/** Derive the declared run budget input from the plan's worst-case bounds. */
function budgetInputFor(plan: NormalizedPreparationPlanV1, controlTransitionAllowance: number): RunBudgetInput {
  return {
    maximumPhaseInstances: plan.bounds.maximumPhaseInstances, maximumEvidenceRefs: plan.bounds.maximumEvidenceRefs,
    maximumBrokerRequests: plan.bounds.maximumBrokerRequests, maximumEffects: plan.bounds.maximumEffects,
    maximumTransitions: plan.bounds.maximumTransitions, controlTransitionAllowance,
  };
}

/**
 * The manifest's identities and timestamp: a test-pinned id wins, else a reused
 * (crash-replay) identity, else a freshly minted one; `createdAt` is the reused
 * timestamp when replaying so the manifest is byte-identical, else the clock.
 */
function manifestIdentities(request: StagePreparationRequest, at: string, reuse?: ReusedIdentities) {
  const pinned = request.idsForTest ?? reuse;
  return {
    preparationId: pinned?.preparationId ?? mintPreparationId(),
    runId: pinned?.runId ?? mintPreparationRunId(),
    createdAt: reuse?.createdAt ?? at,
  };
}

/** Materialize the immutable manifest under freshly minted or fixed identities. */
function materializeManifest(
  request: StagePreparationRequest, evidence: readonly EvidenceRefV1[], keyEpochId: Sha256Digest, at: string,
  reuse?: ReusedIdentities,
): PreparationManifestV1 {
  const { preparationId, runId, createdAt } = manifestIdentities(request, at, reuse);
  const candidate = {
    schemaVersion: 1 as const, preparationId, runId, workspaceId: request.plan.workspaceId, createdAt,
    createdBy: { id: request.createdBy.id, surface: request.createdBy.surface }, keyEpochId,
    plan: request.plan, planDigest: preparationPlanDigest(request.plan),
    initialEvidence: evidence.map((ref) => ({ ...ref })),
    ...(request.plan.supersedesPreparationId === undefined ? {} : { supersedesPreparationId: request.plan.supersedesPreparationId }),
  };
  return parsePreparationManifest(canonicalBytes(candidate).toString("utf8"));
}

/**
 * Prove the staging clock and the whole-record run budget.
 *
 * Both are pure functions of the plan bounds and the declared allowance, so they
 * are proven BEFORE the key epoch is resolved: a first-ever invocation refused
 * on either must leave the project exactly as it found it, and resolving the key
 * epoch on a project that has none MINTS one durably (see `resolveKeyEpoch`).
 */
function planStage(request: StagePreparationRequest, inputs: PlannedInitialInputSetV1): PlannedStage {
  const now = request.clock?.now() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("preparation staging clock is invalid");
  const budgetInput = budgetInputFor(request.plan, request.controlTransitionAllowance);
  return { inputs, budgetInput, projectedRunBudget: projectPreparationRunBudget(budgetInput), at: now.toISOString() };
}

/** Materialize the manifest over the planned inputs under the resolved key epoch. */
function prepareStage(
  request: StagePreparationRequest, planned: PlannedStage, keyEpochId: Sha256Digest, reuse?: ReusedIdentities,
): PreparedStage {
  const manifest = materializeManifest(request, planned.inputs.evidence, keyEpochId, planned.at, reuse);
  return {
    manifest, manifestBytes: canonicalBytes(manifest), manifestDigest: preparationManifestDigest(manifest),
    inputs: planned.inputs, projectedRunBudget: planned.projectedRunBudget, budgetInput: planned.budgetInput,
    preparedInputsCount: planned.inputs.preparedInputsCount,
    actor: { id: request.actor.id, surface: request.actor.surface }, dryRun: request.dryRun === true,
    faults: { ...request.faultsForTest },
  };
}

interface Materialization { missingEvidence: Set<string>; missingManifest: boolean; missingRun: boolean; complete: boolean }

/**
 * Whether the healthy inventory this staging just scanned, under the same hold
 * of the lock and before any write, already proves every leg absent: no
 * directory for the preparation (so no manifest and no evidence beneath it) and
 * no run leaf for the run. Each read below would then answer `absent` too. The
 * reads stay for a reused or fixed identity the scan saw, which a crash may have
 * left partly written; the create-only writes still refuse anything that appears
 * after the scan.
 */
function scanProvesAbsent(prepared: PreparedStage, inventory: PreparationInventory): boolean {
  return !inventory.preparationIds.has(prepared.manifest.preparationId) && !inventory.runIds.has(prepared.manifest.runId);
}

/** Inspect what a fixed-id replay still needs, distinguishing an exact replay. */
async function inspectMaterialization(
  steps: StageLockedSteps, prepared: PreparedStage, keyEpochId: Sha256Digest, inventory: PreparationInventory,
): Promise<Materialization> {
  if (scanProvesAbsent(prepared, inventory)) {
    const missingEvidence = new Set(prepared.inputs.objects.map((object) => object.digest));
    return { missingEvidence, missingManifest: true, missingRun: true, complete: false };
  }
  const location = { workspaceId: prepared.manifest.workspaceId, preparationId: prepared.manifest.preparationId };
  const missingEvidence = new Set<string>();
  for (const object of prepared.inputs.objects) {
    const read = await steps.readEvidence(location, object.digest);
    if (read.status === "absent") missingEvidence.add(object.digest);
    else if (read.status !== "ok") throw new Error(`preparation evidence target is ${read.status}`);
  }
  const missingManifest = await manifestMissing(steps, prepared);
  const missingRun = await runMissing(steps, prepared, keyEpochId);
  return { missingEvidence, missingManifest, missingRun, complete: missingEvidence.size === 0 && !missingManifest && !missingRun };
}

/** Distinguish an absent manifest from an exact immutable replay or a conflict. */
async function manifestMissing(steps: StageLockedSteps, prepared: PreparedStage): Promise<boolean> {
  const read = await steps.readManifest(prepared.manifest.workspaceId, prepared.manifest.preparationId);
  if (read.status === "absent") return true;
  if (read.status !== "ok") throw new Error(`preparation manifest target is ${read.status}`);
  if (!canonicalBytes(read.manifest).equals(prepared.manifestBytes)) throw new Error("preparation manifest replay conflict");
  return false;
}

/** Distinguish an absent run from an exact genesis replay or a conflict. */
async function runMissing(steps: StageLockedSteps, prepared: PreparedStage, keyEpochId: Sha256Digest): Promise<boolean> {
  const read = await steps.readRun({
    runId: prepared.manifest.runId, preparationId: prepared.manifest.preparationId, workspaceId: prepared.manifest.workspaceId,
    manifestDigest: prepared.manifestDigest, keyEpochId,
  });
  if (read.status === "absent") return true;
  if (read.status !== "ok") throw new Error(`preparation run target is ${read.status}`);
  return false;
}

/**
 * Refuse missing-key reuse unless all active preparation state is empty. The
 * preparation and operation-bundle key epochs are independent trust boundaries
 * that share this empty-epoch shape but never the same key.
 */
function assertKeyCompatible(key: PreparationKeyRead, inventory: PreparationInventory): void {
  if (key.status === "unavailable") throw new Error("preparation integrity key is unreadable");
  if (key.status === "ok") return;
  if (inventoryHasRetainedState(Object.values(inventory.epoch), inventory.quarantine)) {
    throw new Error("preparation integrity key is missing for an active epoch");
  }
}

/** Project the complete capacity dimensions for the proposed preparation. */
function projectCapacity(prepared: PreparedStage, inventory: PreparationInventory, materialization: Materialization): StageCapacityProjection {
  const objects = prepared.inputs.objects;
  const newEvidenceBytes = objects
    .filter((object) => materialization.missingEvidence.has(object.digest)).reduce((sum, object) => sum + object.byteCount, 0);
  const runBytes = prepared.projectedRunBudget.projectedTotalBytes;
  const newBytes = (materialization.missingManifest ? prepared.manifestBytes.byteLength : 0) + (materialization.missingRun ? runBytes : 0) + newEvidenceBytes;
  const workspace = prepared.manifest.workspaceId;
  return {
    newPreparations: 1, activeNonterminalRuns: inventory.activeNonterminalRuns + (materialization.missingRun ? 1 : 0),
    workspacePreparations: (inventory.workspacePreparations.get(workspace) ?? 0) + (materialization.missingManifest ? 1 : 0),
    preparedInputs: prepared.preparedInputsCount, manifestBytes: prepared.manifestBytes.byteLength, runBytes,
    evidenceObjectBytes: objects.length === 0 ? 0 : Math.max(...objects.map((object) => object.byteCount)),
    activeBytes: inventory.activeBytes + newBytes,
  };
}

/** Verify the proposed supersession edge against the retained manifest set. */
function assertSupersession(prepared: PreparedStage, inventory: PreparationInventory): void {
  const retained = inventory.manifests.filter((manifest) => manifest.preparationId !== prepared.manifest.preparationId);
  validatePreparationSupersessionSet([...retained, prepared.manifest]);
}

/** The outcome of publishing: durable success, or a parked stale-input refusal. */
type PublishOutcome = { status: "ok" } | { status: "parked"; reason: string };

/** Publish one completely preflighted preparation in the required durable order. */
async function publishStage(steps: StageLockedSteps, prepared: PreparedStage, keyEpoch: ResolvedKeyEpoch, materialization: Materialization): Promise<PublishOutcome> {
  // A freshly minted key epoch is published FIRST, ahead of every other durable
  // write. The order is not arbitrary: `assertKeyCompatible` refuses a missing
  // key whenever the epoch holds anything, so evidence or a manifest landing
  // before the key would leave a project no later staging could recover without
  // an operator key reset. Publishing here keeps that invariant while leaving
  // every preflight refusal above write-free.
  await keyEpoch.publish?.();
  // The seam between the key epoch and the first epoch content. It exists so a
  // test can WITNESS that boundary: the next await writes evidence, so anything
  // observed here is the complete durable state of a project whose key landed.
  await prepared.faults.beforeEvidenceSync?.();
  const keyEpochId = keyEpoch.keyEpochId;
  const location = { workspaceId: prepared.manifest.workspaceId, preparationId: prepared.manifest.preparationId };
  const materialized = await steps.materializeInputs(location, prepared.inputs, materialization.missingEvidence);
  if (materialized.status === "unavailable") return { status: "parked", reason: `initial-input-${materialized.code}` };
  await prepared.faults.afterEvidenceSync?.();
  await publishManifestAndRun(steps, prepared, keyEpochId, materialization);
  return { status: "ok" };
}

/** Write the canonical manifest and the HMAC genesis run, in that exact order. */
async function publishManifestAndRun(
  steps: StageLockedSteps, prepared: PreparedStage, keyEpochId: Sha256Digest, materialization: Materialization,
): Promise<void> {
  if (materialization.missingManifest) {
    await steps.writeManifest(prepared.manifest);
    await prepared.faults.afterManifestSync?.();
  }
  if (materialization.missingRun) {
    await prepared.faults.beforeInitialRunSync?.();
    await steps.createRun(genesisInput(prepared, keyEpochId), prepared.budgetInput);
    await prepared.faults.afterInitialRunSync?.();
  }
}

/** Build exact genesis inputs from snapshotted staging authority. */
function genesisInput(prepared: PreparedStage, keyEpochId: Sha256Digest): InitialPreparationRunInput {
  return {
    runId: prepared.manifest.runId, preparationId: prepared.manifest.preparationId, manifestDigest: prepared.manifestDigest,
    workspaceId: prepared.manifest.workspaceId, keyEpochId, actor: prepared.actor,
    at: prepared.manifest.createdAt, controlTransitionAllowance: prepared.budgetInput.controlTransitionAllowance,
  };
}

/** Verify the optional workflow parent, parking on any non-verified outcome. */
async function verifyParent(steps: StageLockedSteps, plan: NormalizedPreparationPlanV1): Promise<StagePreparationResult | null> {
  const ref = plan.workflowParent;
  if (ref === undefined) return null;
  const verification = await steps.verifyParent(ref);
  if (verification.status !== "verified") {
    return { status: "parked", reason: `workflow-parent-${verification.status}` };
  }
  // LIFECYCLE ADMISSION, atomic under the staging lock (the same root LOCK_FILE
  // workflow advance/cancel take): a parent-bound stage may be created/reused
  // ONLY while its parent run is still running AND that stage is the current
  // one — otherwise the journey has moved on and this child must not be staged.
  if (verification.runStatus !== "running") {
    return { status: "parked", reason: "workflow-parent-not-running" };
  }
  if (ref.stageId !== undefined && verification.currentStage !== ref.stageId) {
    return { status: "parked", reason: "workflow-parent-stage-not-current" };
  }
  return null;
}

/** Deep-equal two workflow-parent refs across all four identity fields. */
function sameParent(a: WorkflowParentRefV1, b: WorkflowParentRefV1): boolean {
  return a.workflowRunId === b.workflowRunId && a.workflowId === b.workflowId
    && a.workflowDigest === b.workflowDigest && a.stageId === b.stageId;
}

/**
 * Fixed identities a reused parent-bound staging re-materializes under. The
 * `createdAt` is pinned from the existing manifest too, so the replay is
 * BYTE-IDENTICAL (ids + timestamp + same plan/epoch/evidence) — otherwise a
 * fresh timestamp would make the re-materialized manifest conflict with the one
 * already on disk instead of reconciling it.
 */
interface ReusedIdentities { preparationId: PreparationId; runId: PreparationRunId; createdAt: string }

/** The get-or-create outcome for a parent-bound staging. */
type ParentStagingDecision =
  | { kind: "create" }
  | { kind: "parked"; reason: string }
  | { kind: "reuse"; identities: ReusedIdentities };

/**
 * Get-or-create arbitration for a parent-bound staging, UNDER the staging lock.
 *
 * Staging mints random preparation/run ids, so parent-tuple equality alone
 * cannot dedupe a retry or a concurrent second invoke — this does, by scanning
 * the already-read inventory for an existing preparation under the SAME parent
 * tuple: zero → create fresh; exactly one whose `planDigest` matches → REUSE its
 * exact identities; one whose digest differs → conflict; more than one →
 * ambiguity. Crucially, a reuse does NOT short-circuit past the durability legs
 * (that would strand a manifest-before-run crash forever); it hands back the
 * existing identities so the SAME staging path re-materializes under them, and
 * `inspectMaterialization` + `publishStage` idempotently complete whatever a
 * prior crash left missing. Dry runs never dedupe (a preview writes nothing).
 */
function arbitrateParentStaging(
  request: StagePreparationRequest, inventory: PreparationInventory, planDigest: Sha256Digest,
): ParentStagingDecision {
  const parent = request.plan.workflowParent;
  if (parent === undefined || request.dryRun === true) return { kind: "create" };
  const matches = inventory.manifests.filter(
    (manifest) => manifest.plan.workflowParent !== undefined
      && sameParent(manifest.plan.workflowParent, parent));
  if (matches.length === 0) return { kind: "create" };
  if (matches.length > 1) return { kind: "parked", reason: "workflow-parent-ambiguous" };
  const existing = matches[0]!;
  if (existing.planDigest !== planDigest) return { kind: "parked", reason: "workflow-parent-incompatible" };
  return { kind: "reuse", identities: { preparationId: existing.preparationId, runId: existing.runId, createdAt: existing.createdAt } };
}

/** A usable key epoch id, plus the durable publication a freshly minted one owes. */
interface ResolvedKeyEpoch {
  keyEpochId: Sha256Digest;
  publish: (() => Promise<void>) | null;
}

/**
 * Resolve the current key epoch, minting the first one IN MEMORY for an empty epoch.
 *
 * An existing epoch owes nothing. A freshly minted one carries its durable write
 * to `publishStage`, so every preflight gate above it — supersession, capacity,
 * and the materialization inspection, all of which need the epoch id because the
 * manifest binds it — refuses without having written to the project at all.
 */
async function resolveKeyEpoch(steps: StageLockedSteps, inventory: PreparationInventory, currentKey: PreparationKeyRead): Promise<ResolvedKeyEpoch> {
  if (currentKey.status === "ok") return { keyEpochId: currentKey.keyEpochId, publish: null };
  return steps.mintEmptyEpochKey(inventory.epoch);
}

/**
 * Stage one immutable durable preparation while the caller holds the project lock.
 *
 * THE PRECONDITION IS ON THE PUBLISHING PATH. `dryRun` returns before
 * `publishStage` on every branch and mints no durable epoch, so `previewPreparation`
 * calls this WITHOUT the lock on purpose — taking it would run the recovery gate,
 * which settles handoffs, from a verb that must write nothing. A change that moves
 * a write above the dry-run return breaks that caller silently.
 *
 * `gated` is the gate's write-free preparation pass from the acquisition this
 * staging runs under, when it has one (`acquireMutationLockHandingOver`).
 */
export async function stagePreparationLocked(
  root: string, request: StagePreparationRequest, gated: WriteFreePreparationPass | null = null,
): Promise<StagePreparationResult> {
  return stagePreparationLockedWith(diskStageLockedSteps(root, gated), request);
}

/** {@link stagePreparationLocked} over {@link StageLockedSteps}: THE ONE BODY. */
export async function stagePreparationLockedWith(steps: StageLockedSteps, request: StagePreparationRequest): Promise<StagePreparationResult> {
  const parked = await verifyParent(steps, request.plan);
  if (parked !== null) return parked;
  const inventory = await steps.scanInventory(request.capacityOptionsForTest);
  if (inventory.problems.length > 0) throw new Error(`preparation inventory unavailable: ${inventory.problems[0]!.dimension}`);
  const currentKey = await steps.readKey();
  assertKeyCompatible(currentKey, inventory);
  if (currentKey.status !== "ok" && request.dryRun === true) {
    // A fresh-project dry run has no key epoch to bind the immutable manifest to;
    // it is an expected user condition, not a fault, so it parks rather than throws.
    return { status: "parked", reason: "preparation-integrity-key-missing" };
  }
  // Get-or-create UNDER THE LOCK for a parent-bound stage: reuse the one existing
  // attempt's identities for this parent tuple (or park a conflict/ambiguity)
  // rather than mint a second, so concurrent invokes and resume retries converge
  // on one attempt. Reuse re-materializes under those identities and flows the
  // SAME durability legs, so `inspectMaterialization`/`publishStage` idempotently
  // complete whatever a prior crash left missing (never a strand).
  const decision = arbitrateParentStaging(request, inventory, preparationPlanDigest(request.plan));
  if (decision.kind === "parked") return { status: "parked", reason: decision.reason };
  const reuse = decision.kind === "reuse" ? decision.identities : undefined;
  const planned = await planInitialInputs(request.initialInputs);
  if (planned.status === "unavailable") return { status: "parked", reason: `initial-input-${planned.code}` };
  const stage = planStage(request, planned.set);
  const keyEpoch = await resolveKeyEpoch(steps, inventory, currentKey);
  const prepared = prepareStage(request, stage, keyEpoch.keyEpochId, reuse);
  const materialization = await inspectMaterialization(steps, prepared, keyEpoch.keyEpochId, inventory);
  assertSupersession(prepared, inventory);
  assertStageCapacity(projectCapacity(prepared, inventory, materialization));
  const result = { manifest: prepared.manifest, manifestDigest: prepared.manifestDigest, projectedRunBudget: prepared.projectedRunBudget };
  // Neither short circuit can strand an unpublished epoch: a fresh project parks
  // its dry runs above, and an epoch minted here was proven empty, so nothing it
  // could replay against exists and `complete` is necessarily false.
  if (prepared.dryRun || materialization.complete) return { status: "staged", ...result, wrote: false };
  const published = await publishStage(steps, prepared, keyEpoch, materialization);
  if (published.status === "parked") return published;
  return { status: "staged", ...result, wrote: true };
}
