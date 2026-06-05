/**
 * Types for the computed source-freshness layer (radar P0).
 *
 * Freshness is derived on demand from the filesystem + state.json and is never
 * persisted. `FreshnessSnapshot` is built once per command/viewer snapshot and
 * shared by every consumer (lint, export, MCP, context, viewer).
 */

/** A page's computed freshness on the source-derived axis. */
export type FreshnessStatus = "fresh" | "stale" | "orphaned" | "unverified";

/** The minimal page shape `computeFreshness` needs; each surface adapts to it. */
export interface PageFreshnessInput {
  slug: string;
  pageDirectory: "concepts" | "queries";
  frontmatter: Record<string, unknown>;
}

/** One source's freshness inputs within a snapshot. */
export interface SourceFreshness {
  /** Hash recorded in state.json at last compile. */
  recordedHash: string;
  /** Hash of the source file on disk now, or null when the file is missing. */
  currentHash: string | null;
  /** Whether the source file still exists on disk. */
  exists: boolean;
  /** Concept slugs this source produced (state.json ownership map). */
  concepts: string[];
}

/** Reusable, per-run snapshot of all freshness inputs. */
export interface FreshnessSnapshot {
  stateStatus: "ok" | "missing" | "corrupt";
  /** Source filename -> its freshness inputs (empty unless stateStatus === "ok"). */
  sources: Record<string, SourceFreshness>;
}

/** The three orthogonal signals exposed per page. */
export interface PageFreshness {
  freshnessStatus: FreshnessStatus;
  contradicted: boolean;
  archived: boolean;
}
