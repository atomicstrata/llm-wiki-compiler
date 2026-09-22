/**
 * @file test/preparation-sdk-gate-handoff.test.ts
 * @description The `gate` and `handoff` methods on the SDK facade.
 *
 * THE SDK SURFACE IS WHERE A GRANT CHECK HAS CONTENT. A `cli` principal unions
 * the whole local-operator set by transport, so a refusal written against it
 * proves nothing; an `sdk` principal holds exactly its explicit grants. Both
 * missing-grant cases here are therefore written on `sdk`, and each is paired
 * with the durable re-read that a refusal-after-committing would fail.
 *
 * AND THE PER-KIND GRANT IS THE ONE THAT MATTERS FOR `gate`. It is the only
 * operation in the service whose cost is not fixed at construction: the kind is
 * read from the run's own plan, so a caller holding one gate grant is admitted to
 * the gates that kind pays for and refused the others. A suite that only proved
 * "some grant is required" would be satisfied by charging any single token.
 */

import { describe, expect, it } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import { PrincipalAuthorityError } from "../src/preparations/service.js";
import { scanOperationInventory } from "../src/operation-bundles/capacity.js";
import { readPreparationRun } from "../src/preparations/run-store.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { handoffObligations, stageReadyPreparation } from "./preparations/handoff-fixture.js";
import {
  SEED_GATE_ID, gatedRun, readGateRun, type GateFixture,
} from "./preparation-gate-fixture.js";

const root = useTempRoot();

/** A wiki whose SDK principal holds exactly the named grants. */
function wikiOn(dir: string, grants: readonly string[]) {
  return createWiki({ root: dir, preparation: { id: "embedder", grants: grants as never } });
}

/** Decide the fixture's gate through the SDK facade. */
function gate(fixture: GateFixture, grants: readonly string[], decision = "approved") {
  return wikiOn(fixture.root, grants).gatePreparation({
    runId: fixture.binding.runId, gateId: SEED_GATE_ID, decision: decision as never,
  });
}

describe("gatePreparation records through the same service the CLI uses", () => {
  it("records the decision for a principal holding the kind's grant", async () => {
    const fixture = await gatedRun("sdkgate");
    try {
      expect(await gate(fixture, ["preparation.gate.decide"]))
        .toMatchObject({ status: "recorded", gateId: SEED_GATE_ID, decisionIndex: 0 });
      const run = await readGateRun(fixture);
      expect(run.gateProofs).toHaveLength(1);
      // The actor is the embedder's own label on the `sdk` surface, stamped by
      // the facade — no method argument carries one.
      expect(run.gateProofs[0]?.actor).toMatchObject({ id: "embedder", surface: "sdk" });
    } finally { await fixture.cleanup(); }
  });

  it("REFUSES an embedder that named no grants, and writes nothing", async () => {
    const fixture = await gatedRun("sdkgatenone");
    try {
      const result = await gate(fixture, []);
      expect(result).toMatchObject({ status: "refused" });
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("THROWS for a principal holding a DIFFERENT gate kind's grant", async () => {
    const fixture = await gatedRun("sdkgatewrong");
    try {
      // The effect grant decides four of the eight kinds and not this one. Only
      // the per-kind charge can tell it apart from the right grant.
      await expect(gate(fixture, ["preparation.effect.approve"]))
        .rejects.toBeInstanceOf(PrincipalAuthorityError);
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });
});

describe("handoffPreparation stages through the same service", () => {
  it("hands off for a principal holding the run grant", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await wikiOn(root.dir, ["preparation.run"])
      .handoffPreparation(binding.runId, handoffObligations(binding));
    expect(result).toMatchObject({ status: "handed-off", runId: binding.runId });
    const run = await readPreparationRun(root.dir, binding);
    expect(run.status === "ok" && run.run.state).toBe("handed-off");
  });

  it("THROWS missing-grant for an embedder that named none, creating no bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(wikiOn(root.dir, []).handoffPreparation(binding.runId, handoffObligations(binding)))
      .rejects.toBeInstanceOf(PrincipalAuthorityError);
    expect((await scanOperationInventory(root.dir)).manifests).toHaveLength(0);
  });
});
