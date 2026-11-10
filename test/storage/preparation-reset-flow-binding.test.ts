/**
 * @file test/storage/preparation-reset-flow-binding.test.ts
 * @description The remaining preparation destructive POLICY as root-free bodies over
 * memory steps: both reset invocations (`resetPreparationKeyEpochWith`), the reset
 * key-material bodies (`readAuthenticatedPendingKeyFrom`, `stagePendingResetKeyWith`,
 * `publishActiveResetKeyWith`, `moveOldKeyIntoUnitWith`), intent supersession
 * (`supersedeIntentOnlyUnitsWith`), the sweep-orphan enumeration
 * (`enumerateSweepableOrphansFrom`) and the retirement set (`retirableUnitsFromLeaves`).
 *
 * WHAT IS MEMORY ONLY. The doubles log every call and answer scripted states with
 * REAL signed/parsed records built through the shipped receipt helpers. They prove
 * order, refusals and exact-once minting, not namespaces, leases, confinement or
 * durable writes, which stay in the local adapters and are covered on real fixtures by
 * `key-reset`, `reset-intent-supersession`, `reset-intent-contract`, `prune-sweep*`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { mintLifecycleMutationPermit } from "../../src/preparations/lifecycle-mutation-permit.js";
import { retirableUnitsFromLeaves, type QuarantineUnitLeaves } from "../../src/preparations/quarantine-move.js";
import { buildResetIntent, MISSING_KEY_CONFIRMATION, resetContinuationDigest, signPendingResetKey } from "../../src/preparations/receipts.js";
import {
  moveOldKeyIntoUnitWith, publishActiveResetKeyWith, readAuthenticatedPendingKeyFrom, resetPreparationKeyEpochWith,
  stagePendingResetKeyWith, type ResetFlowSteps, type ResetKeyLeaves,
} from "../../src/preparations/reset.js";
import { supersedeIntentOnlyUnitsWith, type IntentSupersessionSteps } from "../../src/preparations/reset-intent-supersession.js";
import { enumerateSweepableOrphansFrom, type SweepOrphanReads } from "../../src/preparations/retention.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";

const ACTOR = { id: "op", surface: "cli" as const };
const AT = "2026-07-20T00:00:00.000Z";
const SECRET = Buffer.alloc(32, 9);
const TOKEN = SECRET.toString("base64");
const UNIT = "rst-unit";
const KEY = Buffer.alloc(32, 3);

/** Memory key leaves over a scripted unit-leaf map and active key; every call logged. */
function keyLeaves(log: string[], leaves: Record<string, unknown>, active: unknown = { status: "absent" }): ResetKeyLeaves {
  return {
    readActiveKey: async () => { log.push("readActiveKey"); return active as never; },
    readUnitLeaf: async (_u, leaf) => { log.push(`read:${leaf}`); return (leaves[leaf] ?? { status: "absent" }) as never; },
    writeUnitLeaf: async (_u, leaf, bytes, permit) => { log.push(`write:${leaf}:${permit === undefined ? "no-permit" : "permit"}`); leaves[`${leaf}:written`] = bytes; },
    publishActiveKey: async () => { log.push("publish"); return (leaves.publish ?? "created") as never; },
    moveOldKey: async () => { log.push("moveOldKey"); if (leaves.move instanceof Error) throw leaves.move; return "moved"; },
  };
}

/** Memory flow steps; every call logged. */
function flow(log: string[], keys: ResetKeyLeaves, over: Partial<ResetFlowSteps> = {}): ResetFlowSteps {
  return {
    keys,
    supersedeIntentOnly: async () => { log.push("supersede"); return []; },
    listUnits: async () => { log.push("listUnits"); return { status: "ok", unitIds: ["u-a"] }; },
    intentPresence: async (unitId) => { log.push(`presence:${unitId}`); return "absent"; },
    readSettledReceipt: async () => { log.push("readSettledReceipt"); return null; },
    runCustody: async () => { log.push("runCustody"); return { keyEpochId: "sha256:x" } as never; },
    completeCustody: async () => { log.push("completeCustody"); },
    ...over,
  };
}

const intentBody = (unitId = UNIT) => Buffer.from(canonicalBytes(buildResetIntent({
  unitId, reason: "missing-key", confirmation: MISSING_KEY_CONFIRMATION, continuationDigest: resetContinuationDigest(SECRET), actor: ACTOR, at: AT,
})));

