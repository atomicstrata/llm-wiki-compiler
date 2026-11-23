/**
 * @file src/scale/downgrade-journal.ts
 * @description The retained EVIDENCE DIRECTORY of one indexed scale-down and
 * its create-only journal leaves, under `.llmwiki/scale-downgrade/<fence
 * revision>-<plan digest prefix>/`:
 *
 * - `plan.json`: the exact plan applied (written before the intent);
 * - `attempt-<n>/staged/<relPath>` and `attempt-<n>/stage.json`: one staging
 *   attempt's exported files and, once every one is written and verified,
 *   its STAGE MANIFEST binding each staged file's identity and digest and
 *   each prior file's identity and digest. An attempt without a manifest is
 *   incomplete: it is kept as evidence and a NEW attempt directory is used;
 * - `prior/<relPath>`: every prior file moved aside before installation;
 * - `archive.json`: the identity of `.llmwiki/indexed` (and the pins
 *   directory) recorded BEFORE they are moved here as `indexed/` and
 *   `indexed-pins/`;
 * - `receipt.json`: written after the archive is verified and before the
 *   final activation: what was installed, retained and archived;
 * - `intent.json`: the bootstrap intent, retired here after completion (or
 *   after a proven cancel);
 * - `cancel.json` and `cancel-receipt.json`: a pre-install CANCEL's intent,
 *   written before its only authority change, and its receipt, written after
 *   that change is proven (`./downgrade-cancel.ts`).
 *
 * Every leaf is written once (create-only, durable, 0600) and read back
 * strictly within a cap; nothing here is rewritten or deleted.
 */

import path from "node:path";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { mayHaveEvidenceAlias, publishDowngradeEvidence } from "./downgrade-evidence-write.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { DOWNGRADE_DIR, MAX_DOWNGRADE_PLAN_BYTES, ScaleDowngradeError, type DowngradeRunV1, type DowngradeUnitV1 } from "./downgrade-contracts.js";
import { at, identityAt, type ObjectIdentityV1 } from "./downgrade-fs.js";
import { stageBeforeInstall } from "./downgrade-stage-replay.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { closed, count, digest, identity, list, SchemaViolation, text, units } from "./downgrade-schema.js";

/** Most staging attempts one scale-down keeps. */
const MAX_ATTEMPTS = 1_000;
/** Most prior files and listed stores, runs and pins a leaf holds. */
const MAX_PRIORS = 10_005;
const MAX_LIST = 10_000;
const STAGE_FORMAT = "llmwiki-scale-downgrade-stage";
/** The archive journal name, before and after its publication. */
export const ARCHIVE_LEAF = "archive.json";
const ARCHIVE_FORMAT = "llmwiki-scale-downgrade-archive";
const RECEIPT_FORMAT = "llmwiki-scale-downgrade-receipt";
const CANCEL_FORMAT = "llmwiki-scale-downgrade-cancel";
const CANCEL_RECEIPT_FORMAT = "llmwiki-scale-downgrade-cancel-receipt";
/** The cancel leaves, relative to the evidence directory. */
export const CANCEL_LEAF = "cancel.json";
export const CANCEL_RECEIPT_LEAF = "cancel-receipt.json";
/** The only scratch names a cancel capture writer can prove and reuse. */
export const CANCEL_READY_NAMES = [durableTempPath(CANCEL_LEAF), durableWritingPath(CANCEL_LEAF)] as const;
/** Reserved pre-publication names for the bound cancel receipt. */
export const CANCEL_RECEIPT_READY_NAMES = [durableTempPath(CANCEL_RECEIPT_LEAF), durableWritingPath(CANCEL_RECEIPT_LEAF)] as const;

