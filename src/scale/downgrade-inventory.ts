/**
 * @file src/scale/downgrade-inventory.ts
 * @description The read-only INVENTORY of a scale-down: everything its plan
 * binds and every blocker, measured from the project as it is now.
 *
 * - The scale record (revision and exact bytes' SHA-256): the active layout
 *   must be larger than the target, with nothing pending or preparing.
 * - The NEW estimate, which must plan no larger than the target, and the
 *   MEASURED size from the files (`sources/` documents and bytes; `wiki/`
 *   generated files reported separately), which must too: a lowered estimate
 *   alone never authorizes a scale-down.
 * - From `local-indexed`: the indexed facts (`./downgrade-indexed-facts.ts`),
 *   every export unit measured by running the real export into a counting
 *   sink (`./downgrade-units.ts`: an unrepresentable one is a blocker), the
 *   prior file each unit replaces (by digest), and the notices.
 * - The content freeze of everything else (`./downgrade-freeze.ts`).
 * - From `local-indexed`: the evidence directories of COMPLETED cancels
 *   (`cancelled`, present only when there is one). A bootstrapped cancel
 *   writes no record, so without them an unchanged project would preview
 *   again to the very plan it cancelled, whose evidence directory is taken
 *   and which is never applied: a dead end. Binding them gives the new plan
 *   its own digest and directory, while the cancelled plan stays refused.
 *   An apply's own directory never holds a cancel receipt, so the apply's
 *   locked recomputation of its plan is unaffected.
 * Free space is measured separately ({@link spaceBlocker}): it moves on its
 * own, so it is checked at preview and apply but never bound into the plan.
 */

import path from "node:path";
import { CSTATE_CAPABILITY } from "../cstate/contracts.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { PREFLIGHT_HEADROOM_BYTES, SCALE_RECORD_FILE, ScaleRefusalError, type RequestedScaleV1, type ScaleRequest } from "./contracts.js";
import type { DowngradeTarget, LocalArchitectureV2, ScaleRecord } from "./contracts-v2.js";
import {
  DOWNGRADE_DIR, type DowngradeBlockerV1, type DowngradeFreezeV1, type DowngradeMeasuredV1, type DowngradeNoticeCode, type DowngradeRunV1, type DowngradeUnitV1,
} from "./downgrade-contracts.js";
import type { SinkFactory } from "./downgrade-export-history.js";
import { freezeContent, FreezeUnboundedError } from "./downgrade-freeze.js";
import { identityAt, leafDigest } from "./downgrade-fs.js";
import { indexedFacts, type IndexedFactsV1 } from "./downgrade-indexed-facts.js";
import { CANCEL_RECEIPT_LEAF } from "./downgrade-journal.js";
import { EVIDENCE_DIR_NAME } from "./downgrade-schema.js";
import { ExportSink } from "./downgrade-sink.js";
import { priorPathsOf, runExports } from "./downgrade-units.js";
import { needsTransitionV2, planScaleV2 } from "./plan-v2.js";
import { readScaleRecord } from "./record.js";
import type { PreflightIo } from "./steps.js";

/** What a scale-down was asked for. */
export interface DowngradeRequestV1 {
  readonly target: DowngradeTarget;
  /** The new expected scale; it must plan no larger than the target. */
  readonly request: ScaleRequest;
}

/** One prior file a unit replaces, by digest, or absent. */
export interface DowngradePriorV1 {
  readonly relPath: string;
  readonly sha256: string | null;
  readonly bytes: number;
}