describe("both reset invocations over memory steps", () => {
  it("F1 first pass: a healthy key refuses; a missing key with the wrong confirmation refuses before the pending check; the right one lists, records ONE intent and returns its secret", async () => {
    const healthy: string[] = [];
    await expect(resetPreparationKeyEpochWith(flow(healthy, keyLeaves(healthy, {}, { status: "ok", key: KEY })), { actor: ACTOR, at: AT, confirmation: "x" })).rejects.toMatchObject({ code: "key-healthy" });
    const wrong: string[] = [];
    await expect(resetPreparationKeyEpochWith(flow(wrong, keyLeaves(wrong, {})), { actor: ACTOR, at: AT, confirmation: "x" })).rejects.toMatchObject({ code: "confirmation-mismatch" });
    const log: string[] = [], leaves: Record<string, unknown> = {};
    const result = await resetPreparationKeyEpochWith(flow(log, keyLeaves(log, leaves)), { actor: ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION });
    expect([healthy, wrong, log]).toEqual([["readActiveKey"], ["readActiveKey"], ["readActiveKey", "listUnits", "presence:u-a", "write:intent:no-permit"]]);
    expect(result).toMatchObject({ status: "intent-recorded", reason: "missing-key" });
    const written = JSON.parse((leaves["intent:written"] as Buffer).toString("utf8"));
    expect(written.continuationDigest).toBe(resetContinuationDigest(Buffer.from((result as { continuationToken: string }).continuationToken, "base64")));
  });

  it("F2 supersedes BEFORE eligibility: a healthy key with superseded units returns that outcome without minting", async () => {
    const log: string[] = [];
    const steps = flow(log, keyLeaves(log, {}, { status: "ok", key: KEY }), { supersedeIntentOnly: async () => { log.push("supersede"); return ["u-old"]; } });
    expect(await resetPreparationKeyEpochWith(steps, { actor: ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, supersedePendingReset: true }))
      .toEqual({ status: "pending-intent-superseded", unitIds: ["u-old"] });
    expect(log).toEqual(["supersede", "readActiveKey"]);
  });

  it("F3 second pass: a malformed token reads nothing; unreadable, absent and foreign intents refuse distinctly; a valid one runs the driver custody", async () => {
    const pass = async (intent: unknown, token = TOKEN) => {
      const log: string[] = [];
      const outcome = await resetPreparationKeyEpochWith(flow(log, keyLeaves(log, { intent })), { actor: ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation: { unitId: UNIT, token } })
        .catch((error: { code: string }) => error.code);
      return [outcome, log];
    };
    expect(await pass({ status: "ok", body: intentBody() }, "bad")).toEqual(["continuation-mismatch", []]);
    expect(await pass({ status: "unavailable" })).toEqual(["continuation-unreadable", ["read:intent"]]);
    expect(await pass({ status: "absent" })).toEqual(["continuation-mismatch", ["read:intent"]]);
    expect(await pass({ status: "ok", body: intentBody("rst-other") })).toEqual(["continuation-mismatch", ["read:intent"]]);
    expect(await pass({ status: "ok", body: intentBody() })).toEqual([{ status: "completed", unitId: UNIT, keyEpochId: "sha256:x", receipt: { keyEpochId: "sha256:x" } }, ["read:intent", "readActiveKey", "runCustody"]]);
  });
});

