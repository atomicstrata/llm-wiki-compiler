/**
 * @file test/scale/downgrade-cancel-completion.test.ts
 * @description Raw-lock completion rows of the pre-install cancel through the
 * real public `cancelScaleDowngrade` (real project lock, real durable writers
 * for everything the cancel itself writes), on CONSTRUCTED states.
 *
 * The preimages are SYNTHETIC: the plan, the bootstrap intent, the scale
 * record, the cancel intent and any receipt are planted plainly by the test,
 * each bound to the plan exactly as a real run would leave it. They stand for
 * an already-written record; nothing here runs, or qualifies, the fenced
 * compare-and-swap, a crash or power loss (the real indexed fenced tests stay
 * pending).
 *
 * Witnessed rows: F2 (a fenced cancel intent and exactly the expected cancel
 * record) resumes, writes the bound receipt and retires the intent, and a
 * second call is the F6 replay of that product-written state; F5 (a bound
 * receipt with the intent still in place) resumes WITHOUT writing a receipt;
 * B2 (a bootstrapped cancel intent and a moved-on record with the indexed
 * stores in place) completes and reports the later record. In each, the scale
 * record's bytes are unchanged and the evidence is kept.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { INDEXED_DIR } from "../../src/segments/contracts.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { intentOf } from "../../src/scale/downgrade-apply.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { fenceAndCancelRecords, plainProject, plant, plantLeaf, sha256, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

/** The bootstrap intent's own leaf, which a completed cancel retires into the evidence directory. */
const INTENT_LEAF = ".llmwiki/scale-downgrade.json";

/** Keeps a fixture project for removal after the test (the shared durable cleanup hook). */
const track = trackDurableCancelProjects();

/** A plain project (bootstrap intent in place) whose scale record is this plan's cancel record; returns it and the record's text. */
async function withCancelRecord(): Promise<{ project: CancelProject; recordText: string }> {
  const project = track(await plainProject());
  const recordText = serializeAnyScaleRecord(fenceAndCancelRecords(project.plan).cancel);
  await plant(project.root, SCALE_RECORD_FILE, recordText);
  return { project, recordText };
}

/** A SYNTHETIC cancel intent of `phase`, bound to the plan: fenced commits to the cancel record, bootstrapped to the original. */
function cancelIntent(project: CancelProject, phase: "fenced" | "bootstrapped", cancelRecordSha: string) {
  const intent = intentOf(project.plan);
  const fenced = phase === "fenced";
  const priors = fenced ? project.plan.inventory.priors.map((prior) => ({ relPath: prior.relPath, sha256: prior.sha256, identity: null })) : [];
  return { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest, phase, fenceRevision: intent.fenceRevision,
    cancelRevision: fenced ? intent.fenceRevision + 1 : null, recordSha256: fenced ? cancelRecordSha : intent.originalRecordSha256, priors };
}

/** The scale record text and the evidence directory listing of `project`. */
async function stateOf(project: CancelProject): Promise<{ record: string; evidence: string[]; intentInPlace: boolean }> {
  const record = await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8");
  const evidence = (await readdir(path.join(project.root, project.dir))).sort();
  return { record, evidence, intentInPlace: (await readdir(path.join(project.root, ".llmwiki"))).includes(path.basename(INTENT_LEAF)) };
}

const COMPLETED = ["cancel-receipt.json", "cancel.json", "intent.json", "plan.json"];
const OFFLINE = { readersOffline: true };

describe("fenced completion rows under the raw lock", () => {
  it("F2 resumes, writes the receipt and retires the intent; a second call is the F6 replay", async () => {
    const { project, recordText } = await withCancelRecord();
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), cancelIntent(project, "fenced", sha256(recordText)));
    const resumed = await cancelScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(resumed).toMatchObject({ phase: "fenced", estimate: "planned-kept", resumed: true, alreadyCancelled: false, laterRecord: null });
    expect(await stateOf(project)).toEqual({ record: recordText, evidence: COMPLETED, intentInPlace: false });
    const receipt = await readFile(path.join(project.root, project.dir, "cancel-receipt.json"), "utf8");
    const replay = await cancelScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(replay).toMatchObject({ phase: "fenced", resumed: false, alreadyCancelled: true, laterRecord: null });
    expect(await readFile(path.join(project.root, project.dir, "cancel-receipt.json"), "utf8")).toBe(receipt);
    expect(await stateOf(project)).toEqual({ record: recordText, evidence: COMPLETED, intentInPlace: false });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("F5 resumes without writing a receipt: the bound one is kept byte for byte and the intent retired", async () => {
    const { project, recordText } = await withCancelRecord();
    const intent = intentOf(project.plan);
    const cancel = cancelIntent(project, "fenced", sha256(recordText));
    const cancelSha = await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), cancel);
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel-receipt.json"), { format: "llmwiki-scale-downgrade-cancel-receipt", version: 1, plan: project.plan.digest,
      phase: "fenced", fenceRevision: intent.fenceRevision, cancelRevision: cancel.cancelRevision, recordSha256: cancel.recordSha256, cancelIntentSha256: cancelSha, estimate: "planned-kept", laterRecord: null });
    const receipt = await readFile(path.join(project.root, project.dir, "cancel-receipt.json"), "utf8");
    const resumed = await cancelScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(resumed).toMatchObject({ phase: "fenced", resumed: true, alreadyCancelled: false, laterRecord: null });
    expect(await readFile(path.join(project.root, project.dir, "cancel-receipt.json"), "utf8")).toBe(receipt);
    expect(await stateOf(project)).toEqual({ record: recordText, evidence: COMPLETED, intentInPlace: false });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("a bootstrapped completion row under the raw lock", () => {
  it("B2 completes over a moved-on record with the indexed stores in place and reports that later record", async () => {
    const { project, recordText } = await withCancelRecord();
    await mkdir(path.join(project.root, INDEXED_DIR), { recursive: true });
    await plantLeaf(project.root, path.posix.join(project.dir, "cancel.json"), cancelIntent(project, "bootstrapped", ""));
    const later = fenceAndCancelRecords(project.plan).cancel;
    const resumed = await cancelScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(resumed).toMatchObject({ phase: "bootstrapped", estimate: "unchanged", resumed: true, alreadyCancelled: false,
      laterRecord: { revision: later.revision, architecture: later.active.architecture } });
    expect(await stateOf(project)).toEqual({ record: recordText, evidence: COMPLETED, intentInPlace: false });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
