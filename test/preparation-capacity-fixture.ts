/**
 * @file test/preparation-capacity-fixture.ts
 * @description Local helpers for the Orchestration V2 capacity boundary matrix.
 *
 * Every cap in this matrix is exercised at EXACTLY its limit and one unit over,
 * so nothing here may hard-code a boundary that the source already states. The
 * two run-budget boundaries are DERIVED from the exported constants plus one
 * measured projection, because they are functions of a canonical record width
 * that no constant names; if a derivation drifts, its at-cap partner goes red
 * rather than silently testing the wrong number.
 *
 * `test/preparation-cli-fixture.ts` is reused read-only for the pieces that
 * already exist there (`initializedWorkspace`, `expectRefusal`). What is added
 * here is what that fixture does not do: raw plan/seed DOCUMENT control (the
 * byte and depth caps need text a validated fixture cannot express) and
 * before/after store enumeration for the no-partial-staging assertions.
 */

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runCLI, type CLIResult } from "./fixtures/run-cli.js";
import { initializedWorkspace } from "./preparation-cli-fixture.js";
import { validPlan } from "./preparations/plan-fixture.js";
import { canonicalBytes, canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import {
  MAX_PREPARATION_RUN_BYTES, MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES,
  PREPARATION_RUN_CONTROL_RESERVE_BYTES,
} from "../src/preparations/constants.js";
import { projectPreparationRunBudget, type RunBudgetInput } from "../src/preparations/run-budget.js";
import { readPreparationKey } from "../src/preparations/key-epoch.js";

/** The private store directory a staged preparation lives under. */
const STORE_SEGMENT = ".llmwiki";

/** The structured seed value the base plan fixture is content-addressed to. */
export const DEFAULT_SEED = { seed: "initial-input", version: 1 };

/** One project with its plan and seed documents already written. */
export interface StageDocuments {
  cwd: string;
  planFile: string;
  seedFile: string;
}

/** Every durable leaf under the private store as a sorted `path:bytes` list. */
export async function storeInventory(cwd: string): Promise<string[]> {
  return leavesOf(path.join(cwd, STORE_SEGMENT), "");
}

/** The single leaf a published preparation key epoch adds to the store. */
export const KEY_LEAF = "preparation-runs.runkey";

/** Store leaf paths with the `:bytes` suffix dropped, for naming an exact delta. */
export function leafNames(leaves: readonly string[]): string[] {
  return leaves.map((leaf) => leaf.replace(/:\d+$/u, ""));
}

/** The key epoch id of a project that has one, or null when it has no key. */
export async function keyEpochOf(cwd: string): Promise<string | null> {
  const read = await readPreparationKey(cwd);
  return read.status === "ok" ? read.keyEpochId : null;
}

/** Recursively enumerate one directory's leaves, sorted for exact comparison. */
async function leavesOf(dir: string, prefix: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => null);
  if (names === null) return [];
  const leaves: string[] = [];
  for (const name of [...names].sort()) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) leaves.push(...await leavesOf(full, `${prefix}${name}/`));
    else leaves.push(`${prefix}${name}:${info.size}`);
  }
  return leaves;
}

/** An initialized project holding the exact plan and seed TEXT supplied. */
export async function projectWith(
  suffix: string, planText: string, seedText: string,
): Promise<StageDocuments> {
  const cwd = await initializedWorkspace(suffix);
  const planFile = path.join(cwd, "plan.json");
  const seedFile = path.join(cwd, "seed.json");
  await writeFile(planFile, planText);
  await writeFile(seedFile, seedText);
  return { cwd, planFile, seedFile };
}

/** Overwrite one project's plan document with new text. */
export async function rewritePlan(documents: StageDocuments, planText: string): Promise<void> {
  await writeFile(documents.planFile, planText);
}

/** Run `preparation stage` over one project's documents. */
export async function stage(
  documents: StageDocuments, extra: readonly string[] = [],
): Promise<CLIResult> {
  return runCLI(
    ["preparation", "stage", documents.planFile, "--seed", documents.seedFile, ...extra, "--json"],
    documents.cwd,
  );
}

/**
 * The declared outcome envelope one invocation printed.
 *
 * Parsing is what separates a refusal from a fault: a substrate throw that
 * escapes the command's refusal allowlist also exits non-zero, but under
 * `--json` it prints NOTHING, so this throws rather than reporting a refusal
 * that never happened.
 */
