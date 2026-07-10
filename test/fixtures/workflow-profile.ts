/**
 * @file test/fixtures/workflow-profile.ts
 * @description Shared NON-DEFAULT profile fixture declaring a two-stage `build`
 * workflow over two entity types, plus a helper to install it on disk.
 *
 * Used by the workflow CLI and SDK-facade tests so both assert against one fixed
 * profile shape (and so the fixture is not duplicated across test files).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { createWiki } from "../../src/sdk/wiki.js";
import { readRun } from "../../src/workflows/store.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { advanceWorkflow } from "../../src/workflows/advance.js";
import { makeTempRoot } from "./temp-root.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import type { ProfilePack, WorkflowStageDef } from "../../src/profile/types.js";
import type { Wiki } from "../../src/sdk/types.js";
import type { WorkflowRun } from "../../src/workflows/types.js";

/**
 * Re-read a persisted run, failing the test (throwing) if it is not `ok`. Shared so
 * the workflow tests don't each re-declare the same read-and-assert-ok helper.
 *
 * @param root - Absolute project root.
 * @param runId - The run id to re-read.
 * @returns The validated run record.
 */
export async function readOkRun(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
  return read.run;
}

/** The default two-stage read-only `build` workflow (no gates). */
export const ADAPT_BUILD_STAGES: WorkflowStageDef[] = [
  { id: "draft", reads: ["ideas"], writes: [] },
  { id: "run", reads: ["ideas"], writes: [] },
];

/** The `build` def renaming `draft`→`compose` via previousIds (lossless adapt). */
export const ADAPT_RENAMED_STAGES: WorkflowStageDef[] = [
  { id: "compose", reads: ["ideas"], writes: [], previousIds: ["draft"] },
  { id: "run", reads: ["ideas"], writes: [] },
];

/** The `build` def that REMOVED `draft` (lossy adapt when the run sits on it). */
export const ADAPT_REMOVED_STAGES: WorkflowStageDef[] = [{ id: "run", reads: ["ideas"], writes: [] }];

/** A page output naming `experiments/<slug>` with a minimal valid body. */
export function experimentPageOutput(slug: string): {
  kind: "page";
  entityType: string;
  slug: string;
  body: string;
} {
  return { kind: "page", entityType: "experiments", slug, body: `---\ntitle: ${slug}\n---\nbody` };
}

/** Absolute path the planner derives for an `experiments` entity page. */
export function experimentPagePath(root: string, slug: string): string {
  return path.join(root, "wiki", "experiments", `${slug}.md`);
}

/** Build a `research` profile whose single `build` workflow has `stages`. */
export function buildWorkflowProfile(stages: WorkflowStageDef[]): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" }, experiments: { directory: "wiki/experiments" } },
    workflows: { build: { stages } },
  };
}

/** A non-default profile declaring a two-stage `build` workflow. */
export const WORKFLOW_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "research",
  entities: { ideas: { directory: "wiki/ideas" }, experiments: { directory: "wiki/experiments" } },
  workflows: {
    build: {
      stages: [
        { id: "draft", reads: ["ideas"], writes: ["ideas"] },
        { id: "run", reads: ["ideas"], writes: ["experiments"] },
      ],
    },
  },
};

/**
 * Install `pack` (default {@link WORKFLOW_PROFILE}) as the active on-disk profile
 * under `<root>/.llmwiki/profile.json`.
 *
 * @param root - Absolute project root.
 * @param pack - The profile to install (defaults to the workflow fixture).
 */
export async function installWorkflowProfile(
  root: string,
  pack: ProfilePack = WORKFLOW_PROFILE,
): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack), "utf8");
}

/**
 * A non-default profile declaring a `build` workflow plus one workflow ACTION
 * (`build.start`) that requests `trusted-write` on every surface — so discovery
 * can prove the per-surface clamp (`mcp`/`viewer` → `staged-write`).
 */
