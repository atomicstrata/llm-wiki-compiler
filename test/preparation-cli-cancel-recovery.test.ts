/**
 * @file test/preparation-cli-cancel-recovery.test.ts
 * @description `llmwiki preparation cancel` and `llmwiki preparation recover`
 * through the REAL built binary.
 *
 * WHY SUBPROCESS. An in-process test reaches a function; it says nothing about
 * whether commander ever registers the verb, whether the composition root calls
 * the registrar, or whether the `--json` envelope survives contact with the
 * process's own stdout. Every one of those has failed in this command group
 * before — an envelope arrived prefixed with a status icon and never parsed, on
 * every invocation, with the in-process suites green.
 *
 * WHAT EACH CASE PINS: reachability (an unregistered verb exits non-zero with
 * commander's unknown-command error), a PARSEABLE envelope, an exit code that
 * matches the outcome, and the durable effect observed from a separate process
 * than the one that made it.
 */

import { describe, expect, it } from "vitest";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import { CLI, expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import {
  driveRunning, readRun, stagedProject, type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

/** Run one preparation verb in the built binary against a fixture's root. */
function verb(fixture: RunningRunFixture, name: string, ...flags: string[]) {
  return runCLI(["preparation", name, fixture.binding.runId, ...flags], fixture.root);
}

/** The parsed `--json` envelope, which is the contract a consumer depends on. */
function envelopeOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("preparation cancel is reachable from the built binary", () => {
  it("advertises both verbs in the group's help", async () => {
    const fixture = await stagedProject("cliadvertise");
    try {
      const result = await runCLI(["preparation", "--help"], fixture.root);
      expectCLIExit(result, 0);
      expect(result.stdout).toContain("cancel");
      expect(result.stdout).toContain("recover");
    } finally { await fixture.cleanup(); }
  });

  it("publishes a durable request, exits 0, and emits a parseable envelope", async () => {
    const fixture = await stagedProject("clicancel");
    try {
      const result = await verb(fixture, "cancel", "--json");
      expectCLIExit(result, 0);
      expect(envelopeOf(result.stdout))
        .toEqual({ status: "requested", runId: fixture.binding.runId, request: "created" });
      // Read back OUT OF PROCESS: the durable half cannot be observed from the
      // envelope, and this is the only assertion that survives a command that
      // reports success without writing anything.
      const read = await readPreparationCancel(
        fixture.root, fixture.binding.workspaceId, fixture.binding.runId);
      expect(read.status).toBe("present");
      if (read.status === "present") expect(read.request.requester).toBe("cli-operator");
    } finally { await fixture.cleanup(); }
  });

  it("exits 0 on an idempotent retry and says the request is already pending", async () => {
    const fixture = await stagedProject("cliidem");
    try {
      expectCLIExit(await verb(fixture, "cancel"), 0);
      const again = await verb(fixture, "cancel", "--json");
      // NOT A FAILURE: the operator's intent is on disk either way, and a
      // nonzero exit would make a re-run of a script look broken.
      expectCLIExit(again, 0);
      expect(envelopeOf(again.stdout)).toMatchObject({ request: "already-pending" });
    } finally { await fixture.cleanup(); }
  });

  it("exits non-zero with a typed refusal for an unknown run", async () => {
    const fixture = await stagedProject("clicancelunknown");
    try {
      const result = await runCLI(["preparation", "cancel", "prun_" + "0".repeat(64), "--json"], fixture.root);
      expect(result.code).not.toBe(0);
      expect(envelopeOf(result.stdout)).toEqual({ status: "refused", reason: "no such preparation run" });
    } finally { await fixture.cleanup(); }
  });
});

describe("preparation recover is reachable from the built binary", () => {
  it("parks a stranded run, exits 0, and reports the lifecycle state", async () => {
    const fixture = await stagedProject("clirecover");
    try {
      await driveRunning(fixture, "stranded");
      const result = await verb(fixture, "recover", "--json");
      expectCLIExit(result, 0);
      expect(envelopeOf(result.stdout)).toEqual({
        status: "parked", runId: fixture.binding.runId, lifecycle: { status: "clean" },
      });
      const run = await readRun(fixture);
      expect(run.state).toBe("recovery-required");
      expect(run.executionOwner).toBeUndefined();
      // The CLI is the local operator, and the durable transition says so.
      expect(run.transitions[run.transitions.length - 1]?.actor)
        .toMatchObject({ id: "cli-operator", surface: "cli" });
    } finally { await fixture.cleanup(); }
  });

  it("refuses a LIVE-owner run non-zero and leaves it running", async () => {
    // The stranded-versus-busy precondition, reached through the binary. The
    // owner names THIS test process, which really is alive, so the subprocess's
    // liveness check answers about a genuinely running process.
    const fixture = await stagedProject("clirecoverlive");
    try {
      await driveRunning(fixture, "live");
      const result = await verb(fixture, "recover", "--json");
      expect(result.code).not.toBe(0);
      const envelope = envelopeOf(result.stdout);
      expect(envelope.status).toBe("refused");
      expect(String(envelope.reason)).toMatch(/live executor/u);
      expect((await readRun(fixture)).state).toBe("running");
    } finally { await fixture.cleanup(); }
  });

  it("prints the human lines without a JSON flag", async () => {
    const fixture = await stagedProject("clirecoverhuman");
    try {
      await driveRunning(fixture, "stranded");
      const result = await verb(fixture, "recover");
      expectCLIExit(result, 0);
      expect(result.stdout).toContain("parked for recovery");
      // The lifecycle line is printed for a healthy project too — it is the
      // reason this verb is worth running even when nothing is wrong.
      expect(result.stdout).toContain("no unfinished lifecycle maintenance");
    } finally { await fixture.cleanup(); }
  });
});

describe("the built binary really is what these tests ran", () => {
  it("names a compiled entry point that exists", async () => {
    // ANTI-VACUITY for the whole file: every case above asserts on a subprocess,
    // and a missing binary would fail them all with the same shape as a genuine
    // regression. This says which it was.
    const { access } = await import("node:fs/promises");
    await expect(access(CLI)).resolves.toBeUndefined();
  });
});
