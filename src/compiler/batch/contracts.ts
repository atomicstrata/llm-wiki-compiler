/**
 * @file src/compiler/batch/contracts.ts
 * @description Shared names of the BATCH COMPILE: the bounded-memory,
 * resumable compile body of a `local-indexed` project whose segmented
 * compile state is the authority (`../../cstate/contracts.ts`).
 *
 * A batch compile keeps everything it derives in ONE run store,
 * `.llmwiki/indexed/crun-<runId>`, as rows whose keys reproduce the
 * incumbent compile's orders under a prefix scan, so no phase holds the whole
 * state, a full source list or a full merged-concept list in memory:
 * - `f:<file>` → `{hash, bytes}`: the selected sources and their hashes (the listing);
 * - `d:<seq>` → `{file, detected, scoped, reason?}`: the detected changes, in
 *   incumbent order (the listing, then deletions in compile-state order),
 *   with the status this run acts on (`scoped`); `k:<file>` → `<seq>`;
 * - `a:<seq>` → file, `av:<file>`/`aa:<file>`: the affected-owner closure;
 * - `rs:<slug>`: the reconciliation slugs;
 * - `t:<seq>` → `{file, round}`: the sources to extract, in incumbent order;
 * - `x:<seq>` → the extraction of `t:<seq>`; `xf:<file>` → `<seq>`;
 *   `cx:<slug>\0<seq>\0<idx>`: the CONTRIBUTION index (incumbent merge order);
 * - `fz:<slug>` → `<pos>`: slugs frozen by a failed extraction;
 * - `ap:<slug>`: the affected page slugs; `go:<n>` → slug: the generation
 *   order; `gr:<slug>` → the generation outcome;
 * - `r:<n>` → one report line (paged by `compile --report`).
 * The meta carries the phase, its cursor, the counters and the run identity.
 *
 * The run store is DERIVED state: it is never backed up, and a backup refuses
 * while a run is active. A finished run's store is RETAINED (its report stays
 * readable) until an operator explicitly retires it (`llmwiki catalog runs`,
 * `../../indexed/run-retire.ts`), which removes only finished runs that are not
 * the compile state's last run and carry no restart publication evidence.
 */

/** The prefix of every run store's name. */
export const RUN_STORE_PREFIX = "crun-";
/** Whether `store` is a batch compile run store's name (DERIVED state: never backed up, never restored). */
export const isRunStoreName = (store: string): boolean => /^crun-[0-9a-f]{12}$/.test(store);
/** The default sources (or slugs) per checkpointed batch. */
export const DEFAULT_BATCH_SIZE = 100;
/** The largest batch size a caller may ask for. */
export const MAX_BATCH_SIZE = 10_000;
/** Most owners one page may merge before the run refuses (before any generation). */
export const MAX_PAGE_OWNERS = 2_000;
/** Most source bytes one page may merge before the run refuses (before any generation). */
export const MAX_PAGE_INPUT_BYTES = 8 * 1024 * 1024;
/** Digits of a zero-padded sequence number in a key, so key order is sequence order. */
const SEQ_DIGITS = 12;

/** The phases of a run, in order. A run moves only forward. */
export const BATCH_PHASES = Object.freeze([
  "listing", "detect", "closure", "orphan-deleted", "extract", "freeze", "plan-generation", "generate",
  "plan-state", "orphan-frozen", "seeds", "resolve", "repair", "finalize-state", "residual", "done",
] as const);
export type BatchPhase = (typeof BATCH_PHASES)[number] | "superseded";

/** A sequence number in its key form. */
export const seqText = (seq: number): string => String(seq).padStart(SEQ_DIGITS, "0");
/** A sequenced row key under `prefix`. */
export const seqKey = (prefix: string, seq: number): string => `${prefix}${seqText(seq)}`;
/** The sequence a sequenced key carries after `prefix`. */
export const keySeq = (prefix: string, key: string): number => Number(key.slice(prefix.length, prefix.length + SEQ_DIGITS));
/** The key of a contribution of `slug` by extraction `seq`, concept `idx`. */
export const contributionKey = (slug: string, seq: number, idx: number): string => `cx:${slug}\0${seqText(seq)}\0${String(idx).padStart(6, "0")}`;
/** The prefix of every contribution of `slug`. */
export const contributionsPrefix = (slug: string): string => `cx:${slug}\0`;

/** The extraction and contribution of a contribution key. */
export function parseContributionKey(key: string): { seq: number; idx: number } {
  const parts = key.split("\0");
  return { seq: Number(parts[1]), idx: Number(parts[2]) };
}

/** Why a batch compile refused before any effect, or stopped. */
export type BatchCompileErrorCode =
  | "compile_batch_unsupported_option" | "compile_batch_inputs_changed" | "compile_batch_fanin_exceeded"
  | "compile_batch_run_active" | "compile_batch_run_unknown" | "compile_batch_report_cursor_stale" | "compile_batch_row_too_large"
  | "compile_batch_source_unreadable" | "compile_batch_page_too_large";

/** A batch compile refusal with a stable code. */
export class BatchCompileError extends Error {
  constructor(readonly code: BatchCompileErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BatchCompileError";
  }
}

/** The options a batch compile adds to the incumbent `CompileOptions` (any other incumbent option it does not support is refused before any effect). */
export interface BatchRunOptions {
  /** Sources (or slugs) per checkpointed batch; default {@link DEFAULT_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Supersede the active run and start a new one from the current inputs. */
  readonly restart?: boolean;
}

/** Counters a run keeps across its phases (bounded: numbers only). */
export interface BatchCountersV1 {
  listed: number;
  hashed: number;
  detected: number;
  /** Sources this run leaves unchanged (the result's `skipped`). */
  unchanged: number;
  /** Sources this run removes (the result's `deleted`). */
  deleted: number;
  /** Sources compiled directly (the result's `compiled`, with the affected ones counted in `toExtract`). */
  compiled: number;
  toExtract: number;
  extracted: number;
  reused: number;
  failed: number;
  pagesPlanned: number;
  /** Seed pages committed. */
  seeded: number;
  pagesWritten: number;
  pageErrors: number;
  orphaned: number;
  resolved: number;
  repaired: number;
  sourcesAdvanced: number;
  batches: number;
  /** Report lines written (`r:<n>`). */
  reported: number;
}

/** A zeroed set of counters. */
export function zeroCounters(): BatchCountersV1 {
  return {
    listed: 0, hashed: 0, detected: 0, unchanged: 0, deleted: 0, compiled: 0, toExtract: 0, extracted: 0, reused: 0, failed: 0, pagesPlanned: 0, seeded: 0, pagesWritten: 0,
    pageErrors: 0, orphaned: 0, resolved: 0, repaired: 0, sourcesAdvanced: 0, batches: 0, reported: 0,
  };
}

/** The bounded result of a batch compile: the legacy arrays of `CompileResult` stay EMPTY. */
export interface BatchCompileSummaryV1 {
  readonly runId: string;
  readonly phase: BatchPhase;
  /** Every counter; the per-source and per-page facts are paged with `compile --report <runId>`. */
  readonly counts: BatchCountersV1;
}
