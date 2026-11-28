/**
 * @file src/catalog/entity-rows.ts
 * @description The TYPED ENTITY CATALOG of a custom-profile `local-indexed`
 * project: one row per entity page file and one per entity directory,
 * projected by the INCUMBENT collector itself.
 *
 * KEYS. `e:<type>/<stem>` for each `.md` file of a declared entity directory
 * (the raw filename stem, slug-safe or not), and `e:<type>/` for the directory
 * itself (it sorts first among its type's rows). Code-unit key order is the
 * listing order of the indexed route.
 *
 * ROWS. A file row carries the file's stamp, the PUBLIC page view the
 * incumbent listing would return for it without a body (`toEntityPageView`:
 * every frontmatter field), or none when the page's identity is invalid, and
 * every collector problem the file yields (`field-violation` pages are still
 * listed WITH their problems). A directory row carries the directory's
 * problems (`invalid-directory`). Each is produced by running
 * `collectEntityPagesWithMessagesFrom` over a scan binding narrowed to that one
 * entry of that one type, so validation, titles and problem views are
 * byte-for-byte the incumbent's. A page view too large for a row is stored as
 * `live` and re-projected from its file when listed.
 *
 * BOUNDED. A bounded caller (the batch compile) hands an {@link EntityPageBound}:
 * every page body the collector reads is then read through ONE capped,
 * confined, handle-bound read, never more than one byte past the cap, and
 * whatever that read observes instead of a page (too large, grown, swapped,
 * vanished or unreadable) is refused AFTER the collector returns, because the
 * collector swallows a failed read and would silently drop the page. Without a
 * bound the incumbent reads are untouched.
 *
 * ADMISSION. Typed rows are written only on a project whose scale record
 * carries the `typed-entity-catalog-1` capability (`./typed-admission.ts`).
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { collectEntityPagesWithMessagesFrom } from "../profile/block.js";
import { toEntityPageView, type EntityPageView, type EntityProblemView, type EntityTypeDef, type LoadedProfile } from "../profile/types.js";
import { corrupt } from "../segments/contracts.js";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import type { LegacyLocalEntityScans } from "../storage/legacy-local-reads.js";
import { openConfinedLeaf, readConfirmedBufferOrElse, type ReadLeafOptions } from "../utils/confined-read.js";
import { safeRealpath } from "../utils/path-confine.js";
import { closed, isDirStamp, isFileStamp, type DirStamp, type FileStamp } from "./contracts.js";

/** Largest serialized page view a row holds; a larger one is `live`. */
const MAX_ROW_VIEW_BYTES = 512 * 1024;

/** A stored entity file row. */
export interface EntityFileRowV1 {
  readonly stamp: FileStamp;
  /** The bodiless public view; `null` for an invalid identity; `"live"` when too large to store. */
  readonly page: Omit<EntityPageView, "body"> | null | "live";
  readonly problems: readonly EntityProblemView[];
}

/** A stored entity directory row. */
export interface EntityDirRowV1 {
  readonly dir: DirStamp | null;
  readonly problems: readonly EntityProblemView[];
}

/** The key of an entity file row. */
export function entityKey(type: string, stem: string): string {
  return `e:${type}/${stem}`;
}

/** The key of an entity directory row. */
export function entityDirKey(type: string): string {
  return `e:${type}/`;
}

/** Whether `key` is an entity directory row's key. */
export const isEntityDirKey = (key: string): boolean => key.startsWith("e:") && key.endsWith("/");

/** The type and stem of an entity file key. */
export function parseEntityKey(key: string): { type: string; stem: string } {
  const slash = key.indexOf("/");
  return { type: key.slice(2, slash), stem: key.slice(slash + 1) };
}

/** The declared entity types of a custom profile, in declaration order. */
export function entityTypes(loaded: LoadedProfile): [string, EntityTypeDef][] {
  return Object.entries(loaded.profile.entities) as [string, EntityTypeDef][];
}

/** What a bounded entity read observed instead of a page: too large, or not read safely (grown, swapped, vanished or unreadable). */
export type EntityReadObservation =
  | { readonly kind: "oversize"; readonly entry: string; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly entry: string };

/** A bounded caller's limit on entity page bodies (see the file comment). */
export interface EntityPageBound {
  /** The most bytes one page body may hold. */
  readonly maxBytes: number;
  /** Refuse what a read observed instead of a page; never returns. */
  refuse(observed: EntityReadObservation): never;
  /** Test-only seams of the confined read (a page growing after its read). */
  readonly readOptionsForTest?: ReadLeafOptions;
}

/** Where a bounded read records what it observed before it fails the collector's read. */
interface ObservedSlot { observed?: EntityReadObservation }

/** A bounded read in progress: the canonical root it reads under, its bound and its slot. */
interface BoundedRead { readonly root: string; readonly bound: EntityPageBound; readonly slot: ObservedSlot }

/** Classify a failed bounded read by the entry's current size: a message choice only, since every outcome refuses. */
async function failedReadObservation(entry: string, maxBytes: number): Promise<EntityReadObservation> {
  const size = (await lstat(entry).catch(() => null))?.size;
  return size !== undefined && size > maxBytes ? { kind: "oversize", entry, bytes: size } : { kind: "unreadable", entry };
}

/** Read `entry` whole through one confined handle, at most `maxBytes`; anything but a page is recorded in the slot, then thrown. */
async function boundedEntityText(read: BoundedRead, entry: string): Promise<string> {
  const opened = await openConfinedLeaf(read.root, entry, path.dirname(entry), read.bound.readOptionsForTest);
  // The oversize callback RETURNS its observation: the read helper turns a thrown callback into `unavailable`.
  const result = opened.kind === "confirmed" ? await readConfirmedBufferOrElse(opened, read.bound.maxBytes, (bytes) => ({ kind: "oversize" as const, bytes })) : opened;
  if (result.kind === "ok") return result.body.toString("utf-8");
  read.slot.observed = result.kind === "oversize" ? { kind: "oversize", entry, bytes: result.bytes } : await failedReadObservation(entry, read.bound.maxBytes);
  throw new Error(`entity page ${path.basename(entry)} was not read within its bound`);
}

