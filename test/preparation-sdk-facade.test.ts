/**
 * @file test/preparation-sdk-facade.test.ts
 * @description What the SDK facade actually returns: every result serializes
 * and comes back unchanged, and D-10-4's could-not-read / does-not-qualify
 * distinction survives the crossing.
 *
 * WHY SERIALIZATION IS A CONTRACT AND NOT A DETAIL. An in-process facade is one
 * transport; MCP and any future RPC surface are another, and a result carrying a
 * class instance, a `Set`, a `Map`, an `undefined`-valued key or a function
 * passes an in-process test and arrives at a remote caller as something else.
 * Asserting the round trip is EQUAL — not merely parseable — is what pins that,
 * and it is checked on the SERIALIZED form so a field added later fails the
 * control rather than shipping.
 *
 * WHY D-10-4 IS TESTED THROUGH THE FACADE. The distinction is enforced in the
 * service, so testing it there proves the service. Testing it HERE proves the
 * surface does not flatten it on the way out — which is exactly what a facade
 * that mapped refusals onto a boolean, or dropped unreadable rows, would do.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { createWiki } from "../src/sdk/wiki.js";
import { expectNoRecoveryAuthority } from "./preparation-sdk-fixture.js";
import type { Wiki } from "../src/sdk/types.js";
import { emptyWorkspace, initializedWorkspace } from "./preparation-cli-fixture.js";
import {
  CANCEL_RECOVERY_GRANTS, driveRunning, stagedProject,
} from "./preparation-recovery-fixture.js";

/** A facade holding the one grant the mutating operations cost. */
function grantedWiki(root: string): Wiki {
  return createWiki({ root, preparation: { id: "sdk-test", grants: ["preparation.run"] } });
}

/** A facade holding the two grants this operation family costs. */
function cancelRecoveryWiki(root: string): Wiki {
  return createWiki({ root, preparation: { id: "sdk-test", grants: CANCEL_RECOVERY_GRANTS } });
}

/** The plan and seed documents an SDK caller would hold in memory. */
async function stageDocuments() {
  const { fixturePlan } = await import("./preparations/store-fixture.js");
  return {
    planDocument: JSON.stringify(fixturePlan()),
    seedDocument: JSON.stringify({ seed: "initial-input", version: 1 }),
  };
}

/** Assert one result survives a JSON round trip byte-for-byte. */
function expectRoundTrip(result: unknown): void {
  const encoded = JSON.stringify(result);
  expect(encoded).toEqual(expect.any(String));
  expect(JSON.parse(encoded) as unknown).toEqual(result);
}

describe("every facade result crosses a transport unchanged", () => {
  it("round-trips a staged result", async () => {
    const cwd = await initializedWorkspace("sdkrtstage");
    const result = await grantedWiki(cwd).stagePreparation(await stageDocuments());
    expect(result.status).toBe("staged");
    expectRoundTrip(result);
  });

  it("round-trips a REFUSED stage, reason and all", async () => {
    // The refusal arm is the half a serialization test usually misses, and it
    // is the one carrying free-text.
    const cwd = await initializedWorkspace("sdkrtrefuse");
    const result = await grantedWiki(cwd).stagePreparation({
      planDocument: "{ not a plan", seedDocument: "{}",
    });
    expect(result).toMatchObject({ status: "refused" });
    expectRoundTrip(result);
  });

  it("round-trips a listing, including its null-valued row fields", async () => {
    // `state` and `detail` are `null` rather than absent precisely so they
    // survive JSON — an `undefined` would vanish and a consumer could not tell
    // "unreadable" from "field not sent".
    const cwd = await emptyWorkspace("sdkrtlist");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    await stagePreparation(cwd);
    const listing = await createWiki({ root: cwd }).listPreparations();
    expect(listing.runs.length).toBeGreaterThan(0);
    expectRoundTrip(listing);
  });

  it("round-trips both arms of fail", async () => {
    const cwd = await emptyWorkspace("sdkrtfail");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const wiki = grantedWiki(cwd);
    const failed = await wiki.failPreparation(binding.runId);
    expect(failed).toMatchObject({ status: "failed" });
    expectRoundTrip(failed);
    // The same run again: now terminal, so refused.
    const refused = await wiki.failPreparation(binding.runId);
    expect(refused).toMatchObject({ status: "refused" });
    expectRoundTrip(refused);
  });
});

