/**
 * @file test/preparations/attempt-custody-dedup.test.ts
 * @description Temporary output custody is CONTENT-ADDRESSED (design section 15.2
 * legs H and L): two accepted artifacts whose bytes hash alike are ONE custody
 * object referenced by two evidence refs, exactly as the create-only evidence CAS
 * treats them at publication. The regression these cases pin is the zero-write
 * violation that shape used to cause — the create-only collision threw past the
 * leg's discard and STRANDED a `prep-attempt-custody-*` directory on both the
 * durable attempt path and the ephemeral read.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPreparationEvidence } from "../../src/preparations/evidence-store.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { providerLegRunner, type ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { ProviderInvocationHostV1 } from "../../src/capability-providers/runtime/invoke.js";
import {
  attemptRequest, completedProviderInvoke, evidenceLocation, providerRequest, stagePreparation,
  type StagedPreparation,
} from "./attempt-fixture.js";
import { ephemeralRequest, runFixtureRead, withEphemeralSandbox } from "./ephemeral-fixture.js";

const HOST = {} as ProviderInvocationHostV1;
const BYTES = Buffer.from("identical-output-bytes");
const HEX = createHash("sha256").update(BYTES).digest("hex");
/** Custody directories are the only residue these cases may never leave behind. */
const CUSTODY_PREFIX = "prep-attempt-custody-";

let staged: StagedPreparation;
let outputRoot: string;
beforeEach(async () => {
  staged = await stagePreparation();
  outputRoot = await mkdtemp(path.join(tmpdir(), "custody-dedup-"));
  await writeFile(path.join(outputRoot, "first.json"), BYTES);
  await writeFile(path.join(outputRoot, "second.json"), BYTES);
});
afterEach(async () => {
  await staged.cleanup();
  await rm(outputRoot, { recursive: true, force: true });
});

/** One artifact claim over a file whose bytes hash to the shared digest. */
function artifact(outputId: string, file: string) {
  return {
    outputId, mediaType: "application/json", digest: `sha256:${HEX}`, byteCount: BYTES.byteLength,
    evidence: { evidencePath: path.join(outputRoot, file), digest: `sha256:${HEX}`, byteCount: BYTES.byteLength },
  };
}

/** A completed provider result declaring two outputs with identical bytes. */
function twinOutputs(): ProviderInvokeFn {
  return completedProviderInvoke([artifact("first", "first.json"), artifact("second", "second.json")]);
}

/** Every custody directory left under the sandboxed temporary root. */
function custodyResidue(residue: readonly string[]): readonly string[] {
  return residue.filter((entry) => entry.startsWith(CUSTODY_PREFIX));
}

/** Run one durable attempt whose provider returns the twin identical outputs. */
function twinAttempt() {
  const input = { request: providerRequest(), host: HOST, preparationRunId: staged.binding.runId };
  return executePhaseAttempt(attemptRequest(staged, { leg: providerLegRunner(input, twinOutputs()) }));
}

describe("identical-byte output custody", () => {
  it("commits both refs against one published object on the durable attempt path", async () => {
    const outcome = await twinAttempt();
    const published = await readPreparationEvidence(staged.root, evidenceLocation(staged), HEX);
    // The joint fact: the phase committed AND the shared object is in the CAS once.
    expect([outcome.status === "committed" && outcome.phaseState, published.status]).toEqual(["succeeded", "ok"]);
  });

  it("strands no temporary custody on the durable attempt path", async () => {
    const run = await withEphemeralSandbox(twinAttempt);
    expect(run.result.status).toBe("committed");
    expect(custodyResidue(run.residue)).toEqual([]);
  });

  it("projects both ephemeral outputs from the one custodied object, leaving nothing", async () => {
    const run = await withEphemeralSandbox(() => runFixtureRead(ephemeralRequest(), twinOutputs()));
    const result = run.result;
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.outputs.map((output) => output.provenanceLabel)).toEqual(["first", "second"]);
    expect(result.outputs.every((output) => Buffer.from(output.bytes).equals(BYTES))).toBe(true);
    expect(run.residue).toEqual([]);
  });
});
