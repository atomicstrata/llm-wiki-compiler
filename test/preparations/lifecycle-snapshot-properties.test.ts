/**
 * @file test/preparations/lifecycle-snapshot-properties.test.ts
 * @description Adversarial monotonicity, bound, and authority-capture checks
 * for the Task 9B lifecycle snapshot.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import {
  lifecyclePreparationKeyFile,
  lifecycleQuarantineUnitPaths,
} from "../../src/preparations/lifecycle-fs/paths.js";
import { lifecycleScanBounds } from "../../src/preparations/lifecycle-fs/bounds.js";
import {
  MAX_ACTIVE_PREPARATION_BYTES,
  MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
} from "../../src/preparations/constants.js";
import {
  MAX_LIFECYCLE_RECEIPT_BYTES,
  signQuarantineReceipt,
  type QuarantineReceiptContentV1,
} from "../../src/preparations/receipts.js";
import {
  lifecycleSnapshotFixture,
  quarantineObject,
  writeQuarantineReceipts,
  writePruneReceipts,
} from "./lifecycle-snapshot-fixture.js";

/** Require the single adversarial unit to remain visible and fail closed. */
function expectOnlyUnitUnavailable(
  snapshot: Awaited<ReturnType<typeof scanPreparationLifecycle>>,
): void {
  expect(snapshot.units).toHaveLength(1);
  expect(snapshot.units[0]?.state).toBe("unavailable");
  expect(snapshot.complete).toBe(false);
}

