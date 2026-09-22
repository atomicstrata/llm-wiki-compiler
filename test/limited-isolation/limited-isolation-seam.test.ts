/**
 * @file test/limited-isolation/limited-isolation-seam.test.ts
 * @description The INTEGRATION witness for the limited-isolation backend: a
 * trusted probe provider driven through the STANDARD pack-side seam (compile ->
 * stage -> `runPreparation` with a `devProviderInvocation` host whose one
 * operator decision is `backend: limitedIsolationBackend()`), re-witnessing the
 * four AS-3 controls off the run's own durable record.
 *
 * WHAT EACH CONTROL'S WITNESS IS, through the seam rather than in-process:
 * network-deny and scratch-confinement arrive ENCODED IN THE PHASE OUTPUT the
 * probe published through the runtime's protocol and evidence store (plus the
 * parent-side canary and connection count, which a lying probe cannot fake);
 * fail-closed is the run PARKING with nothing executed when the tool is
 * unavailable, and the backend's NAMED reason at the invocation seam; explicit
 * opt-in is the same staged action refusing its provider phase when the host
 * passes no invocation at all.
 *
 * The package's own test (limited-isolation-backend.test.ts) witnesses the
 * controls at the backend's mouth; THIS file witnesses that the seam a future
 * pack-side execution calls through preserves them end to end.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { limitedIsolationBackend } from "../../packages/llmwiki-limited-isolation-backend/src/index.js";
import { invokeCapabilityProvider } from "../../src/capability-providers/runtime/invoke.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { abandonPreparationRunLocked } from "../../src/preparations/abandonment.js";
import {
  removeResolutionFixture,
} from "../capability-providers/resolution-fixture.js";
import {
  phaseStates, readPhaseOutput, resultReason, stageCompiledAction, stagedRunTracker,
} from "../operations-packs/runtime-fixture.js";
import {
  countingListener, isolationToolPresent, outerCanReach, type CountingListenerV1,
} from "./net-probe-fixture.js";
import {
  cleanupSeamScratch, compileProbeAction, driveSeam, drivenExtractTitles, installProbeProvider,
  probeInvocation, seedCanary, withFreshLaunchParent, type ProbeProviderV1,
} from "./seam-fixture.js";

/** A tool name that exists on no machine: the fail-closed arm's override. */
const MISSING_TOOL = "llmwiki-no-such-isolation-tool";

/** The exact probe report a correctly confined run publishes. */
const CONFINED_REPORT = "net=blocked;escape=blocked;scratch=ok";

const runs = stagedRunTracker();
let provider: ProbeProviderV1 | undefined;
let listener: CountingListenerV1 | undefined;
/** Temporary roots this suite creates outside the tracked run root. */
const scratch: string[] = [];
/** Register one for removal; these sit outside `runs`, so nothing else drains them. */
function trackScratch(dir: string): string {
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await runs.cleanupAll();
  await cleanupSeamScratch();
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  listener?.close();
  listener = undefined;
  if (provider) await removeResolutionFixture(provider.fixture);
  provider = undefined;
});

/** Install, listen, seed the canary, and stage the probe action — one arrange. */
async function arrangeProbeRun() {
  provider = await installProbeProvider();
  listener = await countingListener();
  // Non-vacuity: the parent MUST reach the listener, or "blocked" proves nothing.
  expect(await outerCanReach(listener.port), "listener unreachable from the parent").toBe(true);
  const canary = await seedCanary();
  const staged = runs.add(await stageCompiledAction(
    await compileProbeAction(provider, `${listener.port}|${canary}`)));
  return { staged, canary, myListener: listener, myProvider: provider };
}

