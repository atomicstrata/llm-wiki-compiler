/**
 * @file test/preparation-service-show.test.ts
 * @description The `show` operation — the read that reports references and the
 * one surface where the owner-liveness classification is not collapsed.
 *
 * THE LIVENESS CASES ARE THE SPINE. Every other consumer of that evidence takes a
 * boolean, so three of the four classes are indistinguishable to them; here they
 * are four different answers with four different instructions, and the pair that
 * matters most is the two unobservable arms. They carry the SAME boolean
 * everywhere else in the system and opposite guidance here — one resolves on a
 * retry and the other never can — so a test that only checked "not live" would
 * pass against code that merged them.
 *
 * REFERENCES ARE ASSERTED AS REFERENCES. It is not enough that the response
 * happens to contain digests: the case has to fail if a body ever appears beside
 * one, which is why the plan is asserted to be the digest and nothing else.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationServiceV1, ShowResultV1 } from "../src/preparations/service.js";
import { driveCheckpointed, driveRunning, stagedProject } from "./preparation-recovery-fixture.js";
import type { RunningRunFixture } from "./preparation-recovery-fixture.js";

let fixture: RunningRunFixture;
let service: PreparationServiceV1;

beforeEach(async () => {
  fixture = await stagedProject("show");
  service = createPreparationService({
    root: fixture.root, surface: "cli",
    principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: [] }) },
  });
});
afterEach(async () => { await fixture.cleanup(); });

/** Show the fixture's run, failing loudly rather than on a later field. */
async function shown(): Promise<Extract<ShowResultV1, { status: "shown" }>["run"]> {
  const outcome = await service.show({ runId: fixture.binding.runId });
  if (outcome.status !== "shown") throw new Error(`not shown: ${JSON.stringify(outcome)}`);
  return outcome.run;
}

describe("show — what it reports, and what it deliberately does not", () => {
  it("describes a staged run by reference, with no owner and no evidence", async () => {
    const run = await shown();
    expect(run).toMatchObject({
      runId: fixture.binding.runId, state: "planned",
      manifestDigest: fixture.binding.manifestDigest, executionOwner: null,
    });
    expect(run.evidenceRefs).toEqual([]);
  });

  it("names the plan by DIGEST and carries no plan body anywhere in the response", async () => {
    await driveCheckpointed(fixture);
    const run = await shown();
    expect(run.manifestDigest).toBe(fixture.binding.manifestDigest);
    // THE ASSERTION THAT ACTUALLY BINDS: serialize the whole response and check
    // no plan field rode along. Asserting the digest alone passes just as well
    // against a response that ALSO inlined the phases' executors and bounds.
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("\"executor\"");
    expect(serialized).not.toContain("\"phases\":[{\"logicalPhaseId\"");
    expect(serialized).not.toContain("\"bounds\"");
  });

  it("reports a settled phase by its content address, not its output", async () => {
    await driveCheckpointed(fixture);
    const run = await shown();
    expect(run.phases).toHaveLength(1);
    expect(run.phases[0]).toMatchObject({ logicalPhaseId: "collect", state: "succeeded", attemptCount: 1 });
    // `null` rather than an absent key: an operator reading the envelope needs
    // "this phase produced no output" to be a value, not a missing field they
    // have to guess the meaning of.
    expect(run.phases[0]).toHaveProperty("outputEvidenceDigest");
  });
});

describe("show — the owner's liveness is reported uncollapsed", () => {
  /** Drive the run under `owner` and return the reported owner block. */
  async function ownerUnder(owner: "identified" | "stranded" | "live") {
    await driveRunning(fixture, owner);
    const run = await shown();
    if (run.executionOwner === null) throw new Error("expected an execution owner");
    return run.executionOwner;
  }

  it("reports a CONFIRMED owner as live, and not worth re-observing", async () => {
    const owner = await ownerUnder("identified");
    expect(owner).toMatchObject({ liveness: "live", retryable: false, pid: process.pid });
    expect(owner.guidance).toContain("wait for the phase to settle");
  });

  it("reports a PROVABLY GONE owner as stale, pointing at recovery", async () => {
    const owner = await ownerUnder("stranded");
    expect(owner).toMatchObject({ liveness: "stale", retryable: false });
    expect(owner.guidance).toContain("recover the run");
  });

  it("reports an UNRECORDED identity as permanently undetermined, and says retrying will not help", async () => {
    // The shape `mintAttemptLease` still produces whenever the minting host
    // cannot read its own start time. No read can recover what the write
    // declined to store, so this is the arm that must NOT read as retryable.
    const owner = await ownerUnder("live");
    expect(owner).toMatchObject({ liveness: "unobservable-unrecorded", retryable: false });
    expect(owner.guidance).toContain("retrying will not change this answer");
    expect(owner.guidance).toContain("recovery will refuse");
  });

  it("separates the two undetermined arms rather than merging them", async () => {
    // BOTH are "cannot tell" and both carry the same boolean everywhere else in
    // the system. If `show` merged them it would tell an operator holding a
    // permanently unanswerable run to keep retrying.
    const unrecorded = await ownerUnder("live");
    expect(unrecorded.liveness).toBe("unobservable-unrecorded");
    expect(unrecorded.retryable).toBe(false);
    // Its counterpart's guidance is the opposite instruction, asserted from the
    // table rather than by building a second unreadable-probe fixture here —
    // `lock-owner-liveness-classification.test.ts` owns that arm's construction.
    expect(unrecorded.guidance).not.toContain("may resolve from the host that started it");
  });
});

describe("show — could-not-see is not does-not-exist at any leg", () => {
  it("REFUSES an unknown run, which is a settled fact about the store", async () => {
    const outcome = await service.show({ runId: "prep-run-does-not-exist" });
    expect(outcome.status).toBe("refused");
  });

  it("REFUSES a directory that is not a project, naming that rather than the run", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "llmwiki-show-bare-"));
    try {
      const outside = createPreparationService({
        root: bare, surface: "cli",
        principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: [] }) },
      });
      const outcome = await outside.show({ runId: fixture.binding.runId });
      expect(outcome).toEqual({
        status: "refused", reason: "no .llmwiki store here; run from the project root",
      });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
