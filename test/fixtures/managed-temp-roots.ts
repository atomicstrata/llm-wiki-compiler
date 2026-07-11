/**
 * @file test/fixtures/managed-temp-roots.ts
 * @description Tracks disposable project roots and common profile-state assertions.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { makeTempRoot } from "./temp-root.js";

/** Create temp projects with one cleanup operation for test hooks. */
export function managedTempRoots(): {
  create: (label: string) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const roots: string[] = [];
  return {
    create: async (label) => {
      const root = await makeTempRoot(label);
      roots.push(root);
      return root;
    },
    cleanup: async () => {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

/** Assert that a failed operation did not create the active profile. */
export async function expectProfileAbsent(root: string): Promise<void> {
  await expect(readFile(path.join(root, PROFILE_FILE), "utf8")).rejects.toThrow();
}