/** Apply refuses a cancel leaf or either reserved name, regardless of whether cancel can replay it. */
export async function assertNotCancelled(root: string, dir: string): Promise<void> {
  for (const leaf of [CANCEL_LEAF, CANCEL_RECEIPT_LEAF, ...CANCEL_READY_NAMES, ...CANCEL_RECEIPT_READY_NAMES]) {
    if (await identityAt(root, path.posix.join(dir, leaf)) !== null) {
      throw new ScaleDowngradeError("scale_downgrade_cancelled", `${dir} holds cancel evidence at ${leaf}; finish the same cancel or inspect its evidence`);
    }
  }
}

/** One unit as staged: the plan's unit plus the staged file's identity (null when the unit has no file). */
export interface StagedUnitV1 extends DowngradeUnitV1 {
  readonly staged: ObjectIdentityV1 | null;
}

/** One prior file as found before installation: its digest and identity, or absent. */
export interface PriorFileV1 {
  readonly relPath: string;
  readonly sha256: string | null;
  readonly identity: ObjectIdentityV1 | null;
}

/** The stage manifest of one complete attempt. */
export interface StageManifestV1 {
  readonly format: typeof STAGE_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly attempt: number;
  readonly units: readonly StagedUnitV1[];
  readonly priors: readonly PriorFileV1[];
}

/** The identities recorded before the archive moves. */
export interface ArchiveLeafV1 {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly indexed: ObjectIdentityV1;
  readonly pins: ObjectIdentityV1 | null;
}

/** The receipt of a scale-down, written before its final activation. */
export interface DowngradeReceiptV1 {
  readonly format: typeof RECEIPT_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly target: string;
  readonly fenceRevision: number;
  readonly archive: { readonly indexed: ObjectIdentityV1; readonly pins: ObjectIdentityV1 | null; readonly stores: readonly string[] };
  readonly runs: readonly DowngradeRunV1[];
  readonly lastRun: string | null;
  readonly pinLabels: readonly string[];
  readonly units: readonly StagedUnitV1[];
  readonly priors: readonly PriorFileV1[];
}

/** A pre-install cancel's intent: what it proved and the exact record outcome it will write (fenced) or found (bootstrapped). */
export interface CancelIntentV1 {
  readonly format: typeof CANCEL_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly phase: "fenced" | "bootstrapped";
  readonly fenceRevision: number;
  /** Fenced: `fenceRevision + 1`. Bootstrapped: null (no record is written). */
  readonly cancelRevision: number | null;
  /** Fenced: SHA-256 of the exact record bytes the cancel writes. Bootstrapped: of the original record. */
  readonly recordSha256: string;
  /** Each prior as proven in place: its digest, and the identity observed then. */
  readonly priors: readonly PriorFileV1[];
}

/** A proven cancel's receipt: bound to the plan, the exact cancel-intent bytes and the record outcome. */
export interface CancelReceiptV1 {
  readonly format: typeof CANCEL_RECEIPT_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly phase: "fenced" | "bootstrapped";
  readonly fenceRevision: number;
  readonly cancelRevision: number | null;
  readonly recordSha256: string;
  readonly cancelIntentSha256: string;
  /** Fenced: the fence's planned estimate stays on the record the cancel wrote. Bootstrapped: no record was written; the estimate is unchanged. */
  readonly estimate: "planned-kept" | "unchanged";
  /** Bootstrapped only: a newer record found when the cancel completed (never written by it). */
  readonly laterRecord: { readonly revision: number; readonly architecture: string } | null;
}

/** The evidence directory of `plan` once fenced at `fenceRevision`. */
export function downgradeDir(plan: DowngradePlanV1, fenceRevision: number): string {
  return path.posix.join(DOWNGRADE_DIR, `${fenceRevision}-${plan.digest.slice(0, 12)}`);
}

/** Durably publish an independently known journal value or finish its exact publication. */
function createLeaf(root: string, relPath: string, value: unknown, requireExisting = false, replayReady = false): Promise<void> {
  return publishDowngradeEvidence({ root, relative: relPath, maxBytes: MAX_DOWNGRADE_PLAN_BYTES, replayReady }, value, requireExisting);
}

