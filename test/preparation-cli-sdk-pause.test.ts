/**
 * @file test/preparation-cli-sdk-pause.test.ts
 * @description `pause` and `resume` on both surfaces an operator and an embedder
 * actually reach: `dist/cli.js` and the SDK facade.
 *
 * WHAT A SUBPROCESS SUITE PROVES THAT AN IN-PROCESS ONE CANNOT: that the verb is
 * REGISTERED and reachable, that `--json` parses as an envelope rather than
 * arriving behind a status icon, and that the exit code agrees with the outcome.
 * The idempotent arm needs all three at once — `already-paused` is a SUCCESS, so
 * an exit code that treated it as failure would break every retry an operator
 * writes after a dropped connection.
 *
 * THE SDK HALF IS ABOUT THE GRANT (R-5). `pause` costs `preparation.run` — it
 * appends one control transition, asserts nothing about effects and reaches no
 * terminal — so it is tested refused without that token and succeeding with it.
 * Either half alone is satisfied by code that refuses everything or authorizes
 * everything; the mutation between them is a single constructor field.
 */

import { describe, expect, it } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { PreparationGrant } from "../src/preparations/service.js";
import { emptyWorkspace, stagedRunIn } from "./preparation-cli-fixture.js";
import { driveCheckpointed, driveRunning, readRun, stageRunIn } from "./preparation-recovery-fixture.js";
import type { RunningRunFixture } from "./preparation-recovery-fixture.js";

/** The token pause costs — deliberately NOT the destructive one. */
const RUN_GRANTS: readonly PreparationGrant[] = ["preparation.run"];
/** A token that authorizes a different operation entirely. */
const CANCEL_GRANTS: readonly PreparationGrant[] = ["preparation.cancel"];

/** A project whose single run sits at a durable safe checkpoint. */
async function checkpointedProject(suffix: string): Promise<RunningRunFixture> {
  const cwd = await emptyWorkspace(suffix);
  const fixture = await stageRunIn(cwd);
  await driveCheckpointed(fixture);
  return fixture;
}

/** Parse one `--json` envelope, failing loudly rather than on a later field. */
function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("preparation resume through the binary", () => {
  it("returns a paused run to running, exits 0, and says so durably", async () => {
    const fixture = await checkpointedProject("resume-cli-ok");
    await runCLI(["preparation", "pause", fixture.binding.runId, "--json"], fixture.root);
    const result = await runCLI(["preparation", "resume", fixture.binding.runId, "--json"], fixture.root);
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({
      status: "resumed", runId: fixture.binding.runId, transition: "appended",
    });
    // THE VERB IS REGISTERED AND THE SUBPROCESS WROTE IT. An unregistered verb
    // exits non-zero with commander's own error, so this case also pins the
    // registration that an in-process suite cannot see.
    expect((await readRun(fixture)).state).toBe("running");
  });

  it("reports an already-running run as SUCCESS, as its mirror does", async () => {
    const fixture = await checkpointedProject("resume-cli-idem");
    await runCLI(["preparation", "pause", fixture.binding.runId], fixture.root);
    await runCLI(["preparation", "resume", fixture.binding.runId], fixture.root);
    const result = await runCLI(["preparation", "resume", fixture.binding.runId], fixture.root);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("already running");
  });

  it("refuses a run parked for RECOVERY, and names the verb that applies", async () => {
    // THE REFUSAL WORTH HAVING, and the first version of this case did not
    // witness it: it drove the run to `running`, which lands on the idempotent
    // arm and exits 0, so the case asserted `already-running` under a name that
    // said "refuses". A parked run is the state an operator genuinely confuses
    // with a paused one — both look stopped — and the two are released by
    // different verbs holding different grants.
    const { cwd, binding } = await stagedRunIn("resume-cli-parked", "recovery-required");
    const result = await runCLI(["preparation", "resume", binding.runId, "--json"], cwd);
    expect(result.code).toBe(1);
    const shown = envelope(result.stdout) as { status: string; reason: string };
    expect(shown.status).toBe("refused");
    // NAMING THE REMEDY, not merely the state. "this run is recovery-required"
    // leaves an operator to guess which of five verbs comes next.
    expect(shown.reason).toContain("recover it");
  });
});

describe("preparation pause through the binary", () => {
  it("holds a checkpointed run, exits 0, and says so durably", async () => {
    const fixture = await checkpointedProject("pause-cli-ok");
    const result = await runCLI(["preparation", "pause", fixture.binding.runId, "--json"], fixture.root);
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({
      status: "paused", runId: fixture.binding.runId, transition: "appended",
    });
    // THE SUBPROCESS WROTE IT, read back in this process: the envelope alone
    // cannot distinguish a durable append from a well-formed claim.
    expect((await readRun(fixture)).state).toBe("paused");
  });

  it("reports an already-paused run as SUCCESS, with the retry's answer in the line", async () => {
    const fixture = await checkpointedProject("pause-cli-idem");
    await runCLI(["preparation", "pause", fixture.binding.runId], fixture.root);
    const result = await runCLI(["preparation", "pause", fixture.binding.runId], fixture.root);
    // EXIT 0 IS THE LOAD-BEARING HALF. The wording tells the operator this
    // invocation was not the one that stopped the run; the code tells their
    // script the run is paused, which is all it needed to know.
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("already paused");
  });

  it("refuses an in-flight run with a parseable envelope and exit 1", async () => {
    const cwd = await emptyWorkspace("pause-cli-busy");
    const fixture = await stageRunIn(cwd);
    await driveRunning(fixture, "identified");
    const result = await runCLI(["preparation", "pause", fixture.binding.runId, "--json"], cwd);
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
    // The refusal did not move the run — the assertion the envelope cannot make.
    expect((await readRun(fixture)).state).toBe("running");
  });

  it("refuses an unknown run rather than reporting a pause of nothing", async () => {
    const cwd = await emptyWorkspace("pause-cli-unknown");
    await stageRunIn(cwd);
    const result = await runCLI(["preparation", "pause", "prep-run-does-not-exist", "--json"], cwd);
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
  });
});

describe("pause requires the run grant on the SDK surface", () => {
  /** Assert the facade refuses for want of the grant, and that nothing moved. */
  async function expectUngranted(suffix: string, grants: readonly PreparationGrant[]): Promise<void> {
    const fixture = await checkpointedProject(suffix);
    const wiki = createWiki({ root: fixture.root, preparation: { id: "sdk-test", grants } });
    await expect(wiki.pausePreparation(fixture.binding.runId)).rejects.toMatchObject({ code: "missing-grant" });
    // OBSERVED ON DISK, because a rejection can be raised after a commit.
    expect((await readRun(fixture)).state).toBe("running");
  }

  it("REFUSES an embedder holding only `preparation.cancel`, and moves nothing", async () => {
    await expectUngranted("sdkpausenogrant", CANCEL_GRANTS);
  });

  it("STOPS refusing when the run grant is present — the mutation", async () => {
    const fixture = await checkpointedProject("sdkpausegrant");
    const wiki = createWiki({ root: fixture.root, preparation: { id: "sdk-test", grants: RUN_GRANTS } });
    expect(await wiki.pausePreparation(fixture.binding.runId)).toMatchObject({
      status: "paused", transition: "appended",
    });
    expect((await readRun(fixture)).state).toBe("paused");
  });

  it("defaults to no grants at all when the embedder names none", async () => {
    await expectUngranted("sdkpausedefault", []);
  });
});
