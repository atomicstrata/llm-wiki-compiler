/**
 * @file src/scale/downgrade-contracts.ts
 * @description The names of an EXPLICIT SCALE-DOWN: the move of a project to
 * a smaller local layout (`local-indexed` → `local-large` | `local-standard`,
 * or `local-large` → `local-standard`) that PRESERVES its current data.
 *
 * Lowering the expected scale never does this (`scale set` keeps a larger
 * active layout); a scale-down is a separate, explicit preview and apply. A
 * scale-down of an indexed project exports every current indexed authority
 * into the incumbent files, verifies them with the incumbent readers, swaps
 * them in (keeping each prior file), moves the indexed stores into a retained
 * archive (run reports stay pageable there), and only then activates the
 * smaller layout. Where the smaller layout cannot represent something, the
 * preview names a typed BLOCKER and the apply refuses; nothing is converted
 * lossily and nothing is deleted.
 *
 * Every location below is under the project's private directory.
 */

/** The bootstrap intent (the scale-down's marker), written before the fence record. */
export const DOWNGRADE_INTENT_FILE = ".llmwiki/scale-downgrade.json";
/** The directory holding every scale-down's retained evidence, one subdirectory per fence revision. */
export const DOWNGRADE_DIR = ".llmwiki/scale-downgrade";

/** The plan's format tag. */
export const DOWNGRADE_PLAN_FORMAT = "llmwiki-scale-downgrade-plan";
/** Longest plan text accepted. */
export const MAX_DOWNGRADE_PLAN_BYTES = 16 * 1024 * 1024;
/** Most workspace operation catalogs one scale-down exports. */
export const MAX_DOWNGRADE_WORKSPACES = 10_000;

/** Why a scale-down was refused. */
export type ScaleDowngradeCode =
  /** The plan is malformed, forged, or for another project. */
  | "scale_downgrade_invalid_plan"
  /** The project changed since the plan; preview again. */
  | "scale_downgrade_stale_plan"
  /** The plan carries blockers, or a blocker appeared. */
  | "scale_downgrade_blocked"
  /** The operator did not assert that no other reader runs, or a live or uncertain reader was found. */
  | "scale_downgrade_readers_live"
  /** The scale-down stopped part-way; every state left is consistent and the same apply resumes it. */
  | "scale_downgrade_partial"
  /** A retained archive, its run or a report cursor is not what its receipt and plan bind. */
  | "scale_downgrade_archive_invalid"
  /** CANCEL: the no-move proof failed (something may have moved, or evidence is unknown); nothing was written. */
  | "scale_downgrade_not_cancellable"
  /** CANCEL: a cancel intent exists but the record is past the cancel revision with no receipt; nothing proves this cancel committed, so nothing was written. */
  | "scale_downgrade_cancel_unproven"
  /** APPLY: this plan was cancelled (its evidence directory holds a cancel intent); it is never applied. */
  | "scale_downgrade_cancelled"
  /** CANCEL: this plan has no scale-down in progress and no cancel receipt. */
  | "scale_downgrade_nothing_to_cancel";

/** A refused or interrupted scale-down. */
export class ScaleDowngradeError extends Error {
  constructor(readonly code: ScaleDowngradeCode, message: string, readonly detail?: Readonly<Record<string, unknown>>) {
    super(`${code}: ${message}`);
    this.name = "ScaleDowngradeError";
  }
}

/** A condition the smaller layout cannot represent (or that must be settled first); the apply refuses. */
export type DowngradeBlockerCode =
  | "target_not_lower"
  | "estimate_plans_higher"
  | "actual_exceeds_target"
  | "transition_pending"
  | "restore_in_progress"
  | "retirement_unfinished"
  | "batch_run_active"
  | "export_too_large"
  | "export_unsupported"
  | "inventory_unbounded"
  /** A known regular file cannot be read whole, so it can be neither measured nor bound. */
  | "content_unreadable"
  /** An unexpected entry under the indexed stores, an unreadable run store, or a pin that cannot be validated. */
  | "indexed_inventory_invalid"
  | "insufficient_space";

/** One blocker, with what was measured. */
export interface DowngradeBlockerV1 {
  readonly code: DowngradeBlockerCode;
  readonly detail: string;
}

/** What the smaller layout serves differently; listed in the plan, nothing behind it is deleted. */
export type DowngradeNoticeCode =
  /** local-large → local-standard changes only the embedding format selection; no data moves. */
  | "selection_only"
  /** The embedding container stays binary; local-standard keeps an existing binary container authoritative. */
  | "embeddings_binary"
  /** Vectors stay float32 exactly as the indexed store held them. */
  | "precision_float32"
  /** Batch run reports move into the archive, pageable there, not through `compile --report`. */
  | "run_reports_archived"
  /** Pins move into the archive with the stores they protect. */
  | "pins_archived"
  /** Indexed-authority backups bind the indexed scale record; restore refuses on the smaller layout. */
  | "indexed_backups_unrestorable"
  /** Derived catalog rows (including typed entity rows) are archived; pages and entities stay files. */
  | "catalog_archived"
  /** Batch compile options need the segmented compile state; compile returns to the whole-state path. */
  | "batch_compile_unavailable";

/** The measured size of the project, from its files, not its estimate. */
export interface DowngradeMeasuredV1 {
  /** Regular files under `sources/` and their bytes: what the planning policy counts. */
  readonly sourceDocuments: number;
  readonly sourceBytes: number;
  /** Regular files under `wiki/` (generated pages, entities, graph files) and their bytes, reported separately. */
  readonly wikiFiles: number;
  readonly wikiBytes: number;
}

/** The content binding of every file a scale-down depends on: count, bytes and one digest over (kind, path, size, SHA-256). */
export interface DowngradeFreezeV1 {
  readonly entries: number;
  readonly bytes: number;
  readonly digest: string;
}

/** One export the scale-down will install, as measured. */
export interface DowngradeUnitV1 {
  readonly kind: "events" | "relations" | "catalog" | "state" | "vectors";
  readonly relPath: string;
  /** The workspace of a catalog unit. */
  readonly workspaceId?: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly records: number;
  /** The events unit only: the digest its last record must carry (the sealed head anchor, unchanged). */
  readonly headDigest?: string | null;
}

/**
 * A durable checkpoint of a scale-down a test may interrupt at (each named
 * step, and `rename:<path>` between a rename of `<path>` and its parents' syncs).
 */
export type DowngradeSeam = "after-intent" | "after-fence" | "after-stage" | "after-install" | "after-archive" | "after-receipt" | "after-activation" | `rename:${string}`
  | "cancel:after-intent" | "cancel:after-record" | "cancel:after-receipt" | "cancel:after-retire" | "apply:after-outer-guard";

/** A seam announcer; absent outside tests. */
export type DowngradeSeamFn = (stage: DowngradeSeam) => Promise<void>;

/** One batch run store moving into the archive, with its status. */
export interface DowngradeRunV1 {
  readonly runId: string;
  readonly status: string;
}
