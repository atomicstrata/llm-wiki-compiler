/**
 * @file test/workflow-page-typed-validation.test.ts
 * @description Integration coverage (through the REAL workflow harness/executor)
 * that a workflow `page` stage output about to land LIVE runs the SAME full typed-
 * candidate validation the promote path runs — field contract + lifecycle FSM +
 * relation-count precondition (A0). Before this seam, a workflow `page` output could
 * create/update a typed entity page LIVE into a gated lifecycle state, or missing a
 * required field / required evidence, bypassing every typed gate.
 *
 * Proves, via `submitStageOutput` on an UNGATED write stage (so a clean write auto-
 * applies without a trust grant):
 *  - a create into a GATED lifecycle state WITHOUT the qualifying relation → DENIED
 *    hard (run auto-fails, page not live);
 *  - a create missing a REQUIRED field → DENIED hard;
 *  - a create entering a state that requires EVIDENCE, missing it → DENIED hard;
 *  - a VALID create (fields ok, FSM-legal, relation precondition met) → APPLIES live;
 *  - a store-SICK relation store during a gated create → PARKS (unverifiable, run NOT
 *    terminally failed), page not live;
 *  - a NON-lifecycle entity page with valid fields → still APPLIES (no false block).
 */

import { describe, it, expect } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import type { StageOutput } from "../src/workflows/stage-output.js";
import { submitStageOutput } from "../src/workflows/stage-output.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readRun } from "../src/workflows/store.js";
import { appendRelation } from "../src/relations/store.js";
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
} from "../src/relations/enforce-precondition.js";
import { EntityFieldContractError } from "../src/profile/field-contract.js";
import { LifecycleTransitionError } from "../src/profile/lifecycle.js";
import { makeResearchLiteProjectRoot, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";

/**
 * A gated research profile with an UNGATED one-stage `build` workflow writing
 * `experiments`/`ideas`. `experiments` requires fields `title`+`stage`; entering
 * `running` requires `hypothesis` evidence; entering `complete` requires ≥1
 * `tests`→`ideas` relation on its `from` side. `ideas` is a NON-lifecycle entity.
 */
function gatedWorkflowProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "wf-gated",
    entities: {
      ideas: { directory: "wiki/ideas", requiredFields: ["title"], fields: { title: { type: "string" } } },
      experiments: {
        directory: "wiki/experiments",
        requiredFields: ["title", "stage"],
        fields: {
          title: { type: "string" },
          stage: { type: "enum", enum: ["designed", "running", "complete"] },
          hypothesis: { type: "string" },
        },
        lifecycle: {
          field: "stage",
          initial: "designed",
          terminal: ["complete"],
          transitions: { designed: ["running"], running: ["complete"] },
          transitionRequirements: { running: ["hypothesis"] },
          transitionRelationRequirements: { complete: [{ relationType: "tests", role: "from", otherTypes: ["ideas"], minCount: 1 }] },
        },
      },
    },
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
    workflows: { build: { stages: [{ id: "run", reads: ["ideas"], writes: ["experiments", "ideas"] }] } },
  } as ProfilePack;
}

/** A `page` stage output for `entityType/slug` with body `body`. */
function pageOut(entityType: string, slug: string, body: string): StageOutput {
  return { kind: "page", entityType, slug, body };
}

/** An experiment page body at the given lifecycle `stage` (+ optional extra frontmatter lines). */
function expBody(stage: string, extra = ""): string {
  return `---\ntitle: An Experiment\nstage: ${stage}\n${extra}---\n\nExperiment body.\n`;
}

/** Absolute on-disk path of an experiment page. */
function expPath(root: string, slug: string): string {
  return path.join(root, "wiki/experiments", `${slug}.md`);
}

