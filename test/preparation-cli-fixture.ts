/**
 * @file test/preparation-cli-fixture.ts
 * @description Shared workspace and document fixtures for the preparation CLI
 * subprocess tests.
 *
 * Extracted when `preparation-cli.test.ts` passed the repo's 400-line test-file
 * limit. Both halves use ONE copy of these, so a change to what "an initialized
 * project" means cannot drift between the read tests and the write tests.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

/** A bare directory — no `.llmwiki`, so the store is genuinely absent. */
export async function emptyWorkspace(suffix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `llmwiki-prep-${suffix}-`));
}

/**
 * A directory that IS an initialized project.
 *
 * `stage` refuses to create a store as a side effect — running one directory
 * deep would otherwise silently fork the project — so a write test has to start
 * from an initialized root, which is what an operator has after `init`.
 */
export async function initializedWorkspace(suffix: string): Promise<string> {
  const dir = await emptyWorkspace(suffix);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
  return dir;
}

/** Write a plan and its matching seed into an existing project. */
export async function planAndSeed(
  cwd: string, mutate: (plan: Record<string, unknown>) => void = () => {},
): Promise<{ planFile: string; seedFile: string }> {
  const { fixturePlan } = await import("./preparations/store-fixture.js");
  const { writeFile } = await import("node:fs/promises");
  const planFile = path.join(cwd, "plan.json");
  const seedFile = path.join(cwd, "seed.json");
  await writeFile(planFile, JSON.stringify(fixturePlan(mutate)));
  await writeFile(seedFile, JSON.stringify({ seed: "initial-input", version: 1 }));
  return { planFile, seedFile };
}

/** An initialized project with a plan and its matching seed already written. */
export async function stageable(suffix: string, mutate: (plan: Record<string, unknown>) => void = () => {}) {
  const cwd = await initializedWorkspace(suffix);
  return { cwd, ...await planAndSeed(cwd, mutate) };
}

/** Write a schema-valid plan without supplying its required seed. */
export async function planWithoutSeed(cwd: string): Promise<string> {
  const { validPlan } = await import("./preparations/plan-fixture.js");
  const { writeFile } = await import("node:fs/promises");
  const file = path.join(cwd, "plan.json");
  await writeFile(file, JSON.stringify(validPlan()));
  return file;
}

/** The durable manifest of the single preparation in this project. */
export async function onlyManifest(cwd: string, workspaceId: string): Promise<Record<string, unknown>> {
  const path = await import("node:path");
  const { readdir, readFile } = await import("node:fs/promises");
  const { MANIFEST_FILENAME, PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
  const dir = path.join(cwd, ".llmwiki", "workspaces", workspaceId, PREPARATIONS_SEGMENT);
  const [prepId] = await readdir(dir);
  return JSON.parse(await readFile(path.join(dir, prepId!, MANIFEST_FILENAME), "utf8")) as Record<string, unknown>;
}

/** Stage through the actual CLI and inspect its sole durable manifest. */
export async function stageManifest(cwd: string, planFile: string, seedFile: string): Promise<Record<string, unknown>> {
  const staged = await runCLI(["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
  expectCLIExit(staged, 0);
  const created = JSON.parse(staged.stdout) as { workspaceId: string };
  return onlyManifest(cwd, created.workspaceId);
}

/** Read a successful machine-readable listing through a fresh CLI process. */
export async function listEnvelope(cwd: string): Promise<{ runs: unknown[]; problems: string[] }> {
  const result = await runCLI(["preparation", "list", "--json"], cwd);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout) as { runs: unknown[]; problems: string[] };
}



/**
 * Run a command expecting a typed refusal, and return its reason.
 *
 * The assert-code-then-parse-then-check-status trio was repeated in a dozen
 * tests. Sharing it keeps the important half — the REASON — impossible to
 * forget, which is the half that was missing when a test passed under a
 * mutation that refused every invocation.
 */
export async function expectRefusal(args: readonly string[], cwd: string): Promise<string> {
  const result = await runCLI([...args, "--json"], cwd);
  expect(result.code).not.toBe(0);
  const envelope = JSON.parse(result.stdout) as { status: string; reason: string };
  expect(envelope.status).toBe("refused");
  return envelope.reason;
}

/** Every run id the CLI currently lists, read back through a fresh process. */
export async function listedStates(cwd: string): Promise<Record<string, string | null>> {
  const result = await runCLI(["preparation", "list", "--json"], cwd);
  const envelope = JSON.parse(result.stdout) as { runs: { runId: string; state: string | null }[] };
  return Object.fromEntries(envelope.runs.map((run) => [run.runId, run.state]));
}

/**
 * Stage a run and drive it to one further state through the substrate.
 *
 * The append is done in process ON PURPOSE: these are fixtures for states the
 * CLI cannot yet produce, and driving them by hand is how a test reaches the
 * refusal it wants to observe. The behaviour under test is always the
 * subsequent CLI invocation.
 */
export async function stagedRunIn(
  suffix: string, state: "recovery-required" | "cancelling",
): Promise<{ cwd: string; binding: { workspaceId: string; runId: string } }> {
  const cwd = await emptyWorkspace(suffix);
  const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
  const { binding } = await stagePreparation(cwd);
  const { appendPreparationTransitionLocked, readPreparationRun } =
    await import("../src/preparations/run-store.js");
  const { preparationRunPredecessor } = await import("../src/preparations/run-integrity.js");
  const read = await readPreparationRun(cwd, binding);
  if (read.status !== "ok") throw new Error("run unavailable");
  await appendPreparationTransitionLocked(cwd, binding, preparationRunPredecessor(read.run), {
    type: state, stateAfter: state,
    actor: { id: "operator", surface: "cli" }, at: "2026-08-05T12:00:00.000Z",
    payload: state === "recovery-required"
      ? { kind: "problem", code: "preparation-integrity-obligation" }
      : { kind: "none" },
  } as never);
  return { cwd, binding };
}

/** The durable state of one run, read directly from the store. */
export async function runStateOf(
  cwd: string, binding: { workspaceId: string; runId: string },
): Promise<string | null> {
  const { readPreparationRun } = await import("../src/preparations/run-store.js");
  const read = await readPreparationRun(cwd, binding as never);
  return read.status === "ok" ? read.run.state : null;
}