/** Everything a scale-down plan binds. */
export interface DowngradeInventoryV1 {
  readonly from: LocalArchitectureV2;
  readonly target: DowngradeTarget;
  readonly record: { readonly revision: number; readonly sha256: string };
  readonly requested: RequestedScaleV1;
  readonly measured: DowngradeMeasuredV1;
  readonly freeze: DowngradeFreezeV1;
  readonly stores: IndexedFactsV1["stores"];
  readonly units: readonly DowngradeUnitV1[];
  readonly priors: readonly DowngradePriorV1[];
  readonly runs: readonly DowngradeRunV1[];
  readonly lastRun: string | null;
  readonly pins: IndexedFactsV1["pins"];
  readonly capabilities: readonly string[];
  readonly notices: readonly DowngradeNoticeCode[];
  readonly blockers: readonly DowngradeBlockerV1[];
  /** The evidence directories holding a cancel receipt, sorted; absent when there is none (see the file comment). */
  readonly cancelled?: readonly string[];
}

/** Most evidence directories read when binding completed cancels (the archive reader's own bound). */
const MAX_EVIDENCE_DIRS = 1_000;

/**
 * The evidence directories under {@link DOWNGRADE_DIR} that hold a cancel
 * receipt, sorted. Only names an evidence directory can have
 * ({@link EVIDENCE_DIR_NAME}, the plan schema's own rule) are probed; any
 * other entry is ignored, as the archive reader ignores it, so the list
 * never makes a ready plan that cannot parse. A root that exists but cannot
 * be listed in full is a blocker, never read as "no cancel".
 */
async function completedCancels(root: string): Promise<{ cancelled: string[]; blocker?: DowngradeBlockerV1 }> {
  const listing = await listConfinedDirBounded(root, DOWNGRADE_DIR, MAX_EVIDENCE_DIRS);
  if (listing.kind === "absent") return { cancelled: [] };
  if (listing.kind !== "ok") return { cancelled: [], blocker: { code: "inventory_unbounded", detail: `${DOWNGRADE_DIR} cannot be listed in full` } };
  const cancelled: string[] = [];
  for (const entry of listing.entries) {
    if (entry.kind !== "directory" || !EVIDENCE_DIR_NAME.test(entry.name)) continue;
    if ((await identityAt(root, path.posix.join(DOWNGRADE_DIR, entry.name, CANCEL_RECEIPT_LEAF))) !== null) cancelled.push(entry.name);
  }
  return { cancelled: cancelled.sort() };
}

/** No indexed facts (a scale-down from `local-large`). */
const NO_FACTS: IndexedFactsV1 = { stores: [], workspaces: [], runs: [], lastRun: null, pins: { labels: [], digest: "" }, blockers: [] };

/** A counting sink: measures, holds nothing. */
const counting: SinkFactory = (relPath, cap) => new ExportSink(relPath, cap);

/** The current record and its exact bytes' digest; an unreadable one refuses, an absent one is `local-standard`. */
async function boundRecord(root: string): Promise<{ record: ScaleRecord | null; revision: number; sha256: string }> {
  const read = await readScaleRecord(root);
  if (read.kind === "unreadable") throw new ScaleRefusalError("scale_state_unreadable", `${read.reason}; restore it by hand`);
  if (read.kind === "absent") return { record: null, revision: 0, sha256: "" };
  const digest = await leafDigest(root, SCALE_RECORD_FILE);
  if (digest.kind !== "ok") throw new ScaleRefusalError("scale_state_unreadable", `${SCALE_RECORD_FILE} cannot be read`);
  return { record: read.record, revision: read.record.revision, sha256: digest.sha256 };
}

/** Whether `plan` fits `target` (no larger than it, and not beyond the local envelope). */
function fits(planned: ReturnType<typeof planScaleV2>, target: DowngradeTarget): boolean {
  return planned.architecture !== "unavailable" && !needsTransitionV2(target, planned.architecture);
}

/** Whether `target` is a smaller layout than `from`. */
function lowerThan(target: DowngradeTarget, from: LocalArchitectureV2): boolean {
  return from === "local-indexed" || (from === "local-large" && target === "local-standard");
}

/** Whether `record` holds a capability still being prepared. */
function capabilityPreparing(record: ScaleRecord): boolean {
  return record.version !== 1 && (record.capabilities ?? []).some((capability) => capability.status === "preparing");
}

