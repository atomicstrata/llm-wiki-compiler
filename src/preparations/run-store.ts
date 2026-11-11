/**
 * @file src/preparations/run-store.ts
 * @description Exact-binding preparation-run reads, create-only genesis
 * publication, and authenticated-prefix transition appends with whole-file
 * fsync/rename replacement (design sections 12.1, 12.2, 13). No exported writer
 * accepts a caller-supplied progressed record or re-signs unverifiable history:
 * every append re-reads and authenticates the exact predecessor, appends exactly
 * one next state version through the pure hash-chained constructor, re-parses and
 * re-verifies the candidate in memory, charges the correct budget lane, and only
 * then durably replaces the record. Handoff and abandonment run through dedicated
 * writers that verify their evidence before the state changes.
 *
 * ONE READ BODY, OVER THE READER'S OWN LEAVES. `readPreparationRunFrom` is the
 * single body of the read; it takes `PreparationRunLeafReads` and no project
 * root. `readPreparationRun` keeps its signature and delegates to it over the
 * private local-disk leaves, built on each call. What is bound is THIS READER'S
 * decisions: the cap it asks for, leaf before key, the typed codes, parsing
 * against the caller's binding, and AUTHENTICATION, which stays in the body
 * with the real key. Path derivation, confinement and cap enforcement stay in
 * the local-disk leaves. Nothing here selects a backend.
 *
 * ONE BODY PER WRITER, OVER THE WRITERS' OWN STEPS. Genesis, the authenticated
 * append (with or without a projector), the handoff settlement and the
 * abandonment each have one root-free body (`…With`) over
 * {@link PreparationRunWriteSteps}: the authenticated read, the key, the
 * verifying evidence read, create-only genesis publication and durable
 * replacement. The bodies own predecessor authentication, the epoch, signing,
 * the budget lane, the projector invariant, the reserved handoff identities and
 * evidence verification BEFORE the write. Every root form keeps its signature and
 * passes {@link diskPreparationRunWriteSteps}, whose closures keep the incumbent
 * confinement, exact-parent, durability and mode flags.
 */

import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { genesisCollisionMessage, publishRunGenesis, readAuthenticatedRunFrom, replaceRunLeaf } from "../utils/run-store-io.js";
import { readDurableOperationLeaf } from "../operation-bundles/durable-leaf.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import type { CappedLeafRead } from "../utils/confined-read.js";
import { MAX_PREPARATION_RUN_BYTES } from "./constants.js";
import { readPreparationEvidence, type PreparationEvidenceLocation, type PreparationEvidenceRead } from "./evidence-store.js";
import { readPreparationKey } from "./key-epoch.js";
import type { PreparationKeyRead } from "./key-epoch.js";
import { preparationPaths } from "./paths.js";
import { assertPreparationRunWriteBudget, preparationRunWriteBudgetClass, projectPreparationRunBudget, type RunBudgetInput, type RunWriteBudgetClass } from "./run-budget.js";
import {
  appendPreparationTransition, createInitialPreparationRun, preparationRunBinding,
  preparationRunBindingMatches, preparationRunPredecessor, signPreparationRun,
  verifyPreparationRunIntegrity,
} from "./run-integrity.js";
import { parsePreparationRun } from "./run-parse.js";
import { once, oncePer } from "../utils/pass-memo.js";
import type {
  AppendPreparationTransitionInput, HandoffBindingV1, HandoffStartBindingV1,
  InitialPreparationRunInput, PreparationPrincipalV1, PreparationRunBinding,
  PreparationRunContentV1, PreparationRunPredecessor, PreparationRunV1, ResidualFindingV1,
} from "./run-types.js";

/**
 * Typed reason an authenticated run read could not be trusted. Following the
 * inherited Milestone A taxonomy (PO-INV-31), integrity-invalid is folded into
 * `unavailable` rather than a fourth status, but every leg carries a distinct
 * typed `code` so a Task 3 consumer branches on the code — never a free-form
 * `detail` string. `run-integrity-invalid` is the "bytes exist but are not
 * trusted under the healthy key" case (design section 25.2); the two key legs
 * stay distinct from a missing/unreadable leaf and from a bad identity.
 */
