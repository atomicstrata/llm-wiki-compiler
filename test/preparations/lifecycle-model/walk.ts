/**
 * @file test/preparations/lifecycle-model/walk.ts
 * @description One recursive file walk shared by the lifecycle model controls. Both
 * the ownership tripwire and the coverage matrix need to enumerate a tree, and a second
 * copy of that loop is a second place for the two controls to disagree about what they
 * are looking at.
 *
 * The walk is over committed trees no test writes, and several controls in one
 * suite walk the same tree, so each listing is taken once per test file.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

const listings = new Map<string, Promise<string[]>>();

/** Every file under `relative` with `suffix`, returned repo-relative; listed once per test file. */
export async function listFilesUnder(repoRoot: string, relative: string, suffix: string): Promise<string[]> {
  const key = JSON.stringify([path.resolve(repoRoot), relative, suffix]);
  let listing = listings.get(key);
  if (listing === undefined) {
    listing = walkFilesUnder(repoRoot, relative, suffix);
    listings.set(key, listing);
  }
  return [...await listing];
}

/** The uncached walk behind {@link listFilesUnder}. */
async function walkFilesUnder(repoRoot: string, relative: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(repoRoot, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await walkFilesUnder(repoRoot, next, suffix));
    else if (entry.name.endsWith(suffix)) found.push(next);
  }
  return found;
}
