/**
 * @file test/indexed/maintenance-legs.test.ts
 * @description Each custody leg of the maintenance acquisition refuses on
 * its own, in the gate's order: the page journal, operation bundles, the
 * portable intent, the scale gate, preparation lifecycle maintenance, and an
 * owed preparation settlement. A refusal is `indexed_maintenance_blocked`
 * naming that leg; the body never runs, no later leg is consulted, and the
 * raw project lock is released. The legs' incumbent detectors are stubbed
 * here (each is exercised on real disk by its own suite, and the bundle and
 * journal legs by `maintenance-lock.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";

const stubs = {
  journal: vi.fn(), bundles: vi.fn(), portable: vi.fn(), scale: vi.fn(), lifecycle: vi.fn(), settlement: vi.fn(),
};
// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realLockGate = { ...(await import("../../src/operation-bundles/lock-gate.js")) };
const realPendingGate = { ...(await import("../../src/portable/host/pending-gate.js")) };
const realScaleGate = { ...(await import("../../src/scale/gate.js")) };
vi.mock("../../src/trust/journal-health.js", () => ({ journalHealth: stubs.journal }));
vi.mock("../../src/operation-bundles/lock-gate.js", async () => ({
  ...realLockGate,
  detectBundleRecoveryFrom: stubs.bundles, gatePreparationLifecycleFrom: stubs.lifecycle,
}));
vi.mock("../../src/portable/host/pending-gate.js", async () => ({
  ...realPendingGate, portableGateBlock: stubs.portable,
}));
vi.mock("../../src/scale/gate.js", async () => ({ ...realScaleGate, scaleGateRefusal: stubs.scale }));
vi.mock("../../src/preparations/settlement-pending.js", () => ({ pendingPreparationSettlement: stubs.settlement }));

const { IndexedMaintenanceBlockedError, withMaintenanceLock } = await import("../../src/indexed/maintenance-lock.js");
const { acquireLock, releaseLock } = await import("../../src/utils/lock.js");
const { PreparationLifecycleGateError } = await import("../../src/operation-bundles/lock-gate.js");

/** Each leg in the gate's order, with the stub value that makes it refuse. */
const LEGS = [
  { leg: "page-journal", stub: stubs.journal, block: () => ({ status: "pending" }) },
  { leg: "operation-bundles", stub: stubs.bundles, block: () => "bundle-recovery-blocking" },
  { leg: "portable", stub: stubs.portable, block: () => "unresolved-intent" },
  { leg: "scale", stub: stubs.scale, block: () => new Error("scale-transition-pending: a scale transition is unfinished") },
  { leg: "preparation-lifecycle", stub: stubs.lifecycle, block: () => { throw new PreparationLifecycleGateError("lifecycle maintenance is pending"); } },
  { leg: "preparation-settlement", stub: stubs.settlement, block: () => "research/prun_1" },
] as const;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-legs-"));
  stubs.journal.mockResolvedValue({ status: "ok" });
  for (const stub of [stubs.bundles, stubs.portable, stubs.scale, stubs.settlement]) stub.mockResolvedValue(null);
  stubs.lifecycle.mockResolvedValue(null);
});
afterEach(async () => { vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("the maintenance acquisition's custody legs", () => {
  it("admit the body when every leg is clear", async () => {
    await expect(withMaintenanceLock(root, {}, async () => "collected")).resolves.toBe("collected");
    for (const { stub } of LEGS) expect(stub).toHaveBeenCalledTimes(1);
  });

  it.each(LEGS.map((entry, at) => ({ ...entry, at })))("refuse at $leg, consulting no later leg and releasing the lock", async ({ leg, stub, block, at }) => {
    stub.mockImplementation(async () => block());
    const body = vi.fn(async () => "collected");
    const refused = await withMaintenanceLock(root, {}, body).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IndexedMaintenanceBlockedError);
    expect(refused).toMatchObject({ code: "indexed_maintenance_blocked", leg });
    expect(body).not.toHaveBeenCalled();
    for (const later of LEGS.slice(at + 1)) expect(later.stub).not.toHaveBeenCalled();
    expect(await acquireLock(root)).toBe(true);
    await releaseLock(root);
  });
});