/** Blockers from the record alone: the active layout must be larger than the target, with nothing pending or preparing. */
function recordBlockers(record: ScaleRecord | null, target: DowngradeTarget): DowngradeBlockerV1[] {
  const blockers: DowngradeBlockerV1[] = [];
  const from = record?.active.architecture ?? "local-standard";
  if (!lowerThan(target, from)) blockers.push({ code: "target_not_lower", detail: `the active layout ${from} is not larger than ${target}` });
  if (record !== null && (record.pending !== null || capabilityPreparing(record))) blockers.push({ code: "transition_pending", detail: "a scale transition, capability preparation or unavailable estimate is recorded; settle it first (`llmwiki scale status`)" });
  return blockers;
}

/** Blockers from the record, the new estimate and the measured size. */
function scaleBlockers(record: ScaleRecord | null, target: DowngradeTarget, requested: ReturnType<typeof planScaleV2>, measured: DowngradeMeasuredV1): DowngradeBlockerV1[] {
  const blockers = recordBlockers(record, target);
  if (!fits(requested, target)) blockers.push({ code: "estimate_plans_higher", detail: `the new estimate plans ${requested.architecture}, larger than ${target}` });
  const actual = planScaleV2({ documents: Math.max(1, measured.sourceDocuments), sizeBytes: Math.max(1, measured.sourceBytes) });
  if (!fits(actual, target)) blockers.push({ code: "actual_exceeds_target", detail: `the measured ${measured.sourceDocuments} documents (${measured.sourceBytes} bytes) plan ${actual.architecture}, larger than ${target}` });
  return blockers;
}

/** The prior digest of each path; one that cannot be read whole is a blocker (it could not be retained exactly). */
async function priorsOf(root: string, relPaths: readonly string[]): Promise<{ priors: DowngradePriorV1[]; blockers: DowngradeBlockerV1[] }> {
  const priors: DowngradePriorV1[] = [];
  const blockers: DowngradeBlockerV1[] = [];
  for (const relPath of relPaths) {
    const digest = await leafDigest(root, relPath);
    if (digest.kind === "unavailable") blockers.push({ code: "content_unreadable", detail: `${relPath} is not a readable single-link regular file; it cannot be retained as a prior file` });
    priors.push(digest.kind === "ok" ? { relPath, sha256: digest.sha256, bytes: digest.bytes } : { relPath, sha256: null, bytes: 0 });
  }
  return { priors, blockers };
}

/** The notices of a scale-down from `from` to `target` with these facts. */
async function noticesOf(root: string, from: LocalArchitectureV2, target: DowngradeTarget, facts: IndexedFactsV1, units: readonly DowngradeUnitV1[], segmentedState: boolean): Promise<DowngradeNoticeCode[]> {
  const binary = units.find((unit) => unit.kind === "vectors")?.present ?? (await identityAt(root, ".llmwiki/embeddings.bin")) !== null;
  if (from === "local-large") return ["selection_only", ...(binary ? ["embeddings_binary" as const] : [])];
  const vectors: DowngradeNoticeCode[] = binary ? ["precision_float32", ...(target === "local-standard" ? ["embeddings_binary" as const] : [])] : [];
  return ["catalog_archived", "indexed_backups_unrestorable", ...vectors, ...archivedNotices(facts, segmentedState)];
}

/** The notices of what an indexed scale-down archives or stops serving. */
function archivedNotices(facts: IndexedFactsV1, segmentedState: boolean): DowngradeNoticeCode[] {
  const notices: DowngradeNoticeCode[] = [];
  if (facts.runs.length > 0) notices.push("run_reports_archived");
  if (facts.pins.labels.length > 0) notices.push("pins_archived");
  if (segmentedState) notices.push("batch_compile_unavailable");
  return notices;
}

