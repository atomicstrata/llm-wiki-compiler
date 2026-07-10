/**
 * Shared interfaces for the compilation pipeline modules.
 *
 * These types are referenced by the orchestration spine (`index.ts`) and by
 * the extracted leaf modules (`extraction-merge`, `review-pipeline`,
 * `seed-pages`, `compile-report`). They live here, rather than in any single
 * module, so the modules can depend on the shapes without importing each other
 * — keeping the dependency graph acyclic.
 */

import type { CompilePageWrite } from "./compile-write.js";
import type {
  ExtractedConcept,
  ReviewedCandidateRef,
  SourceChange,
  SourceState,
} from "../utils/types.js";

/** Per-source state snapshots keyed by source filename. */
export type SourceStateMap = Record<string, SourceState>;

/** A concept with all contributing sources merged for generation. */
export interface MergedConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
}

/** Buckets of source changes used by the compile pipeline. */
export interface ChangeBuckets {
  toCompile: SourceChange[];
  deleted: SourceChange[];
  unchanged: SourceChange[];
}

/** Result of phase 2: page writes plus any errors collected along the way. */
export interface PageGenerationResult {
  /** All merged concepts generated this run, including held candidates. */
  pages: MergedConcept[];
  /** Concept pages actually written into wiki/concepts this run. */
  writtenPages: MergedConcept[];
  errors: string[];
  /** Candidate ids written by --review or review policy. Empty otherwise. */
  candidates: string[];
  /** Structured split of candidates created this run. */
  review: {
    held: ReviewedCandidateRef[];
    forced: ReviewedCandidateRef[];
  };
  /**
   * Slugs of seed pages written this run (overview / comparison / entity).
   * Concept pages live on `pages`; seed pages don't fit MergedConcept's
   * source-list shape, so they're tracked separately here. summarizeCompile
   * concatenates these into CompileResult.pages so downstream consumers
   * (MCP, embeddings, programmatic callers) see seed-page changes too.
   */
  seedSlugs: string[];
}

/** Outcome of generating a single merged concept page. */
export interface MergedPageOutcome {
  error?: string;
  /**
   * A valid live page to write, deferred to the batched executor apply in
   * {@link generatePagesPhase}. Set ONLY on the live-write branch; the two
   * candidate branches leave it unset (they persist a candidate JSON instead).
   */
  liveWrite?: CompilePageWrite;
  candidate?: {
    mode: "held" | "forced";
    id: string;
    ref: ReviewedCandidateRef;
  };
}
