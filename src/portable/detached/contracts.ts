/**
 * @file src/portable/detached/contracts.ts
 * @description The negotiated `portable-detached/2` protocol of slice S5: a
 * backlog of bounded disk scoped proposals compiled DETACHED and resumable
 * across process boundaries, on a registered directory that has ALREADY
 * adopted portable format 2.
 *
 * Each proposal is an ordinary S2b `proposal.persist` operation with its own
 * id and outcome; nothing here approves, applies or publishes. Model calls
 * are checkpointed units, reused only when their whole identity — the full
 * provider call, the frozen generation profile, and the identity of every
 * input handed to the compile — matches, and only after the unit is imported
 * under current authority into the current holder's custody.
 *
 * These are new methods with their own closed outcomes. No version 1, S1–S4
 * outcome union, operation kind, receipt or registration feature changes.
 */

import type { ContentDigest, ProposalOutcome, PublicationStatus } from "../contracts.js";
import type { DiskCompileScopeV2 } from "../scoped-disk/disk-contracts.js";

/** The protocol name a caller states to reach these methods. */
export const DETACHED_PROTOCOL_V2 = "portable-detached/2";

/** The capability every other backend refuses by name. */
export const DETACHED_CAPABILITY = "detachedCompile";

/** The host ceilings. Fixture options may only lower them. */
export const DETACHED_LIMITS = {
  leaseMs: 60_000,
  pollMs: 20_000,
  capMs: 24 * 60 * 60 * 1000,
  maxBacklogEntries: 1000,
  maxUnitsPerOperation: 512,
  maxPassesPerOperation: 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 256 * 1024,
  maxInputRefs: 4096,
  maxPassBytes: 1024 * 1024,
  maxOwnedBytes: 64 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxUnitBytes: 512 * 1024,
  maxJobBytes: 3 * 1024 * 1024,
  maxPlanBytes: 1024 * 1024,
  maxModifierChars: 128,
  maxModelIdChars: 64,
  maxSystemPolicyChars: 8192,
  maxSummaryBytes: 2 * 1024 * 1024,
} as const;

/** The limits one opened surface runs under. */
export type DetachedLimits = { -readonly [K in keyof typeof DETACHED_LIMITS]: number };

/**
 * Expected custody: which epoch and lease owner a caller claims to be. It
 * selects; it never authorizes. Every step derives the principal afresh and
 * checks this against the identity record under the project gate.
 */
export interface CustodyHandleV2 { operationId: string; epoch: number; owner: string }

/** The closed refusal codes of the detached steps. */
export const DETACHED_REFUSAL_CODES_V2 = [
  "permission_denied", "capability_unsupported", "limit_exceeded", "lease_lost", "custody_unknown",
  "profile_changed", "recovery_blocking", "invalid_request", "not_settled",
] as const;
export type DetachedRefusalCodeV2 = (typeof DETACHED_REFUSAL_CODES_V2)[number];

/** Work ONE replay or collection did: performed, not durable totals. */
export interface PassWorkV2 {
  calls: number;
  hits: number;
  newImports: number;
  alreadyImported: number;
  newIntents: number;
  submits: number;
  adoptions: number;
  closedSkips: number;
  inputRefChecks: number;
  handoffs: number;
  polls: number;
  collected: number;
  discarded: number;
  missesByReason: { profile: number; inputs: number; request: number };
  /** Owned-byte quota checks, and the directory entries their scans stat'ed (journal, jobs and pending reserves). */
  quotaScans: number;
  quotaStats: number;
  /** The most response bytes this pass held at once: read by calls still in flight, or by one collection poll. */
  peakResponseBytes: number;
}

/** The answer of one step. */
export type DetachedStepV2 =
  | { kind: "begun"; handle: CustodyHandleV2; resumed: boolean }
  | { kind: "waiting"; handle: CustodyHandleV2; reason: "pending_units" | "needs_dispatch"; missing: number; pass: PassWorkV2 }
  | { kind: "ready"; handle: CustodyHandleV2; pass: PassWorkV2 }
  /** A generation's own outcome, or the status recorded for an operation that settled earlier: both closed unions. */
  | { kind: "settled"; operationId: string; outcome: ProposalOutcome | PublicationStatus }
  | { kind: "held"; operationId: string; expiresAt: string }
  | { kind: "refused"; operationId: string; code: DetachedRefusalCodeV2; notice: string };

/** Durable unit counts, derived from the operation's own unit records. */
export interface UnitCountsV2 { intent: number; submitted: number; collected: number; discarded: number }

/** A current-authorized status: counts only, never an input path, unit key or prompt metadata. */
export type DetachedStatusV2 =
  | { kind: "status"; operationId: string; outcome: string; lease: { live: boolean; epoch: number }; units: UnitCountsV2; notice: string }
  | { kind: "refused"; operationId: string; code: DetachedRefusalCodeV2; notice: string };

/** The frozen generation profile: everything that shapes a model call besides its inputs. */
export interface GenerationProfileV2 {
  adapter: "simulated-batch/1";
  modelId: string;
  configDigest: ContentDigest;
  promptVersion: string;
  packageVersion: string;
  modifiers: { lang: string | null; sourcesSection: boolean };
  systemPolicyDigest: string | null;
  modifierPairs: readonly string[];
}

/** The receipt-bound provenance record a detached proposal publishes at `proposals/<op>/generation`. */
export interface GenerationRecordV2 {
  kind: "llmwiki-detached-generation";
  version: 2;
  protocol: typeof DETACHED_PROTOCOL_V2;
  profile: GenerationProfileV2;
  profileDigest: ContentDigest;
  epoch: number;
  units: { fresh: number; imported: number };
}

/** One entry of a backlog: an operation id allocated up front, and its bounded scope. */
export interface BacklogEntryV2 { operationId: string; scope: DiskCompileScopeV2 }

/** A persisted backlog plan. */
export interface BacklogPlanV2 { kind: "backlog-plan"; planId: string; entries: readonly BacklogEntryV2[] }

/** One entry's result after a backlog run. */
export interface BacklogEntryResultV2 { operationId: string; result: DetachedStepV2 }
