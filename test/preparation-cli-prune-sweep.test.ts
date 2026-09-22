/**
 * @file test/preparation-cli-prune-sweep.test.ts
 * @description `preparation prune` and `preparation sweep` through
 * `dist/cli.js`, which is where an operator meets the only verbs that destroy
 * bytes.
 *
 * WHAT A SUBPROCESS SUITE PROVES THAT AN IN-PROCESS ONE CANNOT: that the verbs
 * are REGISTERED and reachable, that the envelope parses as an envelope rather
 * than arriving behind a status icon, and that the exit code says what the
 * outcome says. The last is not cosmetic here — `nothing-to-sweep` is the
 * ordinary result of running sweep on a healthy project, so an exit code that
 * treated it as failure would make routine maintenance unscriptable.
 */

import path from "node:path";
import { chmod, rm } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { runCLI, expectCLIJson } from "./fixtures/run-cli.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";
import { preparationPaths } from "../src/preparations/paths.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { driveToFailed, stagePreparation } from "./preparations/lifecycle-fixture.js";

/** Far enough in the past that the thirty-day floor is cleared by real time. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** A project holding one terminal run old enough to prune. */
async function prunableProject(suffix: string): Promise<{ cwd: string; runId: string; workspaceId: string }> {
  const cwd = await emptyWorkspace(suffix);
  const { binding } = await stagePreparation(cwd);
  await driveToFailed(cwd, binding, LONG_AGO);
  return { cwd, runId: binding.runId, workspaceId: binding.workspaceId };
}

/** Parse one `--json` envelope, failing loudly rather than on a later field. */
function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("preparation prune through the binary", () => {
  it("reclaims an eligible run and exits 0", async () => {
    const { cwd, runId } = await prunableProject("prune-ok");
    const result = await runCLI(["preparation", "prune", runId, "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ status: "pruned", runId, resumed: false });
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(0);
  });

  it("names what it deleted in the human line, including the unit to audit", async () => {
    const { cwd, runId } = await prunableProject("prune-human");
    const result = await runCLI(["preparation", "prune", runId], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("byte(s) reclaimed");
    expect(result.stdout).toContain("unit prn-");
  });

  it("refuses a run inside its retention floor with a parseable envelope and exit 1", async () => {
    const cwd = await emptyWorkspace("prune-floor");
    const { binding } = await stagePreparation(cwd);
    await driveToFailed(cwd, binding, new Date().toISOString());
    const result = await runCLI(["preparation", "prune", binding.runId, "--json"], cwd);
    expectCLIJson(result, 1, { status: "refused" });
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(1);
  });
});

describe("preparation sweep through the binary", () => {
  it("reclaims a provably-absent-owner orphan and exits 0", async () => {
    const cwd = await emptyWorkspace("sweep-ok");
    const { binding } = await stagePreparation(cwd);
    await rm(preparationPaths(cwd, binding.workspaceId).runFile(binding.runId), { force: true });
    const result = await runCLI(["preparation", "sweep", "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ status: "swept", resumed: false });
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(0);
  });

  it("exits 0 with nothing to reclaim, because that is the healthy outcome", async () => {
    const cwd = await emptyWorkspace("sweep-clean");
    await stagePreparation(cwd);
    const result = await runCLI(["preparation", "sweep", "--json"], cwd);
    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toEqual({ status: "nothing-to-sweep" });
  });

  it("still emits an envelope when the destructive scan refuses a partial store", async () => {
    // THE LEAK THIS PINS WAS ONLY VISIBLE HERE. In process the refusal is an
    // exception a caller can catch; through the binary it was exit 1 with
    // EMPTY STDOUT, so `--json` handed a consumer nothing to parse. `prune`
    // never had it on this fault — its run lookup refuses a leg earlier — so
    // testing the pair together would have certified sweep on prune's behaviour.
    const cwd = await emptyWorkspace("sweep-partial");
    const { binding } = await stagePreparation(cwd);
    const blocked = path.join(path.dirname(path.dirname(
      preparationPaths(cwd, binding.workspaceId).runFile(binding.runId))), "preparations");
    await chmod(blocked, 0o000);
    try {
      const result = await runCLI(["preparation", "sweep", "--json"], cwd);
      expect(result.code).toBe(1);
      expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
    } finally {
      await chmod(blocked, 0o700);
    }
  });

  it("refuses outside a project rather than creating one to sweep", async () => {
    const bare = await emptyWorkspace("sweep-bare");
    const result = await runCLI(["preparation", "sweep", "--json"], bare);
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ status: "refused" });
  });
});

describe("the preparation group offers both verbs and still withholds handoff", () => {
  it("lists prune and sweep in its help", async () => {
    const cwd = await emptyWorkspace("prune-help");
    const help = await runCLI(["preparation", "--help"], cwd);
    expect(help.stdout).toContain("prune");
    expect(help.stdout).toContain("sweep");
    // The R-7 asymmetry is unchanged by this slice, and pinning it here means a
    // future verb cannot be added by accident alongside these two.
    expect(help.stdout).not.toContain("handoff");
  });

  it("keeps `prune` a run-scoped verb, so it cannot be aimed at a project", async () => {
    // Missing the required argument is a commander-level refusal, and it matters
    // for a destructive verb: an operator who types `preparation prune` alone
    // must not have anything happen at all.
    const { cwd } = await prunableProject("prune-noarg");
    const result = await runCLI(["preparation", "prune"], cwd);
    expect(result.code).not.toBe(0);
    expect((await scanPreparationInventory(cwd)).manifests.length).toBe(1);
    expect(path.isAbsolute(cwd)).toBe(true);
  });
});