export type PreparationRunUnavailableCode =
  | "identity"
  | "run-leaf-unavailable"
  | "integrity-key-missing"
  | "integrity-key-unreadable"
  | "run-integrity-invalid";

export type PreparationRunRead =
  | { status: "ok"; run: PreparationRunV1 }
  | { status: "absent" }
  | { status: "unavailable"; detail: string; code: PreparationRunUnavailableCode };

/** Explicit residual-state confirmation and its verified findings. */
export interface AbandonPreparationRunInput {
  actor: PreparationPrincipalV1;
  at: string;
  confirmResidualState: true;
  findings: readonly ResidualFindingV1[];
}

/** The reserved-identity binding recorded when a handoff durably begins. */
export interface HandoffStartInput {
  actor: PreparationPrincipalV1;
  at: string;
  start: HandoffStartBindingV1;
}

/** The actor/timestamp settling a handoff; every identity comes from durable state. */
export interface HandoffPreparationRunInput {
  actor: PreparationPrincipalV1;
  at: string;
}

/** Read one exact workspace run leaf before consulting any project key. */
async function readRunLeaf(root: string, binding: PreparationRunBinding, maxBytes: number, scanned?: ScannedLeafBytes) {
  const paths = preparationPaths(root, binding.workspaceId);
  return readDurableOperationLeaf(root, paths.runFile(binding.runId), paths.runsRoot, maxBytes, scanned);
}

/**
 * What the run read asks of the store. Owned by the run reader; no read takes
 * a project root.
 */
export interface PreparationRunLeafReads {
  /**
   * One run leaf's text by its binding, within `maxBytes`. May throw or reject,
   * for an unsafe identity or otherwise; the body maps both to `identity`.
   */
  readRunLeaf(binding: PreparationRunBinding, maxBytes: number): Promise<CappedLeafRead>;
  /**
   * The preparation key, WITH ITS BYTES. Deliberate: this body is the one that
   * authenticates, so it needs the key itself. An `ok` answer whose key is not
   * 32 bytes fails verification and reads as integrity-invalid; the local-disk
   * key reader never returns one.
   */
  readKey(): Promise<PreparationKeyRead>;
}

/**
 * The local-disk run leaves for one project root, built per call: each closure
 * calls the incumbent's function when it is asked. Exported for the store's
 * leaf composition (`store-leaf-reads.ts`) only; in no package index.
 */
export function diskPreparationRunLeafReads(root: string): PreparationRunLeafReads {
  return {
    readRunLeaf: (binding, maxBytes) => readRunLeaf(root, binding, maxBytes),
    readKey: () => readPreparationKey(root),
  };
}

/**
 * Read, parse, and authenticate only against all caller-requested identities.
 * With `hold`, the read is that hold's ({@link preparationRunHoldReads}): one
 * key read and one read per binding for one hold of the project lock.
 */
export async function readPreparationRun(
  root: string, binding: PreparationRunBinding, hold?: PreparationRunWriteReads,
): Promise<PreparationRunRead> {
  return hold === undefined ? readPreparationRunFrom(diskPreparationRunLeafReads(root), binding) : hold.readRun(binding);
}

/** One run read's identity: every field of the binding it authenticates against. */
function preparationRunReadIdentity(binding: PreparationRunBinding): string {
  return [binding.workspaceId, binding.preparationId, binding.runId, binding.manifestDigest, binding.keyEpochId].join("\0");
}

/**
 * The run and key reads of ONE HOLD of the project lock, for the local disk:
 * the key is read once, and each binding's run once, under that one key read.
 * Within one hold nothing else writes the run or the key, so a second disk read
 * before this hold's own write could only return the first one's answer. The
 * caller takes a fresh one per hold and never consults it after writing the run
 * or the key; a write through {@link preparationRunWriteStepsOn} is the end of it.
 * With `scanned`, a run leaf the pass's inventory walk already read is used
 * once the durable reader proves it current.
 */
export function preparationRunHoldReads(root: string, scanned?: ScannedLeafBytes): PreparationRunWriteReads {
  const readKey = once(() => readPreparationKey(root));
  const leaves: PreparationRunLeafReads = { readRunLeaf: (binding, maxBytes) => readRunLeaf(root, binding, maxBytes, scanned), readKey };
  return { readKey, readRun: oncePer(preparationRunReadIdentity, (binding) => readPreparationRunFrom(leaves, binding)) };
}

