/**
 * @file src/operation-bundles/run-store.ts
 * @description Exact-binding operation-run reads, create-only genesis
 * publication, and authenticated-prefix transition appends. No exported writer
 * accepts a caller-supplied progressed record or re-signs unverifiable history.
 *
 * ONE RUN READ, OVER THE READER'S OWN LEAVES. {@link readOperationRunFrom} is the
 * one body of {@link readOperationRun}: it reads the run leaf FIRST (any throw or
 * rejection, for an unsafe identity or otherwise, is `identity`), then — only for a
 * present leaf — a FRESH key read, then parses, binds and AUTHENTICATES here. It
 * takes {@link OperationRunLeafReads} and no project root. The production default is
 * {@link diskOperationRunLeafReads}, which calls the incumbent leaf read and
 * `readOperationKey` at call time.
 *
 * ONE BODY PER WRITER, OVER THE WRITERS' OWN STEPS. Genesis creation, the
 * authenticated append, and the recovered and abandoned control writers each have
 * one root-free body (`…With`) over {@link OperationRunWriteSteps}: the authenticated
 * read, a fresh key, one evidence leaf, create-only genesis publication and durable
 * replacement. The bodies own every proof check, the predecessor-then-fresh-key
 * order, signing, budget and the exactly-one-transition rule. The root forms keep
 * their signatures and pass {@link diskOperationRunWriteSteps}, whose closures keep
 * the confinement, exact-parent, durability and mode flags of the incumbent calls.
 */

import { createHash } from "node:crypto";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { genesisCollisionMessage, publishRunGenesis, readAuthenticatedRunFrom, replaceRunLeaf } from "../utils/run-store-io.js";
import { readConfinedLeafBuffer, type CappedLeafRead, type CappedLeafReadBuffer } from "../utils/confined-read.js";
import { MAX_MUTATIONS_PER_BUNDLE, MAX_RUN_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES } from "./constants.js";
import { mutationId, type MutationId } from "./ids.js";
import { readDurableOperationLeaf } from "./durable-leaf.js";
import { once } from "../utils/pass-memo.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import { readOperationKey, type OperationKeyRead } from "./key-epoch.js";
import { operationPaths } from "./paths.js";
import type { OperationProblemCode } from "./problems.js";
import { assertOperationRunWriteBudget, operationRunWriteBudgetClass, projectRunBudget, type RunWriteBudgetClass } from "./run-budget.js";
import {
  appendOperationTransition, createInitialOperationRun, operationRunBinding,
  operationRunBindingMatches, operationRunPredecessor, signOperationRun,
  verifyOperationRunIntegrity,
} from "./run-integrity.js";
import { parseAbandonmentObservation, parseOperationRun } from "./run-parse.js";
import {
  authoritativeNamespaceForMutation, residualFindingsDigest,
  unresolvedResidualIds,
} from "./run-residuals.js";
import type {
  AppendOperationTransitionInput, InitialOperationRunInput, OperationRun,
  OperationRunBinding, OperationRunPredecessor,
  ResidualFinding, RunEvidenceRef,
} from "./run-types.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest } from "./types.js";

export type OperationRunRead =
  | { status: "ok"; run: OperationRun }
  | { status: "absent" }
  | { status: "unavailable"; detail: string; code?: OperationProblemCode };

export interface RecoveryRequiredControlTransition {
  type: "recovery-required";
  code: "run-record-headroom-exhausted";
  actor: OperationPrincipal;
  at: string;
}

/** Proof inputs for settling an original from an authenticated recovery run. */
export interface RecoveredControlTransition {
  actor: OperationPrincipal;
  at: string;
  recoveryBinding: OperationRunBinding;
  recoveryExpected: OperationRunPredecessor;
  recoveryManifest: OperationBundleManifest;
}

/** Explicit destructive confirmation and bounded fresh residual observations. */
export interface AbandonmentObservation {
  code: string;
  mutationId: MutationId;
  evidence: RunEvidenceRef;
}

/** Explicit destructive confirmation and bounded fresh residual observations. */
export interface AbandonedControlTransition {
  actor: OperationPrincipal;
  at: string;
  confirmResidualState: true;
  manifest: OperationBundleManifest;
  observations: readonly AbandonmentObservation[];
}

