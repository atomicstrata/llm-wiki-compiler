/**
 * @file test/workflow-projection-cli.test.ts
 * @description Real-subprocess tests for the `workflow project <run-id>` CLI.
 *
 * Scaffolds a tmp project whose `build` workflow declares a `projectionFile`,
 * starts a run, then drives `dist/cli.js`:
 *  - `workflow project <id>` writes the DERIVED markdown under `wiki/` and exits 0;
 *  - a workflow with NO projectionFile prints the no-target notice (exit 0);
 *  - an unknown run id exits non-zero and writes nothing.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/** Install a `build` profile with an optional `projectionFile`. */
async function installProfile(projectionFile?: string): Promise<void> {
  const build = {
    stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
    ...(projectionFile !== undefined ? { projectionFile } : {}),
  };
  const pack: ProfilePack = {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" } },
    workflows: { build },
  };
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack), "utf8");
}

/** Start a `build` run and return its minted id (parsed from stdout). */
async function startRun(): Promise<string> {
  const start = await runCLI(["workflow", "start", "build"], root);
  return (start.stdout.match(/build-[a-z0-9-]+/) ?? ["build-x"])[0];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workflow-proj-cli-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow project", () => {
  it("writes the DERIVED projection markdown under wiki/ and exits 0", async () => {
    await installProfile("wiki/outputs/workflows/build.md");
    const runId = await startRun();
    const result = await runCLI(["workflow", "project", runId], root);
    expect(result.code).toBe(0);
    const md = await readFile(path.join(root, "wiki/outputs/workflows/build.md"), "utf8");
    expect(md).toMatch(/DERIVED from the workflow run JSON/);
    expect(md).toContain("status: pending");
  });

  it("prints the no-target notice and exits 0 when no projectionFile is declared", async () => {
    await installProfile();
    const runId = await startRun();
    const result = await runCLI(["workflow", "project", runId], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no projection target/i);
  });

  it("exits non-zero for an unknown run id", async () => {
    await installProfile("wiki/outputs/workflows/build.md");
    const result = await runCLI(["workflow", "project", "build-2026-01-01-9999"], root);
    expect(result.code).not.toBe(0);
  });
});
