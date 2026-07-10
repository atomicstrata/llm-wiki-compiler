/**
 * @file test/fixtures/newsroom-workflow.ts
 * @description CLI-driving helper for the `story-pipeline` end-to-end genericity
 * proof (CLP 7.2 C1) — the NEWSROOM analogue of {@link driveLiteratureReview}.
 *
 * It drives the deliberately dissimilar `newsroom` profile's two-stage
 * `story-pipeline` to COMPLETION over the REAL `dist/cli.js`, reusing the generic
 * {@link startRun}/{@link driveStage}/{@link pageSubmitArgs}/{@link relationSubmitArgs}
 * primitives with ZERO newsroom-specific core code. This EXECUTES — not merely
 * declares — the page-submit apply, the `filed-under` relation-submit apply (with
 * its scope guard), and the `agent:edited` gate approval over newsroom vocabulary,
 * so the C1 abstraction-failure gate is airtight for those legs, not inferred.
 *
 * Stage 1 (`draft-article`, ungated PAGE) runs the standard advance→submit→advance
 * loop. Stage 2 (`file-under-desk`) carries an `agent:edited` gate AND a
 * `filed-under` relation write, so it needs BOTH an output and a gate approval:
 * {@link driveFileUnderDesk} advances (proving the gate genuinely PARKS the run
 * `awaiting-gate`), records the relation, approves the gate as an agent, then
 * advances to completion. The relation's `to` endpoint targets the SEEDED
 * `desks/metro` page ({@link buildNewsroomProject}) so it does not dangle.
 */

import { expect } from "vitest";
import { runCLI, expectCLIExit, type CLIResult } from "./run-cli.js";
import { startRun, pageSubmitArgs, relationSubmitArgs, driveStage } from "./research-workflow.js";

/** The operator grant the `story.file` action's `trust:desk` capability declares. */
export const NEWSROOM_GRANT: NodeJS.ProcessEnv = { LLMWIKI_TRUSTED_WRITE: "newsroom" };

/** The article the `story-pipeline` drafts (a fresh slug — no seed collision). */
export const ARTICLE_SLUG = "waterfront-probe";
/** The SEEDED desk the drafted article is filed under (the `filed-under` `to` endpoint). */
export const DESK_SLUG = "metro";

/**
 * Drive stage 2 (`file-under-desk`): advance to PROVE the `agent:edited` gate parks
 * the run, submit the `filed-under` relation (endpoints resolve — `from` is the
 * drafted article, `to` the seeded desk), approve the gate as an agent, then advance
 * to completion. Returns the terminal advance result.
 */
async function driveFileUnderDesk(root: string, runId: string, env: NodeJS.ProcessEnv): Promise<CLIResult> {
  const parked = await runCLI(["workflow", "advance", runId], root, env);
  expectCLIExit(parked, 0);
  expect(parked.stdout, "the agent gate must block completion until approved").toContain("awaiting-gate");
  const relArgs = await relationSubmitArgs(root, runId, "filed-under", {
    type: "filed-under", from: `articles/${ARTICLE_SLUG}`, to: `desks/${DESK_SLUG}`, attributes: {},
  });
  expectCLIExit(await runCLI(relArgs, root, env), 0);
  expectCLIExit(await runCLI(["workflow", "gate", "approve", runId, "edited", "--actor", "agent"], root, env), 0);
  const done = await runCLI(["workflow", "advance", runId], root, env);
  expectCLIExit(done, 0);
  return done;
}

/**
 * Drive the newsroom `story-pipeline` to completion over the CLI: draft an article
 * (ungated PAGE), then file it under a desk (`agent:edited` gate + `filed-under`
 * RELATION). Returns the terminal advance result (its stdout reports `completed`).
 *
 * @param root - The temp project root (newsroom project built — the desk seed must exist).
 * @param env - Env for every CLI call (pass {@link NEWSROOM_GRANT}).
 * @returns The terminal advance CLIResult.
 */
export async function driveStoryPipeline(root: string, env: NodeJS.ProcessEnv): Promise<CLIResult> {
  const runId = await startRun(root, "story-pipeline", env);
  await driveStage(root, runId, await pageSubmitArgs(root, runId, "articles", ARTICLE_SLUG,
    "headline: Waterfront Probe Widens\nstage: draft",
    "The waterfront corruption probe widened on Wednesday."), env);
  return driveFileUnderDesk(root, runId, env);
}