export const ACTION_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "research",
  entities: { ideas: { directory: "wiki/ideas" } },
  workflows: { build: { stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }] } },
  workflowActions: {
    "build.start": {
      label: "Start build",
      workflow: "build",
      operation: "start",
      permissions: { cli: "trusted-write", sdk: "trusted-write", mcp: "trusted-write", viewer: "trusted-write" },
      trustGate: "trust:writer",
    },
  },
};

/** Mutable holder for the current SDK workflow test's temp-root path. */
export interface WorkflowRootCtx {
  /** Absolute path of the temp project root for the current test. */
  root: string;
}

/**
 * Register a beforeEach/afterEach lifecycle that mints a fresh temp project root
 * (named `<prefix>`) and installs `stages` as the active `build` workflow, then
 * removes the root after. Lets the SDK workflow tests share the temp-root +
 * profile-install boilerplate instead of duplicating it per file.
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param stages - The `build` workflow stages to install.
 * @returns A context whose `root` is set fresh before each test.
 */
export function useWorkflowRoot(prefix: string, stages: WorkflowStageDef[]): WorkflowRootCtx {
  const ctx: WorkflowRootCtx = { root: "" };
  beforeEach(async () => {
    ctx.root = await mkdtemp(path.join(os.tmpdir(), prefix));
    await installWorkflowProfile(ctx.root, buildWorkflowProfile(stages));
  });
  afterEach(async () => {
    if (ctx.root) await rm(ctx.root, { recursive: true, force: true });
    ctx.root = "";
  });
  return ctx;
}

/**
 * Build an SDK facade over `root` and start a `build` run, returning both. Shared
 * by the SDK workflow tests so the create-facade + start-run preamble isn't
 * duplicated per file.
 *
 * @param root - The temp project root the facade binds to.
 * @returns The `Wiki` facade and the started run's id.
 */
export async function startBuildRun(root: string): Promise<{ wiki: Wiki; runId: string }> {
  const wiki = createWiki({ root });
  const run = await wiki.startWorkflow("build", {});
  return { wiki, runId: run.runId };
}

/**
 * Mint a fresh temp root, install a SINGLE-stage `build` workflow with `stage`, and
 * start a run — the `makeTempRoot → install → startWorkflow` preamble the
 * single-stage seam/lifecycle tests share. Grants are the caller's concern (set the
 * trusted-write env var before calling for an auto-applying stage).
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param stage - The single `build` stage to install.
 * @returns The temp root and the started run's id.
 */
export async function startOneStageBuild(prefix: string, stage: WorkflowStageDef): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([stage]));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

/**
 * Mint a fresh temp root, install a `build` workflow with `stages`, start a run, and
 * advance once to PARK it on its first stage (awaiting-gate or awaiting-output). The
 * shared start-then-advance-to-park preamble several CLI/status tests use.
 *
 * @param prefix - The mkdtemp prefix for the per-test root.
 * @param stages - The `build` workflow stages to install.
 * @returns The temp root and the parked run's id.
 */
export async function startAndParkBuild(prefix: string, stages: WorkflowStageDef[]): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(stages));
  const run = await startWorkflow(root, "build", {});
  await advanceWorkflow(root, run.runId);
  return { root, runId: run.runId };
}

/**
 * Advance `runId` once and assert it did NOT complete — it re-parked on the single
 * `run` stage. The shared post-condition the resume-retry tests use to prove a
 * cleared stage must be re-executed (the write re-submitted / the gate re-obtained)
 * rather than auto-completing off stale state.
 *
 * @param root - The project root.
 * @param runId - The run id to advance and assert on.
 */
export async function expectAdvanceParkedOnRun(root: string, runId: string): Promise<void> {
  const advanced = await advanceWorkflow(root, runId);
  expect(advanced.outcome).not.toBe("completed");
  expect(advanced.run.currentStage).toBe("run");
}
