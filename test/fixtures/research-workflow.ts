/**
 * @file test/fixtures/research-workflow.ts
 * @description Shared CLI-driving helpers for the `research` and `manuscript-writing`
 * workflow end-to-end proofs (CLP 7.2). Every helper drives the REAL `dist/cli.js` through
 * {@link runCLI} so the proof exercises the same seam an operator would.
 *
 * The core primitive is {@link driveStage}: for a write-declaring stage it runs the
 * `advance` → `submit` → `advance` loop the harness requires (the first `advance`
 * parks `awaiting-output`, the `submit` records the typed output, the second
 * `advance` steps to the next stage or completes the run), asserting a clean exit at
 * each step. The typed-output builders ({@link pageSubmitArgs}/{@link relationSubmitArgs}/
 * {@link lifecycleSubmit}) each seed the body/output/evidence file under the temp
 * root and return the exact `workflow submit` arg vector, so a caller composes a
 * whole pipeline from one-line stage drives.
 *
 * {@link driveResearchToComplete} drives the 9-stage research pipeline through
 * `link-experiment`, parameterized by the `tests`→idea target slug (a real idea for
 * the happy path, a nonexistent one for the G1-denial proof), and leaves the run
 * parked at `complete-experiment` for the caller to drive the terminal transition.
 * {@link driveManuscriptWritingToSubmit} does the same for the 4-stage
 * `manuscript-writing` pipeline, parameterized by the cited paper slug, leaving it
 * parked at `submit-manuscript`. {@link driveLiteratureReview} drives the 4-stage
 * `literature-review` pipeline through `extract-concept`, leaving the run parked at
 * the trust-gated `link-concept` RELATION stage — the CLP 7.2 per-kind write-semantics
 * proof (page-apply vs. page-park vs. relation-refuse) drives the rest from there.
 */

import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runCLI, type CLIResult } from "./run-cli.js";
import { expectCLIExit } from "./run-cli.js";

/** The operator out-of-band grant the sole `trust:`-gated stage (`import-paper`) needs. */
export const RESEARCH_GRANT: NodeJS.ProcessEnv = { LLMWIKI_TRUSTED_WRITE: "research" };

/** The paper the research pipeline imports (a fresh slug — no seed collision). */
export const PAPER_SLUG = "bert";
/** The idea the research pipeline proposes (the real `tests` target for the happy path). */
export const IDEA_SLUG = "retrieval-augmentation";
/** The experiment the research pipeline designs, runs, and completes. */
export const EXPERIMENT_SLUG = "probe-depth";
/** The manuscript the manuscript pipeline drafts and submits. */
export const MANUSCRIPT_SLUG = "retrieval-survey";
/** A real, SEEDED paper the happy manuscript cites (exists once `buildResearchProject` ran). */
export const SEEDED_PAPER_SLUG = "attention-is-all-you-need";
/** The concept the literature-review pipeline extracts from the paper (the `link-concept` relation's `to` endpoint). */
export const CONCEPT_SLUG = "attention";

/** Absolute path the planner derives for a typed entity page. */
export function entityPagePath(root: string, entityType: string, slug: string): string {
  return path.join(root, "wiki", entityType, `${slug}.md`);
}

/** Write `contents` to `<root>/<name>` and return its absolute path. */
async function seedFile(root: string, name: string, contents: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, contents, "utf8");
  return file;
}

