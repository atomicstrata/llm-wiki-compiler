/**
 * @file test/preparations/exposure.test.ts
 * @description The Task 4 exposure-gate primitive: given a materialized Provider
 * V2 input snapshot, `deriveProviderPhaseExposure` derives the provider exposure
 * set through the shared primitive so the provider digest equals THAT snapshot's
 * digest, and binds sensitivity and allowed destinations into a preparation
 * digest. Adding, removing, replacing, or reordering an input drifts the provider
 * exposure-set digest; changing an allowed egress destination drifts only the
 * preparation digest. This exercises the derivation in isolation — it does not
 * imply the snapshot is any invocation's eventual snapshot; wiring it to the
 * invocation gate is Task 4 (see exposure.ts and the decision log).
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { providerExposureDigest } from "../../src/capability-providers/authority/exposure.js";
import { materializeProviderInputs } from "../../src/capability-providers/runtime/inputs.js";
import type { ProviderInputRefV1 } from "../../src/capability-providers/authority/types.js";
import { prepareStructuredValueInput } from "../../src/preparations/inputs.js";
import {
  deriveProviderPhaseExposure, type PhaseExposureEntryV1, type PhaseExposureRowV1,
  type PreparationPhaseExposureV1,
} from "../../src/preparations/exposure.js";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** Materialize one ordered provider input set through the real Provider V2 seam. */
async function materialize(names: readonly string[]): Promise<{ inputs: readonly ProviderInputRefV1[]; digest: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-exposure-"));
  scratch.push(dir);
  const specs = names.map((name) => {
    const prepared = prepareStructuredValueInput({
      value: { name }, sourceIdentity: `struct/${name}`, provenanceLabel: name,
      mediaType: "application/json", sensitivity: "ordinary", retention: "until-handoff", evidenceKind: "prepared-input",
    });
    return { inputId: prepared.input.inputId, kind: prepared.input.kind, provenanceLabel: prepared.input.provenanceLabel, mediaType: prepared.input.mediaType, bytes: prepared.bytes };
  });
  const materialized = await materializeProviderInputs(dir, specs);
  return { inputs: materialized.inputs, digest: materialized.exposureDigest };
}

/** Pair each materialized provider input with a single allowed destination. */
function entries(inputs: readonly ProviderInputRefV1[], destination = "broker:model"): PhaseExposureEntryV1[] {
  return inputs.map((providerInput) => ({ providerInput, sensitivity: "ordinary", allowedDestinations: [destination] }));
}

describe("deriveProviderPhaseExposure", () => {
  it("equals the supplied snapshot's input-set digest and derives through the Provider V2 primitive", async () => {
    const { inputs, digest } = await materialize(["a", "b"]);
    const exposure: PreparationPhaseExposureV1 = deriveProviderPhaseExposure(entries(inputs));
    expect(exposure.providerExposure.inputExposureSetDigest).toBe(digest);
    expect(providerExposureDigest(exposure.providerExposure.inputs)).toBe(exposure.providerExposure.inputExposureSetDigest);
    const rows: readonly PhaseExposureRowV1[] = exposure.display;
    expect(rows.map((row) => row.inputId)).toEqual(exposure.providerExposure.inputs.map((i) => i.inputId));
  });

  it("drifts the provider set on add, remove, replace, and reorder", async () => {
    const base = deriveProviderPhaseExposure(entries((await materialize(["a", "b"])).inputs)).exposureDigest;
    const digestOf = async (names: string[]) => deriveProviderPhaseExposure(entries((await materialize(names)).inputs)).exposureDigest;
    expect(await digestOf(["a", "b", "c"])).not.toBe(base); // added
    expect(await digestOf(["a"])).not.toBe(base); // removed
    expect(await digestOf(["a", "c"])).not.toBe(base); // replaced
    expect(await digestOf(["b", "a"])).not.toBe(base); // reordered
  });

  it("drifts the preparation digest on a changed destination while the provider set holds", async () => {
    const { inputs } = await materialize(["a", "b"]);
    const base = deriveProviderPhaseExposure(entries(inputs, "broker:model"));
    const moved = deriveProviderPhaseExposure(entries(inputs, "broker:network"));
    expect(moved.providerExposure.inputExposureSetDigest).toBe(base.providerExposure.inputExposureSetDigest);
    expect(moved.exposureDigest).not.toBe(base.exposureDigest);
  });
});
