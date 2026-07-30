/**
 * Resolver for `llmwiki refresh --stale`. Computes a RefreshPlan from a single
 * read-only freshness snapshot — page-level ownership drives the action sets, so
 * status is repaired without re-implementing any compile logic. Read-only and
 * LLM-free (it reads + hashes sources, but never writes); never calls
 * detectChanges (avoids the double-hash regression) and never uses readState
 * (which writes .bak on corrupt state).
 */

import { readdir } from "fs/promises";
import path from "path";
import { readStateClassified } from "../utils/state.js";
import { buildFreshnessSnapshot } from "../freshness/index.js";
import { findAffectedSources } from "./deps.js";
import { scanWikiPages } from "./indexgen.js";
import { CONCEPTS_DIR, SOURCES_DIR } from "../utils/constants.js";
import type { SourceChange, WikiState } from "../utils/types.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import type { StateStatus } from "../utils/state.js";

export interface RefreshPlan {
  /** Stale pages and partial-deletion pages rebuilt from live owners. */
  recompiledPages: string[];
  /** @deprecated Shared pages are rebuilt; retained as an empty compatibility field. */
  sharedKeptPages: string[];
  /** Pages whose owners are ALL deleted — recomputed as orphaned. Disjoint. */
  computedOrphanedPages: string[];
  /** Frontmatter-orphaned pages with no tracked owner — already orphaned, no action. Disjoint. */
  alreadyOrphanedPages: string[];
  /** Live owner files whose hash drifted — the changed sources to recompile. */
  changedOwners: string[];
  /** Owner files no longer on disk — the deleted sources to process. */
  deletedOwners: string[];
  /**
   * Unchanged co-contributors pulled in because they share a concept with a
   * selected owner (from current state, NOT the owners themselves). The real
   * compile run may surface more affected sources post-extraction.
   */
  knownAffected: string[];
  /** Sources on disk but not in state (new) — skipped by refresh; distinct from the outcome lists. */
  newSkipped: string[];
  /** Keep a detected change only if its file is a selected owner (changed or deleted). */
  changeFilter: (change: SourceChange) => boolean;
}

/**
 * Classified outcome of reading .llmwiki/state.json for a refresh run.
 * A non-"ok" status (missing/corrupt/too-new) yields a null plan: refresh is
 * skipped, so a too-new project is never silently treated as compilable.
 */
export type RefreshStateStatus = StateStatus;

export interface RefreshResolution {
  stateStatus: RefreshStateStatus;
  /** null unless stateStatus === "ok" */
  plan: RefreshPlan | null;
}

interface Owner {
  file: string;
  exists: boolean;
  changed: boolean;
}

/** Owners of a slug derived directly from the snapshot's per-source concept lists. */
function ownersOf(slug: string, snapshot: FreshnessSnapshot): Owner[] {
  return Object.entries(snapshot.sources)
    .filter(([, s]) => s.concepts.includes(slug))
    .map(([file, s]) => ({
      file,
      exists: s.exists,
      changed: s.exists && s.currentHash !== s.recordedHash,
    }));
}

interface PageClassification {
  recompiledPages: string[];
  sharedKeptPages: string[];
  computedOrphanedPages: string[];
  alreadyOrphanedPages: string[];
  changedOwners: Set<string>;
  deletedOwners: Set<string>;
}

/** Sort each page into exactly one outcome list and collect its actionable owners. */
function classifyPages(
  pages: { slug: string; meta: Record<string, unknown> }[],
  snapshot: FreshnessSnapshot,
): PageClassification {
  const c: PageClassification = {
    recompiledPages: [],
    sharedKeptPages: [],
    computedOrphanedPages: [],
    alreadyOrphanedPages: [],
    changedOwners: new Set(),
    deletedOwners: new Set(),
  };
  for (const { slug, meta } of pages) {
    classifyOnePage(slug, meta, snapshot, c);
  }
  return c;
}

