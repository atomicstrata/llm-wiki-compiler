/**
 * @file Exercise ordinary admission against synthetic scale records and retained intent.
 * Uses real confined reads, with no lock acquisition or downgrade execution.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexedActive } from "../../src/indexed/routing.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecord, type ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { assertNoDowngradeForScaleUpdate, downgradeNeedsRecovery } from "../../src/scale/downgrade-admission.js";
import { scaleGateRefusal } from "../../src/scale/gate.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { activationRecord, fenceRecord } from "../../src/scale/downgrade-records.js";
import { emptyDowngradePlan } from "./fixtures/admission-fixtures.js";

const requested = { documents: 100, sizeBytes: 102400, documentsBasis: "stated", sizeBasis: "stated" } as const;
const original: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 7, requested, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };
const target = "local-standard";
const intentPath = ".llmwiki/scale-downgrade.json";
const originalSha = createHash("sha256").update(serializeAnyScaleRecord(original)).digest("hex");
let root: string | undefined;

/** Create a new in-scratch project and a valid plan bound to its exact original record. */
async function fixture() {
  const project = await mkdtemp(path.join(await realpath(tmpdir()), "terminal-admission-"));
  root = project;
  const { plan, dir } = emptyDowngradePlan(project, target, originalSha, requested);
  const intent = { format: "llmwiki-scale-downgrade-intent", version: 1, plan: plan.digest, target, originalRevision: 7, originalRecordSha256: originalSha, fenceRevision: 8, dir };
  await mkdir(path.join(project, dir), { recursive: true });
  await mkdir(path.join(project, ".llmwiki/indexed"));
  await writeFile(path.join(project, dir, "plan.json"), JSON.stringify(plan));
  await writeFile(path.join(project, intentPath), JSON.stringify(intent));
  const fence = fenceRecord(original, requested, target, plan.digest);
  return { project, dir, plan, fence, activation: activationRecord(fence, requested, target), ready: { ...fence, revision: 9, pending: null } };
}

/** Put an exact valid scale record in an owned fixture without the scale API. */
async function put(project: string, record: ScaleRecord) {
  await writeFile(path.join(project, SCALE_RECORD_FILE), serializeAnyScaleRecord(record));
}

/** Require both ordinary readiness and indexed routing to refuse. */
async function blocked(project: string) {
  expect((await scaleGateRefusal(project))?.block).toBe("scale-downgrade-pending");
  await expect(indexedActive(project)).rejects.toMatchObject({ block: "scale-downgrade-pending" });
}

/** Verify ordinary reads reopen only after the fixture retires the live intent. */
async function retiresIntentAndAdmits(project: string, indexed: boolean) {
  await blocked(project);
  await rm(path.join(project, intentPath));
  expect(await scaleGateRefusal(project)).toBeNull();
  expect(await indexedActive(project)).toBe(indexed);
}

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true });
  root = undefined;
});

/** Receipt-less F2 must remain recoverable at the exact successor revision. */
test("blocks a visible cancel successor with its fenced cancel intent still live", async () => {
  const { project, dir, plan, ready } = await fixture();
  await put(project, ready);
  const cancel = { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: plan.digest,
    phase: "fenced", fenceRevision: 8, cancelRevision: 9, recordSha256: createHash("sha256").update(serializeAnyScaleRecord(ready)).digest("hex"), priors: [] };
  await writeFile(path.join(project, dir, "cancel.json"), JSON.stringify(cancel));
  await blocked(project);
  await put(project, { ...ready, revision: 10 });
  await retiresIntentAndAdmits(project, true);
});

/** V1 activation stays behind the live intent although no pending field remains. */
test("blocks visible V1 activation until intent retirement", async () => {
  const { project, activation } = await fixture();
  await put(project, activation);
  await retiresIntentAndAdmits(project, false);
});

/** Preserve both the exact original and a positively evidenced plan-only stale state. */
test("allows original and pre-fence staleness, but refuses the active fence", async () => {
  const { project, dir, fence } = await fixture();
  await put(project, original);
  expect(await scaleGateRefusal(project)).toBeNull();
  expect(await indexedActive(project)).toBe(true);
  await put(project, { ...original, revision: 8 });
  expect(await scaleGateRefusal(project)).toBeNull();
  expect(await indexedActive(project)).toBe(true);
  await mkdir(path.join(project, dir, "attempt-1"));
  await blocked(project);
  await put(project, fence);
  await blocked(project);
  await rm(path.join(project, intentPath));
  await blocked(project);
});

/** An untrusted leaf does not convert a project to the old unregistered path. */
test("refuses malformed or redirected live intent even without a scale record", async () => {
  const { project } = await fixture();
  await writeFile(path.join(project, intentPath), "{}");
  await blocked(project);
  await rm(path.join(project, intentPath));
  await symlink("absent-intent", path.join(project, intentPath));
  await blocked(project);
  await rm(path.join(project, intentPath));
  await rm(path.join(project, ".llmwiki/indexed"), { recursive: true });
  expect(await scaleGateRefusal(project)).toBeNull();
  expect(await indexedActive(project)).toBe(false);
});

/** The early scale check also protects V3 and rejects a stale observed original. */
test("refuses V3 terminal publication and a displaced early record observation", async () => {
  const { project, dir, plan, ready } = await fixture();
  await put(project, original);
  const observed = { kind: "ok", record: original } as const;
  expect(await downgradeNeedsRecovery(project, observed)).toBe(false);
  const changed = { ...ready, version: 3, capabilities: [{ name: "segmented-compile-state-1", status: "ready" }] } as const;
  await put(project, changed);
  const sha = createHash("sha256").update(serializeAnyScaleRecord(changed)).digest("hex");
  await writeFile(path.join(project, dir, "cancel.json"), JSON.stringify({ format: "llmwiki-scale-downgrade-cancel", version: 1, plan: plan.digest,
    phase: "fenced", fenceRevision: 8, cancelRevision: 9, recordSha256: sha, priors: [] }));
  expect(await downgradeNeedsRecovery(project, observed)).toBe(true);
  await expect(assertNoDowngradeForScaleUpdate(project)).rejects.toMatchObject({ code: "scale_downgrade_pending" });
  await blocked(project);
});

/** A B2-quality pre-fence proof stays usable, but changed or unknown evidence cannot grant it. */
test("preserves a bound bootstrapped cancel on a later indexed record", async () => {
  const { project, dir, plan } = await fixture();
  await put(project, { ...original, revision: 10 });
  const leaf = path.join(project, dir, "cancel.json");
  const cancel = { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: plan.digest, phase: "bootstrapped",
    fenceRevision: 8, cancelRevision: null, recordSha256: originalSha, priors: [] };
  await writeFile(leaf, JSON.stringify(cancel));
  expect(await scaleGateRefusal(project)).toBeNull();
  expect(await indexedActive(project)).toBe(true);
  await writeFile(leaf, JSON.stringify({ ...cancel, recordSha256: "0".repeat(64) }));
  await blocked(project);
});
