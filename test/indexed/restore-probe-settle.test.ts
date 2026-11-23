/**
 * @file test/indexed/restore-probe-settle.test.ts
 * @description A pre-seam restore refusal must not leave the probe child polling.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { build } from "esbuild";

/** A missing backup refuses before the paused file can be written. */
it("exits after a pre-seam restore refusal without hiding the refusal", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "llmwiki-restore-probe-"));
  try {
    const project = path.join(temp, "project");
    const script = path.join(temp, "restore-child.mjs");
    await mkdir(project);
    await build({ entryPoints: [path.resolve("test/indexed/fixtures/restore-child.ts")], outfile: script,
      bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
    const child = spawnSync("node", [script, "restore-probe", project, path.join(temp, "missing-backup"), path.join(temp, "paused")], {
      encoding: "utf8", timeout: 3_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temp, TMPDIR: temp },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const line = JSON.parse(child.stdout.trim()) as { outcome: string; message: string };
    expect(line.outcome).not.toBe("ok");
    expect(line.message).toMatch(/backup/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 12_000);
