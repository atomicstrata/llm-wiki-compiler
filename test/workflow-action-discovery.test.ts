/**
 * @file test/workflow-action-discovery.test.ts
 * @description Tests for the read-only workflow-action discovery operations.
 *
 * `listActions` surfaces the profile's declared `workflowActions` (sorted by id,
 * `[]` for a default project). `showAction` returns the detail with
 * `effectivePermissions` correctly computed = min(requested, localGrant, surface
 * cap) per surface — so an action requesting `trusted-write` on `mcp` clamps to
 * `staged-write`, and a local config tightening `cli` to `read-only` is honoured.
 * An undeclared (or prototype-chain) id throws `UnknownActionError`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listActions, showAction } from "../src/workflows/actions.js";
import { UnknownActionError } from "../src/workflows/errors.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/** A profile declaring two workflow actions, intentionally out of sorted order. */
function actionProfile(): ProfilePack {
  const permissions = { cli: "trusted-write", sdk: "trusted-write", mcp: "trusted-write", viewer: "read-only" } as const;
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" } },
    workflows: { build: { stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }] } },
    workflowActions: {
      "build.start": { label: "Start build", workflow: "build", operation: "start", permissions, trustGate: "trust:writer" },
      "build.advance": { label: "Build status", workflow: "build", operation: "status", permissions },
    },
  };
}

/** Write `pack` to `<root>/.llmwiki/profile.json`. */
async function writeProfile(pack: ProfilePack): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wf-action-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("listActions", () => {
  it("returns declared actions sorted by id", async () => {
    await writeProfile(actionProfile());
    const actions = await listActions(root);
    expect(actions.map((a) => a.actionId)).toEqual(["build.advance", "build.start"]);
    expect(actions[1]).toEqual({ actionId: "build.start", label: "Start build", workflow: "build", operation: "start" });
  });

  it("returns [] for a default-profile project (no actions declared)", async () => {
    expect(await listActions(root)).toEqual([]);
  });
});

describe("showAction effective permissions", () => {
  it("clamps a trusted-write mcp request to the surface cap (staged-write)", async () => {
    await writeProfile(actionProfile());
    const detail = await showAction(root, "build.start");
    expect(detail.effectivePermissions.cli).toBe("trusted-write");
    expect(detail.effectivePermissions.mcp).toBe("staged-write");
    expect(detail.effectivePermissions.viewer).toBe("read-only");
  });

  it("honours a local config that tightens cli to read-only", async () => {
    await writeProfile(actionProfile());
    await writeFile(
      path.join(root, ".llmwiki", "config.json"),
      JSON.stringify({ workflowGrants: { cli: "read-only" } }),
      "utf8",
    );
    const detail = await showAction(root, "build.start");
    expect(detail.effectivePermissions.cli).toBe("read-only");
  });
});

describe("showAction unknown id", () => {
  it("throws UnknownActionError for an undeclared id", async () => {
    await writeProfile(actionProfile());
    await expect(showAction(root, "ghost")).rejects.toBeInstanceOf(UnknownActionError);
  });

  it("throws UnknownActionError for a prototype-chain id (constructor)", async () => {
    await writeProfile(actionProfile());
    await expect(showAction(root, "constructor")).rejects.toBeInstanceOf(UnknownActionError);
  });
});
