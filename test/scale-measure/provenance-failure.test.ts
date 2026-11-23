/**
 * @file test/scale-measure/provenance-failure.test.ts
 * @description A measurement refuses to start when Git cannot identify its source.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";

/** Run a probe with Git absent in its own process, so other test files keep their PATH. */
function withoutGit(body: string): number | null {
  const cwd = path.resolve(import.meta.dir, "../..");
  const probe = `try { ${body}; process.exit(0); } catch (error) { if (String(error).includes("Git provenance unavailable")) process.exit(42); throw error; }`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd, env: { ...process.env, PATH: "/nonexistent-llmwiki-git-path" }, encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  return result.status;
}

it("refuses an environment without Git identity", () => {
  expect(withoutGit('const { environment } = await import("./test/scale-measure/environment.ts"); environment()')).toBe(42);
});

it("refuses a measurement before creating results or corpus when Git is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "llmwiki-provenance-failure-"));
  try {
    const out = path.join(root, "results.json");
    const base = path.join(root, "corpus");
    const body = `const { runMeasurements } = await import("./test/scale-measure/run.ts"); await runMeasurements(${JSON.stringify(out)}, [], ${JSON.stringify(base)})`;
    expect(withoutGit(body)).toBe(42);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(base)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
