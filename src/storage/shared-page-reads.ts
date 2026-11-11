/**
 * @file src/storage/shared-page-reads.ts
 * @description Confined page reads shared across one compile, each reuse
 * checked against the file on disk.
 *
 * A compile walks every concept page several times: link targets for page
 * generation, link resolution, link repair, then index, MOC and embeddings.
 * Each walk reaches the page through its own call chain, and every read is a
 * full confined read (open without following links, post-open realpath, inode
 * check, read). {@link withSharedPageReads} opens a window, and
 * `readConfinedExactFile` routes its reads through {@link sharedConfinedRead}.
 *
 * WHY A REUSE CANNOT GO STALE. Walks write pages between them (generation
 * writes new pages, resolution and repair rewrite links), so a cached read is
 * reused only after one `lstat` of the path matches the identity taken from
 * the OPENED handle's `fstat`, before its bytes were read: device, inode,
 * size, and modified and changed times. An atomic replace gives the path a new
 * inode, an in-place write changes size or times, a delete or a symlink swap
 * changes what the path names; each mismatches and forces a full confined read.
 * Because the identity predates the bytes, a write that lands mid-read also
 * mismatches later rather than pinning a torn read. This holds for every
 * writer, this process's or another's, so no write path has to remember to
 * invalidate anything.
 *
 * WHY A REUSE IS STILL CONFINED. A reused result is the content of the file
 * that passed the full confinement proof when it was read, and the matching
 * identity says the path still names that same, unchanged file. A path that
 * now resolves elsewhere names a different inode and is read afresh, through
 * the full proof.
 *
 * Only a direct, successful read carries an identity. A dropped read, or a
 * page read through an in-directory link, is never reused; it is read again on
 * every ask. Outside a window every ask reads, exactly as before.
 *
 * The walks also parse each page's frontmatter. {@link frontmatterOfRead}
 * keys that parse on the read's result object, so asks answered by the same
 * reused result parse it once. Callers must treat the parse as read-only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfinedReadResult } from "./legacy-local-reads.js";
import fs from "node:fs";
import { parseFrontmatter } from "../utils/markdown.js";

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
  /** `null` when the read must not be reused (dropped, or read through a link). */
  identity: FileIdentity | null;
}

/** One file's read in a window: in flight, then settled (kept so a reuse check needs no await). */
interface SharedEntry {
  pending: Promise<IdentifiedRead>;
  settled?: IdentifiedRead;
}

const sharedReads = new AsyncLocalStorage<Map<string, SharedEntry>>();

/** Run `steps` with confined reads shared among them. See the file header. */
export function withSharedPageReads<T>(steps: () => Promise<T>): Promise<T> {
  return sharedReads.run(new Map(), steps);
}

/** The identity fields of a stat, for {@link FileIdentity}. */
export function fileIdentityOf(stat: FileIdentity): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

/**
 * Whether `file`, not following a final link, is still exactly `identity`.
 * Synchronous: a metadata lookup answered from the kernel's caches, as in
 * fs-metadata.ts, so a reuse costs no round trip.
 */
function stillSameFile(file: string, identity: FileIdentity): boolean {
  const now = fs.lstatSync(file, { throwIfNoEntry: false });
  return now !== undefined && now.dev === identity.dev && now.ino === identity.ino && now.size === identity.size
    && now.mtimeMs === identity.mtimeMs && now.ctimeMs === identity.ctimeMs;
}

/** The settled read `entry` holds, once it has settled. A rejected read yields `null`: read again. */
async function settledRead(entry: SharedEntry): Promise<IdentifiedRead | null> {
  return entry.settled ?? (await entry.pending.catch(() => null));
}

/** The earlier read's result, when it succeeded with an identity `file` still has. */
function reusable(read: IdentifiedRead | null, file: string): ConfinedReadResult | null {
  return read?.identity && stillSameFile(file, read.identity) ? read.result : null;
}

/**
 * `read()`'s result, or an earlier read of the same file in the current window
 * when the file on disk is provably unchanged since (see the file header).
 * Outside a window, `read()` every time.
 *
 * @param expectedDir - The directory the read confines to; part of the key.
 * @param file - The path read; part of the key, and what the reuse check stats.
 * @param read - The full confined read, with the opened file's identity.
 */
export async function sharedConfinedRead(
  expectedDir: string,
  file: string,
  read: () => Promise<IdentifiedRead>,
): Promise<ConfinedReadResult> {
  const window = sharedReads.getStore();
  if (!window) return (await read()).result;
  const key = `${expectedDir}\0${file}`;
  const earlier = window.get(key);
  const reused = earlier ? reusable(await settledRead(earlier), file) : null;
  if (reused) return reused;
  const entry: SharedEntry = { pending: read() };
  entry.pending.then((settled) => { entry.settled = settled; }, () => {});
  window.set(key, entry);
  return (await entry.pending).result;
}

/** A page read that returned content. */
type PageContent = Extract<ConfinedReadResult, { content: string }>;

const parsedReads = new WeakMap<PageContent, ReturnType<typeof parseFrontmatter>>();

/**
 * `parseFrontmatter(read.content)`, parsed once per read result. Reused
 * results (see the file header) share their parse; treat it as read-only.
 */
export function frontmatterOfRead(read: PageContent): ReturnType<typeof parseFrontmatter> {
  let parsed = parsedReads.get(read);
  if (!parsed) {
    parsed = parseFrontmatter(read.content);
    parsedReads.set(read, parsed);
  }
  return parsed;
}
