/**
 * @file test/scale/cancel-helpers.ts
 * @description Fixtures for the pre-install cancel witnesses.
 *
 * Every fixture project is a private temporary directory holding a VALID
 * parsed `local-indexed` scale record (version 2, nothing pending) whose
 * estimate is visibly LARGER than the strictly valid scale-down plan built
 * from it (one `events` unit at its incumbent path). No indexed store is built
 * and no child process runs.
 *
 * Two kinds, kept apart on purpose:
 * - `cancelProject` writes the plan leaf and the bootstrap intent with the
 *   product's own DURABLE writers (fsync). Witnesses using it, and every
 *   witness whose code under test writes, are DURABLE: they need the
 *   quiet-storage admission.
 * - `plainProject` writes every leaf with a plain `writeFile` (no fsync) and
 *   is for witnesses whose code under test only READS (observer, binding,
 *   evidence listing).
 * Each project removes itself; callers own and call `remove()`.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDowngradeIntent } from "../../src/segments/downgrade-access.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import type { RequestedScaleV1 } from "../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { intentOf } from "../../src/scale/downgrade-apply.js";
import { DOWNGRADE_INTENT_FILE } from "../../src/scale/downgrade-contracts.js";
import { recordPlan } from "../../src/scale/downgrade-journal.js";
import { buildDowngradePlan, type DowngradePlanV1 } from "../../src/scale/downgrade-plan.js";
import type { DowngradeInventoryV1 } from "../../src/scale/downgrade-inventory.js";
import { fenceRecord } from "../../src/scale/downgrade-records.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { EVENTS_FILE } from "../../src/utils/constants.js";

/**
 * The estimate the product's own planner records for a stated document count,
 * refusing unless it plans `architecture` (a recorded estimate must be its own
 * derivation). The counts are the ones the existing indexed fixtures use: in
 * `local-v2` an estimate plans `local-indexed` only beyond the local maximum.
 */
function derivedEstimate(architecture: string, documents: number): RequestedScaleV1 {
  const plan = planScaleV2({ documents });
  if (plan.architecture !== architecture) throw new Error(`${documents} documents plan ${plan.architecture}, not ${architecture}`);
  return plan.requested;
}

/** The estimate on the original record (it plans local-indexed), and the smaller one the plan asks for (it plans local-standard): visibly different. */
export const ORIGINAL_ESTIMATE = derivedEstimate("local-indexed", 8_000);
export const PLANNED_ESTIMATE = derivedEstimate("local-standard", 100);
/** Another estimate that also plans local-standard: a coherent fence estimate that is not this plan's. */
export const OTHER_SMALL_ESTIMATE = derivedEstimate("local-standard", 200);
/** A fixed digest standing in for the staged events export, and for a present prior when asked. */
const EVENTS_SHA = "a".repeat(64);
const PRESENT_PRIOR_SHA = "e".repeat(64);

/** The original `local-indexed` record of every fixture: revision 2, nothing pending. */
const ORIGINAL_RECORD: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 2, requested: ORIGINAL_ESTIMATE, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };

/** The refusal code of one awaited call, or "accepted" (shared by the cancel witnesses). */
export function refusalCodeOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));
}

/** SHA-256 of a text's UTF-8 bytes. */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** One fixture project. */
export interface CancelProject {
  readonly root: string;
  readonly plan: DowngradePlanV1;
  /** The evidence directory of the plan's intent. */
  readonly dir: string;
  remove(): Promise<void>;
}

/** A strictly valid indexed inventory over the record with `recordSha256`; `presentPrior` gives the events prior a digest. */
function inventoryFor(recordSha256: string, presentPrior: boolean): DowngradeInventoryV1 {
  return {
    from: "local-indexed", target: "local-standard", record: { revision: 2, sha256: recordSha256 }, requested: PLANNED_ESTIMATE,
    measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 }, freeze: { entries: 0, bytes: 0, digest: "" },
    stores: [], units: [{ kind: "events", relPath: EVENTS_FILE, present: true, bytes: 12, sha256: EVENTS_SHA, records: 1 }],
    priors: [{ relPath: EVENTS_FILE, sha256: presentPrior ? PRESENT_PRIOR_SHA : null, bytes: presentPrior ? 5 : 0 }, { relPath: ".llmwiki/embeddings.json", sha256: null, bytes: 0 }],
    runs: [], lastRun: null, pins: { labels: [], digest: "" }, capabilities: [], notices: [], blockers: [],
  };
}

