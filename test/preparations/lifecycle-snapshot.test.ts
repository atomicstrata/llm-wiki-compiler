/**
 * @file test/preparations/lifecycle-snapshot.test.ts
 * @description End-to-end states for the one root-bound preparation lifecycle
 * snapshot. Both physical registries, key capture, signed record binding,
 * custody postconditions, and historical retirement are observed together.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { buildResetIntent, resetContinuationDigest } from "../../src/preparations/receipts.js";
import {
  openPreparationLifecycleNamespace,
  type PreparationLifecycleNamespaceV1,
} from "../../src/preparations/lifecycle-fs/namespace.js";
import {
  lifecyclePruneUnitPaths,
  lifecycleQuarantineUnitPaths,
  lifecyclePreparationKeyFile,
} from "../../src/preparations/lifecycle-fs/paths.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import { lifecycleStagedDeleteName } from "../../src/preparations/paths.js";
import {
  lifecycleSnapshotFixture,
  quarantineObject,
  writePruneReceipts,
  writeQuarantineReceipts,
} from "./lifecycle-snapshot-fixture.js";

/** Find one required unit without weakening a test through optional chaining. */
function unit(snapshot: Awaited<ReturnType<typeof scanPreparationLifecycle>>, unitId: string) {
  const found = snapshot.units.find((candidate) => candidate.unitId === unitId);
  if (found === undefined) throw new Error(`missing lifecycle unit ${unitId}`);
  return found;
}

/** Write the canonical unsigned first-pass marker for one missing-key reset. */
async function writeMissingKeyIntent(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
): Promise<void> {
  const intent = buildResetIntent({
    unitId,
    reason: "missing-key",
    confirmation: "confirm-all-preparation-residual-state",
    continuationDigest: resetContinuationDigest(Buffer.from("secret")),
    actor: { id: "operator", surface: "cli" },
    at: "2026-07-28T12:00:00.000Z",
  });
  await writeFile(lifecycleQuarantineUnitPaths(namespace, unitId).resetIntentFile,
    canonicalBytes(intent));
}