/** Classify a single page into the classification object (mutates c). */
function classifyOnePage(
  slug: string,
  meta: Record<string, unknown>,
  snapshot: FreshnessSnapshot,
  c: PageClassification,
): void {
  const owners = ownersOf(slug, snapshot);
  if (owners.length === 0) {
    if (meta.orphaned === true) c.alreadyOrphanedPages.push(slug);
    // else: page not tracked in state (e.g. hand-written) — not refresh's concern.
    return;
  }
  const deleted = owners.filter((o) => !o.exists);
  const live = owners.filter((o) => o.exists);
  const changedLive = live.filter((o) => o.changed);

  if (live.length === 0) {
    c.computedOrphanedPages.push(slug);
    deleted.forEach((o) => c.deletedOwners.add(o.file));
  } else if (changedLive.length > 0) {
    c.recompiledPages.push(slug);
    changedLive.forEach((o) => c.changedOwners.add(o.file));
    deleted.forEach((o) => c.deletedOwners.add(o.file));
  } else if (deleted.length > 0) {
    c.recompiledPages.push(slug);
    deleted.forEach((o) => c.deletedOwners.add(o.file));
  }
  // else: all live and fresh — no action needed
}

/** Deterministic output: every plan array is sorted so dry-run/CLI output is stable. */
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/**
 * Resolve the stale-refresh plan from a read-only freshness snapshot.
 * Returns stateStatus and a RefreshPlan (null when state is missing or corrupt).
 * @param root - Absolute path to the llmwiki project root.
 */
export async function resolveStaleRefresh(root: string): Promise<RefreshResolution> {
  const classified = await readStateClassified(root);
  if (classified.status !== "ok") {
    return { stateStatus: classified.status, plan: null };
  }

  const snapshot = await buildFreshnessSnapshot(root, classified);
  const state = classified.state;
  const pages = await scanWikiPages(path.join(root, CONCEPTS_DIR));
  const c = classifyPages(pages, snapshot);

  return {
    stateStatus: "ok",
    plan: {
      recompiledPages: sorted(c.recompiledPages),
      sharedKeptPages: sorted(c.sharedKeptPages),
      computedOrphanedPages: sorted(c.computedOrphanedPages),
      alreadyOrphanedPages: sorted(c.alreadyOrphanedPages),
      changedOwners: sorted(c.changedOwners),
      deletedOwners: sorted(c.deletedOwners),
      knownAffected: sorted(knownAffectedFor(state, c.changedOwners, c.deletedOwners)),
      newSkipped: sorted(await listNewSkipped(root, state)),
      changeFilter: makeChangeFilter(c.changedOwners, c.deletedOwners),
    },
  };
}

/**
 * Affected co-contributors for the same seed the real compile run will use
 * (changed owners as "changed", deleted owners as "deleted").
 * Mirrors the seed construction in the actual refresh command so knownAffected
 * stays in sync with what the compiler would process.
 */
function knownAffectedFor(
  state: WikiState,
  changed: Set<string>,
  deleted: Set<string>,
): string[] {
  const seed: SourceChange[] = [
    ...[...changed].map((file) => ({ file, status: "changed" as const })),
    ...[...deleted].map((file) => ({ file, status: "deleted" as const })),
  ];
  return findAffectedSources(state, seed);
}

/**
 * Source files present on disk that are not tracked in state (new sources).
 * These are skipped by refresh — the full compile run handles new sources.
 * No hashing performed; presence on disk is sufficient.
 */
async function listNewSkipped(root: string, state: WikiState): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(path.join(root, SOURCES_DIR))).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files.filter((f) => !(f in state.sources));
}

/**
 * Build a filter that keeps only SourceChanges whose file is a selected owner
 * (changed or deleted). Used to narrow the full detected-changes list to just
 * the stale owners so the refresh command skips unchanged and new sources.
 */
function makeChangeFilter(
  changed: Set<string>,
  deleted: Set<string>,
): (c: SourceChange) => boolean {
  const ownerSet = new Set<string>([...changed, ...deleted]);
  return (c) => ownerSet.has(c.file);
}
