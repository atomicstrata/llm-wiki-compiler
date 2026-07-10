/**
 * @file test/fixtures/run-action-profile.ts
 * @description Shared fixture for the `runAction` execution-core tests.
 *
 * Builds a NON-DEFAULT profile declaring three gated/ungated workflows and a set
 * of workflow ACTIONS — a `status`, a `start`, an `advance`/`cancel`/`fail` (runId
 * input), a `human:`-gate, and an `agent:`-gate action — plus on-disk install
 * helpers and a `.llmwiki/config.json` planter so the authority and input suites
 * share one profile shape and one local-grant control surface.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { WORKFLOW_PROFILE } from "./workflow-profile.js";
import type { CapabilityClass, ProfilePack } from "../../src/profile/types.js";

/** Per-surface permissions requesting `trusted-write` everywhere (the clamp proves the cap). */
const FULL_PERMISSIONS = {
  cli: "trusted-write",
  sdk: "trusted-write",
  mcp: "trusted-write",
  viewer: "trusted-write",
} as const satisfies Record<string, CapabilityClass>;

/** A `runId` string input every act-on-existing-run action declares. */
const RUN_ID_INPUT = { runId: { type: "string", required: true } } as const;

/**
 * A profile with three workflows (`build` for start/advance/cancel, `humanwf`
 * gated `human:approve`, `agentwf` gated `agent:check`) and five workflow actions.
 */
export function runActionProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: WORKFLOW_PROFILE.entities,
    workflows: {
      ...WORKFLOW_PROFILE.workflows,
      // `secret` mirrors `build`'s stage/gate shape so a cross-workflow scope test
      // can target a `secret` run with a `build`-scoped action (same op surface).
      secret: { stages: WORKFLOW_PROFILE.workflows.build.stages },
      humanwf: { stages: [{ id: "review", reads: ["ideas"], writes: [], gate: "human:approve" }] },
      agentwf: { stages: [{ id: "verify", reads: ["ideas"], writes: [], gate: "agent:check" }] },
    },
    workflowActions: {
      "build.status": { label: "Build status", workflow: "build", operation: "status", permissions: FULL_PERMISSIONS },
      "build.startn": { label: "Start build (typed)", workflow: "build", operation: "start", permissions: FULL_PERMISSIONS, trustGate: "trust:writer", inputSchema: { count: { type: "number", required: true }, dryRun: { type: "boolean" }, tags: { type: "string[]" } } },
      "build.statusone": { label: "Build status one", workflow: "build", operation: "status", permissions: FULL_PERMISSIONS, inputSchema: RUN_ID_INPUT },
      "build.start": { label: "Start build", workflow: "build", operation: "start", permissions: FULL_PERMISSIONS, trustGate: "trust:writer" },
      "build.advance": { label: "Advance build", workflow: "build", operation: "advance", permissions: FULL_PERMISSIONS, trustGate: "trust:writer", inputSchema: RUN_ID_INPUT },
      "build.cancel": { label: "Cancel build", workflow: "build", operation: "cancel", permissions: FULL_PERMISSIONS, trustGate: "trust:writer", inputSchema: RUN_ID_INPUT },
      "build.fail": { label: "Fail build", workflow: "build", operation: "fail", permissions: FULL_PERMISSIONS, trustGate: "trust:writer", inputSchema: { runId: { type: "string", required: true }, detail: { type: "string" } } },
      "gatehuman.approve": { label: "Approve review", workflow: "humanwf", operation: "gate", permissions: FULL_PERMISSIONS, gate: "human:approve", inputSchema: RUN_ID_INPUT },
      "gateagent.check": { label: "Agent check", workflow: "agentwf", operation: "gate", permissions: FULL_PERMISSIONS, gate: "agent:check", inputSchema: RUN_ID_INPUT },
    },
  };
}

/** Install `pack` (default {@link runActionProfile}) as `<root>/.llmwiki/profile.json`. */
export async function installRunActionProfile(root: string, pack: ProfilePack = runActionProfile()): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack), "utf8");
}

/** Plant a `.llmwiki/config.json` carrying the given local-authority knobs. */
export async function plantLocalConfig(root: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, LLMWIKI_DIR, "config.json"), JSON.stringify(config), "utf8");
}
