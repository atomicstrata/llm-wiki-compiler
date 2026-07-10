/**
 * @file test/workflow-list.test.ts
 * @description Tests for `listWorkflows`: it surfaces the profile's declared
 * workflows (with their stage ids, in declared order, sorted by workflow id) and
 * returns `[]` for a default-profile project that declares none.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { listWorkflows } from "../src/workflows/list.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

/** Write `pack` to `<root>/.llmwiki/profile.json`. */
async function writeProfile(root: string, pack: ProfilePack): Promise<void> {
  const filePath = path.join(root, PROFILE_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(pack), "utf8");
}

/** A profile declaring two workflows, intentionally out of sorted order. */
function twoWorkflowProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" }, experiments: { directory: "wiki/experiments" } },
    workflows: {
      zebra: { stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }] },
      build: {
        stages: [
          { id: "draft", reads: ["ideas"], writes: ["ideas"] },
          { id: "run", reads: ["ideas"], writes: ["experiments"] },
        ],
      },
    },
  };
}

describe("listWorkflows", () => {
  it("returns declared workflows with stage ids, sorted by workflow id", async () => {
    const root = await makeTempRoot("wf-list");
    await writeProfile(root, twoWorkflowProfile());
    const summaries = await listWorkflows(root);
    expect(summaries).toEqual([
      { workflowId: "build", stageIds: ["draft", "run"] },
      { workflowId: "zebra", stageIds: ["draft"] },
    ]);
  });

  it("returns [] for a default-profile project (no workflows declared)", async () => {
    const root = await makeTempRoot("wf-list-default");
    expect(await listWorkflows(root)).toEqual([]);
  });
});