describe("preparation lifecycle snapshot", () => {
  const root = useTempRoot();

  it("is complete and clean when both registries and the key are absent", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "read");
    const snapshot = await scanPreparationLifecycle(namespace);
    expect(snapshot.keyState).toEqual({ status: "absent" });
    expect(snapshot.units).toEqual([]);
    expect(snapshot.complete).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.units)).toBe(true);
  });

  it("classifies a closed pre-plan reset as awaiting continuation", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unitId = "rst-awaiting";
    const paths = lifecycleQuarantineUnitPaths(fixture.namespace, unitId);
    await mkdir(paths.bytesRoot, { recursive: true });
    await writeMissingKeyIntent(fixture.namespace, unitId);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, unitId)).toMatchObject({
      operation: "project-key-reset", state: "awaiting-continuation",
    });
    expect(snapshot.complete).toBe(true);
  });

  it("classifies only truly empty units as inert", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-empty").unitRoot);
    await mkdir(lifecyclePruneUnitPaths(fixture.namespace, "prn-empty").unitRoot);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "qtn-empty")).toMatchObject({ operation: null, state: "inert" });
    expect(unit(snapshot, "prn-empty")).toMatchObject({ operation: null, state: "inert" });
  });

  it("keeps a pre-plan reset with unknown content unavailable", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unitId = "rst-foreign";
    const paths = lifecycleQuarantineUnitPaths(fixture.namespace, unitId);
    await mkdir(paths.unitRoot);
    await writeMissingKeyIntent(fixture.namespace, unitId);
    await writeFile(`${paths.unitRoot}/foreign`, "unknown");
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, unitId).state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("reports current retained and absent completed custody honestly", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const retained = quarantineObject(fixture.namespace, "qtn-retained");
    const absent = quarantineObject(fixture.namespace, "qtn-absent");
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-retained", objects: [retained.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-retained").bytesRoot);
    await writeFile(retained.destination, retained.body);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-absent", objects: [absent.object], completed: true,
    });
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "qtn-retained")).toMatchObject({
      state: "completed", custody: "verified-retained",
    });
    expect(unit(snapshot, "qtn-absent")).toMatchObject({
      state: "completed", custody: "absent-unproven",
    });
  });

  it("distinguishes planned from applying quarantine protocol positions", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const planned = quarantineObject(fixture.namespace, "qtn-planned");
    const applying = quarantineObject(fixture.namespace, "qtn-applying");
    await mkdir(planned.source.slice(0, planned.source.lastIndexOf("/")), { recursive: true });
    await writeFile(planned.source, planned.body);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-planned", objects: [planned.object],
    });
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-applying", objects: [applying.object],
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-applying").bytesRoot);
    await writeFile(applying.destination, applying.body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "qtn-planned").state).toBe("planned");
    expect(unit(snapshot, "qtn-applying").state).toBe("applying");
  });

  it("fails closed on partial completed custody", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const first = quarantineObject(fixture.namespace, "qtn-partial", Buffer.from("one"));
    const second = { ...quarantineObject(fixture.namespace, "qtn-partial", Buffer.from("two")) };
    second.object = { ...second.object, objectName: "obj-000001" };
    second.destination = lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-partial")
      .byteObjectFile("obj-000001");
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-partial", objects: [first.object, second.object], completed: true,
    });
    await mkdir(lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-partial").bytesRoot);
    await writeFile(first.destination, first.body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "qtn-partial").state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("derives prune operation from authenticated content, not the unit prefix", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writePruneReceipts({
      ...fixture,
      unitId: "prn-content-disagrees",
      operation: "sweep",
      objects: [],
      completed: true,
    });
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "prn-content-disagrees")).toMatchObject({
      operation: "orphan-sweep", state: "unavailable",
    });
  });

  it("distinguishes planned from applying prune protocol positions", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const body = Buffer.from("delete-me");
    const digest = createHash("sha256").update(body).digest("hex");
    const plannedObject = {
      logicalPath: "workspaces/ws/delete-planned.bin", byteCount: body.length, digest,
    };
    const applyingObject = {
      logicalPath: "workspaces/ws/delete-applying.bin", byteCount: body.length, digest,
    };
    await writePruneReceipts({
      ...fixture, unitId: "prn-planned", operation: "prune", objects: [plannedObject],
    });
    await writePruneReceipts({
      ...fixture, unitId: "prn-applying", operation: "prune", objects: [applyingObject],
    });
    const source = `${fixture.namespace.root.realPath}/.llmwiki/${plannedObject.logicalPath}`;
    await mkdir(source.slice(0, source.lastIndexOf("/")), { recursive: true });
    await writeFile(source, body);
    const staged = `${lifecyclePruneUnitPaths(fixture.namespace, "prn-applying").unitRoot}/${lifecycleStagedDeleteName(0)}`;
    await writeFile(staged, body);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "prn-planned").state).toBe("planned");
    expect(unit(snapshot, "prn-applying").state).toBe("applying");
  });

  it("rejects a receipt copied beneath a different unit identity", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-origin", objects: [],
    });
    const origin = lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-origin");
    const copied = lifecycleQuarantineUnitPaths(fixture.namespace, "qtn-copy");
    await mkdir(copied.unitRoot);
    await copyFile(origin.plannedReceiptFile, copied.plannedReceiptFile);
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "qtn-copy").state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("classifies a completed prune only while all planned leaves stay absent", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const logicalPath = "workspaces/ws/restored.bin";
    const body = Buffer.from("restored");
    await writePruneReceipts({
      ...fixture,
      unitId: "prn-complete",
      operation: "prune",
      completed: true,
      objects: [{
        logicalPath,
        byteCount: body.byteLength,
        digest: createHash("sha256").update(body).digest("hex"),
      }],
    });
    let snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "prn-complete").state).toBe("completed");
    const source = `${fixture.namespace.root.realPath}/.llmwiki/${logicalPath}`;
    await mkdir(source.slice(0, source.lastIndexOf("/")), { recursive: true });
    await writeFile(source, body);
    snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "prn-complete").state).toBe("unavailable");
  });

  it("classifies old custody as historical only through active reset evidence", async () => {
    const oldFixture = await lifecycleSnapshotFixture(root.dir);
    const old = await writeQuarantineReceipts({
      ...oldFixture, unitId: "qtn-old", objects: [], completed: true,
    });
    await unlink(lifecyclePreparationKeyFile(oldFixture.namespace));
    const current = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...current,
      unitId: "rst-current",
      scope: "project-reset",
      objects: [],
      completed: true,
      retiredUnits: [{
        unitId: "qtn-old",
        receiptDigest: createHash("sha256").update(old.completed as Buffer).digest("hex"),
      }],
    });
    const snapshot = await scanPreparationLifecycle(current.namespace);
    expect(unit(snapshot, "qtn-old").state).toBe("historical");
    expect(unit(snapshot, "rst-current").state).toBe("completed");
  });

  it("withdraws history when the exact retired receipt bytes change", async () => {
    const oldFixture = await lifecycleSnapshotFixture(root.dir);
    const old = await writeQuarantineReceipts({
      ...oldFixture, unitId: "qtn-retired-changed", objects: [], completed: true,
    });
    await unlink(lifecyclePreparationKeyFile(oldFixture.namespace));
    const current = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...current,
      unitId: "rst-retirement",
      scope: "project-reset",
      objects: [],
      completed: true,
      retiredUnits: [{
        unitId: "qtn-retired-changed",
        receiptDigest: createHash("sha256").update(old.completed as Buffer).digest("hex"),
      }],
    });
    const oldPaths = lifecycleQuarantineUnitPaths(current.namespace, "qtn-retired-changed");
    await writeFile(oldPaths.completedReceiptFile, Buffer.concat([old.completed as Buffer, Buffer.from("\n")]));
    const snapshot = await scanPreparationLifecycle(current.namespace);
    expect(unit(snapshot, "qtn-retired-changed").state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("rejects unexplained staged content beside a completed sweep", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writePruneReceipts({
      ...fixture,
      unitId: "swp-unknown-stage",
      operation: "sweep",
      objects: [],
      completed: true,
    });
    const staged = `${lifecyclePruneUnitPaths(fixture.namespace, "swp-unknown-stage").unitRoot}/pending-delete-000000`;
    await writeFile(staged, "unexplained");
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    expect(unit(snapshot, "swp-unknown-stage").state).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
  });

  it("marks a nonempty unit unavailable when the preparation key is missing", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-no-key", objects: [],
    });
    await unlink(lifecyclePreparationKeyFile(fixture.namespace));
    const namespace = await openPreparationLifecycleNamespace(root.dir, "read");
    const snapshot = await scanPreparationLifecycle(namespace);
    expect(unit(snapshot, "qtn-no-key").state).toBe("unavailable");
    expect(snapshot.keyState).toEqual({ status: "absent" });
    expect(snapshot.complete).toBe(false);
  });
});
