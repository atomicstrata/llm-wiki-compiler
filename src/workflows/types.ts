/**
 * @file src/workflows/types.ts
 * @description The durable, core-owned workflow run record type.
 *
 * A {@link WorkflowRun} is the SOURCE OF TRUTH for one workflow run, persisted
 * as a single JSON file under `.llmwiki/workflows/runs/<runId>.json` (a private
 * dir, never emitted into `wiki/` output). This module defines ONLY the record
 * shape and its schema version; the confined CRUD primitives live in
 * `./store.js`. There is intentionally no execution, status-transition, or CLI
 * logic here — those belong to a later task.
 *
 * The record captures enough to detect later DRIFT against the profile it was
 * started from: {@link WorkflowRun.workflowDigest} and
 * {@link WorkflowRun.profileDigest} pin the def/profile identity at start, and
 * {@link WorkflowRun.knownStageIds} records the stage set so a later config
 * change can be classified rather than silently mis-resumed.
 */

/** Lifecycle status of a workflow run (or of one stage within it). */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

/** The set of known statuses, for fail-closed validation of untrusted records. */
export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "pending",
  "running",
  "completed",
  "cancelled",
  "failed",
];

/**
 * The current run-record schema version. Reads fail closed ONLY when a record's
 * version EXCEEDS this (a future record we cannot understand); an OLDER record is
 * forward-migrated on read via `./run-migrate.ts`. NEVER bump this without adding
 * the matching `migrateV<n>ToV<n+1>` step there — the gate + ladder make a bump
 * safe (older migrates, newer fails closed) instead of bricking the fleet.
 *
 * v2 (this version) materially changed the run shape over v1: the remediation added
 * the `integrity` HMAC (tamper-evidence), the advisory `owner`, the `pendingOutput`
 * crash-recovery marker, and deep field validation. A v1 record predates the HMAC,
 * so it arrives UNSIGNED — see {@link RUN_INTEGRITY_MIN_SCHEMA_VERSION}: it migrates
 * to the v2 SHAPE but can NEVER be auto-trusted (auto-signing an unsigned record
 * would reopen the forgery hole). Trust requires a record signed by THIS project's
 * key at v2+; a legacy unsigned run must be explicitly discarded from the run store
 * (`.llmwiki/workflows/runs/`).
 */
export const WORKFLOW_RUN_SCHEMA_VERSION = 2;

/**
 * The first schema version that carries an `integrity` HMAC. A record whose ON-DISK
 * `schemaVersion` is BELOW this is structurally UNSIGNED (it predates tamper-
 * evidence): the reader migrates its shape but surfaces it as `legacy-unsigned`
 * rather than trusting it — NEVER auto-sign a record that arrives without integrity.
 */
export const RUN_INTEGRITY_MIN_SCHEMA_VERSION = 2;

/** Who performed a workflow event. */
export type WorkflowActorKind = "human" | "agent" | "system";

/** The kinds of recorded workflow lifecycle event. */
export type WorkflowEventType =
  | "workflow-start" | "stage-advanced" | "gate-approved" | "stage-output"
  | "run-cancelled" | "run-failed" | "run-resumed" | "workflow-adapted"
  | "events-truncated" | "fields-truncated";

/** One recorded workflow lifecycle event (in-record audit trail). */
export interface WorkflowEvent {
  /** Which kind of lifecycle event this records. */
  type: WorkflowEventType;
  /** ISO-8601 timestamp. */
  at: string;
  /** Who performed the event (human/agent/system). */
  actorKind: WorkflowActorKind;
  /** Optional free-form label identifying the actor (e.g. a username or agent id). */
  actorLabel?: string;
  /** The stage this event concerns, when stage-scoped. */
  stageId?: string;
  /** The gate this event concerns, when gate-scoped. */
  gateId?: string;
  /** The decision recorded (e.g. an approval verdict), when applicable. */
  decision?: string;
  /** Optional human-readable detail about the event. */
  detail?: string;
  /** run.stateVersion immediately before this event. */
  stateVersionBefore: number;
  /** run.stateVersion immediately after this event. */
  stateVersionAfter: number;
}

