/**
 * @file test/operations-packs/pack-chaining-units.test.ts
 * @description The G1 chaining units the end-to-end drive cannot reach: the
 * completeness deficit when a chained terminal DROPS one of several predecessor
 * items (the drive's single-item input can only exercise 1→1), and the
 * fixed-code refusal for a `phase-output` binding whose predecessor is not a
 * `single` expansion (multi-instance sources are out of G1's scope).
 *
 * The deficit case is the teeth of source-aware completeness: `planned` comes
 * from the predecessor's PUBLISHED items and `completed` from the drafts, so a
 * terminal that produced a draft for one of two published items must show one
 * REQUIRED deficit — a `planned` taken from the drafts could never show it.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileIntents } from "../../src/operations-packs/handlers/intent-compile.js";
import type { PackEvidenceItemV1 } from "../../src/operations-packs/handlers/types.js";
import { createPackMaterializer } from "../../src/operations-packs/runtime/materializer.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import {
  deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity,
} from "../../src/preparations/ids.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import { mixedTerminalPaperRequest, multiSourceSingleIntentRequest } from "./compile-fixture.js";
import { actionInputItemIdentities } from "../../src/operations-packs/runtime/host-registry.js";
import { compileTwoPhasePaperAction } from "./runtime-fixture.js";

const INPUT = { topic: "superconductivity", doi: "10.1/abc" } as const;

/** One predecessor-published paper candidate under the given identity. */
function paperItem(itemId: string): PackEvidenceItemV1 {
  return { itemId, fields: { topic: INPUT.topic, doi: INPUT.doi } };
}

/** The bare sha256 hex of one canonical byte buffer. */
function hexOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal durable phase summary carrying one published output digest. */
function summaryOf(logicalPhaseId: string, hex: string, attempt?: string) {
  return {
    logicalPhaseId, state: "succeeded", outputEvidenceDigest: `sha256:${hex}`,
    ...(attempt === undefined ? {} : { currentAttemptId: attempt }),
  };
}

/**
 * Materialize one synthesized chained run — the predecessor `pick` PUBLISHED
 * `predecessorItems`, the terminal `propose` drafted over `draftedEvidence` —
 * and return the derived required-deficit count.
 */
function materializedDeficits(
  action: CompiledPackActionV1,
  predecessorItems: readonly PackEvidenceItemV1[],
  draftedEvidence: readonly PackEvidenceItemV1[],
): number {
  const outcome = materializeChained(action, { items: predecessorItems }, draftedEvidence);
  return (outcome.result as { completeness: { requiredDeficitCount: number } }).completeness.requiredDeficitCount;
}

/** Materialize with the predecessor publishing arbitrary output — deficits and all. */
function materializeChained(
  action: CompiledPackActionV1,
  predecessorOutput: Readonly<Record<string, unknown>>,
  draftedEvidence: readonly PackEvidenceItemV1[],
): ReturnType<ReturnType<typeof createPackMaterializer>["materialize"]> {
  const propose = action.phaseBindings.find((entry) => entry.logicalPhaseId === "propose")!;
  const predecessor = canonicalBytes(predecessorOutput);
  const terminal = canonicalBytes(compileIntents({
    body: propose.body as never, evidence: draftedEvidence, bounds: propose.bounds,
    identities: { runId: "prr_test", principal: "pack-runtime", hostTimestamp: "2026-08-16T00:00:00.000Z" },
  }));
  const attemptId = deriveAttemptId(derivePhaseInstanceId({
    manifestDigest: `sha256:${"c".repeat(64)}`, logicalPhaseId: "propose",
    expansionIdentity: singleExpansionIdentity(),
  }), 0);
  const run = {
    phaseSummaries: [summaryOf("pick", hexOf(predecessor)), summaryOf("propose", hexOf(terminal), attemptId)],
    evidenceRefs: [{
      kind: "host-output", mediaType: "application/json", provenanceLabel: "pack-intent-compile-output",
      digest: `sha256:${hexOf(terminal)}`, byteCount: terminal.byteLength,
      sensitivity: "normal", retention: "until-handoff", untrusted: true,
      producer: { kind: "host", contractDigest: action.materializationSpec.handlerContractDigest },
    }],
  } as unknown as PreparationRunV1;
  const evidence = new Map([[hexOf(predecessor), predecessor], [hexOf(terminal), terminal]]);
  return createPackMaterializer(action).materialize({ run, evidence });
}