/** A lock-holding caller's {@link preparationRunHoldReads}, renewed at each acquisition and after each run write. */
export interface PreparationRunHolds {
  /** The current hold's reads. */
  current(): PreparationRunWriteReads;
  /** Begin a new hold: call it once the lock is acquired. */
  renew(): void;
  /** Run one run write over the current hold, which ends with it whether it succeeds or not. */
  writing<T>(write: (hold: PreparationRunWriteReads) => Promise<T>): Promise<T>;
}

/** {@link PreparationRunHolds} for `root`. Building it reads nothing. */
export function preparationRunHolds(root: string): PreparationRunHolds {
  let hold = preparationRunHoldReads(root);
  const renew = () => { hold = preparationRunHoldReads(root); };
  return {
    current: () => hold,
    renew,
    writing: async (write) => {
      try {
        return await write(hold);
      } finally {
        renew();
      }
    },
  };
}

/**
 * {@link readPreparationRun} over the reader's own leaves: the one body. It
 * reads the leaf, then the key only if the leaf is present, then parses and
 * AUTHENTICATES here. It confines nothing and trusts no leaf it cannot verify.
 */
export async function readPreparationRunFrom(
  leaves: PreparationRunLeafReads, binding: PreparationRunBinding,
): Promise<PreparationRunRead> {
  return readAuthenticatedRunFrom<PreparationRunBinding, PreparationRunV1, Extract<PreparationRunRead, { status: "unavailable" }>>(leaves, binding, {
    maxBytes: MAX_PREPARATION_RUN_BYTES,
    parse: (body) => parsePreparationRun(body, binding),
    verify: (run, key) => verifyPreparationRunIntegrity(run, key, binding),
    // THE PREPARATION TAXONOMY: the identity and run-leaf refusals carry their own codes.
    identity: { status: "unavailable", detail: "identity", code: "identity" },
    runLeaf: { status: "unavailable", detail: "run-leaf", code: "run-leaf-unavailable" },
  });
}

/** What the run writers ask of the store. No member takes a project root. */
export interface PreparationRunWriteSteps {
  /** The authenticated exact-binding run read. Local: `readPreparationRunFrom` over the operation's one key read. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /**
   * The preparation key WITH ITS BYTES. Local: read ONCE per write operation and
   * shared with that operation's run read (see {@link diskPreparationRunWriteSteps}).
   */
  readKey(): Promise<PreparationKeyRead>;
  /** The verifying evidence read. Local: `readPreparationEvidence(root, location, digest)`. */
  readEvidence(location: PreparationEvidenceLocation, digest: string): Promise<PreparationEvidenceRead>;
  /** Create-only genesis publication; `collisionMessage` is asked only on a genuine create collision. */
  publishGenesis(binding: PreparationRunBinding, serialized: string, collisionMessage: () => Promise<string>): Promise<void>;
  /** Durable, strictly synced replacement of the run leaf. */
  replaceRun(binding: PreparationRunBinding, serialized: string): Promise<void>;
}

/** The two reads a write operation shares: the authenticated run and the key it is signed under. */
export type PreparationRunWriteReads = Pick<PreparationRunWriteSteps, "readRun" | "readKey">;

/**
 * The local-disk run write steps for one root, built per call: ONE write
 * operation under the project lock, over its own {@link preparationRunHoldReads}.
 * The run read and the signing key are one reading of the key: the append reads
 * the run (which authenticates it under the key) and then asks for the key to
 * sign with, and nothing between the two writes the key, so the second disk read
 * could only return the first one's answer. The same holds for the run: the
 * handoff settlement reads it for the reserved identities and the append reads
 * it again, with no write between. Every body reads before its one write, except
 * the genesis collision diagnostic, which reads only after it and so reaches the
 * disk. Every other closure calls the incumbent when asked. In no package index.
 */
function diskPreparationRunWriteSteps(root: string, hold: PreparationRunWriteReads = preparationRunHoldReads(root)): PreparationRunWriteSteps {
  return preparationRunWriteStepsOn(root, hold);
}

