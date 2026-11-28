/**
 * @file src/scale/downgrade-freeze.ts
 * @description The CONTENT FREEZE of a scale-down: one digest over every file
 * the project's meaning depends on, by bytes, and the measured size of the
 * project those files show.
 *
 * WHAT IS BOUND. Every entry under `sources/`, `wiki/` (generated pages,
 * entities, graph files), and the private workspace, candidate and
 * rule-candidate trees, plus the private leaves the smaller layout reads
 * (compile state, embedding stores, event head, profile, config, rule state,
 * pending and quarantined embeddings). A regular file is bound by its path,
 * size, SHA-256 (read in bounded chunks, re-checked after reading), nanosecond
 * mtime and inode; a link or special file by its path and kind (never
 * followed). A directory binds nothing of its own (it is walked): the
 * scale-down itself creates the parent directories of the files it installs
 * (`wiki/graph/` of a project that had no incumbent log), which must not read
 * as a change to the frozen content. Entries are visited in sorted order, so equal
 * content yields an equal digest. A known regular file that cannot be read
 * whole (vanished, replaced, hard-linked, edited during the read) is
 * `content_unreadable` (a blocker), never left out of the measurement.
 *
 * WHAT IS NOT. The files the scale-down itself replaces (`excluded`: its
 * export units) are bound separately by their prior digests, and the indexed
 * stores by their manifests. The project lock, reader leases and caches that
 * reads may refresh (`last-lint.json`) are never bound.
 *
 * BOUNDED. At most {@link MAX_FREEZE_ENTRIES} entries and
 * {@link MAX_DIRECTORY_ENTRIES} per directory; beyond either the freeze is
 * `inventory_unbounded` (a blocker), never a partial digest.
 */

import { createHash, type Hash } from "node:crypto";
import path from "node:path";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import {
  EMBEDDINGS_FILE, EVENTS_HEAD_FILE, PENDING_EMBEDDINGS_FILE, PROFILE_FILE, QUARANTINED_EMBEDDINGS_FILE, RULE_STATE_FILE, STATE_FILE,
} from "../utils/constants.js";
import { EMBEDDINGS_BINARY_FILE } from "../utils/embeddings-storage.js";
import type { DowngradeFreezeV1, DowngradeMeasuredV1 } from "./downgrade-contracts.js";
import { identityAt, leafDigest } from "./downgrade-fs.js";

/** Most entries one freeze binds. */
const MAX_FREEZE_ENTRIES = 1_000_000;
/** Most entries one directory may hold. */
const MAX_DIRECTORY_ENTRIES = 100_000;

/** The trees bound entry by entry. */
const FROZEN_TREES = Object.freeze(["sources", "wiki", ".llmwiki/workspaces", ".llmwiki/candidates", ".llmwiki/rule-candidates"]);
/** The private leaves bound one by one. */
const FROZEN_LEAVES = Object.freeze([
  STATE_FILE, EMBEDDINGS_FILE, EMBEDDINGS_BINARY_FILE, EVENTS_HEAD_FILE, PROFILE_FILE, ".llmwiki/config.json", RULE_STATE_FILE, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE,
]);

/** A freeze that could not bind everything: too many entries, or a file it cannot read. */
export class FreezeUnboundedError extends Error {
  constructor(message: string, readonly code: "inventory_unbounded" | "content_unreadable" = "inventory_unbounded") {
    super(message);
    this.name = "FreezeUnboundedError";
  }
}

/** The running state of one freeze. */
interface FreezeWalk {
  readonly hash: Hash;
  /** False for a measurement only: sizes from one unfollowed stat, no bytes read, the digest meaningless. */
  readonly hashBytes: boolean;
  readonly excluded: ReadonlySet<string>;
  entries: number;
  bytes: number;
  readonly measured: { sourceDocuments: number; sourceBytes: number; wikiFiles: number; wikiBytes: number };
}

/** Bind one entry line, refusing past the entry cap. */
function bind(walk: FreezeWalk, line: string): void {
  walk.entries += 1;
  if (walk.entries > MAX_FREEZE_ENTRIES) throw new FreezeUnboundedError(`more than ${MAX_FREEZE_ENTRIES} entries would be bound`);
  walk.hash.update(`${line}\n`);
}

