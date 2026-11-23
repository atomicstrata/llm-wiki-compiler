/**
 * @file test/scale-measure/disk-receipt.test.ts
 * @description Preserve a build child's result when post-child disk accounting fails.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";

/** Run one isolated build with a disk failure, returning its recorded entry. */
async function failedDiskBuild(exitCode: number): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-disk-receipt-"));
  const out = path.join(root, "results.json");
  const base = path.join(root, "work");
  try {
    const probe = spawnSync(process.execPath, [path.join(import.meta.dir, "disk-receipt-probe.ts"), out, base, String(exitCode)], {
      cwd: path.resolve(import.meta.dir, "../.."), encoding: "utf8",
    });
    expect(probe.error).toBeUndefined();
    expect(existsSync(out)).toBe(true);
    expect(probe.status).toBe(0);
    const result = JSON.parse(await readFile(out, "utf8")) as { entries: Record<string, unknown>[] };
    expect(result.entries).toHaveLength(1);
    return result.entries[0]!;
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("records a successful child's result as failed when disk evidence is unavailable", async () => {
  expect(await failedDiskBuild(0)).toMatchObject({ mode: "build", name: "init", completed: true, failed: true, diskError: "disk-observation-failed" });
});

it("records both child failure and disk failure before refusing", async () => {
  expect(await failedDiskBuild(1)).toMatchObject({ mode: "build", name: "init", failed: true, code: 1, diskError: "disk-observation-failed" });
});
