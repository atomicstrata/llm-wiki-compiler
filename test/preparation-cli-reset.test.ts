/**
 * @file test/preparation-cli-reset.test.ts
 * @description `preparation reset` through `dist/cli.js` — the only surface this
 * operation has, so this is the only suite that exercises it end to end.
 *
 * WHAT A SUBPROCESS SUITE PROVES THAT AN IN-PROCESS ONE CANNOT: that the verb is
 * REGISTERED, that its flags parse as flags, that the envelope arrives as an
 * envelope rather than behind a status icon, and that the exit code agrees with
 * the outcome. For every other operation those are useful; for this one they are
 * the whole product. Reset had a substrate and no caller for two milestones, and
 * the approved operator runbook for a project whose key is gone ended by telling
 * its reader to invoke internal functions from a harness that does not exist. An
 * in-process test would have been green throughout that period.
 *
 * THE TWO PASSES ARE RUN AS TWO PROCESSES, which is what an operator does and is
 * the only way the continuation secret is tested as a durable binding rather
 * than as a variable held in one closure. Pass one's process exits; the secret
 * survives only because the operator copied it off stdout, which is exactly the
 * property the human-output case pins.
 */

import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCLI, expectCLIJson } from "./fixtures/run-cli.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";
import { preparationKeyFile } from "../src/preparations/paths.js";
import { FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION } from "../src/preparations/reset.js";
import { removePreparationKey, stagePreparation } from "./preparations/lifecycle-fixture.js";

/** The environment variable that keeps the continuation secret out of `ps`. */
const RESET_TOKEN_ENV = "LLMWIKI_PREP_RESET_TOKEN";

/** Parse one `--json` envelope, failing loudly rather than on a later field. */
function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * One `preparation reset` invocation, with the confirmation already supplied.
 *
 * ONE HOME FOR THE ARGUMENT VECTOR. Every case below differs from every other by
 * one or two flags, and spelling the whole vector out per case is how a suite
 * comes to test a verb name it no longer registers. The confirmation is the
 * missing-key phrase because that is the state these fixtures build; the
 * wrong-phrase case supplies its own.
 */
function resetCLI(cwd: string, ...flags: readonly string[]) {
  return runCLI([
    "preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION, ...flags,
  ], cwd);
}

/** A project holding one run whose preparation key has gone missing. */
async function strandedProject(suffix: string): Promise<string> {
  const cwd = await emptyWorkspace(suffix);
  await stagePreparation(cwd);
  await removePreparationKey(cwd);
  return cwd;
}

/** Run pass one and return the unit and secret it reported. */
async function passOne(cwd: string): Promise<{ unitId: string; token: string }> {
  const result = await resetCLI(cwd, "--json");
  expect(result.code, result.stderr).toBe(0);
  const body = envelope(result.stdout);
  expect(body.status).toBe("intent-recorded");
  return { unitId: body.unitId as string, token: body.continuationToken as string };
}

describe("the two passes complete through the binary", () => {
  it("records an intent and exits 0", async () => {
    const cwd = await strandedProject("reset-pass-one");
    const result = await resetCLI(cwd, "--json");
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({
      status: "intent-recorded", reason: "missing-key",
    });
  });

  it("completes when a SECOND process presents the unit and secret", async () => {
    const cwd = await strandedProject("reset-pass-two");
    const { unitId, token } = await passOne(cwd);
    const result = await resetCLI(cwd, "--continue", unitId, "--token", token, "--json");
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ status: "completed", unitId });
    // THE DURABLE HALF: the project has a readable key again, which is the whole
    // point of the verb and the one thing the envelope does not assert.
    expect((await readFile(preparationKeyFile(cwd), "utf8")).length).toBeGreaterThan(0);
  });

  it("prints the secret and the completing command in human mode", async () => {
    const cwd = await strandedProject("reset-human");
    const result = await resetCLI(cwd);
    expect(result.code, result.stderr).toBe(0);
    // WITHOUT THIS OUTPUT THE VERB IS UNUSABLE. The secret exists only in pass
    // one's stdout — only its digest is durable — so an operator who cannot read
    // it here can never complete the reset they just started.
    expect(result.stdout).toContain("continuation secret (shown once)");
    expect(result.stdout).toContain("--continue rst-");
  });
});

