/**
 * @file test/preparation-service-input-capture.test.ts
 * @description D-10-9 for the INPUT, at both layers.
 *
 * WHAT WAS PROVED AND WHAT WAS ASSUMED. Earlier rounds proved the PRINCIPAL is
 * captured in the synchronous prologue and stopped there. D-10-9 says *boundary
 * input* is captured once before the first `await` — it does not say "the
 * principal is". The stage request was not: the facade's document closures
 * retained `input`, and the service forwarded `request` and read its fields
 * only after awaiting the project preflight. Mutating `input.planDocument`
 * immediately after the call returned changed the document that got staged.
 *
 * THE SHAPE OF THE MISS IS WORTH NAMING, because the own-gate sweep should have
 * suggested it: that work hardened WHICH properties are read and never asked
 * WHEN. Both questions have to be answered about the same fields.
 *
 * THE LAZY-DOCUMENT CONTRACT IS PRESERVED. Laziness is deliberate — the service
 * settles its project preflight BEFORE reading any document, which is what keeps
 * a bad plan in a store-less directory reporting the missing store rather than
 * the bad plan. Capturing a CALLABLE is not invoking it: the reference is
 * captured synchronously and bound to its owner, and the invocation stays
 * exactly where it was.
 *
 * AND THE ONLY THING ENFORCING THAT ORDERING IS THE LAST TEST IN THIS FILE.
 * An earlier version of this header credited `preparation-cli-stage.test.ts`
 * with pinning it. That is false, and measured: inverting the ordering so
 * documents are read before the preflight leaves all three shipped CLI
 * subprocess suites green (35/35) and fails only the reader-invocation test
 * below. Both cited CLI cases supply a valid plan AND a valid seed, so neither
 * can discriminate preflight-from-document ordering — they pass either way.
 *
 * The false credit is worth correcting rather than deleting, because it is how
 * the real control gets removed: a future editor reads "the CLI suite covers
 * this", deletes the test that actually covers it, and the suite stays green.
 */

import { describe, expect, it } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationPrincipal, StageResultV1 } from "../src/preparations/service.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { Wiki } from "../src/sdk/types.js";
import { emptyWorkspace, runStateOf } from "./preparation-cli-fixture.js";
import type { StagedBinding } from "./preparation-sdk-fixture.js";
import { stageDocuments, stageableProject, stagedAllowance } from "./preparation-sdk-fixture.js";

/** A facade holding the one grant staging costs. */
function grantedWiki(root: string): Wiki {
  return createWiki({ root, preparation: { id: "sdk-test", grants: ["preparation.run"] } });
}

/** Assert a staged result durably recorded the allowance the caller first gave. */
async function expectStagedWithAllowance(
  pending: Promise<StageResultV1>, cwd: string, allowance: number,
): Promise<void> {
  const result = await pending;
  // Narrowed on the discriminant rather than cast: the refused arm carries no
  // `workspaceId`, and asserting through a cast would read one off it.
  expect(result.status).toBe("staged");
  if (result.status !== "staged") return;
  expect(await stagedAllowance(cwd, result.workspaceId)).toBe(allowance);
}

/** A project holding two distinct `planned` runs, so a substitution is observable. */
async function twoPlannedRuns(suffix: string) {
  const cwd = await emptyWorkspace(suffix);
  const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
  const first = (await stagePreparation(cwd)).binding;
  const second = (await stagePreparation(cwd)).binding;
  return { cwd, first, second };
}

/**
 * Assert the NAMED run went terminal and the other one did not move.
 *
 * The second half is the load-bearing one: a retargeted `runId` shows up as a
 * run the caller never named going terminal, and an assertion that only checks
 * the named run passes while the service quietly terminates the wrong one.
 */
async function expectOnlyNamedRunFailed(
  result: unknown, cwd: string, named: StagedBinding, untouched: StagedBinding,
): Promise<void> {
  expect(result).toEqual({ status: "failed", runId: named.runId });
  expect(await runStateOf(cwd, named)).toBe("failed");
  expect(await runStateOf(cwd, untouched)).toBe("planned");
}

/** A service a second host would construct, holding the same grant. */
function grantedService(root: string) {
  return createPreparationService({
    root, surface: "sdk",
    principals: {
      principalFor: () => ({
        id: "host-2", surface: "sdk", grants: ["preparation.run"],
      } as PreparationPrincipal),
    },
  });
}

/** The same host, holding the token the DESTRUCTIVE verbs cost instead. */
function destructiveService(root: string) {
  return createPreparationService({
    root, surface: "sdk",
    principals: {
      principalFor: () => ({
        id: "host-2", surface: "sdk", grants: ["preparation.quarantine"],
      } as PreparationPrincipal),
    },
  });
}

/**
 * Two runs already terminal and past the retention floor, so both are prunable.
 *
 * BOTH must be eligible, or a substitution would be refused for ineligibility
 * and the case would pass without ever testing the capture.
 */