describe("the limited-isolation backend integrates at the standard pack seam", () => {
  it("confines a provider run end to end: the durable output reports both controls held", async () => {
    // On the declared matrix (linux+macos) the isolation tool MUST be present:
    // a silent skip would let green CI witness nothing (ci.yml provisions bwrap).
    if (!isolationToolPresent()) {
      const declaredMatrix = process.platform === "darwin" || process.platform === "linux";
      expect(declaredMatrix, "the isolation tool is absent on a DECLARED platform").toBe(false);
      return;
    }
    const { staged, canary, myListener, myProvider } = await arrangeProbeRun();
    // The probe's report, off the run's own evidence store — not the backend's.
    const titles = await drivenExtractTitles(staged,
      await probeInvocation(myProvider, staged.root, limitedIsolationBackend()));
    expect(titles).toEqual([CONFINED_REPORT]);
    // Parent-side corroboration a lying probe cannot fake: the canary bytes are
    // unchanged, and the only connection the listener ever saw is our own.
    expect(await readFile(canary, "utf8")).toBe("seed");
    expect(myListener.connections(), "the sandboxed probe reached the parent listener").toBe(1);
  }, 90_000);

  it("REFUSES fail-closed through the seam when the isolation tool is unavailable", async () => {
    const { staged, canary, myListener, myProvider } = await arrangeProbeRun();
    const result = await driveSeam(staged, await probeInvocation(
      myProvider, staged.root, limitedIsolationBackend({ isolationToolOverride: MISSING_TOOL })));
    // NEVER a silent unsandboxed fallback: the trusted command demonstrably did
    // not execute — the canary and listener are untouched beyond the parent's
    // own non-vacuity dial.
    expect(result.status).not.toBe("handed-off");
    expect(await readFile(canary, "utf8")).toBe("seed");
    expect(myListener.connections()).toBe(1);
    // THE DURABLE TRUTH, and the property that matters to an operator: the run
    // is PARKED `recovery-required` with the extract leg recovery-required under
    // the problem code "leg-fault", and the execution owner is cleared.
    //
    // This arm is where the strand was found. It used to assert the run stayed
    // `running`, which was true and useless: an ownerless `running` run had no
    // product exit — re-drive skips a phase that is neither `pending` nor
    // `ready`, `recovery` refuses a run holding no owner, and `abandon` requires
    // the RUN to be `recovery-required`. Asserting the park was correct and
    // never asking whether an operator could get out is exactly how it hid.
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    expect(read.run.state, "the fault parks the RUN, not only the leg").toBe("recovery-required");
    expect(read.run.executionOwner, "no owner left fencing a run nothing advances").toBeUndefined();
    const extract = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === "extract");
    expect(extract?.state).toBe("recovery-required");
    expect(extract?.problem).toBe("leg-fault");

    // AND THE OPERATOR CAN GET OUT. Driven, not asserted: a missing tool costs
    // this run, never the project. The NAMED isolation refusal is still not
    // durably typed — it is witnessed at the invocation seam below — which
    // remains the flagged follow-up.
    const abandoned = await abandonPreparationRunLocked(staged.root, {
      binding: staged.binding, actor: { id: "operator", surface: "cli" },
      at: new Date().toISOString(), confirmResidualState: true,
    });
    expect(abandoned.state).toBe("abandoned");
    const after = await readPreparationRun(staged.root, staged.binding);
    expect(after.status === "ok" && after.run.state, "durably abandoned").toBe("abandoned");
  }, 60_000);

  it("names its fail-closed reason at the invocation seam", async () => {
    provider = await installProbeProvider();
    const staged = runs.add(await stageCompiledAction(await compileProbeAction(provider, "unused")));
    const invocation = await probeInvocation(
      provider, staged.root, limitedIsolationBackend({ isolationToolOverride: MISSING_TOOL }));
    const phase = staged.action.plan.phases.find((entry) => entry.logicalPhaseId === "extract");
    const executor = phase?.executor;
    if (phase === undefined || executor?.kind !== "provider-capability") throw new Error("fixture recipe shape changed");
    const legInput = await invocation(executor, phase, { templateRef: "render.provider-request", text: "probe" }, {
      root: staged.root, workspaceId: staged.binding.workspaceId,
      preparationRunId: staged.binding.runId, surface: "sdk",
    });
    if (legInput === null) throw new Error("the host declined its own provider");
    const parent = trackScratch(await mkdtemp(path.join(tmpdir(), "seam-custody-")));
    const failure = await invokeCapabilityProvider(
      withFreshLaunchParent(legInput.request, parent), legInput.host)
      .then((result) => new Error(`resolved instead: ${JSON.stringify(result)}`),
        (error: unknown) => error as Error);
    expect(failure?.message).toContain(
      `limited-isolation backend refuses: isolation tool '${MISSING_TOOL}' is unavailable`);
    expect((failure?.cause as Error | undefined)?.name).toBe("IsolationUnavailableError");
  }, 60_000);

  it("refuses the provider phase when the host opts nothing in", async () => {
    const { staged, canary, myListener } = await arrangeProbeRun();
    const result = await driveSeam(staged);
    expect(result.status).not.toBe("handed-off");
    expect((await phaseStates(staged)).get("extract")).toBe("failed");
    expect(await readFile(canary, "utf8")).toBe("seed");
    expect(myListener.connections()).toBe(1);
  }, 60_000);
});
