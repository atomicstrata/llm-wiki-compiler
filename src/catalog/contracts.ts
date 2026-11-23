/**
 * @file src/catalog/contracts.ts
 * @description The durable paged CATALOG of a `local-indexed` project: its
 * row shapes, keys and manifest facts.
 *
 * THE FILES ARE THE TRUTH. Every row is a rebuildable projection of one
 * Markdown file (a page under `wiki/concepts` or `wiki/queries`, a source
 * under `sources/`), stamped with the file's size, nanosecond mtime and inode
 * so a reader can tell, per row, whether the file still matches. The catalog
 * holds no labels, receipts, custody or authorization, and nothing authorizes
 * through it; single-item reads (`getPage`, `getSource`) keep reading the
 * live file.
 *
 * KEYS order by UTF-16 code unit: `p:<dir>/<slug>` for pages (so listings run
 * by directory, then slug), `s:<sourceId>` for sources,
 * `i:<sha256(source identity)>:<sourceId>` for the ingest identity index, and
 * `d:<relDir>` for the stamp of EVERY catalogued directory (the page
 * directories, `sources/` and each nested source directory).
 *
 * FRESHNESS covers DIRECTORY METADATA (created, deleted or renamed entries)
 * plus the stamps of the rows a listing returns; it is not a full content
 * verification of rows a listing does not return. A read stats every catalogued directory (O(directory count), not
 * O(files)) and compares it with its recorded stamp: a created, deleted or
 * renamed file changes its own directory's stamp, nested or not. It reports
 * `stale` or `unverified` explicitly and never scans files to make up for a
 * stale catalog. See `./reads.ts` and `./sync.ts`.
 */

import { createHash } from "node:crypto";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR } from "../utils/constants.js";
import type { PageDirectory } from "../export/types.js";

/** The catalog's segment store name. */
export const CATALOG_STORE = "catalog";

/** The catalog row schema this build writes and reads. */
export const CATALOG_SCHEMA = 1;

/** Page directories in listing order, with their project-relative paths. */
export const PAGE_DIRECTORIES: ReadonlyArray<readonly [PageDirectory, string]> = [["concepts", CONCEPTS_DIR], ["queries", QUERIES_DIR]];

/** The top directories whose stamps the catalog always keeps (recorded as absent when missing). */
export const CATALOGUED_DIRS = [CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR] as const;

/** Uncatalogued paths kept as a sample. */
export const SAMPLE_SIZE = 20;

/** A directory mtime this close to its capture is "unverified": a same-tick change could hide behind it. */
export const RACY_WINDOW_MS = 2_000;

/** The facts that tell whether a file still matches its row. */
export interface FileStamp {
  readonly size: number;
  /** Nanosecond mtime, as a decimal string. */
  readonly mtimeNs: string;
  readonly ino: string;
}

/** A directory's stamp at a reconciliation. */
export interface DirStamp extends FileStamp {
  readonly capturedAtMs: number;
}

/** One page's projection: the `Page` fields without its body, plus the file stamp. */
export interface PageRowV1 {
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly orphaned: boolean;
  readonly archived: boolean;
  readonly stamp: FileStamp;
}

/** One source's projection: the `SourceRecord` fields without its body, plus the file stamp. */
export interface SourceRowV1 {
  readonly title: string;
  readonly source: string;
  readonly sourceType: string;
  readonly ingestedAt?: string;
  readonly stamp: FileStamp;
}

/** Counts kept in the manifest so a count is one manifest read. */
export interface CatalogCounts {
  readonly concepts: number;
  readonly queries: number;
  readonly sources: number;
}

/** The catalog's manifest facts. Directory stamps are rows (`d:`), not facts. */
export interface CatalogMeta {
  readonly schema: typeof CATALOG_SCHEMA;
  /**
   * `building` until the first complete reconciliation commits; `ready` after
   * one; `reconciling` while a later reconciliation's checkpoints are
   * published but it has not finished (rows partly updated, counts not yet
   * recomputed). A rerun of the reconciliation resumes any of them.
   */
  readonly phase: "building" | "ready" | "reconciling";
  readonly counts: CatalogCounts;
  /** Files a reconciliation found but could not catalogue (a link, an over-long name), with a bounded sample. */
  readonly uncatalogued: { readonly count: number; readonly sample: readonly string[] };
  /** Present exactly when the typed entity catalog of a custom profile was built (`./entity-rows.ts`). */
  readonly typed?: TypedCatalogMeta;
}

/** The facts of a typed entity catalog: the profile it was built for, its identity, and its totals. */
export interface TypedCatalogMeta {
  /** The effective custom profile's digest; a different profile makes the typed listing refuse. */
  readonly profileDigest: string;
  /** A random id minted when the typed rows were first built for this profile; entity cursors bind to it. */
  readonly catalogId: string;
  /** Valid entity pages (listed) and collector problems, as of the last completed reconciliation. */
  readonly pages: number;
  readonly problems: number;
  /** The declared directory of every entity type the rows were projected under. */
  readonly directories: Readonly<Record<string, string>>;
}

/** The key of a page row. */
export function pageKey(dir: PageDirectory, slug: string): string {
  return `p:${dir}/${slug}`;
}

/** The key of a directory stamp row. */
export function dirKey(relDir: string): string {
  return `d:${relDir}`;
}

/** The key of a source row. */
export function sourceKey(id: string): string {
  return `s:${id}`;
}

/** The prefix of every identity row of `source`. */
export function identityPrefix(source: string): string {
  return `i:${createHash("sha256").update(source, "utf8").digest("hex")}:`;
}

/** The key of one identity row. */
export function identityKey(source: string, id: string): string {
  return `${identityPrefix(source)}${id}`;
}

/** The page directory and slug of a page key. */
export function parsePageKey(key: string): { dir: PageDirectory; slug: string } {
  const rest = key.slice(2);
  const cut = rest.indexOf("/");
  return { dir: rest.slice(0, cut) as PageDirectory, slug: rest.slice(cut + 1) };
}

/** An empty catalog's facts, before any reconciliation. */
export function emptyCatalogMeta(): CatalogMeta {
  return { schema: CATALOG_SCHEMA, phase: "building", counts: { concepts: 0, queries: 0, sources: 0 }, uncatalogued: { count: 0, sample: [] } };
}

/** Whether `value` is an object with exactly the required keys plus any of the optional ones. */
export function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/** Whether `value` is a well-formed file stamp. */
export function isFileStamp(value: unknown): value is FileStamp {
  return closed(value, ["size", "mtimeNs", "ino"]) && Number.isSafeInteger(value.size) && (value.size as number) >= 0
    && typeof value.mtimeNs === "string" && /^\d{1,30}$/.test(value.mtimeNs) && typeof value.ino === "string" && /^\d{1,30}$/.test(value.ino);
}

/** Whether `value` is a well-formed directory stamp. */
export function isDirStamp(value: unknown): value is DirStamp {
  if (!closed(value, ["size", "mtimeNs", "ino", "capturedAtMs"])) return false;
  const { capturedAtMs, ...stamp } = value;
  return Number.isSafeInteger(capturedAtMs) && (capturedAtMs as number) >= 0 && isFileStamp(stamp);
}
