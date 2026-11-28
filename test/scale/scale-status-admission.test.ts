/**
 * @file test/scale/scale-status-admission.test.ts
 * @description Disk `scale status` reports the admission the gate observes
 * from ONE confined record read (SCALE-2), and the transition preview uses
 * that same observation (S1-REVIEW-1).
 *
 * BLOCKED OBSERVATIONS (synthetic records and leaves in private roots, no
 * lock, no writes): a terminal V1 activation whose downgrade intent is still
 * live reports `downgrading` with the same-plan reason; an orphan indexed
 * directory with no record reports `unreadable` (missing authority) with null
 * record and plan; a valid ready indexed record beside a recognized PREFLIGHT
 * restore marker (fixed token, schema-valid owner, outside any restore scope,
 * so no owner liveness probe runs) reports `restoring` with the wait/resume
 * reason. Each keeps the exact record and plan the record-only seam
 * (`scaleStatusFrom(io)`) decodes, changes no file, and returns to the
 * record-derived report once the fixture removes the intent or marker. The
 * production SDK facade reports the same.
 *
 * CONTROLS: a clean root, an unreadable record (its own bounded fault), and
 * ready, preparing, parked, unavailable, replan-available and pending indexed
 * records report exactly what the record-only seam reports.
 *
 * PREVIEW: its `current` carries the same admission (`restoring`), and an
 * unreadable record beside a live intent refuses `scale_downgrade_pending`
 * first, exactly as `scale set` does under its raw lock.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the `test/portable/scale-first-open.test.ts` seam) for the raw lock of the
 * `scale set` parity case; no native start-time probe runs.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecord, type ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { activationRecord, fenceRecord } from "../../src/scale/downgrade-records.js";
import { nextRecord } from "../../src/scale/next-record.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { parseSizeBytes, planScale } from "../../src/scale/plan.js";
import { previewScaleTransition } from "../../src/scale/preview.js";
import { diskScaleRecordIo } from "../../src/scale/record.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { scaleStatus, scaleStatusFrom, setExpectedScale } from "../../src/scale/transition.js";
import { buildScaleFacade } from "../../src/sdk/scale-facade.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { ownPidOwnerSeamPerTest, privateRoots } from "../fixtures/scoped-test-roots.js";
import { emptyDowngradePlan, entryStates } from "./fixtures/admission-fixtures.js";

const INTENT = ".llmwiki/scale-downgrade.json";
const MARKER = ".llmwiki/indexed-restore.json";
const AMPLE = { freeBytes: async () => Number.MAX_SAFE_INTEGER };
const requested = { documents: 100, sizeBytes: 102400, documentsBasis: "stated", sizeBasis: "stated" } as const;
const indexedReady: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 7, requested, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };
const { privateDir, cleanup } = privateRoots("llmwiki-scale-status-");

ownPidOwnerSeamPerTest();
afterAll(cleanup);

/** A new private project root with its private directory. */
async function privateRoot(): Promise<string> {
  const root = await privateDir();
  await mkdir(path.join(root, ".llmwiki"));
  return root;
}

/** Write `record` as the project's scale record (no scale API). */
async function put(root: string, record: ScaleRecord): Promise<void> {
  await writeFile(path.join(root, SCALE_RECORD_FILE), serializeAnyScaleRecord(record));
}

/** A terminal V1 activation of a valid plan whose downgrade intent is still live (as an interrupted retirement leaves it). */
async function terminalActivation(): Promise<string> {
  const root = await privateRoot();
  const originalSha = createHash("sha256").update(serializeAnyScaleRecord(indexedReady)).digest("hex");
  const { plan, dir } = emptyDowngradePlan(root, "local-standard", originalSha, requested);
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, dir, "plan.json"), JSON.stringify(plan));
  await writeFile(path.join(root, INTENT), JSON.stringify({ format: "llmwiki-scale-downgrade-intent", version: 1, plan: plan.digest, target: "local-standard", originalRevision: 7, originalRecordSha256: originalSha, fenceRevision: 8, dir }));
  await put(root, activationRecord(fenceRecord(indexedReady, requested, "local-standard", plan.digest), requested, "local-standard"));
  return root;
}

/** A recognized PREFLIGHT restore marker of another (absent) restore: fixed token, schema-valid owner, opaque journal. */
function preflightMarker(): string {
  return JSON.stringify({ format: "llmwiki-indexed-restore-marker", version: 1, token: "a".repeat(32), backupDigest: "b".repeat(64), phase: "preflight", owner: { pid: 1 }, journal: {} });
}

/** Inode and bytes of every file, and every entry, under `root`. */
function projectState(root: string): Promise<Record<string, string>> {
  return entryStates(root, async (file, info) => (info.isFile() ? `${info.ino}:${createHash("sha256").update(await readFile(file)).digest("hex")}` : "entry"));
}

