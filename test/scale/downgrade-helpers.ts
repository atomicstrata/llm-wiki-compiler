/**
 * @file test/scale/downgrade-helpers.ts
 * @description Shared fixtures of the scale-down tests. Every process that
 * opens a fixture's stores is a CHILD (`fixtures/downgrade-child.ts`): a
 * preview reads the indexed stores under a reader lease, so a preview in the
 * test process would be a live reader that makes every apply refuse, and an
 * apply must be a fresh collector. The test process only copies projects,
 * keeps plan files and inspects files.
 *
 * PROJECTS. Each case builds its own project (the indexed activation is
 * several durable commits on the test volume); a plan is always made for the
 * project it applies to.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "bun:test";
import { afterAll } from "../config/storage-profile-hooks.js";
import { bundleChild, runChild } from "../helpers-child-process.js";

/**
 * A case: a build and a few children, each mostly durable commits. Measured
 * alone on the private test volume: a build 66 s, a preview 2.4 s, an apply
 * 38 s (CPU under 1 s each: the time is fsync). A case making two to four of
 * them under parallel test files has exceeded 300 s, so it gets this bound.
 */
export const CASE_TIMEOUT_MS = 900_000;

let script: string | undefined;

/** Run one child mode and return its JSON line. */
export async function downgradeMode(...args: string[]): Promise<Record<string, unknown>> {
  script ??= await bundleChild("test/scale/fixtures/downgrade-child.ts");
  const end = await runChild(script, args);
  expect(end.json, `${end.stderr}\nexit ${end.code}`).not.toBeNull();
  return end.json!;
}

/** Run one child mode that must succeed and return its result. */
export async function ok<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  const json = await downgradeMode(...args);
  expect(json.outcome, String(json.message)).toBe("ok");
  return json.result as T;
}

/** Run a child that must exit at a seam with code 70 (a kill after that durable checkpoint). */
export async function crashAt(root: string, planFile: string, seam: string): Promise<void> {
  script ??= await bundleChild("test/scale/fixtures/downgrade-child.ts");
  const end = await runChild(script, ["apply", root, planFile, "crash", seam]);
  expect(end.code, end.stdout + end.stderr).toBe(70);
}

/** One test file's projects: each case builds its own (removed after the file). */
export interface DowngradeProjects {
  /** A freshly built project of `mode`. */
  build(mode: "build" | "build-late" | "large"): Promise<string>;
}

/**
 * Register the projects of a test file. Each case BUILDS its own: copying a
 * built indexed project would give every frozen legacy backup a new inode
 * and mtime, which the indexed stores (correctly) report as a changed backup.
 */
export function useDowngradeProjects(): DowngradeProjects {
  const scratch: string[] = [];
  afterAll(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });
  return {
    build: async (mode) => {
      const root = await mkdtemp(path.join(tmpdir(), `llmwiki-downgrade-${mode}-`));
      scratch.push(root);
      await ok(mode, root);
      return root;
    },
  };
}

/** A plan file path at the top of `root` (outside every tree a scale-down binds). */
export function planFileFor(root: string, tag = "plan"): string {
  return path.join(root, `${tag}.json`);
}

/** Expect `root` to have completed a scale-down to local-standard with `before`'s logical content. */
export async function expectCompleted(root: string, before: Record<string, unknown>): Promise<void> {
  const after = await ok<Record<string, unknown>>("snapshot", root);
  /** A snapshot without the fields that name the layout. */
  const strip = (snapshot: Record<string, unknown>) => ({ ...snapshot, active: undefined, version: undefined, readiness: undefined });
  expect(strip(after)).toEqual(strip(before));
  expect([after.active, after.version, after.readiness]).toEqual(["local-standard", 1, "ready"]);
  const privateDir = await readdir(path.join(root, ".llmwiki"));
  expect(privateDir).not.toContain("indexed");
  expect(privateDir).not.toContain("scale-downgrade.json");
}
