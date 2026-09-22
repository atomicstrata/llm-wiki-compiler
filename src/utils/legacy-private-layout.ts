/**
 * Preserve the public CLI's confined private-directory aliases when no new
 * authority entries exist. This proves absence only; it never grants read or
 * write authority over a new authority store through an alias.
 */
import path from "node:path";
import { lstatLeaf } from "./fs-presence.js";
import { resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { LLMWIKI_DIR } from "./constants.js";

/** Prove a stable confined alias has none of the supplied literal child names. */
export async function legacyPrivateAliasHasNoEntries(root: string, segments: readonly string[]): Promise<boolean> {
  if (segments.length === 0 || segments.some((name) => !/^[a-z][a-z0-9.-]*$/.test(name))) return false;
  const lexical = path.join(root, LLMWIKI_DIR);
  const before = await lstatLeaf(lexical);
  if (before.kind !== "present" || !before.stats.isSymbolicLink()) return false;
  const resolved = await resolveExistingConfinedPrivateDir(root);
  if (resolved === null) return false;
  const directory = await lstatLeaf(resolved);
  if (directory.kind !== "present" || !directory.stats.isDirectory()) return false;
  for (const segment of segments) {
    if ((await lstatLeaf(path.join(resolved, segment))).kind !== "absent") return false;
  }
  const after = await lstatLeaf(lexical);
  const current = await lstatLeaf(resolved);
  return after.kind === "present" && current.kind === "present" &&
    before.stats.dev === after.stats.dev && before.stats.ino === after.stats.ino &&
    directory.stats.dev === current.stats.dev && directory.stats.ino === current.stats.ino &&
    await resolveExistingConfinedPrivateDir(root) === resolved;
}