/** Stand up a gated project (profile + one `ideas/real` page) and start a `build` run. */
async function startGatedRun(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeResearchLiteProjectRoot(prefix, gatedWorkflowProfile());
  await writeMarkdownPage(root, "wiki/ideas", "real", "---\ntitle: A Real Idea\n---\n\nIdea body.\n");
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/** Append one `tests` relation `experiments/<from>` → `ideas/<to>`. */
function addTests(root: string, fromSlug: string, toSlug: string): Promise<unknown> {
  return appendRelation(root, gatedWorkflowProfile(), {
    type: "tests",
    from: `experiments/${fromSlug}` as EntityId,
    to: `ideas/${toSlug}` as EntityId,
    attributes: {},
  });
}

/** Assert the run is terminal `failed` (hard-denied auto-fail routing). */
async function expectRunFailed(root: string, runId: string): Promise<void> {
  const read = await readRun(root, runId);
  expect(read.status === "ok" && read.run.status).toBe("failed");
}

/**
 * Drive a workflow `page` output for `experiments/foo` that must be HARD-DENIED by
 * the typed validation: assert it rejects with `errorCtor`, the page never lands,
 * and the run auto-fails. Shared by the three denial cases (relation / field /
 * evidence) so each spells only its own body + expected error type.
 */
async function expectHardDeniedNotLive(prefix: string, body: string, errorCtor: new (...a: never[]) => Error): Promise<void> {
  const { root, runId } = await startGatedRun(prefix);
  try {
    await expect(submitStageOutput(root, runId, pageOut("experiments", "foo", body))).rejects.toBeInstanceOf(errorCtor);
    expect(existsSync(expPath(root, "foo"))).toBe(false);
    await expectRunFailed(root, runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workflow page output — typed validation on the LIVE apply path (A0)", () => {
  it("DENIES a create into gated `complete` WITHOUT the qualifying relation (hard); page not live, run FAILED", async () => {
    await expectHardDeniedNotLive("wf-typed-relgate-", expBody("complete"), RelationPreconditionUnmetError);
  });

  it("DENIES a create missing a REQUIRED field (hard); page not live, run FAILED", async () => {
    const body = "---\nstage: designed\n---\n\nNo title here.\n"; // required `title` omitted
    await expectHardDeniedNotLive("wf-typed-field-", body, EntityFieldContractError);
  });

  it("DENIES a create into a state requiring EVIDENCE, missing it (hard); page not live, run FAILED", async () => {
    // Entering `running` requires `hypothesis` evidence; body omits it.
    await expectHardDeniedNotLive("wf-typed-evidence-", expBody("running"), LifecycleTransitionError);
  });

  it("APPLIES a VALID create (fields ok, FSM-legal, relation precondition met) into gated `complete`", async () => {
    const { root, runId } = await startGatedRun("wf-typed-valid-");
    try {
      await addTests(root, "foo", "real"); // satisfies the `complete` relation precondition
      const result = await submitStageOutput(root, runId, pageOut("experiments", "foo", expBody("complete")));
      expect(result.applied).toBe(true);
      expect(result.decision).toBe("allow");
      expect(existsSync(expPath(root, "foo"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("PARKS on a store-SICK relation store during a gated create (unverifiable, NOT hard); page not live, run NOT failed", async () => {
    const { root, runId } = await startGatedRun("wf-typed-sick-");
    try {
      await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
      const corrupt = '{"kind":"relation-store-header","schemaVersion":1}\nnot-a-valid-record\nalso-garbage\n';
      await writeFile(path.join(root, RELATIONS_FILE), corrupt, "utf8");
      await expect(submitStageOutput(root, runId, pageOut("experiments", "foo", expBody("complete"))))
        .rejects.toBeInstanceOf(RelationPreconditionUnverifiableError);
      expect(existsSync(expPath(root, "foo"))).toBe(false);
      const read = await readRun(root, runId);
      expect(read.status === "ok" && read.run.status).not.toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("APPLIES a NON-lifecycle entity page with valid fields (no false block)", async () => {
    const { root, runId } = await startGatedRun("wf-typed-nonlifecycle-");
    try {
      const body = "---\ntitle: A Fresh Idea\n---\n\nIdea prose.\n"; // `ideas` has no lifecycle/precondition
      const result = await submitStageOutput(root, runId, pageOut("ideas", "fresh", body));
      expect(result.applied).toBe(true);
      expect(existsSync(path.join(root, "wiki/ideas", "fresh.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