/** Read one exact workspace leaf before consulting any project key. */
async function readRunLeaf(root: string, binding: OperationRunBinding, maxBytes: number, scanned?: ScannedLeafBytes) {
  const paths = operationPaths(root, binding.workspaceId);
  return readDurableOperationLeaf(
    root, paths.runFile(binding.runId), paths.runsRoot, maxBytes, scanned,
  );
}

/**
 * What the operation run read asks of the store. Owned by the run reader; no read
 * takes a project root.
 */
export interface OperationRunLeafReads {
  /** One run leaf's text by its binding, within `maxBytes`. May throw or reject, for an unsafe identity or otherwise; the body maps both to `identity`. */
  readRunLeaf(binding: OperationRunBinding, maxBytes: number): Promise<CappedLeafRead>;
  /** The operation key WITH ITS BYTES, read fresh on each call (this body authenticates). Local: `readOperationKey(root)`. */
  readKey(): Promise<OperationKeyRead>;
}

/** The local-disk run leaves for one project root, built per call: each closure calls the incumbent function when asked. In no package index. */
export function diskOperationRunLeafReads(root: string, scanned?: ScannedLeafBytes): OperationRunLeafReads {
  return {
    readRunLeaf: (binding, maxBytes) => readRunLeaf(root, binding, maxBytes, scanned),
    readKey: () => readOperationKey(root),
  };
}

/**
 * Read, parse, and authenticate only against all caller-requested identities. A
 * caller that already read the key under the same lock hold may hand in its
 * `readKey`; otherwise the key is read here.
 */
export async function readOperationRun(root: string, binding: OperationRunBinding, readKey?: () => Promise<OperationKeyRead>): Promise<OperationRunRead> {
  const leaves = diskOperationRunLeafReads(root);
  return readOperationRunFrom(readKey === undefined ? leaves : { ...leaves, readKey }, binding);
}

/**
 * {@link readOperationRun} over the reader's own leaves: THE ONE BODY. The run leaf
 * first (a throw is `identity`, with no code), then the key only for a present
 * leaf, then parse, bind and authenticate. It confines nothing and trusts no leaf it
 * cannot verify.
 */
export async function readOperationRunFrom(leaves: OperationRunLeafReads, binding: OperationRunBinding): Promise<OperationRunRead> {
  return readAuthenticatedRunFrom<OperationRunBinding, OperationRun, Extract<OperationRunRead, { status: "unavailable" }>>(leaves, binding, {
    maxBytes: MAX_RUN_BYTES,
    parse: (body) => parseOperationRun(body, binding),
    verify: (run, key) => verifyOperationRunIntegrity(run, key, binding),
    // THE OPERATION TAXONOMY: the identity and run-leaf refusals carry NO code.
    identity: { status: "unavailable", detail: "identity" },
    runLeaf: { status: "unavailable", detail: "run-leaf" },
  });
}

