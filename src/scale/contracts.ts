/**
 * @file src/scale/contracts.ts
 * @description The names of a project's EXPECTED SCALE: what a person said the
 * wiki will grow to, the local architecture that estimate plans for, and the
 * persisted record of the request, the active architecture and any unfinished
 * or blocked transition.
 *
 * AN EXPECTED SCALE IS INTENT, NOT VERIFIED CAPACITY. Every threshold here is a
 * PLANNING POLICY derived from the code's own hard format limits (the 64 MiB
 * JSON embedding store, the 512 MiB / 100,000-entry binary container, the
 * 64 MiB single-file relation and event stores) under the stated assumptions
 * ({@link AVERAGE_DOCUMENT_BYTES}, {@link EMBEDDING_ENTRIES_PER_DOCUMENT}). No
 * threshold qualifies a corpus size, and none supports a gigabyte- or
 * terabyte-scale claim.
 *
 * BOTH ARCHITECTURES ARE LOCAL. `local-standard` is today's behaviour, byte for
 * byte. `local-large` is the same machine and files with the embedding store
 * eagerly converted to the existing binary container and that format selected
 * for every later write. Neither starts a daemon, container, cloud resource,
 * provider call or background service, and neither is an indexed or
 * out-of-core store. An estimate beyond the local envelope plans
 * `unavailable`: it is recorded and blocks dependent work, and is never active.
 */

/** The project-relative location of the scale record. */
export const SCALE_RECORD_FILE = ".llmwiki/scale.json";

/** The only record version this build reads or writes. */
export const SCALE_RECORD_VERSION = 1;

/** A record larger than this is unreadable; a valid one is well under 2 KiB. */
export const MAX_SCALE_RECORD_BYTES = 16 * 1024;

/** Longest step detail kept in the record. */
export const MAX_STEP_DETAIL_CHARS = 512;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Assumption: the average source size used to derive a document count from bytes alone. */
export const AVERAGE_DOCUMENT_BYTES = 64 * 1024;
/** Assumption: embedding entries (pages plus chunks) one document yields. */
export const EMBEDDING_ENTRIES_PER_DOCUMENT = 10;
/** Assumption: bytes one embedding entry may need (3,072 float32 dimensions plus metadata). */
export const BYTES_PER_EMBEDDING_ENTRY = 16 * 1024;
/** Fixed headroom the disk preflight always adds on top of its full estimate. */
export const PREFLIGHT_HEADROOM_BYTES = GIB;

/**
 * Planning policy: at most this many documents plan `local-standard`. Under
 * the assumptions above, 400 documents need 400 x 10 x 16 KiB = 62.5 MiB of
 * embeddings, inside the 64 MiB JSON store (`MAX_EMBEDDING_STORE_BYTES`).
 */
export const STANDARD_MAX_DOCUMENTS = 400;
/**
 * Planning policy: the local envelope's document bound for `local-large`.
 * 3,000 documents need 30,000 entries and 3,000 x 10 x 16 KiB = 468.75 MiB,
 * inside the binary container's 100,000 entries and 512 MiB
 * (`MAX_EMBEDDING_ENTRIES`, `MAX_BINARY_STORE_BYTES`).
 */
export const LOCAL_MAX_DOCUMENTS = 3_000;
/** Planning policy: source bytes for `local-standard`, the same documents at the average size (25 MiB). */
export const STANDARD_MAX_BYTES = STANDARD_MAX_DOCUMENTS * AVERAGE_DOCUMENT_BYTES;
/** Planning policy: source bytes for the local envelope, the same documents at the average size (187.5 MiB). */
export const LOCAL_MAX_BYTES = LOCAL_MAX_DOCUMENTS * AVERAGE_DOCUMENT_BYTES;

/** An architecture this build can make active, on the current machine only. */
export type LocalArchitecture = "local-standard" | "local-large";

/** What an estimate plans: a local architecture, or one this build cannot provide. */
export type PlannedArchitecture = LocalArchitecture | "unavailable";

/** Which local-envelope bound an unavailable estimate exceeds. */
export type EnvelopeBound = "documents" | "bytes";