/** The parsed leaf at `relPath`, or null when absent; anything unreadable refuses. */
async function readLeaf(root: string, relPath: string): Promise<unknown> {
  const read = await readConfinedLeafBuffer(root, at(root, relPath), path.dirname(at(root, relPath)), MAX_DOWNGRADE_PLAN_BYTES, { requireSingleLink: true });
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new ScaleDowngradeError("scale_downgrade_partial", `${relPath} is not a readable journal leaf`);
  try { return JSON.parse(read.body.toString("utf8")) as unknown; } catch { throw new ScaleDowngradeError("scale_downgrade_partial", `${relPath} is not valid JSON`); }
}

/** The prior files of a journal leaf. */
function priorFiles(value: unknown, what: string): void {
  list(value, what, MAX_PRIORS, (entry, at) => { const prior = closed(entry, `${what}[${at}]`, ["relPath", "sha256", "identity"]); text(prior.relPath, "prior path", 1024); digest(prior.sha256, "prior sha256", true); identity(prior.identity, "prior identity", true); });
}

/** The staged units of a journal leaf (each with its staged identity). */
function stagedUnits(root: string, value: unknown, what: string): void {
  for (const entry of units(root, value, what, ["staged"])) identity((entry as unknown as Record<string, unknown>).staged, `${what} staged identity`, true);
}

/** Refuse unless `value` is one of `allowed`. */
function member(value: unknown, what: string, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new SchemaViolation(`${what} must be one of ${allowed.join(", ")}`);
}

/** The fields a cancel intent and its receipt share. */
function cancelOutcome(fields: Record<string, unknown>): void {
  member(fields.phase, "phase", ["fenced", "bootstrapped"]);
  count(fields.fenceRevision, "fenceRevision");
  if (fields.phase === "fenced" ? fields.cancelRevision !== (fields.fenceRevision as number) + 1 : fields.cancelRevision !== null) throw new SchemaViolation("cancelRevision does not match the phase");
  digest(fields.recordSha256, "recordSha256");
}

/** The closed body of each leaf format. */
const BODIES: Readonly<Record<string, (root: string, fields: Record<string, unknown>) => void>> = {
  [STAGE_FORMAT]: (root, fields) => { count(fields.attempt, "attempt"); stagedUnits(root, fields.units, "units"); priorFiles(fields.priors, "priors"); },
  [ARCHIVE_FORMAT]: (_root, fields) => { identity(fields.indexed, "indexed"); identity(fields.pins, "pins", true); },
  [RECEIPT_FORMAT]: (root, fields) => {
    text(fields.target, "target", 32); count(fields.fenceRevision, "fenceRevision");
    const archive = closed(fields.archive, "archive", ["indexed", "pins", "stores"]);
    identity(archive.indexed, "archive.indexed"); identity(archive.pins, "archive.pins", true); list(archive.stores, "archive.stores", MAX_LIST, (name) => text(name, "store", 64));
    list(fields.runs, "runs", MAX_LIST, (entry) => { const run = closed(entry, "run", ["runId", "status"]); if (!/^[0-9a-f]{12}$/.test(String(run.runId))) throw new SchemaViolation("a run id is malformed"); text(run.status, "run status", 32); });
    if (fields.lastRun !== null) text(fields.lastRun, "lastRun", 64);
    list(fields.pinLabels, "pinLabels", MAX_LIST, (label) => text(label, "pin label", 64));
    stagedUnits(root, fields.units, "units"); priorFiles(fields.priors, "priors");
  },
  [CANCEL_FORMAT]: (_root, fields) => { cancelOutcome(fields); priorFiles(fields.priors, "priors"); },
  [CANCEL_RECEIPT_FORMAT]: (_root, fields) => {
    cancelOutcome(fields); digest(fields.cancelIntentSha256, "cancelIntentSha256"); member(fields.estimate, "estimate", ["planned-kept", "unchanged"]);
    if (fields.laterRecord !== null) { const later = closed(fields.laterRecord, "laterRecord", ["revision", "architecture"]); count(later.revision, "laterRecord.revision"); text(later.architecture, "laterRecord.architecture", 32); }
  },
};