/** What the run writers ask of the store. No member takes a project root. */
export interface OperationRunWriteSteps {
  /** The authenticated exact-binding run read. Local: `readOperationRun(root, binding)`. */
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  /**
   * The operation key WITH ITS BYTES. Local: `readOperationKey(root)`, read once per
   * write and shared with that write's run reads (see {@link diskOperationRunWriteSteps}).
   */
  readKey(): Promise<OperationKeyRead>;
  /** One content-addressed run-evidence leaf, single-link and capped; a path it cannot derive rejects. */
  readEvidenceLeaf(binding: OperationRunBinding, digestHex: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** Create-only genesis publication; `collisionMessage` is asked only on a genuine create collision. */
  publishGenesis(binding: OperationRunBinding, serialized: string, collisionMessage: () => Promise<string>): Promise<void>;
  /** Durable, strictly synced replacement of the run leaf. */
  replaceRun(binding: OperationRunBinding, serialized: string): Promise<void>;
}

/**
 * The local-disk run write steps for one root, built per call; each closure calls
 * the incumbent when asked. In no package index. ONE KEY READ PER WRITE: the
 * steps live for one writer call, under the caller's lock, and no writer writes
 * the key, so the key that authenticates the predecessor (and a recovery run) is
 * the key read once here and the key that signs the next record. A second read
 * would only re-ask the first (the body's epoch checks still compare it). A
 * caller whose whole lock hold shares one key read hands its `readKey` in.
 */
function diskOperationRunWriteSteps(root: string, readKey = once(() => readOperationKey(root))): OperationRunWriteSteps {
  return {
    readRun: (binding) => readOperationRun(root, binding, readKey),
    readKey,
    readEvidenceLeaf: (binding, digestHex, maxBytes) => {
      const paths = operationPaths(root, binding.workspaceId);
      return readConfinedLeafBuffer(root, paths.evidenceFile(binding.runId, digestHex), paths.evidenceRoot(binding.runId), maxBytes, { requireSingleLink: true });
    },
    publishGenesis: (binding, serialized, collisionMessage) =>
      publishRunGenesis({ root, file: operationPaths(root, binding.workspaceId).runFile(binding.runId) }, serialized, collisionMessage),
    replaceRun: (binding, serialized) =>
      replaceRunLeaf({ root, file: operationPaths(root, binding.workspaceId).runFile(binding.runId) }, serialized),
  };
}

/** Sign, serialize, parse, and authenticate a candidate before touching disk. */
function prepareSignedRun(run: ReturnType<typeof createInitialOperationRun>, key: Buffer, binding: OperationRunBinding, budgetClass: RunWriteBudgetClass): { parsed: OperationRun; serialized: string } {
  const signed = signOperationRun(key, run);
  const serialized = canonicalBytes(signed).toString("utf8");
  assertOperationRunWriteBudget(Buffer.byteLength(serialized, "utf8"), budgetClass);
  const parsed = parseOperationRun(serialized, binding);
  if (!verifyOperationRunIntegrity(parsed, key, binding)) throw new Error("operation run HMAC verification failed");
  return { parsed, serialized };
}

/** Prove the complete worst case before create-only genesis publication. */
function preflightGenesis(input: InitialOperationRunInput): void {
  const projections = input.manifest.mutations.filter((item) => item.kind === "projection").length;
  projectRunBudget({
    mutationCount: input.manifest.mutations.length - projections,
    declaredCompensatorCount: input.declaredCompensatorMutationIds.length,
    projectionCount: projections,
    controlTransitionAllowance: input.controlTransitionAllowance,
  });
}

/**
 * Publish the sole genesis record without replacement. The caller must hold the
 * project lock and must already have completed manifest/payload preflight.
 */
export async function createOperationRunLocked(root: string, input: InitialOperationRunInput): Promise<OperationRun> {
  return createOperationRunWith(diskOperationRunWriteSteps(root), input);
}

/** {@link createOperationRunLocked} over the writers' own steps: the one genesis body. */
export async function createOperationRunWith(steps: OperationRunWriteSteps, input: InitialOperationRunInput): Promise<OperationRun> {
  preflightGenesis(input);
  const key = await requireOperationKey(steps);
  if (input.keyEpochId !== key.keyEpochId) throw new Error("operation run key epoch mismatch");
  const content = createInitialOperationRun(input), binding = operationRunBinding(content);
  const prepared = prepareSignedRun(content, key.key, binding, "ordinary");
  await steps.publishGenesis(binding, prepared.serialized, genesisCollisionMessage("operation", (asked) => steps.readRun(asked), binding));
  return prepared.parsed;
}

/** Require one healthy current key without ever creating or replacing it. */
async function requireOperationKey(steps: Pick<OperationRunWriteSteps, "readKey">) {
  const key = await steps.readKey();
  if (key.status === "absent") throw new Error("integrity-key-missing");
  if (key.status === "unavailable") throw new Error("integrity-key-unreadable");
  return key;
}

/** Refuse stale callers unless both state version and chain tip are exact. */
function assertExpectedPredecessor(run: OperationRun, expected: OperationRunPredecessor): void {
  const actual = operationRunPredecessor(run);
  if (actual.stateVersion !== expected.stateVersion || actual.chainTip !== expected.chainTip) {
    throw new Error("operation run predecessor changed");
  }
}

/**
 * Authenticate the exact predecessor, append exactly one next state version,
 * and durably replace the record. The caller must hold the project lock; a
 * caller that already read the key under that same hold may hand in its
 * `readKey`, since nothing it holds the lock for writes the key.
 */
export async function appendOperationTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AppendOperationTransitionInput,
  readKey?: () => Promise<OperationKeyRead>,
): Promise<OperationRun> {
  return appendOperationTransitionWith(diskOperationRunWriteSteps(root, readKey), binding, expected, input);
}