function outcomeOf(result: CLIResult): Record<string, unknown> {
  expect(result.stdout, `no envelope; code=${result.code} stderr=${result.stderr}`).not.toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Assert one invocation staged, and return the minted run id. */
export function stagedRunId(result: CLIResult): string {
  const outcome = outcomeOf(result);
  expect(outcome, `expected a staged exit; code=${result.code}`).toMatchObject({ status: "staged" });
  expect(result.code).toBe(0);
  return String(outcome.runId);
}

/** Assert one invocation produced the declared refusal, and return its reason. */
export function refusalReason(result: CLIResult): string {
  const outcome = outcomeOf(result);
  expect(outcome, `expected a refusal; code=${result.code}`).toMatchObject({ status: "refused" });
  expect(result.code).not.toBe(0);
  return String(outcome.reason);
}

/**
 * Run one action and prove the store is byte-for-byte what it was.
 *
 * This is the no-partial-staging control. Comparing the whole enumeration —
 * every path AND size — rather than a run listing is deliberate: an orphaned
 * evidence object or a half-written manifest is invisible to `preparation list`
 * precisely because it never became a run.
 */
export async function expectStoreUnchanged(
  cwd: string, act: () => Promise<CLIResult>,
): Promise<CLIResult> {
  const before = await storeInventory(cwd);
  const result = await act();
  expect(await storeInventory(cwd)).toEqual(before);
  return result;
}

/** Build a plan document whose declared input set is content-addressed to `seed`. */
export function planFor(
  seed: unknown, mutate: (plan: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const plan = validPlan();
  plan.initialInputSet = {
    kind: "seed", mediaType: "application/json", provenanceLabel: "caller",
    digest: canonicalDigest(seed), byteCount: canonicalBytes(seed).byteLength,
    sensitivity: "ordinary", retention: "until-handoff",
    producer: { kind: "host", contractDigest: `sha256:${"a".repeat(64)}` }, untrusted: true,
  };
  mutate(plan);
  return plan;
}

/** A JSON value nested through exactly `depth` containers. */
export function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
}

/** Pad one document with trailing whitespace to exactly `bytes` UTF-8 bytes. */
export function padTo(text: string, bytes: number): string {
  const padding = bytes - Buffer.byteLength(text, "utf8");
  expect(padding).toBeGreaterThanOrEqual(0);
  return text + " ".repeat(padding);
}

/** Per-instance bounds shared by every phase of a generated chain plan. */
function chainPhaseBounds(): Record<string, number> {
  return {
    maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0,
    maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes: 1024,
    maximumCheckpointBytes: 0, maximumTokensPerAttempt: 100, maximumTimeMsPerInstance: 1000,
    maximumCostMicrosPerAttempt: 10,
  };
}

/** A linear dependency chain of `count` single-instance work phases. */
function chainPhases(count: number): Record<string, unknown>[] {
  const contractDigest = `sha256:${"a".repeat(64)}`;
  return Array.from({ length: count }, (_unused, index) => ({
    logicalPhaseId: `p${index}`, role: "work", disposition: "required",
    dependsOn: index === 0 ? [] : [`p${index - 1}`],
    executor: { kind: "host-handler", handlerId: "chain", handlerContractVersion: "1", handlerContractDigest: contractDigest },
    inputBindings: [index === 0
      ? { bindingId: "seed", sourceKind: "initial-input" }
      : { bindingId: "prev", sourceKind: "phase-output", sourcePhaseId: `p${index - 1}` }],
    expansion: { kind: "single" }, bounds: chainPhaseBounds(),
  }));
}

/** The exact worst-case envelope a `count`-phase chain declares. */
function chainBounds(count: number): Record<string, number> {
  return {
    maximumPhaseInstances: count, maximumAttempts: count * 2, maximumInvocations: count * 2,
    maximumBrokerRequests: 0, maximumEffects: 0, maximumTransitions: count * 4,
    maximumEvidenceRefs: count * 3, maximumEvidenceBytes: count * 1024, maximumCheckpointBytes: 0,
    maximumTokens: count * 200, maximumTimeMs: count * 1000, maximumCostMicros: count * 20,
  };
}

/**
 * A plan declaring exactly `count` logical phases.
 *
 * The chain keeps the handoff capacity block the base fixture declares: an
 * atomicity class of `local-bundle-only` REQUIRES a local bundle output, so
 * replacing the output contract wholesale rejects on atomicity long before the
 * phase-count cap is reached.
 */
export function chainPlan(count: number, seed: unknown = DEFAULT_SEED): Record<string, unknown> {
  return planFor(seed, (plan) => {
    plan.phases = chainPhases(count);
    plan.outputContract = {
      ...(plan.outputContract as Record<string, unknown>),
      producingPhaseIds: [`p${count - 1}`],
    };
    plan.bounds = chainBounds(count);
  });
}

/** The run-budget input one plan document plus one allowance projects. */
export function budgetInputFor(plan: Record<string, unknown>, allowance: number): RunBudgetInput {
  const bounds = plan.bounds as Record<string, number>;
  return {
    maximumPhaseInstances: bounds.maximumPhaseInstances!,
    maximumEvidenceRefs: bounds.maximumEvidenceRefs!,
    maximumBrokerRequests: bounds.maximumBrokerRequests!,
    maximumEffects: bounds.maximumEffects!,
    maximumTransitions: bounds.maximumTransitions!,
    controlTransitionAllowance: allowance,
  };
}

/** Bytes one transition costs the record: the full envelope plus its separator. */
const TRANSITION_COST_BYTES = MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES + 1;

/**
 * The largest declared ordinary transition count this plan can still stage.
 *
 * Derived, not tabulated. The gate is `projectedOrdinaryBytes <= 4 MiB - 256 KiB`
 * and the projection is `base + n * envelope + (n - 1)`, so measuring `base`
 * once at n = 1 yields the exact largest admissible n for THIS plan shape.
 */
export function ordinaryTransitionCeiling(plan: Record<string, unknown>, allowance: number): number {
  const probe = projectPreparationRunBudget({ ...budgetInputFor(plan, allowance), maximumTransitions: 1 });
  const baseBytes = probe.projectedOrdinaryBytes - MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES;
  const ordinaryLimit = MAX_PREPARATION_RUN_BYTES - PREPARATION_RUN_CONTROL_RESERVE_BYTES;
  return Math.floor((ordinaryLimit - baseBytes + 1) / TRANSITION_COST_BYTES);
}

/**
 * The largest control-transition allowance the reserved 256 KiB holds.
 *
 * The control delta is exactly `allowance * (envelope + 1)` — the reserve is
 * charged the full envelope per control move plus one array separator — so this
 * boundary is a pure function of the two published constants.
 */
export function controlAllowanceCeiling(): number {
  return Math.floor(PREPARATION_RUN_CONTROL_RESERVE_BYTES / TRANSITION_COST_BYTES);
}