/** Count a bound regular file toward the measured size of its tree. */
function measure(walk: FreezeWalk, relPath: string, bytes: number, bound = true): void {
  if (bound) walk.bytes += bytes;
  if (relPath.startsWith("sources/")) { walk.measured.sourceDocuments += 1; walk.measured.sourceBytes += bytes; }
  if (relPath.startsWith("wiki/")) { walk.measured.wikiFiles += 1; walk.measured.wikiBytes += bytes; }
}

/** Count the regular file at `relPath` toward the measured size without binding it. */
async function measureOnly(root: string, walk: FreezeWalk, relPath: string): Promise<void> {
  const identity = await identityAt(root, relPath);
  if (identity?.kind === "file") measure(walk, relPath, Number(identity.size), false);
}

/** Bind the regular file at `relPath` by size and SHA-256; an unreadable one refuses. */
async function bindFile(root: string, walk: FreezeWalk, relPath: string): Promise<void> {
  if (!walk.hashBytes) {
    const identity = await identityAt(root, relPath);
    return identity === null ? undefined : measure(walk, relPath, Number(identity.size));
  }
  const digest = await leafDigest(root, relPath);
  if (digest.kind !== "ok") throw new FreezeUnboundedError(`${relPath} is ${digest.kind === "absent" ? "gone" : "not a readable single-link regular file"}; its content cannot be bound`, "content_unreadable");
  measure(walk, relPath, digest.bytes);
  bind(walk, `f\t${relPath}\t${digest.bytes}\t${digest.sha256}\t${digest.identity.mtimeNs}\t${digest.identity.ino}`);
}

/** Bind every entry of the directory at `relDir`, sorted, recursing into directories. */
async function bindTree(root: string, walk: FreezeWalk, relDir: string): Promise<void> {
  const listing = await listConfinedDirBounded(root, relDir, MAX_DIRECTORY_ENTRIES);
  if (listing.kind === "absent") return;
  if (listing.kind !== "ok") throw new FreezeUnboundedError(`${relDir} cannot be listed in full`);
  for (const entry of [...listing.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relPath = path.posix.join(relDir, entry.name);
    // An excluded file (one the scale-down replaces, bound by its own digest) still counts toward the measured size.
    if (walk.excluded.has(relPath)) { await measureOnly(root, walk, relPath); continue; }
    if (entry.kind === "directory") await bindTree(root, walk, relPath);
    else if (entry.kind === "file") await bindFile(root, walk, relPath);
    else bind(walk, `${entry.kind}\t${relPath}`);
  }
}

/** Bind one private leaf: absent, a regular file by bytes, or anything else by kind. */
async function bindLeaf(root: string, walk: FreezeWalk, relPath: string): Promise<void> {
  if (walk.excluded.has(relPath)) return;
  const identity = await identityAt(root, relPath);
  if (identity === null) return bind(walk, `absent\t${relPath}`);
  if (identity.kind === "file") return bindFile(root, walk, relPath);
  bind(walk, `${identity.kind}\t${relPath}`);
}

/** The content freeze of the project at `root`, without the files in `excluded`, and its measured size. */
export async function freezeContent(root: string, excluded: ReadonlySet<string>): Promise<{ freeze: DowngradeFreezeV1; measured: DowngradeMeasuredV1 }> {
  return walkContent(root, excluded, true);
}

/** The measured size alone (one stat per file, nothing read): what a transition preview reports. */
export async function measureContent(root: string): Promise<DowngradeMeasuredV1> {
  return (await walkContent(root, new Set(), false)).measured;
}

/** Walk the frozen trees and leaves of `root`. */
async function walkContent(root: string, excluded: ReadonlySet<string>, hashBytes: boolean): Promise<{ freeze: DowngradeFreezeV1; measured: DowngradeMeasuredV1 }> {
  const walk: FreezeWalk = { hash: createHash("sha256"), hashBytes, excluded, entries: 0, bytes: 0, measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 } };
  for (const tree of FROZEN_TREES) await bindTree(root, walk, tree);
  for (const leaf of FROZEN_LEAVES) await bindLeaf(root, walk, leaf);
  return { freeze: { entries: walk.entries, bytes: walk.bytes, digest: walk.hash.digest("hex") }, measured: { ...walk.measured } };
}
