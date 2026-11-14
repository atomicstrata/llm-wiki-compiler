/** Confined page reads shared across one compile, each reuse checked against the file on disk. */

import type { ConfinedReadResult } from "./legacy-local-reads.js";
import fs from "node:fs";
import { sharedReadEntries, sharedReadKey } from "../utils/shared-read-window.js";

/** What a file was when it was opened: compared against an `lstat` before any reuse. */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** A confined read and, when it may be reused, the identity of the file it read. */
export interface IdentifiedRead {
  result: ConfinedReadResult;
  identity: FileIdentity | null;
}

interface SharedEntry {
  expectedDir: string;
  pending: Promise<IdentifiedRead>;
}

/** The identity fields of a stat, for {@link FileIdentity}. */
export function fileIdentityOf(stat: FileIdentity): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function stillSameFile(file: string, identity: FileIdentity): boolean {
  let now: fs.Stats | undefined;
  try {
    now = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    // An unsearchable or replaced parent: not reusable, and the full read classifies it.
    return false;
  }
  return now !== undefined && now.dev === identity.dev && now.ino === identity.ino && now.size === identity.size
    && now.mtimeMs === identity.mtimeMs && now.ctimeMs === identity.ctimeMs;
}

function settledRead(entry: SharedEntry): Promise<IdentifiedRead | null> {
  return entry.pending.catch(() => null);
}

function reusable(read: IdentifiedRead | null, file: string): ConfinedReadResult | null {
  return read?.identity && stillSameFile(file, read.identity) ? read.result : null;
}

/** `read()`'s result, or an earlier read of the same file in the current window when the file on disk is provably unchanged since (see the file header). */
export async function sharedConfinedRead(
  expectedDir: string,
  file: string,
  read: () => Promise<IdentifiedRead>,
): Promise<ConfinedReadResult> {
  const shared = sharedReadEntries<SharedEntry>();
  if (!shared) return (await read()).result;
  const key = sharedReadKey(file);
  const earlier = shared.get(key);
  const reused = earlier?.expectedDir === expectedDir ? reusable(await settledRead(earlier), file) : null;
  if (reused) return reused;
  const entry: SharedEntry = { expectedDir, pending: read() };
  shared.set(key, entry);
  return (await entry.pending).result;
}