/** Backends an estimate beyond the local envelope would need. None exists in this build. */
export const MISSING_BACKENDS = Object.freeze([
  "segmented-relation-store",
  "segmented-event-store",
  "sharded-vector-store",
  "durable-paged-catalog",
  "durable-hosted-backend",
] as const);

/** One backend this build does not provide. */
export type MissingBackend = (typeof MISSING_BACKENDS)[number];

/** The ordered preparation steps of a `local-large` transition. */
export const PREPARATION_STEPS = Object.freeze(["capacity-preflight", "embedding-container"] as const);

/** One preparation step's name. */
export type PreparationStepName = (typeof PREPARATION_STEPS)[number];

/** A step's last recorded progress. Resume re-verifies every step whatever this says. */
export type StepStatus = "pending" | "done" | "parked";

/** One step's persisted progress. */
export interface StepRecordV1 {
  readonly name: PreparationStepName;
  readonly status: StepStatus;
  /** What the step found or why it parked; bounded by {@link MAX_STEP_DETAIL_CHARS}. */
  readonly detail?: string;
}

/** A person's estimate, as validated input: at least one of the two. */
export interface ScaleRequest {
  /** Expected total source bytes; a positive safe integer, derived from documents when absent. */
  readonly sizeBytes?: number;
  /** Expected document count; a positive safe integer, derived from bytes when absent. */
  readonly documents?: number;
}

/** Whether a recorded figure was stated by the person or derived from the other at the documented average. */
export type EstimateBasis = "stated" | "derived";

/** The estimate as recorded, with where each figure came from. At least one is stated. */
export interface RequestedScaleV1 {
  readonly sizeBytes: number;
  readonly documents: number;
  readonly sizeBasis: EstimateBasis;
  readonly documentsBasis: EstimateBasis;
}

/** The architecture currently serving the project. Only ever a local one. */
export interface ActiveArchitectureV1 {
  readonly architecture: LocalArchitecture;
  /** The revision whose request activated it. */
  readonly sinceRevision: number;
}

/** An unfinished local transition toward `local-large`. */
export interface PreparePendingV1 {
  readonly kind: "prepare";
  readonly revision: number;
  readonly target: "local-large";
  readonly steps: readonly StepRecordV1[];
}

/** A recorded estimate this build cannot serve: dependent work blocks until it is lowered. */
export interface UnavailablePendingV1 {
  readonly kind: "unavailable";
  readonly revision: number;
  readonly exceeds: readonly EnvelopeBound[];
  readonly missing: readonly MissingBackend[];
}

/** The persisted record at {@link SCALE_RECORD_FILE}. */
export interface ScaleRecordV1 {
  readonly version: 1;
  /** Moves by one on every accepted request; the compare-and-swap token. */
  readonly revision: number;
  readonly requested: RequestedScaleV1;
  readonly active: ActiveArchitectureV1;
  /** `null` exactly when the project is ready for dependent work. */
  readonly pending: PreparePendingV1 | UnavailablePendingV1 | null;
}

/** The plan for one estimate. Pure: computed, never persisted as such. */
export interface ScalePlan {
  readonly requested: RequestedScaleV1;
  readonly architecture: PlannedArchitecture;
  /** Non-empty exactly when `architecture` is `unavailable`. */
  readonly exceeds: readonly EnvelopeBound[];
}

/** Why a scale request was refused without changing anything. */
export type ScaleRefusalCode =
  | "scale_invalid_request"
  | "scale_revision_conflict"
  | "scale_state_unreadable"
  /** A version 2 record replacement failed AFTER its rename (durability unconfirmed); read `scale status` before retrying. */
  | "scale_outcome_unknown"
  /** An explicit scale-down is in progress; only resuming that scale-down may change the record. */
  | "scale_downgrade_pending";

/** A refused scale request or prepare: nothing was written. */
export class ScaleRefusalError extends Error {
  constructor(readonly code: ScaleRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScaleRefusalError";
  }
}

/** The one sentence every scale report carries. */
export const SCALE_NOTICE =
  "Expected scale is a planning target, not verified capacity; both architectures run on this machine only.";
