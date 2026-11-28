/**
 * @file test/scale/downgrade-cli.test.ts
 * @description The operator surfaces of a scale-down. The real source CLI
 * entry (`src/cli.ts` under vite-node, each command its own process) on an
 * indexed project a child built: `scale preview` reports that a lower
 * estimate keeps the layout (exit 0); `scale downgrade --target --documents
 * --out` saves a ready plan (exit 0); applying it without `--readers-offline`
 * refuses (exit 2), combining `--apply` with preview options refuses (exit
 * 2), and the asserted apply completes (exit 0) with `scale status` then
 * reporting `local-standard` and `scale archive list` one archive. The SDK
 * facade previews in one process and applies the saved plan in another.
 */

import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";
import { runSourceCli } from "./source-cli.js";

/** One source CLI process (vite-node transforms the source on start). */
const CLI_TIMEOUT_MS = 300_000;

const projects = useDowngradeProjects();

/** Run the source CLI with `args` in `cwd`; returns its exit code and parsed JSON envelope. */
async function cli(cwd: string, ...args: string[]): Promise<{ code: number; body: Record<string, any> }> {
  const run = await runSourceCli(cwd, args, CLI_TIMEOUT_MS);
  return { code: run.code, body: JSON.parse(run.stdout || "{}") as Record<string, any> };
}

describe("the scale-down CLI", () => {
  it("previews, refuses unasserted or mixed applies, applies and lists the archive", async () => {
    const root = await projects.build("build");
    const preview = await cli(root, "scale", "preview", "--documents", "100", "--json");
    expect([preview.code, preview.body.preview.change]).toEqual([0, "none"]);
    const plan = planFileFor(root);
    const saved = await cli(root, "scale", "downgrade", "--target", "local-standard", "--documents", "100", "--out", plan, "--json");
    expect([saved.code, saved.body.preview.ready]).toEqual([0, true]);
    expect((await cli(root, "scale", "downgrade", "--apply", plan, "--json")).body.refusal.code).toBe("scale_downgrade_readers_live");
    expect((await cli(root, "scale", "downgrade", "--apply", plan, "--target", "local-large", "--json")).code).toBe(2);
    const applied = await cli(root, "scale", "downgrade", "--apply", plan, "--readers-offline", "--json");
    expect([applied.code, applied.body.applied.target]).toEqual([0, "local-standard"]);
    expect((await cli(root, "scale", "status", "--json")).body.record.active.architecture).toBe("local-standard");
    expect((await cli(root, "scale", "archive", "list", "--json")).body.archives).toHaveLength(1);
  }, CASE_TIMEOUT_MS);
});

describe("the scale-down SDK facade", () => {
  it("previews in one process and applies the saved plan in another", async () => {
    const root = await projects.build("build");
    expect(await ok("sdk-preview", root, planFileFor(root))).toEqual({ change: "none", ready: true });
    expect(await ok("sdk-apply", root, planFileFor(root))).toEqual({ target: "local-standard", archives: 1 });
  }, CASE_TIMEOUT_MS);
});
