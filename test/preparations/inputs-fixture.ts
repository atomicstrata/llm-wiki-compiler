/**
 * @file test/preparations/inputs-fixture.ts
 * @description Shared fixtures for the Task 3 prepared-input, exposure,
 * ephemeral-read, and dry-run purity suites: caller source-file writers, a
 * bare-digest helper, an ephemeral-eligible plan, and a recursive tree snapshot
 * used to prove pure paths leave a byte-identical project root.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import type { NormalizedPreparationPlanV1 } from "../../src/preparations/plan-types.js";
import type { CallerFileSourceV1 } from "../../src/preparations/inputs.js";
import { validPlan } from "./plan-fixture.js";

/** Write one caller source file under a confined source root and return its leaf. */
export async function writeSourceFile(sourceRoot: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  const leaf = path.join(sourceRoot, name);
  await writeFile(leaf, bytes);
  return leaf;
}

/** Lowercase bare SHA-256 hex of buffered bytes (the evidence filename form). */
export function bareDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build one caller-file source descriptor with test-overridable metadata. */
export function callerSource(
  sourceRoot: string, sourceLeaf: string, overrides: Partial<CallerFileSourceV1> = {},
): CallerFileSourceV1 {
  return {
    sourceRoot, sourceLeaf, sourceIdentity: "sources/input.txt",
    provenanceLabel: "caller-file", mediaType: "text/plain", sensitivity: "ordinary",
    retention: "until-handoff", evidenceKind: "prepared-input", ...overrides,
  };
}

/** Build one ephemeral-read plan OBJECT with an optional single-phase mutation. */
export function ephemeralPlanObject(
  mutatePhase: (phase: Record<string, unknown>) => void = () => {},
  boundsOverride: Record<string, number> = {},
): Record<string, unknown> {
  const object = validPlan();
  object.executionMode = "ephemeral-read";
  (object.initialInputSet as Record<string, unknown>).retention = "terminal-only";
  const phase = (object.phases as Record<string, unknown>[])[0];
  mutatePhase(phase);
  object.phases = [phase];
  object.outputContract = { producingPhaseIds: ["collect"] };
  object.bounds = {
    maximumPhaseInstances: 1, maximumAttempts: 2, maximumInvocations: 2, maximumBrokerRequests: 0,
    maximumEffects: 0, maximumTransitions: 4, maximumEvidenceRefs: 3, maximumEvidenceBytes: 2048,
    maximumCheckpointBytes: 0, maximumTokens: 200, maximumTimeMs: 1000, maximumCostMicros: 20,
    ...boundsOverride,
  };
  return object;
}

/** Build one ephemeral-read plan carrying a permitted read-only brokered call. */
export function ephemeralBrokerPlan(): NormalizedPreparationPlanV1 {
  return parsePreparationPlan(JSON.stringify(ephemeralPlanObject((phase) => {
    phase.brokerPlanDigest = `sha256:${"c".repeat(64)}`;
    (phase.bounds as Record<string, number>).maximumBrokerRequestsPerAttempt = 1;
  }, { maximumBrokerRequests: 2 })));
}

/** Build one ephemeral-read plan OBJECT carrying a durable mutating effect. */
export function ephemeralEffectPlanObject(): Record<string, unknown> {
  return ephemeralPlanObject((phase) => {
    phase.effectPlanDigest = `sha256:${"d".repeat(64)}`;
    (phase.bounds as Record<string, number>).maximumEffectsPerAttempt = 1;
  }, { maximumEffects: 2 });
}

/** Recursively snapshot every regular file under `dir` as sorted `relpath -> sha256`. */
export async function snapshotTree(dir: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const out: Array<readonly [string, string]> = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch { return; }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name), childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(abs, childRel);
      else if (entry.isFile()) out.push([childRel, createHash("sha256").update(await readFile(abs)).digest("hex")]);
      else out.push([childRel, `nonfile:${entry.isSymbolicLink() ? "symlink" : "other"}`]);
    }
  }
  await walk(dir, "");
  return out;
}
