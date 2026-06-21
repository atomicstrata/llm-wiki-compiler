/**
 * @file test/fixtures/confinement-roots.ts
 * @description Shared tmp-root lifecycle for candidate-store confinement tests.
 *
 * Both the concept-store and rule-store confinement suites need the same pair
 * of out-of-tree temp directories — an in-project `root` and an `outside`
 * directory a symlink can be pointed at — created in `beforeEach` and removed in
 * `afterEach`. Extracting the lifecycle here removes the duplicated boilerplate
 * (flagged by fallow) while keeping each suite's symlink/assertion logic local.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach } from "vitest";

/**
 * Mutable context populated by {@link useConfinementRoots}. `root` is the
 * in-project root; `outside` is an out-of-tree dir a symlink can target.
 */
export interface ConfinementRoots {
  /** Absolute path of the current test's in-project temp root. */
  root: string;
  /** Absolute path of the current test's out-of-tree (escape-target) dir. */
  outside: string;
}

/**
 * Register beforeEach/afterEach hooks that create and tear down the `root` and
 * `outside` temp directories for a confinement suite.
 *
 * @param label - Short prefix used to name both temp directories.
 * @returns Mutable context whose fields are set fresh for each test.
 */
export function useConfinementRoots(label: string): ConfinementRoots {
  const ctx: ConfinementRoots = { root: "", outside: "" };

  beforeEach(async () => {
    ctx.root = await mkdtemp(path.join(os.tmpdir(), `${label}-confine-`));
    ctx.outside = await mkdtemp(path.join(os.tmpdir(), `${label}-outside-`));
  });

  afterEach(async () => {
    if (ctx.root) await rm(ctx.root, { recursive: true, force: true });
    if (ctx.outside) await rm(ctx.outside, { recursive: true, force: true });
    ctx.root = ctx.outside = "";
  });

  return ctx;
}