/** A scan binding showing only `name` (or nothing) of `relDir`, its bodies read through `bounded` when given; every other directory reads as missing. */
function narrowedScans(base: LegacyLocalEntityScans, relDir: string, name: string | null, bounded?: BoundedRead): LegacyLocalEntityScans {
  return {
    openEntityDirectory: async (dir) => {
      if (dir !== relDir) return { status: "missing" };
      const opened = await base.openEntityDirectory(dir);
      if (opened.status !== "ok") return opened;
      const readText = bounded === undefined ? opened.directory.readText : (entry: string) => boundedEntityText(bounded, entry);
      return { status: "ok", directory: { ...opened.directory, readText, listNames: async () => (name === null ? [] : [name]) } };
    },
  };
}

/** The bounded read of one collection under `bound`, rooted at the canonical root (entry locators are canonical paths). */
async function boundedRead(root: string, bound: EntityPageBound | undefined): Promise<BoundedRead | undefined> {
  return bound === undefined ? undefined : { root: (await safeRealpath(root)) ?? root, bound, slot: {} };
}

/** Run the incumbent collector over one entry (or only the directory) of one entity type, its page bodies read under `bound` when given. */
export async function collectOne(root: string, loaded: LoadedProfile, type: string, name: string | null, bound?: EntityPageBound): Promise<{ page: EntityPageView | null; problems: EntityProblemView[] }> {
  const def = loaded.profile.entities[type] as EntityTypeDef;
  const narrowed: LoadedProfile = { ...loaded, profile: { ...loaded.profile, entities: { [type]: def } } };
  const bounded = await boundedRead(root, bound);
  const sources = { scans: narrowedScans(diskLocalEntityScans(root), def.directory, name, bounded), realRoot: () => safeRealpath(root), root };
  const { pages, problems } = await collectEntityPagesWithMessagesFrom(sources, narrowed);
  // Raised only now: the collector swallowed the failed read.
  if (bounded?.slot.observed !== undefined) bounded.bound.refuse(bounded.slot.observed);
  return { page: pages[0] === undefined ? null : toEntityPageView(pages[0], true), problems };
}

/** Project one entity file into its row (its page body read under `bound` when given). */
export async function entityFileRow(root: string, loaded: LoadedProfile, key: string, stamp: FileStamp, bound?: EntityPageBound): Promise<EntityFileRowV1> {
  const { type, stem } = parseEntityKey(key);
  const { page, problems } = await collectOne(root, loaded, type, `${stem}.md`, bound);
  if (page === null) return { stamp, page: null, problems };
  const { body: _body, ...view } = page;
  const stored = Buffer.byteLength(JSON.stringify(view)) > MAX_ROW_VIEW_BYTES ? "live" : view;
  return { stamp, page: stored, problems };
}

/** Project one entity directory into its row. */
export async function entityDirRow(root: string, loaded: LoadedProfile, key: string, dir: DirStamp | null): Promise<EntityDirRowV1> {
  return { dir, problems: (await collectOne(root, loaded, key.slice(2, -1), null)).problems };
}

/** Whether `value` is a plain object. */
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The collector problem kinds a typed catalog row may carry. */
const COLLECTOR_PROBLEM_KINDS: readonly unknown[] = ["invalid-directory", "non-slug-safe-filename", "slug-mismatch", "field-violation"];

/** Whether `value` is a list of collector problem views (closed shape, the four collector kinds). */
function isProblems(value: unknown): value is EntityProblemView[] {
  return Array.isArray(value) && value.every((problem) => closed(problem, ["kind", "entityType", "message"], ["path"])
    && COLLECTOR_PROBLEM_KINDS.includes(problem.kind) && typeof problem.entityType === "string" && typeof problem.message === "string"
    && (problem.path === undefined || typeof problem.path === "string"));
}

/** Whether `value` is the bodiless public view of exactly the file keyed `type`/`stem` (closed shape; any frontmatter). */
function isViewOf(value: unknown, type: string, stem: string): boolean {
  if (!closed(value, ["entityType", "directory", "slug", "id", "path", "frontmatter"], ["title"])) return false;
  const typed = typeof value.directory === "string" && isObject(value.frontmatter) && (value.title === undefined || typeof value.title === "string");
  return typed && value.entityType === type && value.slug === stem && value.id === `${type}/${stem}` && value.path === `${value.directory as string}/${stem}.md`;
}

/** Validate a stored entity file row (closed shape, identity bound to its key). */
export function asEntityFileRow(value: unknown, key: string): EntityFileRowV1 {
  const { type, stem } = parseEntityKey(key);
  const ok = closed(value, ["stamp", "page", "problems"]) && isFileStamp(value.stamp) && isProblems(value.problems)
    && (value.page === null || value.page === "live" || isViewOf(value.page, type, stem));
  if (!ok) corrupt(`catalog entity row ${key.slice(0, 80)} is malformed`);
  return value as unknown as EntityFileRowV1;
}

/** Validate a stored entity directory row (closed shape, a real directory stamp or null). */
export function asEntityDirRow(value: unknown, key: string): EntityDirRowV1 {
  const ok = closed(value, ["dir", "problems"]) && (value.dir === null || isDirStamp(value.dir)) && isProblems(value.problems);
  if (!ok) corrupt(`catalog entity directory row ${key.slice(0, 80)} is malformed`);
  return value as unknown as EntityDirRowV1;
}