/** The keys of each leaf format beyond format, version and plan. */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  [STAGE_FORMAT]: ["attempt", "units", "priors"],
  [ARCHIVE_FORMAT]: ["indexed", "pins"],
  [RECEIPT_FORMAT]: ["target", "fenceRevision", "archive", "runs", "lastRun", "pinLabels", "units", "priors"],
  [CANCEL_FORMAT]: ["phase", "fenceRevision", "cancelRevision", "recordSha256", "priors"],
  [CANCEL_RECEIPT_FORMAT]: ["phase", "fenceRevision", "cancelRevision", "recordSha256", "cancelIntentSha256", "estimate", "laterRecord"],
};

/** Refuse unless `value` is a closed, valid journal leaf of `format` bound to `plan`. */
function checked<T>(root: string, value: unknown, format: string, plan: string, relPath: string): T {
  try {
    const fields = closed(value, relPath, ["format", "version", "plan", ...KEYS[format]!]);
    if (fields.format !== format || fields.version !== 1 || fields.plan !== plan) throw new SchemaViolation("it is not bound to this plan");
    BODIES[format]!(root, fields);
  } catch (error) {
    if (!(error instanceof SchemaViolation)) throw error;
    throw new ScaleDowngradeError("scale_downgrade_partial", `${relPath} is not this scale-down's journal leaf (${error.message})`);
  }
  return value as T;
}

/** Write the plan into the evidence directory, or confirm the one there is exactly it. */
export function recordPlan(root: string, dir: string, plan: DowngradePlanV1, requireExisting = false): Promise<void> {
  return createLeaf(root, path.posix.join(dir, "plan.json"), plan, requireExisting, true);
}

/** Sync the exact stage after the caller checks it against the plan. */
export function checkpointStage(root: string, dir: string, stage: StageManifestV1): Promise<void> {
  return createLeaf(root, path.posix.join(dir, `attempt-${stage.attempt}`, "stage.json"), stage, true);
}

/** Sync the exact archive evidence before relying on its existing identities. */
export function checkpointArchive(root: string, dir: string, archive: ArchiveLeafV1): Promise<void> {
  return createLeaf(root, path.posix.join(dir, ARCHIVE_LEAF), archive, true);
}

/** Sync a receipt after the caller has proved it binds its exact outcome. */
export function checkpointReceipt(root: string, dir: string, receipt: DowngradeReceiptV1): Promise<void> {
  return createLeaf(root, path.posix.join(dir, "receipt.json"), receipt, true);
}

/** Sync a cancel intent after its phase and prior-file proofs have been rechecked. */
export function checkpointCancelIntent(root: string, dir: string, cancel: CancelIntentV1): Promise<void> {
  return createLeaf(root, path.posix.join(dir, CANCEL_LEAF), cancel, true);
}

/** Sync a cancel receipt after the caller has proved its binding to the exact cancel intent. */
export function checkpointCancelReceipt(root: string, dir: string, receipt: CancelReceiptV1): Promise<void> {
  return createLeaf(root, path.posix.join(dir, CANCEL_RECEIPT_LEAF), receipt, true);
}

/** The attempt numbers present in `dir`, ascending. */
async function attemptsIn(root: string, dir: string): Promise<number[]> {
  const listing = await listConfinedDirBounded(root, dir, MAX_ATTEMPTS + 16);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") throw new ScaleDowngradeError("scale_downgrade_partial", `${dir} cannot be listed in full`);
  return listing.entries.map((entry) => /^attempt-(\d{1,4})$/.exec(entry.name)).filter((match) => match !== null).map((match) => Number(match![1])).sort((a, b) => a - b);
}