describe("reset key material, supersession, sweep orphans and retirement over memory steps", () => {
  it("K1 authenticates the staged key exactly, stages a signed record under the permit, and converges a publish collision only onto the same key", async () => {
    const permit = mintLifecycleMutationPermit("reset", UNIT), log: string[] = [], leaves: Record<string, unknown> = {};
    const staged = await stagePendingResetKeyWith(keyLeaves(log, leaves), UNIT, SECRET, permit);
    leaves["pending-key"] = { status: "ok", body: leaves["pending-key:written"] };
    expect(await readAuthenticatedPendingKeyFrom(keyLeaves(log, leaves), UNIT, SECRET)).toEqual({ kind: "ok", material: staged });
    expect(await readAuthenticatedPendingKeyFrom(keyLeaves([], leaves), UNIT, Buffer.alloc(32, 1))).toEqual({ kind: "invalid" });
    expect(await readAuthenticatedPendingKeyFrom(keyLeaves([], { "pending-key": { status: "unavailable" } }), UNIT, SECRET)).toEqual({ kind: "unreadable" });
    const forged = canonicalBytes(signPendingResetKey(SECRET, { unitId: UNIT, keyEpochId: preparationKeyEpochId(KEY), key: Buffer.alloc(31).toString("base64") }));
    expect(await readAuthenticatedPendingKeyFrom(keyLeaves([], { "pending-key": { status: "ok", body: forged } }), UNIT, SECRET)).toEqual({ kind: "invalid" });
    await publishActiveResetKeyWith(keyLeaves(log, { publish: "exists" }, { status: "ok", key: staged.key }), UNIT, staged, permit);
    await expect(publishActiveResetKeyWith(keyLeaves([], { publish: "exists" }, { status: "ok", key: KEY }), UNIT, staged, permit)).rejects.toThrow("single-epoch race");
    await expect(moveOldKeyIntoUnitWith(keyLeaves([], { move: new Error("x cannot be examined") }), UNIT, permit)).rejects.toMatchObject({ code: "old-key-immovable", message: "the old key leaf cannot be examined; refusing to mint over it" });
    expect(log).toEqual(["write:pending-key:permit", "read:pending-key", "publish", "readActiveKey"]);
  });

  it("S1 supersedes sequentially (classify then clear each unit before the next), skipping materialized units, and refuses an unreadable registry", async () => {
    const log: string[] = [];
    const steps = (listing: unknown): IntentSupersessionSteps => ({
      listUnits: async () => { log.push("list"); return listing as never; },
      observeUnit: async (unitId) => { log.push(`observe:${unitId}`); return unitId === "u-m" ? { status: "ok", names: ["pending-reset-key.json"], bytes: "absent" } : { status: "ok", names: ["reset-intent.json"], bytes: "absent", intentBody: intentBody(unitId) }; },
      clearUnit: async (unitId, empty) => { log.push(`clear:${unitId}:${empty}`); },
    });
    await expect(supersedeIntentOnlyUnitsWith(steps({ status: "unavailable" }), MISSING_KEY_CONFIRMATION, () => MISSING_KEY_CONFIRMATION)).rejects.toThrow("refusing to supersede");
    log.length = 0;
    expect(await supersedeIntentOnlyUnitsWith(steps({ status: "ok", unitIds: ["u-a", "u-m", "u-b"] }), MISSING_KEY_CONFIRMATION, () => MISSING_KEY_CONFIRMATION)).toEqual(["u-a", "u-b"]);
    expect(log).toEqual(["list", "observe:u-a", "clear:u-a:false", "observe:u-m", "observe:u-b", "clear:u-b:false"]);
  });

  it("O1 enumerates sweep orphans from ONE scan: manifest first, unreadable skipped, only a provably absent run contributes its leaves", async () => {
    const log: string[] = [];
    const manifest = (preparationId: string) => ({ runId: `prr_${"1".repeat(32)}`, preparationId, workspaceId: "w", schemaVersion: 1 });
    const reads: SweepOrphanReads = {
      scanForPlan: async () => { log.push("scan"); return { preparationDirectories: [{ workspaceId: "w", preparationId: "prp_p1" }, { workspaceId: "w", preparationId: "prp_p2" }, { workspaceId: "w", preparationId: "prp_p3" }], leaves: [{ workspaceId: "w", preparationId: "prp_p2", relativePath: "x", bytes: 1 }, { workspaceId: "w", preparationId: "prp_p3", relativePath: "y", bytes: 1 }] } as never; },
      readManifest: async (_w, id) => { log.push(`manifest:${id}`); return (id === "prp_p1" ? { status: "unavailable" } : { status: "ok", manifest: manifest(id) }) as never; },
      readRun: async (binding) => { log.push(`run:${binding.preparationId}`); return (binding.preparationId === "prp_p2" ? { status: "absent" } : { status: "unavailable", code: "identity" }) as never; },
      scopedLeafObject: async (relativePath) => { log.push(`capture:${relativePath}`); return { logicalPath: relativePath } as never; },
    };
    const objects = await enumerateSweepableOrphansFrom(reads, `sha256:${"4".repeat(64)}` as never, { status: "ok" } as never);
    expect(objects.map((object) => object.logicalPath)).toEqual(["x"]);
    expect(log).toEqual(["scan", "manifest:prp_p1", "manifest:prp_p2", "run:prp_p2", "capture:x", "manifest:prp_p3", "run:prp_p3"]);
  });

  it("Q1 builds the retirement set sequentially from RAW receipt bytes: the excluded unit skipped, absent dropped, unreadable named", async () => {
    const raw = Buffer.from("raw completed receipt"), log: string[] = [];
    const answers: Record<string, unknown> = { "u-1": { kind: "ok", body: raw }, "u-2": { kind: "absent" }, "u-3": { kind: "unavailable" } };
    const leaves = { readReceiptLeaf: async (unitId: string, which: string) => { log.push(`${which}:${unitId}`); return answers[unitId]; } } as unknown as QuarantineUnitLeaves;
    expect(await retirableUnitsFromLeaves(leaves, ["u-1", "u-x", "u-2", "u-3"], "u-x")).toEqual({
      retired: [{ unitId: "u-1", receiptDigest: createHash("sha256").update(raw).digest("hex") }], unreadable: ["u-3"],
    });
    expect(log).toEqual(["completed:u-1", "completed:u-2", "completed:u-3"]);
  });
});
