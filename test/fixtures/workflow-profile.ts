/**
 * @file test/fixtures/workflow-profile.ts
 * @description Shared NON-DEFAULT profile fixture declaring a two-stage `build`
 * workflow over two entity types, plus a helper to install it on disk.
 *
 * Used by the workflow CLI and SDK-facade tests so both assert against one fixed
 * profile shape (and so the fixture is not duplicated across test files).
 *
 * This module is data and file writes only. Helpers that start or advance runs
 * live in `workflow-run-helpers.ts` and `workflow-run-read.ts`: importing the
 * workflow engine here would load most of the source tree into every test file
 * that only wants a profile.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import type { ProfilePack, WorkflowStageDef } from "../../src/profile/types.js";

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
