/**
 * @file test/scale/downgrade-access.test.ts
 * @description The private access of a scale-down on real disk: admitted
 * only inside its scope, with its intent, its EXACT fence record (pending
 * `downgrade` with the plan, revision and target the intent names) and a
 * barrier carrying its token owned by THIS process incarnation (its pid with
 * a start identity observed live). A missing or different fence, a different
 * token, another pid, and this pid with no or another start identity each
 * refuse. Outside the scope every routed read refuses with
 * `scale-downgrade-pending`; inside, the route still serves the indexed
 * authority. The intent parser refuses an evidence directory other than the
 * derived one and a fence revision other than the original's successor.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { indexedActive } from "../../src/indexed/routing.js";
import type { ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { nextRecord } from "../../src/scale/next-record.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { createDowngradeIntent, holdsDowngradeAccess, runWithDowngradeAccess, type DowngradeIntentV1 } from "../../src/segments/downgrade-access.js";
import { publishRetireBarrier } from "../../src/segments/retire-barrier.js";

const PLAN = "b".repeat(64);
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-downgrade-access-"))); await mkdir(path.join(root, ".llmwiki")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** An active indexed record at revision 2; with `fence`, the downgrade pending at revision 3. */
function record(fence: boolean, plan = PLAN): ScaleRecordV2 {
  const indexed = nextRecord(null, planScaleV2({ documents: 8_000 })) as ScaleRecordV2;
  const lowered = nextRecord({ ...indexed, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null }, planScaleV2({ documents: 100 })) as ScaleRecordV2;
  const base = { ...lowered, revision: 2, pending: null };
  return fence ? { ...base, revision: 3, pending: { kind: "downgrade", revision: 3, target: "local-standard", plan } } : base;
}

/** The intent of the fence at revision 3. */
const INTENT: DowngradeIntentV1 = {
  format: "llmwiki-scale-downgrade-intent", version: 1, plan: PLAN, target: "local-standard", originalRevision: 2,
  originalRecordSha256: "c".repeat(64), fenceRevision: 3, dir: `.llmwiki/scale-downgrade/3-${PLAN.slice(0, 12)}`,
};

/** Write `value` as the scale record. */
const writeRecord = (value: ScaleRecordV2) => writeFile(path.join(root, ".llmwiki", "scale.json"), serializeAnyScaleRecord(value));
/** Whether the scope of `token` is admitted now. */
const admitted = (token: string) => runWithDowngradeAccess(root, token, PLAN, () => holdsDowngradeAccess(root));

/** Rewrite the barrier's owner record through `change`, keeping everything else. */
async function rewriteOwner(change: (owner: Record<string, unknown> & { pid: number }) => Record<string, unknown>): Promise<void> {
  const leaf = path.join(root, ".llmwiki", "indexed-retire.json");
  const barrier = JSON.parse(await readFile(leaf, "utf8")) as { owner: Record<string, unknown> & { pid: number } };
  await writeFile(leaf, `${JSON.stringify({ ...barrier, owner: change(barrier.owner) })}\n`);
}

/** A project fenced for `PLAN` with its intent and this process's barrier; returns the token. */
async function fenced(): Promise<string> {
  await writeRecord(record(true));
  await createDowngradeIntent(root, INTENT);
  return publishRetireBarrier(root, PLAN);
}

describe("private access admission", () => {
  it("admits only the scope with the intent, the exact fence and this process's barrier", async () => {
    const token = await fenced();
    expect(await admitted(token)).toBe(true);
    expect(await holdsDowngradeAccess(root)).toBe(false);
    expect(await admitted("0".repeat(32))).toBe(false);
  });

  it("refuses when the fence is missing or is not the intent's", async () => {
    const token = await fenced();
    await writeRecord(record(false));
    expect(await admitted(token)).toBe(false);
    await writeRecord(record(true, "d".repeat(64)));
    expect(await admitted(token)).toBe(false);
  });

  it("refuses when the barrier is owned by another process", async () => {
    const token = await fenced();
    await rewriteOwner((owner) => ({ ...owner, pid: process.pid + 1 }));
    expect(await admitted(token)).toBe(false);
  });

  it("refuses this pid without a recorded start identity, or with another one (no positive incarnation proof)", async () => {
    const token = await fenced();
    await rewriteOwner(({ pid }) => ({ pid }));
    expect(await admitted(token)).toBe(false);
    await rewriteOwner((owner) => ({ ...owner, pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970", identity: "0" }));
    expect(await admitted(token)).toBe(false);
  });
});

describe("routing under the fence", () => {
  it("refuses outside the scope and serves the indexed authority inside it", async () => {
    const token = await fenced();
    await expect(indexedActive(root)).rejects.toMatchObject({ name: "ScaleGateError", block: "scale-downgrade-pending" });
    expect(await runWithDowngradeAccess(root, token, PLAN, () => indexedActive(root))).toBe(true);
  });
});

describe("the intent parser", () => {
  it("refuses another evidence directory and a fence revision that is not the original's successor", async () => {
    await expect(createDowngradeIntent(root, { ...INTENT, dir: ".llmwiki/scale-downgrade/elsewhere" })).rejects.toThrow(/malformed/);
    await expect(createDowngradeIntent(root, { ...INTENT, fenceRevision: 9, dir: `.llmwiki/scale-downgrade/9-${PLAN.slice(0, 12)}` })).rejects.toThrow(/malformed/);
  });
});