/**
 * An in-flight stage-output INTENT marker (crash-recovery dedup). Persisted BEFORE
 * a stage-output's external (page/relation/lifecycle) write runs and CLEARED in the
 * same write that records the output. Its presence on a fresh submit means a prior
 * submit crashed mid-apply — the external write MAY have landed un-recorded — so the
 * submit FAILS CLOSED (never silently re-applies). The `opId` is a deterministic
 * `${runId}:${stageId}:${stateVersion}` identifying the in-flight operation.
 */
export interface PendingStageOutput {
  /** The stage whose output is mid-apply. */
  stageId: string;
  /** Deterministic op id of the in-flight external write (for reconciliation). */
  opId: string;
}

/** Per-stage progress status (distinct from the run-level status). */
export type StageStatus = "pending" | "running" | "awaiting-gate" | "completed" | "failed";

/** The set of known stage statuses, for fail-closed validation of untrusted records. */
export const STAGE_STATUSES: readonly StageStatus[] = [
  "pending",
  "running",
  "awaiting-gate",
  "completed",
  "failed",
];

/** One stage's recorded progress within a run. */
export interface StageLogEntry {
  /** The stage id this entry reports on. */
  stageId: string;
  /** The recorded per-stage status (may be `awaiting-gate`, unlike the run status). */
  status: StageStatus;
}

/** A durable, core-owned workflow run record (the source of truth for a run). */
export interface WorkflowRun {
  /** Record schema version; reads fail closed when this exceeds the known version. */
  schemaVersion: 2;
  /** Core-minted, slug-safe, opaque run id (also the filename stem). */
  runId: string;
  /** The id of the workflow this run executes. */
  workflowId: string;
  /** Digest of the workflow def the run was started against (drift detection). */
  workflowDigest: string;
  /** Digest of the whole profile at start time (drift detection). */
  profileDigest: string;
  /** The stage ids known at start (used to classify later config drift). */
  knownStageIds: string[];
  /** Current lifecycle status of the run. */
  status: WorkflowRunStatus;
  /** The stage the run is currently at, or null when none/terminal. */
  currentStage: string | null;
  /** Append-only log of per-stage progress. */
  stageLog: StageLogEntry[];
  /** Append-only, in-record audit trail of lifecycle events (capped per run). */
  events: WorkflowEvent[];
  /** The `<kind>:<id>` gate strings approved so far on this run. */
  satisfiedGates: string[];
  /** Caller-supplied inputs the run was started with. */
  inputs: Record<string, unknown>;
  /**
   * Accumulated outputs produced by the run, keyed by STAGE ID
   * (`outputs[stage.id]`).
   *
   * KNOWN LIMITATION — one output per stage: because the key is the stage id, a
   * stage records a SINGLE output ref and `advance` gates the stage on that one
   * `outputs[stage.id]` being present. A stage that declares MULTIPLE distinct
   * `writes` entity types therefore records only the FIRST submitted output and
   * advances on it — it cannot durably record one ref per declared write. Emitting
   * multiple distinct entity-type writes per stage is a FUTURE enhancement that
   * requires per-write output keying (e.g. `outputs[stage.id][entityType]`); today
   * this is an honest, documented limitation, not a silent surprise.
   */
  outputs: Record<string, unknown>;
  /**
   * An in-flight stage-output intent marker, present ONLY between a stage-output's
   * intent persist and its post-apply record. A non-absent value on a fresh submit
   * signals a prior crashed mid-apply (see {@link PendingStageOutput}).
   */
  pendingOutput?: PendingStageOutput;
  /** Monotonic state version, bumped on each persisted mutation. */
  stateVersion: number;
  /**
   * ADVISORY provenance: the caller identity that STARTED the run (M1), from
   * `LLMWIKI_ACTOR` or the OS username. Best-effort attribution, NOT cryptographic —
   * consistent with the single-machine trust model (the R3 HMAC makes the recorded
   * value tamper-evident). Mutating runId-bearing ops on the action surface refuse a
   * caller whose identity differs from a set `owner`; an OWNER-LESS (legacy) run is
   * unrestricted. Optional for back-compat with pre-M1 records.
   */
  owner?: string;
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /**
   * Per-record tamper-evidence: the hex HMAC-SHA256 of this record (with `integrity`
   * itself omitted) under the per-project `.runkey`. STAMPED by `writeRun`/
   * `writeTerminalRun` and RE-VERIFIED by `readRun` — a missing or mismatched value
   * (a hand-edited / synced / restored / foreign-key record) fails closed. See
   * {@link ../workflows/integrity.ts}.
   */
  integrity?: string;
}
