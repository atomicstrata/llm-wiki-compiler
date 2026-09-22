/**
 * @file test/temp-roots.ts
 * @description One temp-directory tracker for suites that create project roots
 * and must remove them afterwards.
 *
 * IT EXISTS BECAUSE THE THIRD COPY APPEARED. Two suites hand-rolling the same
 * mkdtemp-plus-cleanup block is a coincidence; three is a pattern, and each copy
 * is a place a root can leak when someone forgets the `afterEach`.
 *
 * `real` IS A PARAMETER RATHER THAN THE DEFAULT because the two behaviours are
 * both wanted. Suites that hand a root to a seam which refuses symlinked paths
 * need the resolved path (macOS returns a symlinked `/var/...` from `mkdtemp`);
 * suites that deliberately exercise symlink handling need the path exactly as
 * `mkdtemp` gave it, and resolving it for them would silently delete the
 * condition under test.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A tracker owning every root it created, for one suite. */
export interface TempRootTrackerV1 {
  /** Create a tracked temp directory under the system temp dir. */
  create(prefix: string, options?: { real?: boolean }): Promise<string>;
  /** Remove every root created so far. Safe to call when none were. */
  cleanup(): Promise<void>;
}

/**
 * Make a tracker for one suite. Call {@link TempRootTrackerV1.cleanup} from
 * `afterEach`.
 */
export function tempRootTracker(): TempRootTrackerV1 {
  const roots: string[] = [];
  return {
    async create(prefix: string, options: { real?: boolean } = {}): Promise<string> {
      const made = await mkdtemp(path.join(tmpdir(), prefix));
      const root = options.real === true ? await realpath(made) : made;
      roots.push(root);
      return root;
    },
    async cleanup(): Promise<void> {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}
