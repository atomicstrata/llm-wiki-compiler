/**
 * @file test/scale/downgrade-cancel-receipt-replay.test.ts
 * @description B2 receipt replay through the real public `cancelScaleDowngrade`
 * (real raw project lock and durable writers), on CONSTRUCTED states.
 *
 * The preimage is the plain B2 fixture of the completion witnesses: a
 * bootstrapped cancel intent bound to the plan, a moved-on `local-indexed`
 * record and the indexed directory in place. On top of it, each case plants
 * exactly what an interrupted receipt publication can leave: a `.writing`
 * scratch holding a prefix of the receipt (a process stop before the ready
 * link), the exact ready `.tmp` alone, or the published receipt with its
 * `.tmp` alias. A thrown fault cannot leave the writing-only state, since the
 * writer's catch removes it, so it is planted. The retry must keep the
 * positive never-fenced proof, re-derive the same later record, prove the
 * exact bytes, then complete. A receipt naming another later record, or any
 * other extra leaf, fails closed and keeps every name.
 *
 * Binding of a short prefix: once receipt scratch exists beside a moved-on
 * record, ordinary admission (`scale set`, with or without `--no-prepare`) and
 * same-plan apply refuse, so the record a B2 retry re-derives is the one the
 * interrupted attempt saw. A scratch begun under B1 (record still original,
 * `laterRecord: null`) can see exactly one advance; a complete such scratch is
 * then not a prefix of the B2 receipt and is kept. A shorter B1 scratch that
 * stops inside the prefix both serializations share, never ready or published,
 * yields a RECONSTRUCTED completion receipt naming the current, unchanged
 * later record; it is not a recovery of the stopped attempt's exact bytes.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the seam `test/portable/scale-first-open.test.ts` uses), so the real lock
 * publication, pid-checked release and storage code run without the native
 * kernel start-time probe or its `ps` fallback. Owner identity itself is not
 * exercised here.
 */

import { chmod, link, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { INDEXED_DIR } from "../../src/segments/contracts.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { applyScaleDowngrade, intentOf } from "../../src/scale/downgrade-apply.js";
import { assertNoDowngradeForScaleUpdate, downgradeNeedsRecovery } from "../../src/scale/downgrade-admission.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { fenceAndCancelRecords, plainProject, plant, plantLeaf, refusalCodeOf, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

/** Keeps a fixture project for removal after the test (the shared durable cleanup hook). */
const track = trackDurableCancelProjects();

/** The labelled own-PID owner seam (see the file comment), installed for every case. */
let ownerSeam: ReturnType<typeof spyOn<typeof lockOwner, "serializeOwner">> | undefined;
beforeEach(() => { ownerSeam = spyOn(lockOwner, "serializeOwner").mockImplementation((pid) => JSON.stringify({ pid })); });
afterEach(() => { ownerSeam?.mockRestore(); ownerSeam = undefined; });

const OFFLINE = { readersOffline: true };
const COMPLETED = ["cancel-receipt.json", "cancel.json", "intent.json", "plan.json"];

/** A later record as a receipt names it. */
type LaterRecord = { readonly revision: number; readonly architecture: string };

/** A B2 fixture: its project, the receipt path, and the exact receipt bytes naming `laterRecord` (the real later record by default). */
interface B2Fixture {
  readonly project: CancelProject;
  readonly receipt: string;
  readonly later: LaterRecord;
  receiptBytes(laterRecord?: LaterRecord | null): Buffer;
}

/** The plain B2 preimage: bootstrapped cancel intent, moved-on record, indexed directory in place. */
async function b2Fixture(): Promise<B2Fixture> {
  const project = track(await plainProject());
  const record = fenceAndCancelRecords(project.plan).cancel;
  await plant(project.root, SCALE_RECORD_FILE, serializeAnyScaleRecord(record));
  await mkdir(path.join(project.root, INDEXED_DIR), { recursive: true });
  const intent = intentOf(project.plan);
  const cancel = { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest, phase: "bootstrapped",
    fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] };
  const cancelSha = await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), cancel);
  const later = { revision: record.revision, architecture: record.active.architecture };
  const receiptBytes = (laterRecord: LaterRecord | null = later): Buffer => Buffer.from(`${JSON.stringify({ format: "llmwiki-scale-downgrade-cancel-receipt", version: 1,
    plan: cancel.plan, phase: cancel.phase, fenceRevision: cancel.fenceRevision, cancelRevision: null, recordSha256: cancel.recordSha256,
    cancelIntentSha256: cancelSha, estimate: "unchanged", laterRecord })}\n`);
  return { project, receipt: path.join(project.root, project.dir, "cancel-receipt.json"), later, receiptBytes };
}