async function twoTerminalRuns(suffix: string) {
  const { cwd, first, second } = await twoPlannedRuns(suffix);
  const { driveToFailed } = await import("./preparations/lifecycle-fixture.js");
  await driveToFailed(cwd, first, "2026-01-01T00:00:00.000Z");
  await driveToFailed(cwd, second, "2026-01-01T00:00:00.000Z");
  return { cwd, first, second };
}

describe("the SDK captures its stage input before the first await", () => {
  it("stages the ORIGINAL plan when the caller mutates the field afterwards", async () => {
    const cwd = await stageableProject("capinputplan");
    const input = { ...await stageDocuments() };

    const pending = grantedWiki(cwd).stagePreparation(input);
    // Synchronously after the call returns, before any await resolves.
    input.planDocument = "{ not a plan";

    // Staged, because the ORIGINAL document was captured. Uncaptured, the
    // service would parse the replacement and refuse `plan is invalid`.
    expect((await pending).status).toBe("staged");
  });

  it("stages against the ORIGINAL seed when the caller mutates it afterwards", async () => {
    const cwd = await stageableProject("capinputseed");
    const input = { ...await stageDocuments() };

    const pending = grantedWiki(cwd).stagePreparation(input);
    input.seedDocument = JSON.stringify({ seed: "a-different-seed", version: 7 });

    // The plan declares a digest over the original seed bytes, so a swapped
    // seed is refused by the substrate's evidence-coverage check.
    expect((await pending).status).toBe("staged");
  });

  it("records the ORIGINAL allowance when the caller mutates it afterwards", async () => {
    // A COINCIDENCE PIN, not evidence the facade hoist is exercised. This case
    // passed BEFORE the hoist existed: `runQuiet`'s callback runs synchronously
    // up to its first await, so the request object literal — and with it the
    // allowance primitive — was already built before the caller could mutate
    // anything. Nothing about the fix made this go from red to green.
    //
    // It stays because the property is worth holding: a later refactor that
    // moves literal construction behind a deferred boundary would break it, and
    // the allowance is DURABLE and appears in no result DTO, so it is read back
    // off disk. The real control for the service layer is the request-capture
    // test below, whose allowance assertion DOES die when the capture is
    // reverted.
    const cwd = await stageableProject("capinputallowance");
    const input = { ...await stageDocuments(), controlTransitionAllowance: 24 };

    const pending = grantedWiki(cwd).stagePreparation(input);
    input.controlTransitionAllowance = 3;

    await expectStagedWithAllowance(pending, cwd, 24);
  });
});