/** The units, priors and indexed facts of an indexed project (none for any other). */
async function indexedPart(root: string, record: ScaleRecord | null) {
  if (record?.active.architecture !== "local-indexed") return { facts: NO_FACTS, units: [] as DowngradeUnitV1[], priors: [] as DowngradePriorV1[], blockers: [] as DowngradeBlockerV1[], segmentedState: false };
  const facts = await indexedFacts(root);
  const segmentedState = record.version !== 1 && (record.capabilities ?? []).some((capability) => capability.name === CSTATE_CAPABILITY && capability.status === "ready");
  const exported = await runExports(root, { workspaces: facts.workspaces, segmentedState }, counting);
  const priors = await priorsOf(root, priorPathsOf(exported.units));
  return { facts, units: exported.units, priors: priors.priors, blockers: [...exported.blockers, ...priors.blockers], segmentedState };
}

/** The content freeze, or an unbounded-inventory blocker. */
async function freezeOrBlocker(root: string, excluded: ReadonlySet<string>): Promise<{ freeze: DowngradeFreezeV1; measured: DowngradeMeasuredV1; blocker?: DowngradeBlockerV1 }> {
  try { return await freezeContent(root, excluded); } catch (error) {
    if (!(error instanceof FreezeUnboundedError)) throw error;
    const zero = { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 };
    return { freeze: { entries: 0, bytes: 0, digest: "" }, measured: zero, blocker: { code: error.code, detail: error.message } };
  }
}

/** Refuse a scale-down target other than the two smaller layouts (a public boundary: the SDK forwards caller input). */
export function checkedTarget(target: unknown): DowngradeTarget {
  if (target === "local-standard" || target === "local-large") return target;
  throw new ScaleRefusalError("scale_invalid_request", "the scale-down target must be local-standard or local-large");
}

/** Inventory the project at `root` for `input`. Read-only; an invalid target or estimate refuses as `scale set` does, before any read. */
export async function inventoryDowngrade(root: string, input: DowngradeRequestV1): Promise<DowngradeInventoryV1> {
  checkedTarget(input.target);
  const requested = planScaleV2(input.request);
  const bound = await boundRecord(root);
  const part = await indexedPart(root, bound.record);
  const { freeze, measured, blocker } = await freezeOrBlocker(root, new Set(part.priors.map((prior) => prior.relPath)));
  const from = bound.record?.active.architecture ?? "local-standard";
  const cancels: Awaited<ReturnType<typeof completedCancels>> = from === "local-indexed" ? await completedCancels(root) : { cancelled: [] };
  const extra = [blocker, cancels.blocker].filter((entry): entry is DowngradeBlockerV1 => entry !== undefined);
  const blockers = [...scaleBlockers(bound.record, input.target, requested, measured), ...part.facts.blockers, ...part.blockers, ...extra];
  return {
    ...(cancels.cancelled.length > 0 ? { cancelled: cancels.cancelled } : {}),
    from, target: input.target, record: { revision: bound.revision, sha256: bound.sha256 }, requested: requested.requested, measured, freeze,
    stores: part.facts.stores, units: part.units, priors: part.priors, runs: part.facts.runs, lastRun: part.facts.lastRun, pins: part.facts.pins,
    capabilities: bound.record !== null && bound.record.version !== 1 ? (bound.record.capabilities ?? []).map((capability) => capability.name) : [],
    notices: await noticesOf(root, from, input.target, part.facts, part.units, part.segmentedState), blockers,
  };
}

/** The free-space blocker for `inventory`: the exported bytes plus the fixed headroom must fit (a record-only scale-down stages nothing). */
export async function spaceBlocker(inventory: DowngradeInventoryV1, io: PreflightIo): Promise<DowngradeBlockerV1 | null> {
  if (inventory.units.length === 0) return null;
  const needed = inventory.units.reduce((sum, unit) => sum + unit.bytes, 0) + PREFLIGHT_HEADROOM_BYTES;
  const free = await io.freeBytes();
  return free >= needed ? null : { code: "insufficient_space", detail: `${free} bytes free, ${needed} needed (the staged exports plus ${PREFLIGHT_HEADROOM_BYTES} bytes of headroom)` };
}
