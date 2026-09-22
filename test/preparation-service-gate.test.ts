/**
 * @file test/preparation-service-gate.test.ts
 * @description The `gate` operation's own behaviour at the service seam.
 *
 * THE TEST THIS FILE EXISTS FOR IS THE REREAD. A gate decision that authored a
 * correct proof and appended only its transition would report success and
 * authorize nothing: the plain transition writer never populates `gateProofs`,
 * so `findApprovedGateProof` — the function the whole recording exists to feed —
 * would never find the approval. Asserting the returned DTO cannot tell those
 * apart. Reloading the run from disk and asking the CONSUMER can, and that is
 * what "records authority" has to mean.
 *
 * AND THE PAIR THAT MAKES THE FIRST ONE DISCRIMINATING: a decision must NOT move
 * the run. The two assertions together are the whole of "records authority and
 * performs nothing" — one alone is satisfied by a write that also drives state,
 * the other by a write that records nothing at all.
 */

import { describe, expect, it } from "vitest";
import { findApprovedGateProof } from "../src/preparations/gates.js";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { readPreparationManifest } from "../src/preparations/manifest-store.js";
import { PrincipalAuthorityError } from "../src/preparations/service.js";
import type { GateResultV1 } from "../src/preparations/service.js";
import { parseSha256Digest } from "../src/capability-providers/ids.js";
import {
  EFFECT_GATE_GRANTS, REVIEW_GATE_GRANTS, SEED_GATE_ID, currentPlanDigest, gateServiceOn,
  gatedRun, readGateRun, type GateFixture,
} from "./preparation-gate-fixture.js";

/** Decide the fixture's gate through a granted `sdk` service. */
function decide(
  fixture: GateFixture, decision: "approved" | "rejected" | "revised" = "approved",
  grants: readonly string[] = REVIEW_GATE_GRANTS, id = "host-2",
): Promise<GateResultV1> {
  return gateServiceOn(fixture.root, "sdk", grants as never, id).gate({
    runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision,
  });
}

describe("gate records authority and performs nothing", () => {
  it("persists a proof the approval CONSUMER finds after a reload", async () => {
    const fixture = await gatedRun("gatereread");
    try {
      const result = await decide(fixture);
      expect(result).toMatchObject({ status: "recorded", decision: "approved", decisionIndex: 0 });
      // THE REREAD. Off disk, through the consumer, not through the DTO.
      const run = await readGateRun(fixture);
      const found = findApprovedGateProof(run.gateProofs, SEED_GATE_ID, await currentPlanDigest(fixture));
      expect(found?.gateProofId).toBe(result.status === "recorded" ? result.gateProofId : undefined);
    } finally { await fixture.cleanup(); }
  });

  it("leaves the run exactly where it was and adds one transition", async () => {
    const fixture = await gatedRun("gatestill");
    try {
      const before = await readGateRun(fixture);
      await decide(fixture);
      const after = await readGateRun(fixture);
      expect(after.state).toBe(before.state);
      expect(after.transitions.length).toBe(before.transitions.length + 1);
      expect(after.transitions.at(-1)).toMatchObject({
        type: "gate-decided", stateBefore: before.state, stateAfter: before.state,
      });
    } finally { await fixture.cleanup(); }
  });

  it("credits the HOST principal, never a request field", async () => {
    const fixture = await gatedRun("gateactor");
    try {
      await decide(fixture, "approved", REVIEW_GATE_GRANTS, "agent-9");
      const run = await readGateRun(fixture);
      expect(run.transitions.at(-1)?.actor).toMatchObject({ id: "agent-9", surface: "sdk" });
      expect(run.gateProofs[0]?.actor).toMatchObject({ id: "agent-9", surface: "sdk" });
    } finally { await fixture.cleanup(); }
  });
});

describe("the decision index is derived from the run's own proofs", () => {
  it("advances per gate rather than colliding on a caller-chosen index", async () => {
    const fixture = await gatedRun("gateindex");
    try {
      expect(await decide(fixture, "revised")).toMatchObject({ decisionIndex: 0 });
      expect(await decide(fixture, "approved")).toMatchObject({ decisionIndex: 1 });
      const run = await readGateRun(fixture);
      expect(run.gateProofs.map((proof) => proof.decisionIndex)).toEqual([0, 1]);
      // Distinct ids: a repeated index would make the second record unparseable.
      expect(new Set(run.gateProofs.map((proof) => proof.gateProofId)).size).toBe(2);
    } finally { await fixture.cleanup(); }
  });

  it("records a rejection that the approval consumer does NOT find", async () => {
    const fixture = await gatedRun("gatereject");
    try {
      expect(await decide(fixture, "rejected")).toMatchObject({ status: "recorded" });
      const run = await readGateRun(fixture);
      expect(run.gateProofs).toHaveLength(1);
      expect(findApprovedGateProof(run.gateProofs, SEED_GATE_ID, await currentPlanDigest(fixture)))
        .toBeUndefined();
    } finally { await fixture.cleanup(); }
  });
});

describe("gate authority is the KIND's, and the kind comes from the plan", () => {
  it("refuses a principal holding no gate grant before it takes the lock", async () => {
    const fixture = await gatedRun("gatenogrant");
    try {
      const result = await decide(fixture, "approved", []);
      expect(result).toMatchObject({ status: "refused" });
      expect(result.status === "refused" && result.reason).toMatch(/no gate-deciding grant/);
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("THROWS missing-grant for a caller holding the wrong gate's grant", async () => {
    const fixture = await gatedRun("gatewrong");
    try {
      // The effect grant passes the coarse pre-filter and is refused by the exact
      // per-kind check, which is the only thing that can tell the two apart.
      await expect(decide(fixture, "approved", EFFECT_GATE_GRANTS))
        .rejects.toBeInstanceOf(PrincipalAuthorityError);
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });
});
