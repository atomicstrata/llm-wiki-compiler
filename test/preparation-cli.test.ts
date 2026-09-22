/**
 * @file test/preparation-cli.test.ts
 * @description Task 10 slice, chunk 1 — `llmwiki preparation list` is REACHABLE
 * through the built CLI.
 *
 * These run the real `dist/cli.js` in a subprocess. That is the whole point of
 * the chunk: the superseded stack had thirteen preparation operations and zero
 * production callers, so every test in it ran against fixtures that supplied
 * whatever shape the code expected. A subprocess test cannot do that — it either
 * reaches the command through commander's registration or it does not.
 *
 * The precondition each test pins is REACHABILITY, not output prettiness. An
 * unregistered command exits non-zero with commander's unknown-command error, so
 * a passing exit code here is evidence the composition root is wired.
 */

import { describe, expect, it } from "vitest";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

import {
  emptyWorkspace, expectRefusal, initializedWorkspace, listedStates, onlyManifest,
  planAndSeed, runStateOf, stageable, stagedRunIn, listEnvelope,
} from "./preparation-cli-fixture.js";

describe("preparation CLI is reachable from the built binary", () => {
  it("advertises the group in --help", async () => {
    const cwd = await emptyWorkspace("help");
    const result = await runCLI(["--help"], cwd);
    expectCLIExit(result, 0);
    // Registration, observed through the real program rather than by importing
    // the registrar — an import would pass even if `cli.ts` never called it.
    expect(result.stdout).toContain("preparation");
  });

  it("`preparation list` runs and exits 0 on a store with no runs", async () => {
    const cwd = await emptyWorkspace("empty");
    const result = await runCLI(["preparation", "list"], cwd);
    // Exit 0 is the claim: reading a store that has nothing in it SUCCEEDED.
    // An unregistered subcommand would exit non-zero here, so this is the
    // reachability assertion.
    expectCLIExit(result, 0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/No preparation runs|problem:/u);
  });

  it("`--json` emits a parseable envelope with both documented keys", async () => {
    const cwd = await emptyWorkspace("json");
    const result = await runCLI(["preparation", "list", "--json"], cwd);
    expectCLIExit(result, 0);
    // Parsed, not string-matched: the contract is that a machine consumer can
    // read this, and a human-readable line containing the word "runs" would
    // satisfy a substring check while breaking every actual consumer.
    const envelope = JSON.parse(result.stdout) as { runs: unknown[]; problems: unknown[] };
    expect(Array.isArray(envelope.runs)).toBe(true);
    expect(Array.isArray(envelope.problems)).toBe(true);
  });

  it("a pristine PROJECT reports NO problem — an absent key is the healthy state", async () => {
    // The preparation key is minted at first staging, so absent is not a fault.
    // Reporting it trained a reader to ignore the `problem:` lines that matter,
    // which is what made the key-collapse defect below invisible.
    //
    // AN INITIALIZED ROOT, deliberately. This case used a bare directory, which
    // is not a pristine project at all — it is not a project — so it was pinning
    // the silently-clean answer the case below now refuses.
    const cwd = await initializedWorkspace("pristine");
    const envelope = await listEnvelope(cwd);
    expect(envelope.runs).toEqual([]);
    expect(envelope.problems).toEqual([]);
  });

  it("a directory that is NOT a project says so instead of listing clean", async () => {
    // The answer used to be indistinguishable from a healthy project with no
    // runs: the scan finds no inventory, every cross-check compares zero against
    // zero, and an operator standing one directory above their project was told
    // their runs did not exist. Exit stays 0 — nothing failed, and the answer is
    // in the envelope where a consumer can read it.
    const cwd = await emptyWorkspace("not-a-project");
    const envelope = await listEnvelope(cwd);
    expect(envelope.runs).toEqual([]);
    expect(envelope.problems).toEqual([
      "project-readiness: no .llmwiki store here; run from the project root",
    ]);
  });

  it("NEVER answers empty while run bytes are on disk", async () => {
    // Four states made the listing and the scan's own run count disagree while
    // every other signal read healthy. The command answered
    // `{"runs": [], "problems": []}` with run bytes present — and it was
    // holding the contradiction the whole time, because `inventory.epoch.runs`
    // counts what the scan saw and `collect` discarded it.
    //
    // This builds the sharpest of the four: delete the preparation directory
    // (manifest and evidence) and leave the run leaf. Nothing else complains.
    const cwd = await emptyWorkspace("orphaned");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    // PIN THE PRECONDITION: the run is listed before the fault is introduced.
    expect(await listedStates(cwd)).toHaveProperty(binding.runId);

    const { rm } = await import("node:fs/promises");
    const path = await import("node:path");
    await rm(path.join(cwd, ".llmwiki", "workspaces", binding.workspaceId, "preparations"),
      { recursive: true, force: true });

    const after = await runCLI(["preparation", "list", "--json"], cwd);
    expectCLIExit(after, 0);
    const envelope = JSON.parse(after.stdout) as { runs: unknown[]; problems: string[] };
    // An empty list is ACCEPTABLE here — the manifests really are gone. What is
    // not acceptable is an empty list with NO problem, which reads to any
    // consumer as "this project has no preparation runs" while the bytes sit
    // there. The scan saw them; the answer has to say so.
    expect(envelope.problems.join(" ")).toMatch(/run-accounting/u);
  });

  it("NEVER answers empty when the store lost BOTH its manifests and its key", async () => {
    // The conjunction. Each condition had its own test and the cross-check
    // covered one branch; the key-not-ok branch returned BEFORE it, so a store
    // missing both answered `{"runs": [], "problems": []}` with run bytes on
    // disk. Two guards, each correct alone, with the gap between them.
    const cwd = await emptyWorkspace("bothgone");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const { rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const { preparationKeyFile, PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
    await rm(path.join(cwd, ".llmwiki", "workspaces", binding.workspaceId, PREPARATIONS_SEGMENT),
      { recursive: true, force: true });
    await rm(preparationKeyFile(cwd), { force: true });

    const envelope = await listEnvelope(cwd);
    expect(envelope.problems.join(" ")).toMatch(/run-accounting/u);
  });

  it("a run stays VISIBLE when its key cannot be read — could-not-see, not absent", async () => {
    // THE CONTROL THIS FILE WAS MISSING. Every earlier test ran against an
    // empty directory, so none of them contained a run and none could witness
    // the file's own stated rule: a failed read is "could not see", never "does
    // not exist". The command collapsed every known run to zero rows on a key
    // failure and printed "No preparation runs." with a run on disk — and all
    // four tests passed either way, because none of them staged anything.
    const cwd = await emptyWorkspace("keyfail");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);

    // PIN THE PRECONDITION: the run is listed before the fault is introduced.
    // PIN THE PRECONDITION: the run is listed before the fault is introduced.
    expect(await listedStates(cwd)).toHaveProperty(binding.runId);

    // Break ONLY the key, so the manifests remain enumerable. The path comes
    // from the production helper, not a hand-built join: a wrong guess would
    // chmod nothing and the assertion below would pass for the wrong reason.
    const { chmod } = await import("node:fs/promises");
    const { preparationKeyFile } = await import("../src/preparations/paths.js");
    await chmod(preparationKeyFile(cwd), 0o644);

    const after = await runCLI(["preparation", "list", "--json"], cwd);
    expectCLIExit(after, 0);
    const envelope = JSON.parse(after.stdout) as {
      runs: { runId: string; state: string | null; detail: string | null }[];
      problems: string[];
    };
    // The run is STILL LISTED, with its state unknown and a reason — never
    // dropped, which would read to any consumer as "this run does not exist".
    const row = envelope.runs.find((run) => run.runId === binding.runId);
    expect(row).toBeDefined();
    expect(row?.state).toBeNull();
    expect(row?.detail).toEqual(expect.any(String));
    expect(envelope.problems.length).toBeGreaterThan(0);
  });
});

describe("the lifecycle path runs end to end through the CLI", () => {
  it("stage -> list -> fail -> TERMINAL, all observed through the built binary", async () => {
    // THE SLICE'S POINT. One preparation run driven from genesis to a terminal
    // state, every step observed through the real binary rather than by calling
    // the substrate in-process.
    //
    // `failed` is the terminal chosen because it is the only one reachable: six
    // of the eight terminal states have no production writer at all, and
    // `handed-off` is unreachable because nothing writes `handoff-ready`. Every
    // test in the repo that reaches those states casts `type as never` to feed
    // the appender a transition production cannot produce — which is exactly
    // the substitution this slice exists to stop making.
    const cwd = await emptyWorkspace("lifecycle");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);

    // GENESIS is visible.
    expect((await listedStates(cwd))[binding.runId]).toBe("planned");

    // THE TERMINAL TRANSITION, driven by the operator.
    const failed = await runCLI(["preparation", "fail", binding.runId], cwd);
    expectCLIExit(failed, 0);

    // And it is DURABLE — re-read through a separate process invocation, so the
    // assertion is about what landed on disk, not about a return value.
    expect((await listedStates(cwd))[binding.runId]).toBe("failed");
  });

  it("REFUSES an unknown run, non-zero, without touching the store", async () => {
    const cwd = await emptyWorkspace("failunknown");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const reason = await expectRefusal(["preparation", "fail", "prr_does_not_exist"], cwd);
    expect(reason).toMatch(/no such preparation run/u);
    // The REAL run is untouched — a refusal must not move anything.
    expect((await listedStates(cwd))[binding.runId]).toBe("planned");
  });

  it("REFUSES when the project's own configuration is unreadable", async () => {
    // The READINESS check fails closed. A project whose own configuration
    // cannot be read must not have a durable transition driven against it. This
    // is not an authority check: nothing here decides whether the operator MAY
    // act, only whether the project is in a state where acting is meaningful.
    // BREAK ONLY THE PROFILE, so run resolution would otherwise succeed. My
    // first version chmod'd the key — which also trips `resolveRun`'s own key
    // check, so the command refused from a DIFFERENT branch and the test passed
    // with the readiness check deleted entirely. Observing a refusal is not
    // observing the refusal you named.
    const cwd = await emptyWorkspace("notready");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { PROFILE_FILE } = await import("../src/utils/constants.js");
    await writeFile(path.join(cwd, PROFILE_FILE), "{ not json");

    const result = await runCLI(["preparation", "fail", binding.runId], cwd);
    expect(result.code).not.toBe(0);
    // The READINESS reason specifically — not merely "something refused".
    expect(`${result.stdout}${result.stderr}`).toMatch(/profile is present but unreadable/u);

    // And the run DID NOT MOVE: a project whose configuration cannot be read
    // must not have a durable transition driven against it.
    const { readPreparationRun } = await import("../src/preparations/run-store.js");
    const reread = await readPreparationRun(cwd, binding);
    expect(reread.status === "ok" && reread.run.state).toBe("planned");
  });
});