/** Write `body` exclusively at `file` with the evidence mode. */
async function plantEvidence(file: string, body: Buffer): Promise<void> {
  await writeFile(file, body, { flag: "wx", mode: 0o600 });
  await chmod(file, 0o600);
}

/** The evidence listing and whether the bootstrap intent is still in place. */
async function stateOf(project: CancelProject): Promise<{ evidence: string[]; intentInPlace: boolean }> {
  const evidence = (await readdir(path.join(project.root, project.dir))).sort();
  return { evidence, intentInPlace: (await readdir(path.join(project.root, ".llmwiki"))).includes("scale-downgrade.json") };
}

/** Run the public cancel and require B2 completion with the exact receipt bytes on one link. */
async function expectCompleted(fixture: B2Fixture): Promise<void> {
  const result = await cancelScaleDowngrade(fixture.project.root, fixture.project.plan, OFFLINE);
  expect(result).toMatchObject({ phase: "bootstrapped", estimate: "unchanged", resumed: true, alreadyCancelled: false, laterRecord: fixture.later });
  expect(await readFile(fixture.receipt)).toEqual(fixture.receiptBytes());
  expect((await lstat(fixture.receipt)).nlink).toBe(1);
  expect(await stateOf(fixture.project)).toEqual({ evidence: COMPLETED, intentInPlace: false });
  expect(ownerSeam).toHaveBeenCalledWith(process.pid);
}