describe("the cancel and recovery results cross a transport unchanged", () => {
  it("round-trips both arms of cancel", async () => {
    const fixture = await stagedProject("sdkrtcancel");
    try {
      const wiki = cancelRecoveryWiki(fixture.root);
      const requested = await wiki.cancelPreparation(fixture.binding.runId);
      expect(requested).toMatchObject({ status: "requested" });
      expectRoundTrip(requested);
      const refused = await wiki.cancelPreparation("prr_does_not_exist");
      expect(refused).toMatchObject({ status: "refused" });
      expectRoundTrip(refused);
    } finally { await fixture.cleanup(); }
  });

  it("round-trips a recovery result, INCLUDING its null lifecycle", async () => {
    // `lifecycle: null` is the "never observed" answer, and it is `null` rather
    // than absent for the same reason the listing's row fields are: an
    // `undefined` vanishes through JSON and a consumer cannot then tell "not
    // observed" from "field not sent".
    const fixture = await stagedProject("sdkrtrecovery");
    try {
      await driveRunning(fixture, "stranded");
      const wiki = cancelRecoveryWiki(fixture.root);
      const parked = await wiki.recoverPreparation(fixture.binding.runId);
      expect(parked).toMatchObject({ status: "parked", lifecycle: { status: "clean" } });
      expectRoundTrip(parked);

      const { acquireLock, releaseLock } = await import("../src/utils/lock.js");
      await acquireLock(fixture.root, { quiet: true });
      try {
        const busy = await wiki.recoverPreparation(fixture.binding.runId);
        expect(busy).toMatchObject({ status: "refused", lifecycle: null });
        expectRoundTrip(busy);
        expect(JSON.parse(JSON.stringify(busy)) as Record<string, unknown>)
          .toHaveProperty("lifecycle", null);
      } finally { await releaseLock(fixture.root); }
    } finally { await fixture.cleanup(); }
  });

  it("FAILS CLOSED for an embedder that named no grants", async () => {
    // The default identity can read but must not mutate, and neither of these
    // verbs is a read: one publishes a durable request, the other drives a
    // durable transition.
    const fixture = await stagedProject("sdkfailclosed");
    try {
      const wiki = createWiki({ root: fixture.root });
      await expectNoRecoveryAuthority(wiki, fixture.binding.runId);
    } finally { await fixture.cleanup(); }
  });
});

describe("could-not-read stays distinct from does-not-qualify through the facade", () => {
  it("says NO SUCH RUN only when the scan was authoritative", async () => {
    const cwd = await emptyWorkspace("sdktaxonomyknown");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    await stagePreparation(cwd);
    expect(await grantedWiki(cwd).failPreparation("prr_does_not_exist"))
      .toEqual({ status: "refused", reason: "no such preparation run" });
  });

  it("says THIS RUN MAY EXIST once the scan is degraded", async () => {
    // The SAME missing id over a store whose manifest cannot be parsed. A
    // degraded scan drops what it could not read, so a miss over it is not
    // evidence of absence — and collapsing the two is how a caller concludes a
    // run is gone and acts on it.
    const cwd = await emptyWorkspace("sdktaxonomydegraded");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const { writeFile } = await import("node:fs/promises");
    const { MANIFEST_FILENAME, PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
    await writeFile(path.join(cwd, ".llmwiki", "workspaces", binding.workspaceId,
      PREPARATIONS_SEGMENT, binding.preparationId, MANIFEST_FILENAME), "{ corrupt");

    const result = await grantedWiki(cwd).failPreparation("prr_does_not_exist");
    expect(result).toMatchObject({ status: "refused" });
    expect((result as { reason: string }).reason).toMatch(/not authoritative|may exist/u);
    expect((result as { reason: string }).reason).not.toMatch(/no such preparation run/u);
  });

  it("keeps an unreadable run VISIBLE in the listing rather than dropping it", async () => {
    // Dropping the row would read to any consumer as "this run does not exist".
    // It stays, with a null state and a reason.
    const cwd = await emptyWorkspace("sdktaxonomylist");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const wiki = createWiki({ root: cwd });
    // PIN THE PRECONDITION: readable before the fault is introduced.
    expect((await wiki.listPreparations()).runs.map((row) => row.runId))
      .toContain(binding.runId);

    const { chmod } = await import("node:fs/promises");
    const { preparationKeyFile } = await import("../src/preparations/paths.js");
    await chmod(preparationKeyFile(cwd), 0o644);

    const listing = await wiki.listPreparations();
    expect(listing.runs.find((candidate) => candidate.runId === binding.runId))
      .toMatchObject({ runId: binding.runId, state: null, detail: expect.any(String) });
    expect(listing.problems).not.toEqual([]);
  });
});
