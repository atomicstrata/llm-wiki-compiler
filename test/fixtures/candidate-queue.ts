/**
 * @file test/fixtures/candidate-queue.ts
 * @description Shared exact-byte snapshot helpers for candidate queue tests.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";

/** Return pending candidate JSON bytes keyed by physical filename. */
export async function snapshotCandidateQueue(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, CANDIDATES_DIR);
  if (!existsSync(dir)) return {};
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const entries = await Promise.all(names.map(async (name) => [
    name,
    (await readFile(path.join(dir, name))).toString("base64"),
  ] as const));
  return Object.fromEntries(entries);
}