/** Require the disk status (and the SDK's) to report `readiness` with `reason`, the seam's exact record and plan, and no file change. */
async function expectAdmission(root: string, readiness: string, reason: string): Promise<void> {
  const before = await projectState(root);
  const seam = await scaleStatusFrom(diskScaleRecordIo(root));
  const report = await scaleStatus(root);
  expect(report).toMatchObject({ readiness, record: seam.record, plan: seam.plan, superseded: false });
  expect(report.reason).toContain(reason);
  expect(await buildScaleFacade(root, (fn) => fn()).status()).toEqual(report);
  expect(await projectState(root)).toEqual(before);
}

describe("disk status reports the admission the gate observes", () => {
  it("a terminal V1 activation with its live intent is downgrading until the intent is retired", async () => {
    const root = await terminalActivation();
    await expectAdmission(root, "downgrading", "scale downgrade --apply");
    await rm(path.join(root, INTENT));
    expect(await scaleStatus(root)).toEqual(await scaleStatusFrom(diskScaleRecordIo(root)));
  });

  it("an orphan indexed directory with no record is unreadable, with no record or plan", async () => {
    const root = await privateRoot();
    await mkdir(path.join(root, ".llmwiki", "indexed"));
    await writeFile(path.join(root, ".llmwiki", "indexed", "sentinel"), "kept");
    await expectAdmission(root, "unreadable", "the scale record is missing");
    expect(await scaleStatus(root)).toMatchObject({ record: null, plan: null });
  });

  it("a foreign preflight restore marker is restoring with the readable record until it is gone", async () => {
    const root = await privateRoot();
    await put(root, indexedReady);
    await writeFile(path.join(root, MARKER), preflightMarker());
    await expectAdmission(root, "restoring", "indexed-authority restore");
    await rm(path.join(root, MARKER));
    expect(await scaleStatus(root)).toMatchObject({ readiness: "ready", record: indexedReady });
  });
});

describe("record-derived status is unchanged without an admission block", () => {
  it("a clean root is unconfigured and an unreadable record keeps its own bounded fault", async () => {
    const root = await privateRoot();
    expect(await scaleStatus(root)).toMatchObject({ readiness: "unconfigured", record: null });
    await writeFile(path.join(root, SCALE_RECORD_FILE), "{ not a record");
    expect(await scaleStatus(root)).toEqual(await scaleStatusFrom(diskScaleRecordIo(root)));
  });

  it("ready, preparing, parked, unavailable, replan-available and pending indexed records match the record-only seam", async () => {
    const pending = nextRecord(null, planScaleV2({ documents: 2_000 }));
    const parked = { ...pending, pending: { ...pending.pending, steps: [{ name: "capacity-preflight", status: "parked", detail: "no space" }, { name: "embedding-container", status: "pending" }] } };
    const replan = { version: 1, revision: 1, requested: planScale({ documents: 5_000 }).requested, active: { architecture: "local-standard", sinceRevision: 1 },
      pending: { kind: "unavailable", revision: 1, exceeds: ["documents", "bytes"], missing: ["segmented-relation-store", "segmented-event-store", "sharded-vector-store", "durable-paged-catalog", "durable-hosted-backend"] } };
    const records = [nextRecord(null, planScaleV2({ documents: 100 })), pending, parked, nextRecord(null, planScaleV2({ sizeBytes: parseSizeBytes("2TB") })), replan, nextRecord(null, planScaleV2({ documents: 8_000 }))];
    const readiness: string[] = [];
    for (const record of records) {
      const root = await privateRoot();
      await put(root, record as ScaleRecord);
      const report = await scaleStatus(root);
      expect(report).toEqual(await scaleStatusFrom(diskScaleRecordIo(root)));
      readiness.push(report.readiness);
    }
    expect(readiness).toEqual(["ready", "preparing", "parked", "unavailable", "unavailable", "preparing"]);
  });
});

describe("the preview shares the observation and the set's refusal order", () => {
  it("reports a foreign restore in its current status", async () => {
    const root = await privateRoot();
    await put(root, indexedReady);
    await writeFile(path.join(root, MARKER), preflightMarker());
    const preview = await previewScaleTransition(root, { documents: 100 }, [], AMPLE);
    expect([preview.current.readiness, preview.current.record]).toEqual(["restoring", indexedReady]);
  });

  it("refuses an unreadable record beside a live intent as the downgrade first, like set", async () => {
    const root = await terminalActivation();
    await writeFile(path.join(root, SCALE_RECORD_FILE), "{ not a record");
    const code = (work: Promise<unknown>) => work.then(() => "resolved", (error: { code?: string }) => error.code ?? String(error));
    expect(await code(previewScaleTransition(root, { documents: 100 }, [], AMPLE))).toBe("scale_downgrade_pending");
    expect(await code(setExpectedScale(root, { request: { documents: 100 } }))).toBe("scale_downgrade_pending");
    expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  });
});
