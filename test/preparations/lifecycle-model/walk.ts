/**
 * @file test/preparations/lifecycle-model/walk.ts
 * @description One recursive file walk shared by the lifecycle model controls. Both
 * the ownership tripwire and the coverage matrix need to enumerate a tree, and a second
 * copy of that loop is a second place for the two controls to disagree about what they
 * are looking at.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

/** Every file under `relative` with `suffix`, returned repo-relative. */
export async function listFilesUnder(repoRoot: string, relative: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(repoRoot, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await listFilesUnder(repoRoot, next, suffix));
    else if (entry.name.endsWith(suffix)) found.push(next);
  }
  return found;
}