describe("G4a: the action-input decoder zips list fields into source items", () => {
  it("decodes a two-entry list column to positional source identities", () => {
    const bytes = canonicalBytes({ topic: "t", doi: ["10.1/a", "10.1/b"] });
    expect(actionInputItemIdentities(bytes)).toEqual(["source-0", "source-1"]);
  });

  it("keeps the single reserved identity for an all-scalar input, byte-identically", () => {
    expect(actionInputItemIdentities(canonicalBytes({ topic: "t", doi: "10.1/a" }))).toEqual(["action-input"]);
  });

  it("refuses list columns that disagree on length rather than truncating", () => {
    // Zipping unequal columns would silently reassign values across records.
    expect(actionInputItemIdentities(canonicalBytes({ a: ["x"], b: ["y", "z"] }))).toBeNull();
  });
});

describe("G1 chained completeness keeps its deficit teeth", () => {
  it("shows one REQUIRED deficit when the terminal drops one of two predecessor items", async () => {
    // The predecessor PUBLISHED two candidates; the terminal drafted for only one.
    const action = await compileTwoPhasePaperAction(INPUT);
    expect(materializedDeficits(action, [paperItem("paper-1"), paperItem("paper-2")], [paperItem("paper-1")])).toBe(1);
  });

  it("plans the UNION of a mixed terminal's sources: an empty predecessor beside the action input is one item, not a refusal", async () => {
    // The executor gives a terminal bound to BOTH sources their union, so
    // `planned` must be that union too: action input (1 item) ∪ empty pick
    // selection = 1 planned, 1 drafted, no deficit. Deriving `planned` from the
    // one empty predecessor instead refused this legitimate run outright.
    const action = await compilePackAction(mixedTerminalPaperRequest(INPUT));
    expect(materializedDeficits(action, [], [{ itemId: "action-input", fields: { ...INPUT } }])).toBe(0);
  });

  it("shows one REQUIRED deficit when a multi-source terminal drops one of two sources", async () => {
    // The terminal binds the ACTION INPUT, whose doi column decodes to two
    // source items — `planned` is those two identities, so drafting for only
    // source-0 must show the dropped source as a deficit.
    const action = await compilePackAction(multiSourceSingleIntentRequest({ topic: "t", doi: ["10.1/a", "10.1/b"] }));
    const drafted = [{ itemId: "source-0", fields: { topic: "t", doi: "10.1/a" } }];
    expect(materializedDeficits(action, [], drafted)).toBe(1);
  });
});

describe("a recorded required-class deficit refuses materialization", () => {
  /** The two-phase action with the given classes declared refusal-worthy. */
  async function actionRequiring(classes: readonly string[]): Promise<CompiledPackActionV1> {
    const action = await compileTwoPhasePaperAction(INPUT);
    return { ...action, materializationSpec: { ...action.materializationSpec, requiredCompletenessClasses: classes } };
  }

  /** The predecessor output of one valid item plus one recorded invalid-row deficit. */
  const DEFICIT_OUTPUT = {
    items: [paperItem("paper-1")],
    deficits: [{ completenessClass: "row-validity", reason: "invalid-row", droppedCount: 1 }],
  } as const;

  it("REFUSES handoff when a predecessor recorded an invalid-row deficit in a required class", async () => {
    // The P1 this pins: the deficit lived only in the select phase's output
    // JSON — items decoded, deficits discarded — so the valid row drafted, the
    // malformed row vanished, and completeness reported ZERO required deficits.
    const action = await actionRequiring(["row-validity"]);
    expect(() => materializeChained(action, DEFICIT_OUTPUT, [paperItem("paper-1")]))
      .toThrowError(/invalid-row deficit of 1 in required completeness class row-validity/);
  });

  it("still materializes when the recorded deficit's class is not required", async () => {
    const action = await actionRequiring(["some-other-class"]);
    const outcome = materializeChained(action, DEFICIT_OUTPUT, [paperItem("paper-1")]);
    expect((outcome.result as { completeness: { requiredDeficitCount: number } })
      .completeness.requiredDeficitCount).toBe(0);
  });
});