/** Require a bounded plan directory with only canonical attempts. */
async function preinstallAttempts(root: string, dir: string, attempt: number) {
  const listing = await listConfinedDirBounded(root, dir, MAX_ATTEMPTS + 1);
  const attemptNames = new Set(Array.from({ length: attempt }, (_, index) => `attempt-${index + 1}`));
  const valid = listing.kind === "ok" && listing.entries.some(({ name, kind }) => name === "plan.json" && kind === "file")
    && listing.entries.every(({ name, kind }) => name === "plan.json" || (kind === "directory" && attemptNames.has(name)));
  if (!valid) {
    throw new ScaleDowngradeError("scale_downgrade_partial", `${dir} is not an unambiguous pre-install stage directory`);
  }
  return listing.entries;
}

/** Reject any earlier attempt that has a published stage. */
async function assertOnlyStagePublication(root: string, dir: string, attempt: number): Promise<void> {
  const attemptName = `attempt-${attempt}`;
  const entries = await preinstallAttempts(root, dir, attempt);
  for (const { name } of entries) {
    if (name === "plan.json" || name === attemptName) continue;
    const leaf = path.posix.join(dir, name, "stage.json");
    if (await identityAt(root, leaf) !== null) throw new ScaleDowngradeError("scale_downgrade_partial", `${leaf} is another stage publication`);
  }
}

/** Recover the current stage only before any prior, installation or archive move. */
async function recoverLinkedStage(root: string, dir: string, attempt: number, plan: DowngradePlanV1): Promise<StageManifestV1> {
  if (attempt < 1 || attempt > MAX_ATTEMPTS || dir !== downgradeDir(plan, plan.inventory.record.revision + 1)) {
    throw new ScaleDowngradeError("scale_downgrade_partial", `${dir} does not name this plan's bounded stage attempt`);
  }
  const attemptName = `attempt-${attempt}`;
  await assertOnlyStagePublication(root, dir, attempt);
  const fields = await stageBeforeInstall(root, path.posix.join(dir, attemptName), plan);
  const manifest: StageManifestV1 = { format: STAGE_FORMAT, version: 1, plan: plan.digest, attempt, ...fields };
  await checkpointStage(root, dir, manifest);
  return manifest;
}

/** Select a strict manifest or fresh attempt. Only fenced apply supplies a bound plan for post-link recovery. */
export async function latestStage(root: string, dir: string, plan: string, boundPlan?: DowngradePlanV1): Promise<{ manifest: StageManifestV1 | null; nextAttempt: number }> {
  const attempts = await attemptsIn(root, dir);
  for (const attempt of [...attempts].reverse()) {
    const relPath = path.posix.join(dir, `attempt-${attempt}`, "stage.json");
    const value = await readLeaf(root, relPath).catch(async (error: unknown) => {
      if (boundPlan?.digest !== plan || attempt !== attempts.at(-1) || !(await mayHaveEvidenceAlias(root, relPath).catch(() => false))) throw error;
      return recoverLinkedStage(root, dir, attempt, boundPlan);
    });
    if (value !== null) return { manifest: checked<StageManifestV1>(root, value, STAGE_FORMAT, plan, relPath), nextAttempt: attempt + 1 };
  }
  const next = (attempts.at(-1) ?? 0) + 1;
  if (next > MAX_ATTEMPTS) throw new ScaleDowngradeError("scale_downgrade_partial", `${dir} already holds ${MAX_ATTEMPTS} staging attempts`);
  return { manifest: null, nextAttempt: next };
}

/** The staged path of `relPath` in attempt `attempt` of `dir`. */
export function stagedPath(dir: string, attempt: number, relPath: string): string {
  return path.posix.join(dir, `attempt-${attempt}`, "staged", relPath);
}

/** The prior path of `relPath` in `dir`. */
export function priorPath(dir: string, relPath: string): string {
  return path.posix.join(dir, "prior", relPath);
}

/** Record a complete attempt's stage manifest. */
export function recordStage(root: string, dir: string, manifest: Omit<StageManifestV1, "format" | "version">): Promise<void> {
  return createLeaf(root, path.posix.join(dir, `attempt-${manifest.attempt}`, "stage.json"), { format: STAGE_FORMAT, version: 1, ...manifest });
}

