/**
 * @file test/catalog/cli-helpers.ts
 * @description Test-runner helpers for the catalog and indexed CLI tests: set
 * a project's expected scale to a `local-indexed` size through the real set
 * body, and run a `--json` command body with stdout captured. Kept apart from
 * `./helpers.ts` because they import the test runner, and the child-process
 * fixtures bundle `./helpers.ts` (a child cannot load the runner).
 */

import { expect, vi } from "bun:test";
import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../src/scale/transition.js";

/** Set `root`'s expected scale to a `local-indexed` size through the real set body (free space unbounded); expects it ready. */
export async function setIndexedScale(root: string): Promise<void> {
  const steps = { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER } };
  expect((await setExpectedScaleWith(steps, { request: { documents: 8_000 } })).readiness).toBe("ready");
}

/** Run a `--json` command body with stdout captured; returns its exit code and the parsed envelope. */
export async function jsonCommand<T>(run: () => Promise<number>): Promise<{ code: number; envelope: T }> {
  let printed = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { printed += String(chunk); return true; });
  const code = await run();
  write.mockRestore();
  return { code, envelope: JSON.parse(printed) as T };
}