/** Compose a full markdown page document (frontmatter + body) from its parts. */
function pageDoc(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** Start a run of `workflowId` via the CLI and return its minted run id. */
export async function startRun(root: string, workflowId: string, env: NodeJS.ProcessEnv): Promise<string> {
  const start = await runCLI(["workflow", "start", workflowId], root, env);
  expectCLIExit(start, 0);
  return (start.stdout.match(new RegExp(`${workflowId}-[\\w-]+`)) ?? [""])[0];
}

/** Build a `page` submit arg vector, seeding the `--body-file` under the temp root. */
export async function pageSubmitArgs(
  root: string,
  runId: string,
  entityType: string,
  slug: string,
  frontmatter: string,
  body: string,
): Promise<string[]> {
  const file = await seedFile(root, `body-${slug}.md`, pageDoc(frontmatter, body));
  return ["workflow", "submit", runId, "--kind", "page", "--entity-type", entityType, "--slug", slug, "--body-file", file];
}

/** Build a `relation` submit arg vector, seeding the `--output-file` JSON under the temp root. */
export async function relationSubmitArgs(root: string, runId: string, name: string, input: Record<string, unknown>): Promise<string[]> {
  const file = await seedFile(root, `rel-${name}.json`, JSON.stringify(input));
  return ["workflow", "submit", runId, "--kind", "relation", "--output-file", file];
}

/** Build a `lifecycle-transition` submit arg vector, seeding the `--evidence-file` when given. */
async function lifecycleSubmit(
  root: string,
  runId: string,
  entityType: string,
  slug: string,
  toState: string,
  evidence?: Record<string, unknown>,
): Promise<string[]> {
  const args = ["workflow", "submit", runId, "--kind", "lifecycle-transition", "--entity-type", entityType, "--slug", slug, "--to-state", toState];
  if (evidence === undefined) return args;
  const file = await seedFile(root, `evidence-${slug}-${toState}.json`, JSON.stringify(evidence));
  return [...args, "--evidence-file", file];
}

/**
 * Drive ONE write-declaring stage over the CLI: `advance` (parks awaiting-output) →
 * `submit` (records the typed output) → `advance` (steps on / completes). Asserts a
 * clean exit at each step and returns the final `advance` result so a caller can read
 * its `advanced`/`completed` outcome.
 */
export async function driveStage(root: string, runId: string, submitArgs: string[], env: NodeJS.ProcessEnv): Promise<CLIResult> {
  expectCLIExit(await runCLI(["workflow", "advance", runId], root, env), 0);
  expectCLIExit(await runCLI(submitArgs, root, env), 0);
  const stepped = await runCLI(["workflow", "advance", runId], root, env);
  expectCLIExit(stepped, 0);
  return stepped;
}

/** The lifecycle-transition submit args for the terminal `complete-experiment` stage (with G1 evidence). */
export function completeExperimentSubmit(root: string, runId: string): Promise<string[]> {
  return lifecycleSubmit(root, runId, "experiments", EXPERIMENT_SLUG, "complete", {
    resultSummary: "Deeper layers encode measurably more abstract features across the probe suite.",
  });
}

/** The lifecycle-transition submit args for the terminal `submit-manuscript` stage. */
export function submitManuscriptSubmit(root: string, runId: string): Promise<string[]> {
  return lifecycleSubmit(root, runId, "manuscripts", MANUSCRIPT_SLUG, "submitted");
}

/**
 * Drive the 9-stage `research` pipeline through `link-experiment` (stages 1–8),
 * leaving the run parked at `complete-experiment`. The `tests` edge (stage 8) points
 * at `testsIdeaSlug`: pass {@link IDEA_SLUG} for the happy path, or a nonexistent slug
 * to prove the G1 precondition denies the terminal transition.
 *
 * @param root - The temp project root (research profile installed).
 * @param env - Env for every CLI call (pass {@link RESEARCH_GRANT} for the trust stage).
 * @param testsIdeaSlug - The idea slug the stage-8 `tests` edge resolves to.
 * @returns The run id, parked at `complete-experiment`.
 */
export async function driveResearchToComplete(root: string, env: NodeJS.ProcessEnv, testsIdeaSlug: string): Promise<string> {
  const runId = await startRun(root, "research", env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "papers", PAPER_SLUG, "title: BERT\nauthors:\n  - Devlin\nstage: imported", "BERT pretrains deep bidirectional transformers over unlabeled text."), env);
  await driveStage(root, runId, await lifecycleSubmit(root, runId, "papers", PAPER_SLUG, "triaged", { triageNote: "Foundational masked-LM pretraining; high priority to distill." }), env);
  await driveStage(root, runId, await lifecycleSubmit(root, runId, "papers", PAPER_SLUG, "distilled", { distilledSummary: "Bidirectional masked-language pretraining transfers broadly to downstream tasks." }), env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "ideas", IDEA_SLUG, "title: Retrieval Augmentation\nrationale: Grounding generation in retrieved passages may cut hallucination.\nstage: proposed", "Retrieval augmentation conditions generation on documents fetched from an external corpus."), env);
  await driveStage(root, runId, await relationSubmitArgs(root, runId, "builds-on", { type: "builds-on", from: `ideas/${IDEA_SLUG}`, to: `papers/${PAPER_SLUG}`, attributes: {} }), env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "experiments", EXPERIMENT_SLUG, "title: Layer Probe Depth\nhypothesis: Deeper layers encode more abstract features.\nstage: designed", "We probe representations at each layer to measure feature abstraction with depth."), env);
  await driveStage(root, runId, await lifecycleSubmit(root, runId, "experiments", EXPERIMENT_SLUG, "running"), env);
  await driveStage(root, runId, await relationSubmitArgs(root, runId, "tests", { type: "tests", from: `experiments/${EXPERIMENT_SLUG}`, to: `ideas/${testsIdeaSlug}`, attributes: {} }), env);
  return runId;
}