/** The archive leaf of `dir`, or null. */
export async function readArchiveLeaf(root: string, dir: string, plan: string): Promise<ArchiveLeafV1 | null> {
  const relPath = path.posix.join(dir, ARCHIVE_LEAF);
  const value = await readLeaf(root, relPath);
  return value === null ? null : checked<ArchiveLeafV1>(root, value, ARCHIVE_FORMAT, plan, relPath);
}

/** Record the identities about to be archived. */
export function recordArchiveLeaf(root: string, dir: string, leaf: Omit<ArchiveLeafV1, "format" | "version">): Promise<void> {
  return createLeaf(root, path.posix.join(dir, ARCHIVE_LEAF), { format: ARCHIVE_FORMAT, version: 1, ...leaf }, false, true);
}

/** The receipt of `dir`, or null. */
export async function readReceipt(root: string, dir: string, plan: string): Promise<DowngradeReceiptV1 | null> {
  const relPath = path.posix.join(dir, "receipt.json");
  const value = await readLeaf(root, relPath);
  return value === null ? null : checked<DowngradeReceiptV1>(root, value, RECEIPT_FORMAT, plan, relPath);
}

/** Record the receipt. */
export function recordReceipt(root: string, dir: string, receipt: Omit<DowngradeReceiptV1, "format" | "version">): Promise<void> {
  return createLeaf(root, path.posix.join(dir, "receipt.json"), { format: RECEIPT_FORMAT, version: 1, ...receipt }, false, true);
}

/**
 * The stage manifest of attempt `attempt` of `dir` exactly, or null when that
 * attempt has none. Its recorded attempt number must be the directory's.
 */
export async function readStageOf(root: string, dir: string, attempt: number, plan: string): Promise<StageManifestV1 | null> {
  const relPath = path.posix.join(dir, `attempt-${attempt}`, "stage.json");
  const value = await readLeaf(root, relPath);
  if (value === null) return null;
  const manifest = checked<StageManifestV1>(root, value, STAGE_FORMAT, plan, relPath);
  if (manifest.attempt !== attempt) throw new ScaleDowngradeError("scale_downgrade_partial", `${relPath} records attempt ${manifest.attempt}, not ${attempt}`);
  return manifest;
}

/** The cancel intent of `dir`, or null. */
export async function readCancelIntent(root: string, dir: string, plan: string): Promise<CancelIntentV1 | null> {
  const relPath = path.posix.join(dir, CANCEL_LEAF);
  const value = await readLeaf(root, relPath);
  return value === null ? null : checked<CancelIntentV1>(root, value, CANCEL_FORMAT, plan, relPath);
}

/** Durably create the cancel intent (refusing an existing one). */
export function recordCancelIntent(root: string, dir: string, intent: Omit<CancelIntentV1, "format" | "version">): Promise<void> {
  return createLeaf(root, path.posix.join(dir, CANCEL_LEAF), { format: CANCEL_FORMAT, version: 1, ...intent }, false, true);
}

/** The cancel receipt of `dir`, or null. */
export async function readCancelReceipt(root: string, dir: string, plan: string): Promise<CancelReceiptV1 | null> {
  const relPath = path.posix.join(dir, CANCEL_RECEIPT_LEAF);
  const value = await readLeaf(root, relPath);
  return value === null ? null : checked<CancelReceiptV1>(root, value, CANCEL_RECEIPT_FORMAT, plan, relPath);
}

/** Durably create the cancel receipt (refusing an existing one). */
export function recordCancelReceipt(root: string, dir: string, receipt: Omit<CancelReceiptV1, "format" | "version">): Promise<void> {
  return createLeaf(root, path.posix.join(dir, CANCEL_RECEIPT_LEAF), { format: CANCEL_RECEIPT_FORMAT, version: 1, ...receipt }, false, true);
}