/** {@link appendOperationTransitionLocked} over the writers' own steps: the one append body. */
export async function appendOperationTransitionWith(
  steps: OperationRunWriteSteps,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AppendOperationTransitionInput,
): Promise<OperationRun> {
  if (input.type === "recovered" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(steps, binding, expected, input);
}

/** Append one already-proof-checked transition to an authenticated exact prefix. */
async function appendAuthenticatedTransition(
  steps: OperationRunWriteSteps,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AppendOperationTransitionInput,
): Promise<OperationRun> {
  const read = await steps.readRun(binding);
  if (read.status !== "ok") throw new Error(`operation run unavailable: ${read.status === "unavailable" ? read.detail : read.status}`);
  assertExpectedPredecessor(read.run, expected);
  if (!operationRunBindingMatches(read.run, binding)) throw new Error("operation run binding mismatch");
  const key = await requireOperationKey(steps);
  if (key.keyEpochId !== binding.keyEpochId) throw new Error("operation run key epoch changed");
  const next = appendOperationTransition(read.run, input);
  if (next.stateVersion !== expected.stateVersion + 1 || next.transitions.length !== read.run.transitions.length + 1) {
    throw new Error("operation run append did not produce exactly one next state version");
  }
  const prepared = prepareSignedRun(next, key.key, binding, operationRunWriteBudgetClass(input.type));
  await steps.replaceRun(binding, prepared.serialized);
  return prepared.parsed;
}

/** Append the fixed reserve-lane park move with an explicit current actor. */
export function appendControlTransition(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: RecoveryRequiredControlTransition,
): Promise<OperationRun> {
  return appendOperationTransitionLocked(root, binding, expected, {
    type: input.type, stateAfter: "recovery-required", actor: input.actor, at: input.at,
    payload: { kind: "problem", code: input.code },
  });
}

/** Verify the referenced recovery run is currently successful before settlement. */
export async function appendRecoveredTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: RecoveredControlTransition,
): Promise<OperationRun> {
  return appendRecoveredTransitionWith(diskOperationRunWriteSteps(root), binding, expected, input);
}

/** {@link appendRecoveredTransitionLocked} over the writers' own steps: every proof before the append. */
export async function appendRecoveredTransitionWith(
  steps: OperationRunWriteSteps,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: RecoveredControlTransition,
): Promise<OperationRun> {
  if (input.recoveryBinding.workspaceId !== binding.workspaceId || input.recoveryBinding.keyEpochId !== binding.keyEpochId
    || input.recoveryBinding.bundleId === binding.bundleId || input.recoveryBinding.runId === binding.runId) {
    throw new Error("recovery run binding does not settle this workspace epoch");
  }
  const manifest = input.recoveryManifest;
  if (manifest.bundleId !== input.recoveryBinding.bundleId || manifest.runId !== input.recoveryBinding.runId
    || manifest.workspaceId !== binding.workspaceId || manifest.recoversBundleId !== binding.bundleId
    || canonicalDigest(manifest) !== input.recoveryBinding.manifestDigest) {
    throw new Error("recovery manifest is not bound to the original bundle");
  }
  const recovery = await steps.readRun(input.recoveryBinding);
  if (recovery.status !== "ok") throw new Error("recovery run is unavailable");
  assertExpectedPredecessor(recovery.run, input.recoveryExpected);
  if (recovery.run.state !== "succeeded" && recovery.run.state !== "succeeded-with-warnings" && recovery.run.state !== "compensated") {
    throw new Error("recovery run has not reached successful terminal settlement");
  }
  return appendAuthenticatedTransition(steps, binding, expected, {
    type: "recovered", stateAfter: "recovered", actor: input.actor, at: input.at,
    payload: { kind: "recovery", bundleId: recovery.run.bundleId, runId: recovery.run.runId,
      manifestDigest: recovery.run.manifestDigest, terminalState: recovery.run.state,
      stateVersion: recovery.run.stateVersion, chainTip: operationRunPredecessor(recovery.run).chainTip },
  });
}

/** Verify the exact manifest named by the authenticated run binding. */
function assertAbandonmentManifest(binding: OperationRunBinding, manifest: OperationBundleManifest): void {
  if (manifest.bundleId !== binding.bundleId || manifest.runId !== binding.runId
    || manifest.workspaceId !== binding.workspaceId || canonicalDigest(manifest) !== binding.manifestDigest) {
    throw new Error("abandonment manifest does not match the run binding digest");
  }
  manifest.mutations.forEach((item, index) => {
    if (item.index !== index || item.mutationId !== mutationId(manifest.bundleId, index)) {
      throw new Error("abandonment manifest mutation identity mismatch");
    }
  });
}

