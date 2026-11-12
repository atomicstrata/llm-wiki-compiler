/**
 * @file test/storage/lifecycle-scan-binding.test.ts
 * @description The lifecycle scan as ONE body over its confined reads,
 * `scanPreparationLifecycleFrom` over `LifecycleScanReads`, with the project gone,
 * and the lifecycle read authority unchanged. This file uses the body, which
 * exists only after the scan was given its reads, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. A project is planted with signed units, scanned once by the
 * root form, and scanned again by the body over a RECORDER of the disk reads;
 * the project is then removed, and the body scans over MEMORY replaying the
 * captured answers (the key handed back as a fresh copy, since every scan erases
 * its key bytes). Each leg's snapshot must be equal, the memory leg must make the
 * recorded calls in order and reach no confined primitive, a raced unit must be
 * reclassified by the body, and a body-made snapshot must never pass as a
 * recorded lifecycle read.
 *
 * NOT SHOWN HERE: the confined primitives, the namespace opener and the read
 * lease; the lifecycle snapshot, storage and read suites show those.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as keyObservation from "../../src/preparations/lifecycle-fs/key-observation.js";
import * as leafObservation from "../../src/preparations/lifecycle-fs/leaf-observation.js";
import * as observe from "../../src/preparations/lifecycle-fs/observe.js";
import type { PreparationLifecycleNamespaceV1 } from "../../src/preparations/lifecycle-fs/types.js";
import { assertPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import {
  diskLifecycleScanReads, scanPreparationLifecycle, scanPreparationLifecycleFrom, type LifecycleScanReads,
} from "../../src/preparations/lifecycle-snapshot/scan.js";
import type { PreparationLifecycleSnapshotV1 } from "../../src/preparations/lifecycle-snapshot/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { newRecording, plantLifecycleUnits, record, recordingLeafReads, replay, replayingLeafReads, type Recorded } from "./lifecycle-recorded-reads.js";

const tracker = tempRootTracker();
afterEach(() => { vi.restoreAllMocks(); });

/** A key observation with its bytes copied, so a scan's erasure cannot reach the held one. */
const keyCopy = (key: keyObservation.CapturedLifecycleKey) => (key.status === "ok" ? { ...key, key: Buffer.from(key.key) } : key);

/** Wrap the scan's disk reads so every call and answer is recorded. */
function recordingScanReads(reads: LifecycleScanReads, into: Recorded): LifecycleScanReads {
  return {
    assertNamespaceCurrent: () => record(into, `namespace ${into.calls.filter((call) => call.startsWith("namespace")).length}`, reads.assertNamespaceCurrent()),
    // The scan erases the key it is handed, so the recording keeps its OWN copy.
    captureKey: async () => {
      into.calls.push("key");
      const key = await reads.captureKey();
      into.answers.set("key", keyCopy(key));
      return key;
    },
    observeRegistries: (bounds, onEnumerated) => record(into, "registries", reads.observeRegistries(bounds, onEnumerated)),
    unitStillCurrent: (observation) => record(into, `current ${observation.unitId}`, reads.unitStillCurrent(observation)),
    revalidateStorage: (storage) => record(into, "storage", reads.revalidateStorage(storage)),
    assertKeyCurrent: (key) => record(into, "key-current", reads.assertKeyCurrent(key)),
    leaves: recordingLeafReads(reads.leaves, into),
  };
}

/** Memory scan reads replaying `recorded`; `raced` units answer not-current. */
function replayingScanReads(recorded: Recorded, log: string[], raced = new Set<string>()): LifecycleScanReads {
  let namespaceChecks = 0;
  return {
    assertNamespaceCurrent: () => replay(recorded, log, `namespace ${namespaceChecks++}`),
    captureKey: async () => keyCopy(await replay(recorded, log, "key")),
    observeRegistries: () => replay(recorded, log, "registries"),
    unitStillCurrent: async (observation) => (raced.has(observation.unitId) ? false : replay(recorded, log, `current ${observation.unitId}`)),
    revalidateStorage: () => replay(recorded, log, "storage"),
    assertKeyCurrent: () => replay(recorded, log, "key-current"),
    leaves: replayingLeafReads(recorded, log),
  };
}

let ROOT: string, NAMESPACE: PreparationLifecycleNamespaceV1, BY_ROOT: PreparationLifecycleSnapshotV1, RECORDED_SNAPSHOT: PreparationLifecycleSnapshotV1;
const RECORDED = newRecording();

beforeAll(async () => {
  ROOT = await tracker.create("lifecycle-scan-binding-", { real: true });
  NAMESPACE = await plantLifecycleUnits(ROOT);
  BY_ROOT = await scanPreparationLifecycle(NAMESPACE);
  RECORDED_SNAPSHOT = await scanPreparationLifecycleFrom(recordingScanReads(diskLifecycleScanReads(NAMESPACE), RECORDED), NAMESPACE);
  await rm(ROOT, { recursive: true, force: true });
});

describe("the lifecycle scan over its reads, with the project gone", () => {
  it("S1 the body over the disk's reads answers exactly as the root form did, classifying each planted unit", () => {
    expect(RECORDED_SNAPSHOT).toEqual(BY_ROOT);
    expect([BY_ROOT.complete, BY_ROOT.units.map((unit) => `${unit.unitId} ${unit.state}`)])
      .toEqual([true, ["prn-applying applying", "qtn-planned planned", "qtn-retained completed"]]);
  });

  it("S2 over memory the body makes the recorded calls in order, reaches no confined primitive, and answers the same snapshot", async () => {
    const primitives = [vi.spyOn(observe, "observeLifecycleRegistries"), vi.spyOn(keyObservation, "captureLifecycleKey"),
      vi.spyOn(keyObservation, "assertLifecycleKeyObservationCurrent"), vi.spyOn(leafObservation, "readLifecycleLeaf"), vi.spyOn(leafObservation, "observeLifecyclePlannedLeaf")];
    const log: string[] = [];
    const memory = await scanPreparationLifecycleFrom(replayingScanReads(RECORDED, log), NAMESPACE);
    expect([memory, log]).toEqual([BY_ROOT, RECORDED.calls]);
    expect(primitives.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("S3 a unit whose identity raced is reclassified unavailable by the body, and the snapshot is incomplete", async () => {
    const memory = await scanPreparationLifecycleFrom(replayingScanReads(RECORDED, [], new Set(["qtn-planned"])), NAMESPACE);
    expect([memory.complete, memory.units.find((unit) => unit.unitId === "qtn-planned")?.state, memory.digest === BY_ROOT.digest]).toEqual([false, "unavailable", false]);
  });

  it("S4 a snapshot the body made is never a recorded lifecycle read", async () => {
    const forged = Object.freeze({ status: "ok" as const, snapshot: BY_ROOT });
    await expect(assertPreparationLifecycleRead(ROOT, forged)).rejects.toMatchObject({ code: "read-unproven" });
  });
});
