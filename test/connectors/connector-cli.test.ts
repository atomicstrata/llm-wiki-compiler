/**
 * @file test/connectors/connector-cli.test.ts
 * @description Real CLI coverage for connector discovery and refusal paths.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNewsroomProject } from "../fixtures/newsroom-profile.js";

const CLI = path.resolve("dist/cli.js");

/** Run the built CLI against a temp project with optional environment overrides. */
function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

/** Build a newsroom-profile temp project and clean it up after `fn` completes. */
async function withNewsroomProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "connector-cli-"));
  try {
    await buildNewsroomProject(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("connector CLI", () => {
  it("lists only user-facing connectors", async () => {
    await withNewsroomProject(async (root) => {
      const res = run(root, ["connector", "list"], { LLMWIKI_CONNECTORS: "fixture" });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("crossref");
      expect(res.stdout).toContain("inactive, unbound");
      expect(res.stdout).not.toContain("fixture");
    });
  });

  it("runs through the substrate refusal path without fetching when inactive", async () => {
    await withNewsroomProject(async (root) => {
      const res = run(root, ["connector", "run", "fixture", "--input", "id=story-1"], { LLMWIKI_CONNECTORS: "" });
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toContain("connector is not activated");
    });
  });
});