describe("preparation lifecycle snapshot adversarial properties", () => {
  const root = useTempRoot();

  it("enumerates each physical registry exactly once", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const seen: string[] = [];
    await scanPreparationLifecycle(fixture.namespace, {
      onRegistryEnumeratedForTest: (registry) => { seen.push(registry); },
    });
    expect(seen).toEqual(["quarantine", "prune"]);
  });

  it("fails closed when the captured key leaf is replaced mid-scan", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const keyFile = lifecyclePreparationKeyFile(fixture.namespace);
    await expect(scanPreparationLifecycle(fixture.namespace, {
      afterKeyCapturedForTest: async () => {
        await rename(keyFile, `${keyFile}-old`);
        await writeFile(keyFile, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "namespace-changed" });
  });

  it("fails closed when key bytes change in place under the same inode", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const keyFile = lifecyclePreparationKeyFile(fixture.namespace);
    await expect(scanPreparationLifecycle(fixture.namespace, {
      afterKeyCapturedForTest: async () => {
        await writeFile(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "namespace-changed" });
  });

  it("does not expose raw key bytes through output or digest", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(JSON.stringify(snapshot)).not.toContain(fixture.key.toString("base64"));
    expect(snapshot.digest).not.toContain(fixture.key.toString("base64"));
  });

  it("names aggregate postcondition exhaustion without accepting completion", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const object = quarantineObject(fixture.namespace, "qtn-bound", Buffer.from("too-large"));
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-bound", objects: [object.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-bound").bytesRoot);
    await writeFile(object.destination, object.body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      maxPostconditionBytes: object.body.byteLength - 1,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.problems.some((problem) =>
      problem.code === "postcondition-bytes-exhausted")).toBe(true);
  });

  it("names per-object exhaustion without accepting completion", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const object = quarantineObject(fixture.namespace, "qtn-object-bound");
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-object-bound", objects: [object.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-object-bound").bytesRoot);
    await writeFile(object.destination, object.body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      maxObjectBytes: object.body.byteLength - 1,
    });
    expectOnlyUnitUnavailable(snapshot);
    expect(snapshot.problems[0]?.code).toBe("object-bytes-exhausted");
  });

  it("never improves a completed classification after adding unknown content", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const object = quarantineObject(fixture.namespace, "qtn-monotonic");
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-monotonic", objects: [object.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-monotonic").bytesRoot);
    await writeFile(object.destination, object.body);
    const before = await scanPreparationLifecycle(fixture.namespace);
    await writeFile(
      `${lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-monotonic").unitRoot}/foreign`,
      "unknown",
    );
    const after = await scanPreparationLifecycle(fixture.namespace);
    expect(before.units[0]?.state).toBe("completed");
    expect(after.units[0]?.state).toBe("unavailable");
    expect(after.complete).toBe(false);
  });

  it("withdraws completed custody when retained bytes change", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const object = quarantineObject(fixture.namespace, "qtn-tampered", Buffer.from("original"));
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-tampered", objects: [object.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-tampered").bytesRoot);
    await writeFile(object.destination, Buffer.from("tampered"));
    expectOnlyUnitUnavailable(await scanPreparationLifecycle(fixture.namespace));
  });

  it("rejects unknown content added after classification", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const object = quarantineObject(fixture.namespace, "qtn-race");
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-race", objects: [object.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-race").bytesRoot);
    await writeFile(object.destination, object.body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      afterClassificationForTest: async () => {
        await writeFile(
          `${lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-race").unitRoot}/late`,
          "foreign",
        );
      },
    });
    expect(snapshot.units[0]?.state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("rejects a bytes directory created after its absence was observed", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-late-bytes", objects: [], completed: true,
    });
    const paths = lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-late-bytes");
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      afterClassificationForTest: async () => { await mkdir(paths.bytesRoot); },
    });
    expect(snapshot.units[0]?.state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("names receipt-byte exhaustion and cannot raise the host maximum", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-receipt-bound", objects: [],
    });
    const bounded = await scanPreparationLifecycle(fixture.namespace, {
      maxReceiptBytes: 8,
    });
    expect(bounded.problems.some((problem) =>
      problem.code === "receipt-bytes-exhausted")).toBe(true);
    const ordinary = await scanPreparationLifecycle(fixture.namespace, {
      maxReceiptBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(ordinary.units[0]?.state).toBe("planned");
  });

  it("never raises any host-owned scan ceiling", () => {
    const bounds = lifecycleScanBounds({
      maxRegistryEntries: Number.MAX_SAFE_INTEGER,
      maxReceiptBytes: Number.MAX_SAFE_INTEGER,
      maxObjectBytes: Number.MAX_SAFE_INTEGER,
      maxPostconditionBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(bounds.maxRegistryEntries).toBe(100_000);
    expect(bounds.maxReceiptBytes).toBe(MAX_LIFECYCLE_RECEIPT_BYTES);
    expect(bounds.maxObjectBytes).toBe(MAX_PREPARATION_EVIDENCE_OBJECT_BYTES);
    expect(bounds.maxPostconditionBytes).toBe(MAX_ACTIVE_PREPARATION_BYTES);
  });

  it("fails the entire observation when the aggregate entry bound is exhausted", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-one").unitRoot);
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      maxRegistryEntries: 0,
    });
    expect(snapshot.units).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.problems.some((problem) =>
      problem.code === "registry-entries-exhausted")).toBe(true);
  });

  it("produces the same immutable digest for the same authority state", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-deterministic", objects: [], completed: true,
    });
    const first = await scanPreparationLifecycle(fixture.namespace);
    const second = await scanPreparationLifecycle(fixture.namespace);
    expect(second).toEqual(first);
    expect(second.digest).toBe(first.digest);
  });

  it("rejects duplicate quarantine source and custody identities", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const first = quarantineObject(fixture.namespace, "qtn-duplicate");
    const duplicateSource = { ...first.object, objectName: "obj-000001" };
    const duplicateCustody = {
      ...first.object,
      logicalPath: "workspaces/ws/qtn-duplicate-second.bin",
    };
    await mkdir(path.dirname(first.source), { recursive: true });
    await writeFile(first.source, first.body);
    await writeFile(
      path.join(fixture.namespace.root.realPath, ".llmwiki", duplicateCustody.logicalPath),
      first.body,
    );
    await writeQuarantineReceipts({
      ...fixture,
      unitId: "qtn-duplicate",
      objects: [first.object, duplicateSource, duplicateCustody],
    });
    expectOnlyUnitUnavailable(await scanPreparationLifecycle(fixture.namespace));
  });

  it("rejects nonportable planned object paths on every host", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const body = Buffer.from("portable-only");
    const logicalPath = "C:\\authority.bin";
    await mkdir(path.join(fixture.namespace.root.realPath, ".llmwiki"), { recursive: true });
    await writeFile(path.join(fixture.namespace.root.realPath, ".llmwiki", logicalPath), body);
    await writeQuarantineReceipts({
      ...fixture,
      unitId: "qtn-windows-path",
      objects: [{
        logicalPath,
        objectName: "obj-000000",
        byteCount: body.byteLength,
        digest: createHash("sha256").update(body).digest("hex"),
      }],
    });
    expectOnlyUnitUnavailable(await scanPreparationLifecycle(fixture.namespace));
  });

  it("rejects a signed receipt carrying an unknown field", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unitId = "qtn-open-grammar";
    const paths = lifecycleQuarantineUnitPaths(fixture.namespace, unitId);
    await mkdir(paths.unitRoot);
    const content = {
      schemaVersion: 1,
      kind: "quarantine-planned",
      scope: "per-run",
      reason: "run-integrity-invalid",
      unitId,
      keyEpochId: fixture.keyEpochId,
      objects: [],
      residualObligations: [],
      actor: { id: "operator", surface: "cli" },
      at: "2026-07-28T12:00:00.000Z",
      foreign: true,
    } satisfies QuarantineReceiptContentV1 & { foreign: boolean };
    await writeFile(paths.plannedReceiptFile,
      canonicalBytes(signQuarantineReceipt(fixture.key, content)));
    expectOnlyUnitUnavailable(await scanPreparationLifecycle(fixture.namespace));
  });

  it("requires the run identity exactly for run-scoped operations", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture,
      unitId: "qtn-missing-run",
      objects: [],
      runId: null,
    });
    await writePruneReceipts({
      ...fixture,
      unitId: "swp-foreign-run",
      operation: "sweep",
      objects: [],
      runId: "run-foreign",
    });
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(snapshot.units.map((entry) => entry.state)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    expect(snapshot.complete).toBe(false);
  });

  it("rejects a signed completion whose shared authority differs from its plan", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture,
      unitId: "qtn-pair-drift",
      objects: [],
      completed: true,
      completedAt: "2026-07-28T12:00:01.000Z",
    });
    expectOnlyUnitUnavailable(await scanPreparationLifecycle(fixture.namespace));
  });
});