/**
 * The local-disk run writers for one root over a caller's {@link PreparationRunWriteReads}:
 * for a caller that already read the run and key in the same hold of the
 * project lock and has written neither since. A caller that writes the run
 * through these steps must not hand the same reads to a later write.
 */
export function preparationRunWriteStepsOn(root: string, reads: PreparationRunWriteReads): PreparationRunWriteSteps {
  return {
    readRun: reads.readRun,
    readKey: reads.readKey,
    readEvidence: (location, digest) => readPreparationEvidence(root, location, digest),
    publishGenesis: (binding, serialized, collisionMessage) =>
      publishRunGenesis({ root, file: preparationPaths(root, binding.workspaceId).runFile(binding.runId) }, serialized, collisionMessage),
    replaceRun: (binding, serialized) =>
      replaceRunLeaf({ root, file: preparationPaths(root, binding.workspaceId).runFile(binding.runId) }, serialized),
  };
}

/** Sign, serialize, parse, and authenticate a candidate before touching disk. */
function prepareSignedRun(
  run: PreparationRunContentV1, key: Buffer, binding: PreparationRunBinding, budgetClass: RunWriteBudgetClass,
): { parsed: PreparationRunV1; serialized: string } {
  const signed = signPreparationRun(key, run);
  const serialized = canonicalBytes(signed).toString("utf8");
  assertPreparationRunWriteBudget(Buffer.byteLength(serialized, "utf8"), budgetClass);
  const parsed = parsePreparationRun(serialized, binding);
  if (!verifyPreparationRunIntegrity(parsed, key, binding)) throw new Error("preparation run HMAC verification failed");
  return { parsed, serialized };
}

/** Require one healthy current key without ever creating or replacing it. */
async function requirePreparationKey(steps: Pick<PreparationRunWriteSteps, "readKey">) {
  const key = await steps.readKey();
  if (key.status === "absent") throw new Error("preparation integrity key is missing");
  if (key.status === "unavailable") throw new Error("preparation integrity key is unreadable");
  return key;
}

/**
 * Publish the sole genesis record without replacement. The caller holds the
 * project lock and has already completed manifest/evidence preflight. The
 * declared plan budget is re-proven so no run defect can follow a durable write.
 */
export async function createPreparationRunLocked(
  root: string, input: InitialPreparationRunInput, budgetInput: RunBudgetInput, hold?: PreparationRunWriteReads,
): Promise<PreparationRunV1> {
  return createPreparationRunWith(diskPreparationRunWriteSteps(root, hold), input, budgetInput);
}

/**
 * {@link createPreparationRunLocked} over the writers' own steps: the one genesis
 * body. Exported for its memory witness and in no package index.
 */
export async function createPreparationRunWith(
  steps: PreparationRunWriteSteps, input: InitialPreparationRunInput, budgetInput: RunBudgetInput,
): Promise<PreparationRunV1> {
  projectPreparationRunBudget(budgetInput);
  const key = await requirePreparationKey(steps);
  if (input.keyEpochId !== key.keyEpochId) throw new Error("preparation run key epoch mismatch");
  const content = createInitialPreparationRun(input), binding = preparationRunBinding(content);
  const prepared = prepareSignedRun(content, key.key, binding, "ordinary");
  await steps.publishGenesis(binding, prepared.serialized, genesisCollisionMessage("preparation", (asked) => steps.readRun(asked), binding));
  return prepared.parsed;
}

/** Refuse stale callers unless both state version and chain tip are exact. */
function assertExpectedPredecessor(run: PreparationRunV1, expected: PreparationRunPredecessor): void {
  const actual = preparationRunPredecessor(run);
  if (actual.stateVersion !== expected.stateVersion || actual.chainTip !== expected.chainTip) {
    throw new Error("preparation run predecessor changed");
  }
}

/**
 * A pure projector layering additive attempt facts (execution owner, phase
 * summaries, evidence/effect summaries) onto the base next-state content Task 4
 * needs. It never alters the state, state version, or transition chain: the
 * caller-independent invariant check below re-runs on the projected content so a
 * tampering projector fails closed before the record is signed or written.
 */