/**
 * Drive the 4-stage `literature-review` pipeline through `gather-paper` (trust-gated
 * PAGE) and `extract-concept` (ungated PAGE), leaving the run parked at `link-concept`
 * — the trust-gated RELATION stage the Task 4 refuse proof drives from there. The
 * extracted concept is seeded under {@link CONCEPT_SLUG} so the `introduces-concept`
 * relation's `to` endpoint resolves to a real page (not a dangling one).
 *
 * @param root - The temp project root (research profile installed).
 * @param env - Env for every CLI call (pass {@link RESEARCH_GRANT} so `gather-paper` applies).
 * @returns The run id, parked at `link-concept`.
 */
export async function driveLiteratureReview(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const runId = await startRun(root, "literature-review", env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "papers", PAPER_SLUG, "title: BERT\nauthors:\n  - Devlin\nstage: imported", "BERT pretrains deep bidirectional transformers over unlabeled text."), env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "research-concepts", CONCEPT_SLUG, "title: Attention\ndefinition: A mechanism that lets a model weigh different parts of its input when producing each output.\nstage: proposed", "Attention lets a model compute a weighted combination of input representations."), env);
  return runId;
}

/**
 * Drive the 4-stage `manuscript-writing` pipeline through `check-manuscript`
 * (stages 1–3), leaving the run parked at `submit-manuscript`. The `cites` edge
 * (stage 2) points at `citedPaperSlug`: pass {@link SEEDED_PAPER_SLUG} (a real
 * paper) for the happy path, or a nonexistent slug to prove the G1 citation
 * precondition denies the submission.
 *
 * @param root - The temp project root (research project built — the cited paper must exist for the happy case).
 * @param env - Env for every CLI call.
 * @param citedPaperSlug - The paper slug the stage-2 `cites` edge resolves to.
 * @returns The run id, parked at `submit-manuscript`.
 */
export async function driveManuscriptWritingToSubmit(root: string, env: NodeJS.ProcessEnv, citedPaperSlug: string): Promise<string> {
  const runId = await startRun(root, "manuscript-writing", env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "manuscripts", MANUSCRIPT_SLUG, "title: A Survey of Retrieval-Augmented Generation\nabstract: We survey retrieval-augmented generation methods and their scaling.\nstage: drafting", "This manuscript surveys retrieval-augmented generation architectures and training regimes."), env);
  await driveStage(root, runId, await relationSubmitArgs(root, runId, "cites", { type: "cites", from: `manuscripts/${MANUSCRIPT_SLUG}`, to: `papers/${citedPaperSlug}`, attributes: {} }), env);
  await driveStage(root, runId, await lifecycleSubmit(root, runId, "manuscripts", MANUSCRIPT_SLUG, "citation-checked"), env);
  return runId;
}

/** Assert the CLI reported a `completed` outcome (the run finished its last stage). */
export function expectCompleted(result: CLIResult): void {
  expect(result.stdout, `expected a completed outcome:\n${result.stdout}`).toMatch(/completed/);
}

/**
 * Assert the terminal `submit-manuscript` transition is HARD-DENIED by the
 * `cites`→paper G1 relation precondition: the parked stage advances, the terminal
 * submit exits non-zero citing the unmet precondition, and the manuscript never
 * reaches `submitted`. Shared by the G1 denial e2e and the superset proof so the
 * advance→submit→assert tail is not re-spelled.
 *
 * @param root - The temp project root, with a run parked at `submit-manuscript`.
 * @param runId - The manuscript-writing run id (cites edge pointed at a dangling paper).
 * @param env - Env for every CLI call.
 */
export async function expectManuscriptSubmitDenied(root: string, runId: string, env: NodeJS.ProcessEnv): Promise<void> {
  expectCLIExit(await runCLI(["workflow", "advance", runId], root, env), 0);
  const denied = await runCLI(await submitManuscriptSubmit(root, runId), root, env);
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toMatch(/relation preconditions unmet: cites\[from\]/);
  const manuscript = await readFile(entityPagePath(root, "manuscripts", MANUSCRIPT_SLUG), "utf8");
  expect(manuscript).not.toMatch(/stage:\s*submitted/);
}
