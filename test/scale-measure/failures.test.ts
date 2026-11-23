/**
 * @file test/scale-measure/failures.test.ts
 * @description A failed measurement child must make the driver fail after its
 * partial result has been recorded, for both build and operation stages.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { runMeasurements } from "./run.js";

/** Keep Git available for provenance while making measured Node unavailable. */
async function expectChildFailure(name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-measure-failure-"));
  const out = path.join(root, "result.json");
  const priorPath = process.env.PATH;
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitOnly = path.join(root, "git-only");
  await mkdir(gitOnly);
  await symlink(git, path.join(gitOnly, "git"));
  process.env.PATH = gitOnly;
  try {
    await expect(runMeasurements(out, [[name, name === "calibration" ? 0 : 1]], path.join(root, "work"))).rejects.toThrow("measurement child failed");
    const result = JSON.parse(await readFile(out, "utf8")) as { entries: Array<{ failed?: boolean }> };
    expect(result.entries[0]?.failed).toBe(true);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
}

it("fails when a build child fails", async () => {
  await expectChildFailure("indexed");
});

it("fails when an operation child fails", async () => {
  await expectChildFailure("calibration");
});