export type PreparationRunContentProjector = (
  next: PreparationRunContentV1,
) => PreparationRunContentV1;

/** Append one already-proof-checked transition to an authenticated exact prefix. */
async function appendAuthenticatedTransition(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project?: PreparationRunContentProjector,
): Promise<PreparationRunV1> {
  const read = await steps.readRun(binding);
  if (read.status !== "ok") throw new Error(`preparation run unavailable: ${read.status === "unavailable" ? read.detail : read.status}`);
  assertExpectedPredecessor(read.run, expected);
  if (!preparationRunBindingMatches(read.run, binding)) throw new Error("preparation run binding mismatch");
  const key = await requirePreparationKey(steps);
  if (key.keyEpochId !== binding.keyEpochId) throw new Error("preparation run key epoch changed");
  const base = appendPreparationTransition(read.run, input);
  const next = project ? project(base) : base;
  if (next.stateVersion !== expected.stateVersion + 1 || next.transitions.length !== read.run.transitions.length + 1
    || next.state !== base.state) {
    throw new Error("preparation run append did not produce exactly one next state version");
  }
  const prepared = prepareSignedRun(next, key.key, binding, preparationRunWriteBudgetClass(input.type));
  await steps.replaceRun(binding, prepared.serialized);
  return prepared.parsed;
}

/**
 * Append one attempt transition that additionally projects execution-owner,
 * phase-summary, and evidence/effect facts onto the run (design sections 12.5,
 * 13.2). Task 4 supplies the pure projector; the shared under-lock predecessor
 * authentication, budget lane, re-parse, and re-verify guarantee no attempt
 * projection can bypass the run's integrity contract.
 */
export function appendProjectedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project: PreparationRunContentProjector, hold?: PreparationRunWriteReads,
): Promise<PreparationRunV1> {
  if (input.type === "handed-off" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(diskPreparationRunWriteSteps(root, hold), binding, expected, input, project);
}

/** Append one ordinary or fixed-shape control transition under the project lock. */
export async function appendPreparationTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput,
): Promise<PreparationRunV1> {
  return appendPreparationTransitionWith(diskPreparationRunWriteSteps(root), binding, expected, input);
}

/**
 * {@link appendPreparationTransitionLocked} over the writers' own steps. Handoff and
 * abandonment are refused here; they have their own evidence-verifying bodies.
 * {@link appendProjectedTransitionLocked} does NOT route through this function: it
 * keeps its own SYNCHRONOUS guard (a throw, not a rejection) and then reaches the same
 * shared authenticated-append body with its projector.
 */
export async function appendPreparationTransitionWith(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AppendPreparationTransitionInput, project?: PreparationRunContentProjector,
): Promise<PreparationRunV1> {
  if (input.type === "handed-off" || input.type === "abandoned") {
    throw new Error(`${input.type} requires its evidence-verifying control writer`);
  }
  return appendAuthenticatedTransition(steps, binding, expected, input, project);
}

/** Append the reserved-lane park move to `recovery-required`. */
export function appendHeadroomExhaustedControl(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  actor: PreparationPrincipalV1, at: string,
): Promise<PreparationRunV1> {
  return appendAuthenticatedTransition(diskPreparationRunWriteSteps(root), binding, expected, {
    type: "headroom-exhausted", stateAfter: "recovery-required", actor, at,
    payload: { kind: "problem", code: "preparation-run-headroom-exhausted" },
  });
}

/**
 * Durably record `handoff-started`: the reserved-identity recovery authority
 * (design section 22.3 step 6). It writes ONLY the exact reserved bundle/run
 * identities, the deterministic bundle-manifest digest, the pre-handoff chain tip,
 * and the origin/evidence-copy digests through the shared authenticated append —
 * no Milestone A bundle exists yet. On crash this transition is the sole authority
 * that lets recovery resume the same creation rather than mint a duplicate.
 */
export function appendHandoffStartedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffStartInput, hold?: PreparationRunWriteReads,
): Promise<PreparationRunV1> {
  return appendHandoffStartedTransitionWith(diskPreparationRunWriteSteps(root, hold), binding, expected, input);
}