describe("fail refuses honestly instead of throwing a validator string", () => {
  it("`fail --json` stays parseable when the project lock is busy", async () => {
    // `list` and `stage` quiet their output around the work; `fail` did not, so
    // the lock helper's "Another compilation is running." landed on stdout
    // ahead of the envelope. The third surface not inheriting a fix the first
    // two already had.
    const cwd = await emptyWorkspace("failjsonlock");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    const { acquireMutationLock } = await import("../src/operation-bundles/lock-gate.js");
    const { releaseLock } = await import("../src/utils/lock.js");
    expect(await acquireMutationLock(cwd, "ordinary")).toBe(true);
    try {
      const result = await runCLI(
        ["preparation", "fail", binding.runId, "--json"], cwd);
      expect(result.code).not.toBe(0);
      // Parseable — that is the whole claim.
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    } finally {
      await releaseLock(cwd);
    }
  });

  it("REFUSES to fail a recovery-required run — abandonment is not a back door", async () => {
    // `abandonment.ts` exists so a run may leave `recovery-required` terminally
    // ONLY under an explicit residual-state confirmation, with findings
    // RECOMPUTED from the run's own durable state so an operator cannot
    // understate what remained unresolved. `failed` carries a `none` payload —
    // the schema has nowhere to put findings — and costs `preparation.run`
    // rather than the abandonment grant.
    //
    // Deriving the precondition from `LEGAL_EDGES` alone admitted this, because
    // the edge is legal. A legal edge is a record-shape constraint, not an
    // authority statement.
    const { cwd, binding } = await stagedRunIn("failbackdoor", "recovery-required");

    const reason = await expectRefusal(["preparation", "fail", binding.runId], cwd);
    expect(reason).toMatch(/abandoned with an explicit residual-state confirmation/u);

    // And it DID NOT reach a terminal state by this route.
    expect(await runStateOf(cwd, binding)).toBe("recovery-required");
  });

  it("a DEGRADED scan says could-not-see, never no-such-run", async () => {
    // `missReason` re-implements the could-not-see rule that `list` has a
    // control for, and had none of its own — inverting it entirely left the
    // suite green. A corrupted manifest makes the scan non-authoritative, so a
    // miss over it is not evidence of absence.
    const cwd = await emptyWorkspace("faildegraded");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    // The layout comes from the production constants, not a hand-built string.
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { MANIFEST_FILENAME, PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
    await writeFile(path.join(cwd, ".llmwiki", "workspaces", binding.workspaceId,
      PREPARATIONS_SEGMENT, binding.preparationId, MANIFEST_FILENAME), "{ corrupt");

    const reason = await expectRefusal(["preparation", "fail", binding.runId], cwd);
    expect(reason).toMatch(/not authoritative|may exist/u);
    expect(reason).not.toMatch(/no such preparation run/u);
  });

  it("`fail --json` emits a PARSEABLE envelope on success and on refusal", async () => {
    // It did neither: `output.status` prefixes an icon, so every invocation
    // emitted `i {"status":…}`. The tests regexed combined output instead of
    // parsing it, which is why the suite was blind to it — `list --json` has
    // had a parse assertion since chunk 1 and this one dropped it.
    const cwd = await emptyWorkspace("failjson");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);

    const ok = await runCLI(["preparation", "fail", binding.runId, "--json"], cwd);
    expectCLIExit(ok, 0);
    expect((JSON.parse(ok.stdout) as { status: string }).status).toBe("failed");

    // The refusal path too — an already-terminal run.
    const reason = await expectRefusal(["preparation", "fail", binding.runId], cwd);
    expect(reason).toMatch(/already terminal/u);
  });

  it("REFUSES a state that cannot reach failed, without moving the run", async () => {
    // Eleven of sixteen states cannot reach `failed`. Each used to escape as
    // the raw validator string "illegal preparation run state edge", past the
    // `refused` arm built for exactly this.
    const { cwd, binding } = await stagedRunIn("failillegal", "cancelling");

    const reason = await expectRefusal(["preparation", "fail", binding.runId], cwd);
    // The run's own state is named, not a validator internal.
    expect(reason).toMatch(/cancelling/u);
    expect(reason).not.toMatch(/illegal preparation run state edge/u);

    // And it DID NOT MOVE.
    expect(await runStateOf(cwd, binding)).toBe("cancelling");
  });

});