/** Write `text` at `relPath` under `root` with a plain write (no fsync), creating its parents. */
export async function plant(root: string, relPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relPath)), { recursive: true });
  await writeFile(path.join(root, relPath), text);
}

/** A project with the original record (or `recordText`) and its plan; nothing else. */
async function baseProject(options: { recordText?: string; presentPrior?: boolean }): Promise<CancelProject> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-cancel-")));
  const recordText = options.recordText ?? serializeAnyScaleRecord(ORIGINAL_RECORD);
  await plant(root, SCALE_RECORD_FILE, recordText);
  const plan = buildDowngradePlan(root, inventoryFor(sha256(recordText), options.presentPrior === true));
  return { root, plan, dir: intentOf(plan).dir, remove: () => rm(root, { recursive: true, force: true }) };
}

/** DURABLE fixture: `bootstrapped` writes the plan leaf and intent with the product's durable writers, as an interrupted apply leaves them. */
export async function cancelProject(options: { bootstrapped?: boolean } = {}): Promise<CancelProject> {
  const project = await baseProject({});
  if (options.bootstrapped === true) {
    await recordPlan(project.root, project.dir, project.plan);
    await createDowngradeIntent(project.root, intentOf(project.plan));
  }
  return project;
}

/** PLAIN fixture (no fsync): the plan leaf and the bootstrap intent written plainly; `recordText` replaces the original record's bytes. */
export async function plainProject(options: { recordText?: string; presentPrior?: boolean; intent?: boolean } = {}): Promise<CancelProject> {
  const project = await baseProject(options);
  await plant(project.root, path.posix.join(project.dir, "plan.json"), `${JSON.stringify(project.plan)}\n`);
  if (options.intent !== false) await plant(project.root, DOWNGRADE_INTENT_FILE, `${JSON.stringify(intentOf(project.plan))}\n`);
  return project;
}

/** This plan's fence over the original record, and the record a fenced cancel writes over it. */
export function fenceAndCancelRecords(plan: DowngradePlanV1): { fence: ScaleRecordV2; cancel: ScaleRecordV2 } {
  const fence = fenceRecord(ORIGINAL_RECORD, plan.inventory.requested, plan.inventory.target, plan.digest);
  return { fence, cancel: { ...fence, revision: fence.revision + 1, pending: null } };
}

/** Write `value` as a journal-style leaf (`JSON + newline`) at `relPath`, plainly; returns the SHA-256 of the exact bytes. */
export async function plantLeaf(root: string, relPath: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value)}\n`;
  await plant(root, relPath, text);
  return sha256(text);
}

/** A retirement barrier for `planDigest` owned by a process that does not exist (so it is stale). */
export function staleBarrier(planDigest: string): string {
  const host = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
  return `${JSON.stringify({ format: "llmwiki-indexed-retire-barrier", version: 1, token: "0".repeat(32), planDigest, host, owner: { pid: 999_999 } })}\n`;
}

/** Plant a COMPLETED bootstrapped cancel on `project`: cancel intent, bound receipt and the retired intent (in that order); returns `project`. */
export async function plantCompletedCancel(project: CancelProject): Promise<CancelProject> {
  const intent = intentOf(project.plan);
  const cancelSha = await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest,
    phase: "bootstrapped", fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] });
  await plantLeaf(project.root, path.posix.join(project.dir, "cancel-receipt.json"), { format: "llmwiki-scale-downgrade-cancel-receipt", version: 1, plan: project.plan.digest,
    phase: "bootstrapped", fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, cancelIntentSha256: cancelSha, estimate: "unchanged", laterRecord: null });
  await plantLeaf(project.root, path.posix.join(project.dir, "intent.json"), intent);
  return project;
}