/** {@link appendHandoffStartedTransitionLocked} over the writers' own steps: the one append. */
export function appendHandoffStartedTransitionWith(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffStartInput,
): Promise<PreparationRunV1> {
  return appendAuthenticatedTransition(steps, binding, expected, {
    type: "handoff-started", stateAfter: "handoff-started", actor: input.actor, at: input.at,
    payload: { kind: "handoff-started", ...input.start },
  });
}

/** Extract the durable reserved-identity authority from the run's own history. */
export function handoffStartBinding(run: PreparationRunV1): HandoffStartBindingV1 | undefined {
  for (let index = run.transitions.length - 1; index >= 0; index--) {
    const payload = run.transitions[index]!.payload;
    if (payload.kind === "handoff-started") {
      const { kind: _kind, ...start } = payload;
      return start;
    }
  }
  return undefined;
}

/**
 * Settle a handoff by binding the reserved bundle identity recorded at
 * `handoff-started` to the run. The bundle id, manifest digest, handoff id, and
 * pre-handoff hash are read from the DURABLE handoff-started transition — never
 * from the caller — so a `handed-off` binding can only name the exact bundle the
 * recovery authority reserved, and its handoff id recomputes from the same
 * pre-handoff chain tip the loader re-derives on every read.
 */
export async function appendHandoffTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffPreparationRunInput, hold?: PreparationRunWriteReads,
): Promise<PreparationRunV1> {
  return appendHandoffTransitionWith(diskPreparationRunWriteSteps(root, hold), binding, expected, input);
}

/** {@link appendHandoffTransitionLocked} over the writers' own steps: identities only from the durable handoff-started record. */
export async function appendHandoffTransitionWith(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: HandoffPreparationRunInput,
): Promise<PreparationRunV1> {
  const read = await steps.readRun(binding);
  if (read.status !== "ok") throw new Error(`preparation run unavailable: ${read.status}`);
  const start = handoffStartBinding(read.run);
  if (start === undefined) throw new Error("handed-off requires a prior handoff-started transition");
  const handoff: HandoffBindingV1 = {
    handoffId: start.handoffId, bundleId: start.reservedBundleId,
    bundleManifestDigest: start.bundleManifestDigest, finalTransitionHash: start.preHandoffTransitionHash,
  };
  return appendAuthenticatedTransition(steps, binding, expected, {
    type: "handed-off", stateAfter: "handed-off", actor: input.actor, at: input.at, handoff,
    payload: { kind: "handoff", handoffId: start.handoffId, bundleManifestDigest: start.bundleManifestDigest },
  });
}

/** Verify every residual finding's evidence before the abandonment transition. */
async function verifyResidualEvidence(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, findings: readonly ResidualFindingV1[],
): Promise<void> {
  for (const finding of findings) {
    if (finding.evidence === undefined) continue;
    const read = await steps.readEvidence(
      { workspaceId: binding.workspaceId, preparationId: binding.preparationId },
      finding.evidence.digest.slice("sha256:".length),
    );
    if (read.status !== "ok" || read.byteCount !== finding.evidence.byteCount) {
      throw new Error("preparation abandonment evidence is unavailable or mismatched");
    }
  }
}

/** Require explicit confirmation and verified fresh evidence before abandonment. */
export async function appendAbandonedTransitionLocked(
  root: string, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AbandonPreparationRunInput,
): Promise<PreparationRunV1> {
  return appendAbandonedTransitionWith(diskPreparationRunWriteSteps(root), binding, expected, input);
}

/** {@link appendAbandonedTransitionLocked} over the writers' own steps: every evidence byte verified before the append. */
export async function appendAbandonedTransitionWith(
  steps: PreparationRunWriteSteps, binding: PreparationRunBinding, expected: PreparationRunPredecessor,
  input: AbandonPreparationRunInput,
): Promise<PreparationRunV1> {
  if (input.confirmResidualState !== true) throw new Error("residual-state confirmation is required");
  await verifyResidualEvidence(steps, binding, input.findings);
  return appendAuthenticatedTransition(steps, binding, expected, {
    type: "abandoned", stateAfter: "abandoned", actor: input.actor, at: input.at,
    residualFindings: input.findings,
    payload: { kind: "abandonment", confirmation: "confirm-residual-state", findingCount: input.findings.length },
  });
}
