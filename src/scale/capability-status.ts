/**
 * @file src/scale/capability-status.ts
 * @description The status of one version 3 capability in a project's scale
 * record: `absent` (no readable version 2+ record names it), `preparing`, or
 * `ready` (the preparation that verified it published it). A capability's
 * new authority is served only once `ready`; while `preparing`, the gate
 * blocks dependent work and the incumbent authority stays in force.
 *
 * FAIL CLOSED. A missing or unreadable record beside indexed stores cannot
 * say which authority holds the project's state: the read refuses
 * (`scale-state-unreadable`), exactly as the indexed route does, rather than
 * answering `absent` and letting an incumbent file be served in its place.
 */

import type { CapabilityNameV3 } from "./contracts-v2.js";
import { ScaleGateError } from "./gate.js";
import { indexedStoresMayExist, readScaleRecord } from "./record.js";

/** The status of capability `name` for the project at `root`. */
export async function capabilityStatus(root: string, name: CapabilityNameV3): Promise<"absent" | "preparing" | "ready"> {
  const read = await readScaleRecord(root);
  if (read.kind !== "ok") {
    if (await indexedStoresMayExist(root)) throw new ScaleGateError("scale-state-unreadable", read.kind === "unreadable" ? read.reason : "indexed stores exist but the scale record is missing");
    return "absent";
  }
  if (read.record.version === 1) return "absent";
  return read.record.capabilities?.find((capability) => capability.name === name)?.status ?? "absent";
}
