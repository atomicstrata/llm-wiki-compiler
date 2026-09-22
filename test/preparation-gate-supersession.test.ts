/**
 * @file test/preparation-gate-supersession.test.ts
 * @description A later gate decision SUPERSEDES an earlier one, and the operator's
 * stated reason survives the write.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The gate ledger is append-only and a gate may
 * be decided repeatedly, so an order-insensitive search for "any approval ever"
 * made `rejected` and `revised` inert: approve, then reject, and every downstream
 * consumer still read the approval. Two shell commands would have told an
 * operator they revoked an approval they did not revoke — the CLI prints
 * "recorded rejected" and exits 0 either way. Existing coverage only exercised
 * the harmless directions (a lone rejection, and revised-then-approved).
 *
 * WHY SUPERSESSION IS THE RIGHT READING, rather than refusing a second decision:
 * design section 17.3 says a rejection "may cancel future effect-free work", and
 * EVERY consumer of the finder is a pre-start check on future work — an effect
 * start, a follow-up effect, a reconciliation settlement. None of them undoes a
 * settled effect, which is the one thing 17.3 says a rejection cannot do.
 *
 * AND THE REASON CODE. 17.3 also says a rejection "durably records the rejected
 * digest AND reason code". It was accepted by four surfaces, bound into the gate
 * fact's digest, and then dropped on the floor — which also made that digest
 * permanently unreconstructible from the record.
 */

import { describe, expect, it } from "vitest";
import { findApprovedGateProof } from "../src/preparations/gates.js";
import type { GateDecision, GateResultV1 } from "../src/preparations/service.js";
import {
  REVIEW_GATE_GRANTS, SEED_GATE_ID, currentPlanDigest, gateServiceOn, gatedRun, readGateRun,
  type GateFixture,
} from "./preparation-gate-fixture.js";

/** Decide the fixture's gate, optionally with an operator reason code. */
function decide(
  fixture: GateFixture, decision: GateDecision, reasonCode?: string,
): Promise<GateResultV1> {
  return gateServiceOn(fixture.root, "sdk", REVIEW_GATE_GRANTS).gate({
    runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

/** Ask the CONSUMER, off disk, whether this gate is approved right now. */
async function approvalVisibleToConsumers(fixture: GateFixture): Promise<boolean> {
  const run = await readGateRun(fixture);
  return findApprovedGateProof(run.gateProofs, SEED_GATE_ID, await currentPlanDigest(fixture)) !== undefined;
}

describe("the latest decision on a gate is the operative one", () => {
  it("a REJECTION after an approval revokes it", async () => {
    const fixture = await gatedRun("gatesupersede");
    try {
      await decide(fixture, "approved");
      expect(await approvalVisibleToConsumers(fixture)).toBe(true);
      await decide(fixture, "rejected", "stale-input");
      // BOTH proofs are on the ledger — nothing is rewritten — and the consumer
      // reads the later one. An append-only record with a high-water-mark reader
      // is what made the rejection inert.
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(2);
      expect(await approvalVisibleToConsumers(fixture)).toBe(false);
    } finally { await fixture.cleanup(); }
  });

  it("a REVISION after an approval revokes it too", async () => {
    const fixture = await gatedRun("gaterevise");
    try {
      await decide(fixture, "approved");
      await decide(fixture, "revised");
      expect(await approvalVisibleToConsumers(fixture)).toBe(false);
    } finally { await fixture.cleanup(); }
  });

  it("an operator who changes their mind back is honoured", async () => {
    // The other direction, and it is why supersession beats refusing a second
    // decision: the ledger is a record of intent, not a one-way latch.
    const fixture = await gatedRun("gatereapprove");
    try {
      await decide(fixture, "approved");
      await decide(fixture, "rejected");
      await decide(fixture, "approved");
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(3);
      expect(await approvalVisibleToConsumers(fixture)).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  it("a lone rejection still refuses, so the change did not relax anything", async () => {
    const fixture = await gatedRun("gateloneReject");
    try {
      await decide(fixture, "rejected");
      expect(await approvalVisibleToConsumers(fixture)).toBe(false);
    } finally { await fixture.cleanup(); }
  });
});

describe("the operator's reason code is durable", () => {
  it("survives the write and is readable off disk", async () => {
    const fixture = await gatedRun("gatereason");
    try {
      const marker = "operator-said-no-7f3a";
      const result = await decide(fixture, "rejected", marker);
      expect(result.status).toBe("recorded");
      // OFF DISK, through the loader that re-derives the proof id and re-parses
      // every field: a value the parser rejected would never get this far.
      const run = await readGateRun(fixture);
      expect(run.gateProofs[0]?.reasonCode).toBe(marker);
    } finally { await fixture.cleanup(); }
  });

  it("is absent rather than empty when the operator gave none", async () => {
    const fixture = await gatedRun("gatenoreason");
    try {
      await decide(fixture, "approved");
      expect((await readGateRun(fixture)).gateProofs[0]).not.toHaveProperty("reasonCode");
    } finally { await fixture.cleanup(); }
  });

  it("refuses a reason code the bounded-component reader would not admit", async () => {
    // The label goes onto a SIGNED leaf, so it takes the same reader every other
    // operator-supplied component on that record takes. A control character is
    // the cheapest proof that the reader is genuinely applied.
    const fixture = await gatedRun("gatebadreason");
    try {
      const result = await decide(fixture, "rejected", "bad\u0000code");
      expect(result.status).toBe("refused");
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });
});
