/**
 * @file test/newsroom-workflow-e2e-cli.test.ts
 * @description The CLP 7.2 C1 airtight-genericity proof: EXECUTE the workflow
 * page-submit, relation-submit, gate-approval, and submit-ACTION legs over the
 * deliberately dissimilar `newsroom` profile — not just the run-lifecycle
 * start/advance/park the projection-genericity test already covers.
 *
 * If any of these legs carried a research-shaped assumption in the apply/action
 * path (page write, relation scope guard + apply, agent-gate approval, or action
 * authority/input-validation/dispatch), it would surface HERE, driving newsroom
 * vocabulary through the SAME src/ with zero newsroom-specific code. The
 * `story-pipeline` reaching `completed` transitively proves all three drive legs
 * (page output + relation output + agent gate) were satisfied — an unmet agent
 * gate would leave the run parked `awaiting-gate`, never completing.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildNewsroomProject } from "./fixtures/newsroom-profile.js";
import { driveStoryPipeline, NEWSROOM_GRANT, ARTICLE_SLUG, DESK_SLUG } from "./fixtures/newsroom-workflow.js";
import { startWorkflow } from "../src/workflows/start.js";
import { runAction } from "../src/workflows/run-action.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "newsroom-e2e-"));
  await buildNewsroomProject(root);
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("newsroom story-pipeline — page + relation + agent-gate legs over the CLI", () => {
  it("drives to completion: page apply, filed-under relation apply, agent-gate approval", async () => {
    const done = await driveStoryPipeline(root, NEWSROOM_GRANT);
    expect(done.stdout).toContain("outcome: completed");
    expect(done.stdout).toContain("status:       completed");

    const relations = await readFile(path.join(root, "wiki/graph/relations.jsonl"), "utf8");
    expect(relations).toContain('"type":"filed-under"');
    expect(relations).toContain(`"from":"articles/${ARTICLE_SLUG}"`);
    expect(relations).toContain(`"to":"desks/${DESK_SLUG}"`);

    const article = await readFile(path.join(root, `wiki/articles/${ARTICLE_SLUG}.md`), "utf8");
    expect(article).toContain("Waterfront Probe Widens");
  });
});

describe("newsroom story.file — submit-action dispatch over newsroom vocabulary", () => {
  it("applies a newsroom articles page through the same submit-action authority", async () => {
    const run = await startWorkflow(root, "story-pipeline", {});
    const body = "---\nheadline: Late Edition\nstage: draft\n---\n\nThe late edition led with the strike.\n";
    const result = await runAction(root, "story.file",
      { runId: run.runId, entityType: "articles", slug: "late-edition", body }, "cli");

    expect(result.operation).toBe("submit");
    expect(result.effectivePermission).toBe("trusted-write");
    expect((result.result as { applied: boolean }).applied).toBe(true);

    const article = await readFile(path.join(root, "wiki/articles/late-edition.md"), "utf8");
    expect(article).toContain("Late Edition");
  });
});