describe("the service captures its stage request before the first await", () => {
  it("uses the ORIGINAL documents and allowance for a direct host caller", async () => {
    // The SDK is one host. `createPreparationService` is the seam a SECOND host
    // constructs, and a capture that lived only in the facade would leave every
    // other surface — the MCP adapter next — carrying the same defect.
    const cwd = await stageableProject("capservicereq");
    const { planDocument, seedDocument } = await stageDocuments();
    const documents = {
      plan: () => Promise.resolve({ ok: true as const, text: planDocument }),
      seed: () => Promise.resolve({ ok: true as const, text: seedDocument }),
    };
    const request = { documents, controlTransitionAllowance: 24 };

    const pending = grantedService(cwd).stage(request);
    // Retarget every field the request carries.
    request.controlTransitionAllowance = 3;
    documents.plan = () => Promise.resolve({ ok: true as const, text: "{ not a plan" });
    documents.seed = () => Promise.resolve({ ok: true as const, text: "{}" });

    await expectStagedWithAllowance(pending, cwd, 24);
  });

  it("fails the run the caller NAMED, not one substituted afterwards", async () => {
    // THE SIBLING `stage` ALREADY HAS. `fail` read `request.runId` after
    // awaiting readiness, so reassigning it synchronously after the call
    // returned retargeted the transition: the service durably terminated B
    // while the run the caller named stayed planned.
    const { cwd, first, second } = await twoPlannedRuns("capfailtarget");
    const request = { runId: first.runId };

    const pending = grantedService(cwd).fail(request);
    request.runId = second.runId;

    await expectOnlyNamedRunFailed(await pending, cwd, first, second);
  });

  it("REFUSES a two-answer run id without invoking it, and fails nothing", async () => {
    // The split-read half. `runId` was read once for `resolveRun` and again for
    // the result, so a getter answering differently each time drove one run
    // terminal and named a different one in the response — a result describing
    // a run the service never touched.
    //
    // THE PINNED COUNT IS NOW ZERO, AND IT WAS ONE. Collapsing the two reads
    // into one left the accessor RUNNING and the operation still drove a run
    // terminal on whatever it returned; reading the request's own data
    // descriptors refuses it before any caller code executes. Same probe,
    // strictly stronger property — which is why this is rewritten in place
    // rather than deleted as superseded.
    const { cwd, first, second } = await twoPlannedRuns("capfailsplit");
    let reads = 0;
    const request = {
      get runId(): string {
        reads += 1;
        return reads === 1 ? first.runId : second.runId;
      },
    };

    const result = await grantedService(cwd).fail(request);

    expect(reads).toBe(0);
    expect(result).toMatchObject({ status: "refused" });
    // Neither run moved: a refusal returned after a terminal append is not one.
    expect(await runStateOf(cwd, first)).toBe("planned");
    expect(await runStateOf(cwd, second)).toBe("planned");
  });

  it("prunes the run the caller NAMED, not one substituted afterwards", async () => {
    // THE SIBLING GUARANTEE FOR THE DESTRUCTIVE VERB, and it is the one where
    // getting it wrong is unrecoverable: `fail` retargeted to a state a run can
    // be driven out of, while a retargeted prune deletes a different run's bytes
    // and there is nothing to drive back. Prune has its OWN call site for this
    // capture, so a shared-body argument does not cover it.
    const { cwd, first, second } = await twoTerminalRuns("cappruneturget");
    const request = { runId: first.runId };

    const pending = destructiveService(cwd).prune(request);
    request.runId = second.runId;

    expect(await pending).toMatchObject({ status: "pruned", runId: first.runId });
    // THE BYSTANDER IS THE LOAD-BEARING HALF: an assertion that only checks the
    // named run passes while the service quietly deletes the other one.
    expect(await runStateOf(cwd, second)).toBe("failed");
    expect(await runStateOf(cwd, first)).toBeNull();
  });

  it("REFUSES a two-answer run id without invoking it, and deletes nothing", async () => {
    // The split-read half. A getter answering differently each time would delete
    // one run's bytes and name another in the result — a response describing a
    // run the service never touched, about an action nothing can undo.
    //
    // THE PINNED COUNT IS NOW ZERO, AND IT WAS ONE. One read was the strongest
    // property available while the prologue read was a plain `[[Get]]`: the
    // accessor still RAN, inside the prologue of the operation that deletes
    // bytes. Reading the request's own data descriptors refuses it before any
    // caller code executes. Same probe, strictly stronger property — which is
    // why this is rewritten in place rather than deleted as superseded.
    const { cwd, first, second } = await twoTerminalRuns("cappruneesplit");
    let reads = 0;
    const request = {
      get runId(): string {
        reads += 1;
        return reads === 1 ? first.runId : second.runId;
      },
    };

    const result = await destructiveService(cwd).prune(request);

    expect(reads).toBe(0);
    expect(result).toMatchObject({ status: "refused" });
    // BOTH runs survive: a refusal returned after a delete is not a refusal, and
    // the run the second answer names must be as untouched as the first.
    expect(await runStateOf(cwd, first)).toBe("failed");
    expect(await runStateOf(cwd, second)).toBe("failed");
  });

  it("preserves the RECEIVER of a host's document readers", async () => {
    // `captureStageRequest` binds each reader to its owning object, and the
    // prose there says binding "fixes both the function and its receiver".
    // Nothing exercised the receiver half: every other fixture in this repo
    // supplies arrow functions or closures, which carry no `this` at all, so
    // deleting the `.bind` left the entire grid green.
    //
    // This is the shape a host actually writes — a method-bearing object
    // literal, or a class instance — where the reader reaches its own fields
    // through `this`. Detached from its receiver it reads `undefined` and the
    // plan never parses.
    const cwd = await stageableProject("capbindreceiver");
    const { planDocument, seedDocument } = await stageDocuments();
    const documents = {
      planText: planDocument,
      seedText: seedDocument,
      plan(): Promise<{ ok: true; text: string }> {
        return Promise.resolve({ ok: true as const, text: this.planText });
      },
      seed(): Promise<{ ok: true; text: string }> {
        return Promise.resolve({ ok: true as const, text: this.seedText });
      },
    };

    const result = await grantedService(cwd).stage({ documents, controlTransitionAllowance: 16 });

    expect(result.status).toBe("staged");
  });

  it("still reads no document until the project preflight has passed", async () => {
    // THE CONTRACT THE CAPTURE MUST NOT BREAK. Capturing the callable must not
    // become invoking it: a store-less directory has to refuse on the missing
    // store, not on the plan — and the readers assert they were never called.
    let planReads = 0;
    let seedReads = 0;
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-prep-capnostore-"));

    const result = await grantedService(cwd).stage({
      documents: {
        plan: () => { planReads += 1; return Promise.resolve({ ok: true as const, text: "{}" }); },
        seed: () => { seedReads += 1; return Promise.resolve({ ok: true as const, text: "{}" }); },
      },
      controlTransitionAllowance: 16,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect((result as { reason: string }).reason).toMatch(/no \.llmwiki store/u);
    expect({ planReads, seedReads }).toEqual({ planReads: 0, seedReads: 0 });
  });
});