describe("the verb can be figured out from the verb", () => {
  it("names BOTH confirmation phrases when none is supplied", async () => {
    // AN EMERGENCY TOOL THAT CANNOT BE FIGURED OUT IS A DEFECT, and this one was
    // measured being one: the answer was "requires its distinct confirmation",
    // naming neither phrase, and `--help` named neither either. An operator
    // whose project key is gone had no route to the string except reading
    // source. Which phrase applies depends on a key state they are often unsure
    // of — that uncertainty is exactly why they are running this.
    const cwd = await strandedProject("reset-no-confirm");
    const result = await runCLI(["preparation", "reset"], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(MISSING_KEY_CONFIRMATION);
    expect(result.stdout).toContain(FORCED_KEY_CONFIRMATION);
  });

  it("names both phrases in --help, so the answer survives the terminal", async () => {
    const cwd = await strandedProject("reset-help");
    const result = await runCLI(["preparation", "reset", "--help"], cwd);
    expect(result.stdout).toContain(MISSING_KEY_CONFIRMATION);
    expect(result.stdout).toContain(FORCED_KEY_CONFIRMATION);
  });

  it("still leaves a WRONG phrase to the substrate, which alone reads the key", async () => {
    // THE LINE BETWEEN THE TWO REFUSALS. "You supplied nothing" needs no
    // knowledge of the key state; "you supplied the wrong one" does, and
    // answering it here would be a second authority for the operator's
    // acknowledgement.
    const cwd = await strandedProject("reset-wrong-phrase-boundary");
    const result = await runCLI(
      ["preparation", "reset", "--confirm", FORCED_KEY_CONFIRMATION, "--json"], cwd);
    expectCLIJson(result, 1, {
      status: "refused", reason: expect.stringContaining("confirmation-mismatch"),
    });
  });
});

describe("the secret has a route that `ps` cannot see", () => {
  it("completes pass two with the secret ONLY in the environment", async () => {
    // THE AVOIDABLE HALF OF THE EXPOSURE. A `--token` flag lands in the
    // process's argument vector, which `ps` shows to every user on the box for
    // the life of the process; an environment variable does not. Pass one still
    // has to PRINT the secret — that half cannot be closed — so this narrows the
    // half that can be.
    const cwd = await strandedProject("reset-env-token");
    const { unitId, token } = await passOne(cwd);
    const result = await runCLI([
      "preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION,
      "--continue", unitId, "--json",
    ], cwd, { [RESET_TOKEN_ENV]: token });
    expectCLIJson(result, 0, { status: "completed", unitId });
  });

  it("prefers an explicit --token over a stale variable in the environment", async () => {
    // AN OPERATOR WHO TYPED SOMETHING MEANT IT. A stale exported variable
    // silently overriding a typed argument is the surprise worth avoiding, and
    // here the environment holds a token that authorizes nothing.
    const cwd = await strandedProject("reset-token-precedence");
    const { unitId, token } = await passOne(cwd);
    const result = await runCLI([
      "preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION,
      "--continue", unitId, "--token", token, "--json",
    ], cwd, { [RESET_TOKEN_ENV]: Buffer.alloc(32, 9).toString("base64") });
    expectCLIJson(result, 0, { status: "completed", unitId });
  });

  it("treats an EMPTY variable as absent, and says how to supply the secret", async () => {
    // An exported-but-unset variable is not a secret. Collapsing it into one
    // would earn a `continuation-mismatch` about a malformed token, which sends
    // the operator to audit a token they never supplied.
    const cwd = await strandedProject("reset-env-empty");
    const result = await runCLI([
      "preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION,
      "--continue", "rst-whatever", "--json",
    ], cwd, { [RESET_TOKEN_ENV]: "" });
    expect(result.code).toBe(1);
    expect(envelope(result.stdout).reason).toContain(RESET_TOKEN_ENV);
  });

  it("tells the OPERATOR the limit, not only the source file", async () => {
    // THE EXPOSURE IS THEIRS TO CARRY. A limit recorded only in a docblock is
    // one the exposed person never reads, so pass one names both halves beside
    // the secret and points at the route around the half that has one.
    const cwd = await strandedProject("reset-limit-told");
    const result = await runCLI(
      ["preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION], cwd);
    expect(result.stdout).toContain("scrollback");
    expect(result.stdout).toContain(RESET_TOKEN_ENV);
  });

  it("names the private route in --help too", async () => {
    const cwd = await strandedProject("reset-env-help");
    const result = await runCLI(["preparation", "reset", "--help"], cwd);
    expect(result.stdout).toContain(RESET_TOKEN_ENV);
  });
});

describe("the flags refuse a half-supplied continuation", () => {
  it("refuses --continue without --token, and names both flags", async () => {
    const cwd = await strandedProject("reset-half-continue");
    const result = await resetCLI(cwd, "--continue", "rst-whatever", "--json");
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
    expect(result.stdout).toContain("--token");
  });

  it("refuses --token without --continue", async () => {
    const cwd = await strandedProject("reset-half-token");
    const result = await resetCLI(cwd, "--token", "abc", "--json");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("--continue");
  });
});

describe("supersede is reachable from the command line", () => {
  it("clears a marker whose secret is lost and opens a fresh reset", async () => {
    const cwd = await strandedProject("reset-supersede");
    const stranded = await passOne(cwd);
    // THE SECRET IS NOW GONE. Without this flag the project is wedged: nothing
    // can acquire the mutation lock while that marker is pending, so the
    // operator can neither finish the reset nor do anything else.
    const result = await resetCLI(cwd, "--supersede", "--json");
    expect(result.code, result.stderr).toBe(0);
    const body = envelope(result.stdout);
    expect(body.status).toBe("intent-recorded");
    expect(body.unitId).not.toBe(stranded.unitId);
  });

  it("leaves the project usable: the fresh reset completes", async () => {
    // THE PROPERTY THAT MATTERS IS NOT THAT SUPERSEDE RETURNS. A guard that
    // strands is a defect, so the test is that the system is USABLE afterwards —
    // the operator who lost their token can finish the repair.
    const cwd = await strandedProject("reset-supersede-usable");
    await passOne(cwd);
    const superseded = await resetCLI(cwd, "--supersede", "--json");
    const fresh = envelope(superseded.stdout);
    const done = await resetCLI(
      cwd, "--continue", fresh.unitId as string, "--token", fresh.continuationToken as string,
      "--json");
    expect(done.code, done.stderr).toBe(0);
    expect(envelope(done.stdout)).toMatchObject({ status: "completed" });
  });
});

describe("the verb refuses honestly", () => {
  it("refuses a healthy project with a parseable envelope and exit 1", async () => {
    const cwd = await emptyWorkspace("reset-healthy");
    await stagePreparation(cwd);
    const result = await resetCLI(cwd, "--json");
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({
      status: "refused", reason: expect.stringContaining("key-healthy"),
    });
  });

  it("refuses the wrong confirmation phrase for the key's real state", async () => {
    const cwd = await strandedProject("reset-wrong-confirm");
    const result = await runCLI(
      ["preparation", "reset", "--confirm", "not-the-phrase", "--json"], cwd);
    expectCLIJson(result, 1, {
      status: "refused", reason: expect.stringContaining("confirmation-mismatch"),
    });
  });

  it("refuses a project whose profile cannot be read", async () => {
    const cwd = await strandedProject("reset-bad-profile");
    await writeFile(path.join(cwd, ".llmwiki", "profile.json"), "{not json", "utf8");
    const result = await resetCLI(cwd, "--json");
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
  });

  it("refuses a directory that is not a project, and forks no store", async () => {
    // THE CASE RESET NEEDS MOST, and it was measured failing before the store
    // clause existed: exit 0, a fresh `.llmwiki` created here, a pending reset
    // unit inside it and a continuation token returned — a plausible repair
    // performed on a directory that is not the operator's project, while the
    // real one stayed broken. A bare directory and a project whose key was
    // deleted give the substrate the SAME answer, so store presence is the only
    // thing separating them.
    const cwd = await emptyWorkspace("reset-no-store");
    await rm(path.join(cwd, ".llmwiki"), { recursive: true, force: true });
    const result = await resetCLI(cwd, "--json");
    expect(result.code).toBe(1);
    // THE CONSEQUENCE, not just the code. An exit-1 assertion alone passes
    // against a version that refuses AFTER creating the store.
    expect(await readdir(cwd)).toEqual([]);
  });
});
