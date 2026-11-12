/**
 * @file test/storage/lifecycle-classifier-binding.test.ts
 * @description The pass-one lifecycle classifiers as ONE body each over the
 * classifiers' leaf-read seam, `classifyPrunePassOneFrom` and
 * `classifyQuarantinePassOneFrom` over `LifecycleLeafReads`, with the units'
 * files gone. This file uses them, which exist only after the classifiers were
 * given their reads, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Real signed prune and quarantine units are planted at several
 * protocol positions and observed once. Each unit is classified by the root form
 * while a recorder captures every leaf observation it made; the project is then
 * removed, and the bound body classifies the same observation over MEMORY that
 * replays the captured answers, reaching no confined-leaf primitive. The answers
 * must be equal, and the memory leg must ask for exactly the leaves the disk leg
 * read, in the same order.
 *
 * NOT SHOWN HERE: the confined primitives themselves, the scan, the snapshot and
 * read authority; the lifecycle snapshot, storage and read suites show those.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as leafObservation from "../../src/preparations/lifecycle-fs/leaf-observation.js";
import { lifecycleScanBounds } from "../../src/preparations/lifecycle-fs/bounds.js";
import { captureLifecycleKey, type CapturedLifecycleKey } from "../../src/preparations/lifecycle-fs/key-observation.js";
import { observeLifecycleRegistries } from "../../src/preparations/lifecycle-fs/observe.js";
import type { PreparationLifecycleNamespaceV1 } from "../../src/preparations/lifecycle-fs/types.js";
import { diskLifecycleLeafReads } from "../../src/preparations/lifecycle-snapshot/classifier-types.js";
import { classifyPrunePassOne, classifyPrunePassOneFrom } from "../../src/preparations/lifecycle-snapshot/prune-classifier.js";
import { classifyQuarantinePassOne, classifyQuarantinePassOneFrom } from "../../src/preparations/lifecycle-snapshot/quarantine-classifier.js";
import { tempRootTracker } from "../temp-roots.js";
import { newRecording, plantLifecycleUnits, recordingLeafReads, replayingLeafReads, type Recorded } from "./lifecycle-recorded-reads.js";

const tracker = tempRootTracker();
afterEach(() => { vi.restoreAllMocks(); });

/** One classified unit: its disk answer and recording, and its observation. */
interface Held { unitId: string; disk: unknown; recorded: Recorded; observation: unknown }
let NAMESPACE: PreparationLifecycleNamespaceV1, KEY: CapturedLifecycleKey, HELD: Held[];
const BOUNDS = () => lifecycleScanBounds({});

beforeAll(async () => {
  const root = await tracker.create("lifecycle-classifier-binding-", { real: true });
  NAMESPACE = await plantLifecycleUnits(root);
  KEY = await captureLifecycleKey(NAMESPACE);
  const observed = await observeLifecycleRegistries(NAMESPACE, BOUNDS());
  HELD = [];
  for (const observation of observed.units) {
    const recorded = newRecording();
    const reads = recordingLeafReads(diskLifecycleLeafReads(NAMESPACE), recorded);
    const input = { namespace: NAMESPACE, observation, key: KEY, bounds: BOUNDS() };
    const disk = observation.unitId.startsWith("prn-")
      ? await classifyPrunePassOneFrom(reads, NAMESPACE, observation, KEY, input.bounds)
      : await classifyQuarantinePassOneFrom(reads, input);
    HELD.push({ unitId: observation.unitId, disk, recorded, observation });
  }
  await rm(root, { recursive: true, force: true });
});

describe("the pass-one classifiers over captured leaves, with the project gone", () => {
  it("C1 classified each planted unit at its own protocol position on disk", () => {
    const states = Object.fromEntries(HELD.map((held) => [held.unitId, (held.disk as { unit: { state: string } }).unit.state]));
    expect(states).toEqual({ "prn-applying": "applying", "qtn-planned": "planned", "qtn-retained": "completed" });
  });

  it("C2 the bound body answers every unit as the disk did, asking the same leaves in the same order, and reaches no primitive", async () => {
    const primitives = [vi.spyOn(leafObservation, "readLifecycleLeaf"), vi.spyOn(leafObservation, "lifecycleRegularLeaf"), vi.spyOn(leafObservation, "observeLifecyclePlannedLeaf")];
    for (const held of HELD) {
      const log: string[] = [];
      const reads = replayingLeafReads(held.recorded, log);
      const observation = held.observation as never;
      const memory = held.unitId.startsWith("prn-")
        ? await classifyPrunePassOneFrom(reads, NAMESPACE, observation, KEY, BOUNDS())
        : await classifyQuarantinePassOneFrom(reads, { namespace: NAMESPACE, observation, key: KEY, bounds: BOUNDS() });
      expect([held.unitId, memory, log]).toEqual([held.unitId, held.disk, held.recorded.calls]);
    }
    expect(primitives.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("C3 the root forms hand each primitive the namespace's confined root", async () => {
    const read = vi.spyOn(leafObservation, "readLifecycleLeaf").mockResolvedValue({ status: "absent" });
    const held = HELD.find((entry) => entry.unitId === "prn-applying")!;
    await classifyPrunePassOne(NAMESPACE, held.observation as never, KEY, BOUNDS());
    const quarantine = HELD.find((entry) => entry.unitId === "qtn-planned")!;
    await classifyQuarantinePassOne({ namespace: NAMESPACE, observation: quarantine.observation as never, key: KEY, bounds: BOUNDS() });
    expect(read.mock.calls.map((call) => call[0].root)).toEqual([NAMESPACE.root.realPath, NAMESPACE.root.realPath]);
  });
});