/** Build findings in exact unresolved order with manifest-derived namespaces. */
function buildResidualFindings(
  unresolved: readonly MutationId[],
  manifest: OperationBundleManifest,
  observations: readonly AbandonmentObservation[],
): ResidualFinding[] {
  const byId = new Map<MutationId, AbandonmentObservation>();
  for (const observation of observations) {
    if (byId.has(observation.mutationId)) throw new Error("abandonment observations contain duplicate coverage");
    byId.set(observation.mutationId, observation);
  }
  if (byId.size !== unresolved.length || unresolved.some((id) => !byId.has(id))) {
    throw new Error("abandonment observations do not exactly cover unresolved work");
  }
  const mutations = new Map(manifest.mutations.map((item) => [item.mutationId, item]));
  return unresolved.map((id) => {
    const observation = byId.get(id)!, mutation = mutations.get(id);
    if (mutation === undefined) throw new Error("abandonment observation is not manifest-owned");
    return { ...observation, authoritativeNamespace: authoritativeNamespaceForMutation(mutation), evidence: { ...observation.evidence } };
  });
}

/** Verify one claimed evidence reference against exact confined raw bytes. */
async function verifyResidualEvidence(steps: OperationRunWriteSteps, binding: OperationRunBinding, evidence: RunEvidenceRef): Promise<void> {
  const match = /^sha256:([0-9a-f]{64})$/.exec(evidence.digest);
  if (match === null || !Number.isSafeInteger(evidence.byteCount) || evidence.byteCount > MAX_RUN_EVIDENCE_BLOB_BYTES) {
    throw new Error("run evidence reference is invalid");
  }
  const read = await steps.readEvidenceLeaf(binding, match[1]!, MAX_RUN_EVIDENCE_BLOB_BYTES);
  if (read.kind !== "ok") throw new Error(`run evidence is ${read.kind}`);
  const digest = `sha256:${createHash("sha256").update(read.body).digest("hex")}`;
  if (read.body.byteLength !== evidence.byteCount || digest !== evidence.digest) {
    throw new Error("run evidence byte count or digest mismatch");
  }
}

/** Require explicit confirmation, fresh evidence, and manifest-owned namespaces. */
export async function appendAbandonedTransitionLocked(
  root: string,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AbandonedControlTransition,
): Promise<OperationRun> {
  return appendAbandonedTransitionWith(diskOperationRunWriteSteps(root), binding, expected, input);
}

/** {@link appendAbandonedTransitionLocked} over the writers' own steps: every proof, evidence bytes included, before the append. */
async function appendAbandonedTransitionWith(
  steps: OperationRunWriteSteps,
  binding: OperationRunBinding,
  expected: OperationRunPredecessor,
  input: AbandonedControlTransition,
): Promise<OperationRun> {
  if (!input.actor.grants.includes("operation-bundle.abandon")) throw new Error("operation-bundle.abandon grant is required");
  if (input.confirmResidualState !== true) throw new Error("residual-state confirmation is required");
  if (input.observations.length > MAX_MUTATIONS_PER_BUNDLE) {
    throw new Error(`abandonment observations exceed the ${MAX_MUTATIONS_PER_BUNDLE}-mutation launch bound`);
  }
  const read = await steps.readRun(binding);
  if (read.status !== "ok") throw new Error("operation run is unavailable for abandonment");
  assertExpectedPredecessor(read.run, expected);
  const unresolved = unresolvedResidualIds(read.run);
  if (input.observations.length !== unresolved.length) throw new Error("abandonment observations do not exactly cover unresolved work count");
  const observations = input.observations.map(parseAbandonmentObservation);
  assertAbandonmentManifest(binding, input.manifest);
  const findings = buildResidualFindings(unresolved, input.manifest, observations);
  for (const finding of findings) await verifyResidualEvidence(steps, binding, finding.evidence!);
  return appendAuthenticatedTransition(steps, binding, expected, {
    type: "abandoned", stateAfter: "abandoned", actor: input.actor, at: input.at,
    residualFindings: findings,
    payload: {
      kind: "abandonment", confirmation: "confirm-residual-state",
      findingCount: findings.length, findingsDigest: residualFindingsDigest(findings),
    },
  });
}
