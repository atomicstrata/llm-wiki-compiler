/**
 * @file test/indexed/plan-file.ts
 * @description Save a maintenance plan (a segment collection or a batch run
 * retirement plan) as a new, uniquely named JSON file beside the project, as
 * an operator saves one before applying it from another process.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Write `plan` to a new file named `<tag>-<time>-<random>.json` in `root`; returns its path. */
export async function writePlanBeside(root: string, plan: unknown, tag = "plan"): Promise<string> {
  const planFile = path.join(root, `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(planFile, JSON.stringify(plan));
  return planFile;
}
