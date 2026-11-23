/**
 * @file test/scale/durable-cancel-lifecycle.ts
 * @description The shared test lifecycle of the DURABLE cancellation witness
 * files (bootstrapped, races, completion): their named per-case budget, their
 * cleanup budget, and the tracking of the fixture projects each test makes.
 *
 * It is kept apart from `cancel-helpers.ts` on purpose: that module only
 * builds fixtures and has no test-runner import, so the read-only witnesses that
 * use it register no hook. This module registers a `bun:test` `afterEach` when a
 * file calls `trackDurableCancelProjects()`, and only then.
 *
 * Why the budgets are named: the fixtures and the code under test write with
 * fsync, and on the slow durable test volume such cases exceeded the
 * slow-durable profile's 90 s (measured fsync latency about 3.8 s per sync). A
 * pass under these budgets shows the behaviour, not the reference 30 s or
 * slow-profile 90 s budget, and not throughput.
 */

import { afterEach } from "../config/storage-profile-hooks.js";
import type { CancelProject } from "./cancel-helpers.js";

/** The NAMED budget of each durable cancellation case. */
export const DURABLE_CANCEL_CASE_TIMEOUT_MS = 300_000;
/** The cleanup hook's budget: removing durably written fixture projects. */
const DURABLE_CANCEL_CLEANUP_TIMEOUT_MS = 120_000;

/**
 * Register, in the calling test file, an `afterEach` that removes every
 * project kept during the test (in the order kept, within the cleanup
 * budget), and return the function that keeps a project and returns it.
 */
export function trackDurableCancelProjects(): (project: CancelProject) => CancelProject {
  const projects: CancelProject[] = [];
  afterEach(async () => { for (const project of projects.splice(0)) await project?.remove(); }, DURABLE_CANCEL_CLEANUP_TIMEOUT_MS);
  return (project) => {
    projects.push(project);
    return project;
  };
}