describe("B2 resumes its own interrupted receipt publication", () => {
  it.each([["empty", 0], ["partial", 0.5], ["complete", 1]])("replays a writing-only %s receipt prefix", async (_label, fraction) => {
    const fixture = await b2Fixture();
    const bytes = fixture.receiptBytes();
    await plantEvidence(`${fixture.receipt}.writing`, bytes.subarray(0, Math.floor(bytes.length * fraction)));
    await expectCompleted(fixture);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("publishes an exact ready receipt left without its writing name", async () => {
    const fixture = await b2Fixture();
    await plantEvidence(`${fixture.receipt}.tmp`, fixture.receiptBytes());
    const ino = (await lstat(`${fixture.receipt}.tmp`, { bigint: true })).ino;
    await expectCompleted(fixture);
    expect((await lstat(fixture.receipt, { bigint: true })).ino).toBe(ino);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("settles a published receipt's reserved alias on its original inode", async () => {
    const fixture = await b2Fixture();
    await plantEvidence(fixture.receipt, fixture.receiptBytes());
    await link(fixture.receipt, `${fixture.receipt}.tmp`);
    const ino = (await lstat(fixture.receipt, { bigint: true })).ino;
    await expectCompleted(fixture);
    expect((await lstat(fixture.receipt, { bigint: true })).ino).toBe(ino);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("B2 receipt replay fails closed on anything it cannot prove", () => {
  it("keeps a complete writing scratch that names another later record", async () => {
    const fixture = await b2Fixture();
    const stale = fixture.receiptBytes({ ...fixture.later, revision: fixture.later.revision - 1 });
    await plantEvidence(`${fixture.receipt}.writing`, stale);
    await expect(cancelScaleDowngrade(fixture.project.root, fixture.project.plan, OFFLINE)).rejects.toThrow("not a prefix");
    expect(await readFile(`${fixture.receipt}.writing`)).toEqual(stale);
    expect(await stateOf(fixture.project)).toEqual({ evidence: ["cancel-receipt.json.writing", "cancel.json", "plan.json"], intentInPlace: true });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("keeps a receipt and alias that name another later record", async () => {
    const fixture = await b2Fixture();
    const stale = fixture.receiptBytes({ ...fixture.later, revision: fixture.later.revision - 1 });
    await plantEvidence(fixture.receipt, stale);
    await link(fixture.receipt, `${fixture.receipt}.tmp`);
    await expect(cancelScaleDowngrade(fixture.project.root, fixture.project.plan, OFFLINE)).rejects.toThrow("do not match");
    expect(await readFile(fixture.receipt)).toEqual(stale);
    expect((await lstat(fixture.receipt)).nlink).toBe(2);
    expect((await stateOf(fixture.project)).intentInPlace).toBe(true);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("loses the never-fenced proof when any other leaf sits beside the receipt scratch", async () => {
    const fixture = await b2Fixture();
    await plantEvidence(`${fixture.receipt}.writing`, Buffer.alloc(0));
    await plant(fixture.project.root, path.posix.join(fixture.project.dir, "notes.txt"), "x");
    await expect(cancelScaleDowngrade(fixture.project.root, fixture.project.plan, OFFLINE)).rejects.toThrow("B3");
    expect(await stateOf(fixture.project)).toEqual({ evidence: ["cancel-receipt.json.writing", "cancel.json", "notes.txt", "plan.json"], intentInPlace: true });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("receipt scratch binds the later record a B2 retry re-derives", () => {
  it.each(["cancel-receipt.json.writing", "cancel-receipt.json.tmp"])("ordinary scale updates and same-plan apply refuse once %s exists", async (name) => {
    const fixture = await b2Fixture();
    const { root, plan, dir } = fixture.project;
    expect(await downgradeNeedsRecovery(root)).toBe(false);
    await plantEvidence(path.join(root, dir, name), Buffer.alloc(0));
    expect(await downgradeNeedsRecovery(root)).toBe(true);
    expect(await refusalCodeOf(assertNoDowngradeForScaleUpdate(root))).toBe("scale_downgrade_pending");
    expect(await refusalCodeOf(applyScaleDowngrade(root, plan, OFFLINE))).toBe("scale_downgrade_cancelled");
    expect((await stateOf(fixture.project)).evidence).toEqual([name, "cancel.json", "plan.json"].sort());
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("completes over an unpublished B1-origin prefix shared by both serializations, naming the current later record", async () => {
    const fixture = await b2Fixture();
    const [b1, b2] = [fixture.receiptBytes(null), fixture.receiptBytes()];
    const shared = b2.findIndex((byte, at) => byte !== b1[at]);
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(Math.min(b1.length, b2.length));
    await plantEvidence(`${fixture.receipt}.writing`, b1.subarray(0, shared));
    await expect(lstat(`${fixture.receipt}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.receipt)).rejects.toMatchObject({ code: "ENOENT" });
    const record = await readFile(path.join(fixture.project.root, SCALE_RECORD_FILE));
    await expectCompleted(fixture);
    expect(await readFile(path.join(fixture.project.root, SCALE_RECORD_FILE))).toEqual(record);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("keeps a complete B1-origin scratch after the one advance it allows", async () => {
    const fixture = await b2Fixture();
    const b1 = fixture.receiptBytes(null);
    await plantEvidence(`${fixture.receipt}.writing`, b1);
    await expect(cancelScaleDowngrade(fixture.project.root, fixture.project.plan, OFFLINE)).rejects.toThrow("not a prefix");
    expect(await readFile(`${fixture.receipt}.writing`)).toEqual(b1);
    expect((await stateOf(fixture.project)).intentInPlace).toBe(true);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
