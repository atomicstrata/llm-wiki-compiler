/**
 * @file test/workflow-stage-output-kinds.test.ts
 * @description Behavioural tests for the RELATION and LIFECYCLE stage-output kinds
 * of `submitStageOutput` — the seam wiring a write-declaring workflow stage into
 * the executor's under-lock relation/lifecycle authority.
 *
 * Covers the scope guard (BOTH relation endpoint entity types / the lifecycle
 * entityType must be in the stage's `writes`, refused BEFORE any executor call),
 * the apply path (an in-scope output the under-lock authority approves lands live,
 * records a `stage-output` event + output ref, satisfies the stage's `trust:`
 * gate), and the denial path (a denial the authority throws propagates, satisfies
 * NO gate, and leaves the run byte-unchanged).
 *
 * SCOPE RULE (relations): the endpoint entity TYPES of `input.from`/`input.to`
 * (the `<type>` half of each `<type>/<slug>` EntityId, via `parseEntityId`) must
 * ALL be in `stage.writes`. A stage relating entities must declare every
 * participating entity type.
 */

import { describe, it, expect, afterEach } from "vitest";
import { pageLifecycle, kindsProfile, startKindsRun as startKinds, citesOutput, expectRunFailedNoGate } from "./fixtures/seam-fixtures.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { StageWriteScopeError, TrustGateRequiresGrantError } from "../src/workflows/errors.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import { RelationWriteDeniedError } from "../src/trust/relation-apply.js";
import { readRun } from "../src/workflows/store.js";
import { readRelations } from "../src/relations/store-read.js";
import type { EntityId } from "../src/profile/types.js";

/** Grant the kinds-fixture project (`profileId: "research-kinds"`) trusted auto-apply. */
function grantTrustedWrite(): void {
  process.env[TRUSTED_WRITE_ENV_VAR] = "research-kinds";
}

afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

describe("submitStageOutput — relation kind", () => {
  it("WITH the operator grant, applies an in-scope cites relation, records the event + output, satisfies the trust gate", async () => {
    grantTrustedWrite();
    const { root, runId } = await startKinds("wf-rel-allow", kindsProfile(["papers"], "trust:high"));
    const result = await submitStageOutput(root, runId, citesOutput());
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("allow");
    expect((await readRelations(root)).relations.map((r) => r.type)).toContain("cites");
    expect(result.run.events.filter((e) => e.type === "stage-output")).toHaveLength(1);
    expect(result.run.satisfiedGates).toContain("trust:high");
    expect(result.run.outputs.run).toMatchObject({ decision: "allow" });
  });

  // C3 + BUG 1 (H2): the refusal is a HARD denial → the run is routed to `failed`
  // (retryable via resume), nothing is written live, and the gate is NOT satisfied.
  it("WITHOUT the grant, REFUSES a trust-gated relation: not applied, gate NOT satisfied, run FAILED (C3)", async () => {
    const { root, runId } = await startKinds("wf-rel-nogrant", kindsProfile(["papers"], "trust:high"));
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    await expectRunFailedNoGate(root, runId);
    expect((await readRelations(root)).relations).toHaveLength(0);
  });

  it("refuses a relation whose endpoint type is out of scope; nothing written, run byte-unchanged", async () => {
    const { root, runId } = await startKinds("wf-rel-scope", kindsProfile(["experiments"]));
    const before = await readRun(root, runId);
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(StageWriteScopeError);
    expect(await readRun(root, runId)).toEqual(before);
    expect((await readRelations(root)).relations).toHaveLength(0);
  });

  // BUG 1 (H2): a hard relation denial routes the run to `failed`; nothing is written.
  it("propagates a denial (undeclared relation type) — gate NOT satisfied, run FAILED, nothing written", async () => {
    grantTrustedWrite(); // grant so the write reaches the executor; the executor then denies the undeclared type
    const { root, runId } = await startKinds("wf-rel-deny", kindsProfile(["papers"], "trust:high"));
    const out: StageOutput = { kind: "relation", input: { type: "nope", from: "papers/a" as EntityId, to: "papers/b" as EntityId, attributes: {} } };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeInstanceOf(RelationWriteDeniedError);
    await expectRunFailedNoGate(root, runId);
    expect((await readRelations(root)).relations).toHaveLength(0);
  });
});

describe("submitStageOutput — lifecycle-transition kind", () => {
  /** A legal `draft → review` transition output for `papers/a`. */
  function reviewOutput(): StageOutput {
    return { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "review" };
  }

  it("WITH the operator grant, applies an in-scope legal transition, updates the lifecycle field, satisfies the trust gate", async () => {
    grantTrustedWrite();
    const { root, runId } = await startKinds("wf-lc-allow", kindsProfile(["papers"], "trust:high"), ["a"]);
    const result = await submitStageOutput(root, runId, reviewOutput());
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("allow");
    expect(await pageLifecycle(root, "a")).toBe("review");
    expect(result.run.satisfiedGates).toContain("trust:high");
    expect(result.run.events.filter((e) => e.type === "stage-output")).toHaveLength(1);
  });

  // C3 + BUG 1 (H2): a hard refusal routes the run to `failed`; the page stays draft.
  it("WITHOUT the grant, REFUSES a trust-gated transition: not applied, page unchanged, run FAILED (C3)", async () => {
    const { root, runId } = await startKinds("wf-lc-nogrant", kindsProfile(["papers"], "trust:high"), ["a"]);
    await expect(submitStageOutput(root, runId, reviewOutput())).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    await expectRunFailedNoGate(root, runId);
    expect(await pageLifecycle(root, "a")).toBe("draft");
  });

  it("refuses a lifecycle entityType out of scope; page + run byte-unchanged", async () => {
    const { root, runId } = await startKinds("wf-lc-scope", kindsProfile(["experiments"]), ["a"]);
    const before = await readRun(root, runId);
    await expect(submitStageOutput(root, runId, reviewOutput())).rejects.toBeInstanceOf(StageWriteScopeError);
    expect(await readRun(root, runId)).toEqual(before);
    expect(await pageLifecycle(root, "a")).toBe("draft");
  });

  // BUG 1 (H2): an illegal transition is a hard denial → the run is routed to `failed`.
  it("propagates an illegal transition — gate NOT satisfied, run FAILED, page unchanged", async () => {
    grantTrustedWrite(); // grant so the write reaches the executor; the executor then rejects the illegal transition
    const { root, runId } = await startKinds("wf-lc-illegal", kindsProfile(["papers"], "trust:high"), ["a"]);
    const out: StageOutput = { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "published" };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeTruthy();
    await expectRunFailedNoGate(root, runId);
    expect(await pageLifecycle(root, "a")).toBe("draft");
  });
});

describe("submitStageOutput — trust gate NOT auto-satisfiable on relation/lifecycle without a grant (C3 regression)", () => {
  it("a clean relation output to a trust-gated stage never satisfies the gate (no grant)", async () => {
    const { root, runId } = await startKinds("wf-c3-rel", kindsProfile(["papers"], "trust:high"));
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.satisfiedGates).not.toContain("trust:high");
  });

  it("a clean lifecycle transition to a trust-gated stage never satisfies the gate (no grant)", async () => {
    const { root, runId } = await startKinds("wf-c3-lc", kindsProfile(["papers"], "trust:high"), ["a"]);
    const out: StageOutput = { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "review" };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.satisfiedGates).not.toContain("trust:high");
  });
});
