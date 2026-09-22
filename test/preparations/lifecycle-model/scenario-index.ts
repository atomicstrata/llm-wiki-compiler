/**
 * @file test/preparations/lifecycle-model/scenario-index.ts
 * @description One scan of the test tree's scenarios, shared by every control
 * that resolves a citation.
 *
 * The coverage matrix and the protocol map both resolve citations against real
 * scenario titles, and each had grown its own copy of the walk-read-parse loop.
 * Three copies of a citation index is three chances for them to disagree about
 * what counts as a real test — which is precisely the drift these controls exist
 * to prevent.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { listFilesUnder } from "./walk.js";
import { scenarioReach } from "./reach.js";

/** Every scenario title mapped to the production functions it actually calls. */
export async function scenarioBodyIndex(repoRoot: string): Promise<Map<string, ReadonlySet<string>>> {
  const bodies = new Map<string, ReadonlySet<string>>();
  for (const file of await listFilesUnder(repoRoot, "test", ".test.ts")) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    for (const scenario of scenarioReach(file, source)) bodies.set(scenario.title, scenario.calls);
  }
  return bodies;
}

/** Every scenario title that exists anywhere in the test tree. */
export async function scenarioTitleIndex(repoRoot: string): Promise<Set<string>> {
  return new Set((await scenarioBodyIndex(repoRoot)).keys());
}
