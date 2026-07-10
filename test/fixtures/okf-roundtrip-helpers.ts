/**
 * @file test/fixtures/okf-roundtrip-helpers.ts
 * @description Shared helpers for the profile-aware OKF round-trip proofs (CLP 7.6
 * Task 6): build an IMPORTABLE research project (the full research fixture minus the
 * single gated-state page whose relation precondition cannot be met at import time),
 * seed a workflow run, export a project to an OKF bundle, and import a bundle into a
 * fresh project. Kept out of the test files so both round-trip specs share ONE
 * export/import path (DRY, genericity across profiles).
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildOkfBundle } from "../../src/export/okf/bundle.js";
import { runOkfImport, type OkfImportReport } from "../../src/import/run.js";
import { appendRelation } from "../../src/relations/store.js";
import { writeRun, mintRunId } from "../../src/workflows/store.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import { installResearchProfile, RESEARCH_PROFILE } from "./research-profile.js";
import { SEED_PAGES, SEED_RELATIONS } from "./research-seeds.js";
import { writeSeedPage } from "./seed-page.js";

/**
 * The one seed page whose lifecycle state (`experiments/ablation-batch-size` at
 * `complete`) carries a relation precondition (`tests`→a non-rejected idea) that
 * CANNOT be satisfied at import time: typed pages promote BEFORE the relation leg
 * runs, so a fresh-project import refuses its promotion. Excluded from the clean
 * round-trip; exercised on its own by the lifecycle-refusal proof.
 */
export const GATED_EXPERIMENT_SLUG = "ablation-batch-size";

/** True when a relation endpoint references the excluded gated page (it would dangle). */
function touchesGated(from: string, to: string): boolean {
  return from.includes(GATED_EXPERIMENT_SLUG) || to.includes(GATED_EXPERIMENT_SLUG);
}

/**
 * Materialize a research project whose every seed page imports cleanly into a fresh
 * project — the full fixture MINUS the gated `complete` experiment and the relations
 * that reference it — so a trusted round-trip promotes every typed page.
 *
 * @param root - Absolute project root directory.
 */
export async function buildImportableResearchProject(root: string): Promise<void> {
  await installResearchProfile(root);
  for (const page of SEED_PAGES) {
    if (page.slug !== GATED_EXPERIMENT_SLUG) await writeSeedPage(root, page);
  }
  for (const rel of SEED_RELATIONS) {
    if (!touchesGated(rel.from, rel.to)) {
      await appendRelation(root, RESEARCH_PROFILE, { type: rel.type, from: rel.from, to: rel.to });
    }
  }
}

/** A 64-hex placeholder digest (drift-detection field; the round-trip never re-derives it). */
const PLACEHOLDER_DIGEST = "a".repeat(64);

/**
 * Seed one durable, integrity-stampable workflow run so the bundle's
 * `x-llmwiki.workflows` summary is non-empty — proving the run rides in the bundle
 * yet stays inert on import (D-7.6.7). The record carries the genesis
 * `workflow-start` event the fail-closed shape/version-chain validator requires, and
 * is written under the project lock so `writeRun` can persist the per-project
 * integrity key that `readRun` (and thus the exporter) re-verifies against.
 *
 * @param root - Absolute project root directory.
 * @returns The minted run id.
 */
export async function seedWorkflowRun(root: string): Promise<string> {
  const runId = mintRunId("research");
  const now = new Date().toISOString();
  await acquireLock(root);
  try {
    await writeRun(root, {
      schemaVersion: 2, runId, workflowId: "research",
      workflowDigest: PLACEHOLDER_DIGEST, profileDigest: PLACEHOLDER_DIGEST,
      knownStageIds: ["import-paper", "triage-paper"],
      status: "running", currentStage: "triage-paper",
      stageLog: [{ stageId: "import-paper", status: "completed" }],
      events: [{ type: "workflow-start", at: now, actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
      satisfiedGates: [], inputs: {}, outputs: {}, stateVersion: 0, startedAt: now, updatedAt: now,
    });
  } finally {
    await releaseLock(root);
  }
  return runId;
}

/** Export a project's entity docs + bundle block to a fresh OKF bundle dir. */
export async function exportBundle(root: string, out = path.join(root, "bundle")): Promise<string> {
  await buildOkfBundle(root, [], out);
  return out;
}

/** Import a bundle into `fresh`, returning the structured report. */
export async function importBundle(fresh: string, bundle: string, trusted: boolean): Promise<OkfImportReport> {
  return runOkfImport(fresh, bundle, trusted ? { trusted: true } : {});
}

/** The `<type>|<from>|<to>` tuples of a bundle's `x-llmwiki.relations`, sorted (semantic relation identity). */
export async function bundleRelationTuples(bundle: string): Promise<string[]> {
  const { meta } = parseFrontmatter(await readFile(path.join(bundle, "index.md"), "utf-8"));
  const block = meta["x-llmwiki"] as { relations?: Array<Record<string, unknown>> } | undefined;
  const relations = block?.relations ?? [];
  return relations.map((r) => `${r.type}|${r.from}|${r.to}`).sort();
}

/** Parse an entity doc's frontmatter from a bundle. */
export async function readBundleDoc(bundle: string, rel: string): Promise<Record<string, unknown>> {
  const { meta } = parseFrontmatter(await readFile(path.join(bundle, rel), "utf-8"));
  return meta;
}
