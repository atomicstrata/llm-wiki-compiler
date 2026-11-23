/**
 * @file test/cstate/helpers.ts
 * @description Shared fixtures for the segmented compile state tests: a
 * small `local-indexed` project prepared through the real set-and-prepare
 * bodies, with a realistic `state.json` (sources with concepts and an
 * extraction snapshot, an extra source key, frozen slugs, a prompt
 * modifiers digest) written BEFORE the capability is requested.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, setDefaultTimeout } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { diskScaleTransitionSteps, prepareExpectedScaleWith, setExpectedScaleWith, type ScaleTransitionSteps } from "../../src/scale/transition.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import { writeState } from "../../src/utils/state.js";
import type { WikiState } from "../../src/utils/types.js";
import { writeCorpus } from "../catalog/helpers.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { sampleState } from "./sample-state.js";

export { sampleState } from "./sample-state.js";

/** The capability under test. */
export const CSTATE = "segmented-compile-state-1" as const;

/**
 * The fixture's minimum per-test budget: every case builds and upgrades a
 * project through durable segment commits, which the 30 s reference budget
 * does not fit on a loaded test volume.
 */
const COMPILE_STATE_FIXTURE_MIN_TEST_TIMEOUT_MS = 120_000;

/** The local steps with an unbounded free-space answer and an optional checkpoint. */
export function stepsFor(root: string, checkpoint?: ScaleTransitionSteps["checkpoint"]): ScaleTransitionSteps {
  return { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER }, ...(checkpoint === undefined ? {} : { checkpoint }) };
}

/** A fresh `local-indexed` project whose `state.json` is `state`, without the compile-state capability. */
export async function indexedWithState(state: WikiState = sampleState()): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-cstate-"));
  await writeCorpus(root, 4, 3);
  await writeState(root, state);
  const report = await setExpectedScaleWith(stepsFor(root), { request: { documents: 8_000 } });
  expect([report.readiness, report.record?.active.architecture]).toEqual(["ready", "local-indexed"]);
  return root;
}

/** One test file's upgraded projects: the roots it owns (removed after each test) and the builder. */
export interface CompileStateProjects {
  readonly roots: string[];
  /** A project upgraded to the segmented compile state, and the exact bytes of its `state.json` before the upgrade. */
  upgraded(): Promise<{ root: string; legacy: Buffer }>;
}

/**
 * Register a test file's upgraded-project fixture. Each case prepares a scale
 * record through durable segment commits (~10 s alone, measured 20 s for the
 * routed-writes case); under a loaded test volume that passes the default, so
 * the whole FILE gets a measured limit: the larger of the fixture's 120 s
 * floor and the selected storage profile's per-test budget. The default
 * profile (30 s) keeps the 120 s floor and the explicit
 * `slow-durable-storage` profile keeps its 300 s, so the floor never lowers a
 * budget the caller opted into. On slow external storage, single-case runs of
 * this file spent 98-120 s of each case in durable flushes, and four cases
 * timed out at the former unconditional 120 s; the profile budget is a
 * functional allowance for such storage, not evidence of a defect or a fix.
 */
export function useCompileStateProjects(): CompileStateProjects {
  const profile = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE);
  // Bun's file-scope default (public main's replacement for Vitest's setConfig testTimeout); called while the file registers its tests.
  setDefaultTimeout(Math.max(COMPILE_STATE_FIXTURE_MIN_TEST_TIMEOUT_MS, profile.testTimeoutMs));
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  return {
    roots,
    upgraded: async () => {
      const root = await indexedWithState();
      roots.push(root);
      const legacy = await readFile(path.join(root, STATE_FILE));
      expect((await prepareExpectedScaleWith(stepsFor(root), { capabilities: [CSTATE] })).readiness).toBe("ready");
      return { root, legacy };
    },
  };
}
