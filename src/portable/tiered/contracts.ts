/**
 * @file src/portable/tiered/contracts.ts
 * @description The negotiated `portable-tiers/2` protocol of slice S4: one
 * keyword search over two tiers of knowledge — raw source chunks and truly
 * reviewed pages — read-only triage of a cleared source, and a promotion that
 * is nothing but an ordinary S2 scoped proposal.
 *
 * TIER IS PROVENANCE, NOT CONFIDENTIALITY. Every hit says which tier it came
 * from and carries that tier's provenance; labels are a separate field and
 * decide, as everywhere, who may receive it.
 *
 * - A RAW hit is bounded source text with a citation: the current source's
 *   original — a retained original named by its current S3 reference, or,
 *   for an ordinary version 1 source with no matching reference, the
 *   authoritative source object itself (`source-object`, identity extraction,
 *   never truncated, and no original history beyond the current object) — the
 *   extraction that produced the text, whether it was truncated, and the exact
 *   UTF-16 and byte span. It is never reviewed.
 * - A REVIEWED hit is a current page whose exact bytes a committed scoped
 *   apply published from a candidate that a verified approval named. A page
 *   path, frontmatter or approval id alone never makes a page reviewed.
 *
 * These are new methods with their own closed outcomes. No version 1, S1, S2
 * or S3 outcome union, operation kind or capability claim is widened.
 */

import type { ContentDigest, LabelSet, ProposalOutcome } from "../contracts.js";
import type { ScopeBoundsV2, ScopedUnsupportedV2 } from "../scoped/contracts.js";

/** The protocol name a client states to reach these methods. */
export const TIERS_PROTOCOL_V2 = "portable-tiers/2";

/** The path prefix of the tier methods on the simulated host. */
export const TIERS_PATH_PREFIX = "/v2t/";

/** Every method of the tiers route: the wire vocabulary a client and a host share. */
export const TIERS_METHODS = [
  "negotiate", "search", "triage", "promote",
  "scoped.coverage", "scoped.candidates.list", "scoped.candidates.get", "scoped.approve", "scoped.apply",
] as const;
export type TiersMethod = (typeof TIERS_METHODS)[number];

/** The capability every store without both tiers refuses by name. */
export const TIERS_CAPABILITY = "tieredSearch";

/** Every host bound the tier methods admit. A request over one is refused whole, never cut short. */
export const TIERS_LIMITS = {
  maxQueryChars: 200,
  maxQueryTerms: 8,
  defaultResults: 20,
  maxResults: 50,
  /** Postings one ENABLED tier may read before it stops and says `truncated`. */
  scanBudgetPerTier: 500,
  /** UTF-16 units of one raw chunk, never splitting a surrogate pair. */
  maxChunkUnits: 2000,
  /** Chunks of one source: covers the 100,000-unit derivative cap with one-unit boundary adjustments. */
  maxChunksPerSource: 51,
  triage: {
    /** The first distinct terms of a source its sampled lexical score compares. */
    sampledTerms: 2000,
    /** Rarest subject terms used to find candidates. */
    selectedTerms: 8,
    /** Postings ALL candidate-finding scans may read together. */
    scanBudget: 500,
    maxCandidates: 64,
    maxSuggestions: 10,
    /** A sampled similarity at or above this is a near duplicate. */
    nearDuplicate: 0.8,
  },
  /** Largest JSON body a tier call may carry. */
  maxRequestBytes: 4 * 1024,
} as const;

/** The two tiers. */
export type TierName = "raw" | "reviewed";

/** The closed refusal codes of the tier methods. */
export const TIERS_REFUSAL_CODES_V2 = ["permission_denied", "capability_unsupported", "limit_exceeded", "invalid_request", "finding_stale"] as const;
export type TiersRefusalCodeV2 = (typeof TIERS_REFUSAL_CODES_V2)[number];

/** A refusal from the tier union. One constant notice on every path. */
export interface TiersRefusedV2 { kind: "refused"; code: TiersRefusalCodeV2; capability?: typeof TIERS_CAPABILITY; notice: string }

/** A subject the caller may not see, or that does not exist: one answer for both. */
export interface TiersNotVisibleV2 { kind: "not_visible"; notice: string }

/** Where a raw chunk's text came from. */
export type RawOriginalV2 =
  | { kind: "retained-original"; digest: ContentDigest; byteCount: number }
  /** An ordinary version 1 source: its own exact, host-verified bytes. No original history beyond the current object. */
  | { kind: "source-object"; digest: ContentDigest; byteCount: number };

/** How the indexed text was produced from the original. */
export interface RawExtractionV2 {
  rule: "utf8-prefix/utf16-units" | "identity";
  /** Digest of the derivative: the source object's bytes. */
  digest: ContentDigest;
  /** UTF-16 units of the derivative. */
  chars: number;
  truncated: boolean;
}

/** The exact place of one chunk: in the derivative's UTF-16 units and in the original's bytes. */
export interface RawSpanV2 {
  utf16: { start: number; end: number };
  /** Byte offsets that are exact in the ORIGINAL: both admitted rules keep the original's bytes as a prefix. */
  bytes: { start: number; end: number };
}

/** A raw hit's citation. */
export interface RawCitationV2 {
  source: string;
  original: RawOriginalV2;
  extraction: RawExtractionV2;
  span: RawSpanV2;
  chunk: { index: number; count: number };
  /** False when the derivative had more text than {@link TIERS_LIMITS.maxChunksPerSource} chunks cover; never silent. */
  completeCoverage: boolean;
}

/** One raw source chunk. */
export interface RawHitV2 {
  tier: "raw";
  statement: "raw source text, not reviewed";
  path: string;
  digest: ContentDigest;
  labels: LabelSet;
  score: number;
  text: string;
  citation: RawCitationV2;
}

/** The scoped publication that makes a page reviewed. */
export interface ReviewProvenanceV2 { applyOperationId: string; approvalId: string; proposalOperationId: string; candidateId: string }

/** One truly reviewed page. */
export interface ReviewedHitV2 {
  tier: "reviewed";
  statement: "compiled, reviewed and approved";
  path: string;
  title: string;
  digest: ContentDigest;
  labels: LabelSet;
  score: number;
  review: ReviewProvenanceV2;
}

/** What one tier's scan did, for an enabled tier only. */
export type TierScanV2 =
  | { enabled: true; budget: number; postingsRead: number; truncated: boolean; availability: "current" | "index_behind" }
  | { enabled: false };

/** A tiered search's answer. */
export interface TieredResultsV2 {
  kind: "results";
  items: readonly (RawHitV2 | ReviewedHitV2)[];
  tiers: { raw: TierScanV2; reviewed: TierScanV2 };
  notice: string;
}

/** A tiered search request. Tiers default to both; each is enabled only by its own read verb. */
export interface TieredSearchRequestV2 { text: string; tiers?: readonly TierName[]; limit?: number }

/** One triage suggestion: a cleared source similar to the subject. */
export interface TriageSuggestionV2 { source: string; digest: ContentDigest; similarity: number; nearDuplicate: boolean }

/** The bounded work a triage did, all of it inside cleared, current partitions. */
export interface TriageWorkV2 {
  selectedTerms: readonly string[];
  termSeeks: number;
  postingsRead: number;
  budget: number;
  /** True when the shared posting budget ended the scan. */
  truncated: boolean;
  /** True when the candidate cap, not the budget, stopped more sources from being compared. */
  candidateCapReached: boolean;
  candidatesCompared: number;
  partitionsOpened: number;
  /** The subject's own bytes, read once (at most the 1 MiB object cap) to count its terms per chunk. Transient. */
  subjectBytesRead: number;
}

/** A read-only triage of one source. It publishes nothing and calls no model. */
export interface TriageResultV2 {
  kind: "triage";
  subject: { source: string; digest: ContentDigest };
  score: "sampled-jaccard/first-2000-distinct-terms";
  suggestions: readonly TriageSuggestionV2[];
  /** Share of the subject's sampled terms found in no other cleared source. */
  novelty: number;
  /** Union of every opened partition, the subject and every compared candidate, returned or not. */
  labels: LabelSet;
  labelBasis: "opened-cleared-partitions+subject+compared";
  work: TriageWorkV2;
  /** The finding a promotion would start from. Not authority: promotion checks it again. */
  finding: { source: string; digest: ContentDigest };
  notice: string;
}

/**
 * A triage the tier could not answer now — its index is behind, or the ledger
 * moved while it ran. Content-free: no subject, digest, label or count.
 */
export interface TriageFencedV2 { kind: "fenced"; availability: "index_behind"; notice: string }

/** Promote one finding: an ordinary S2 scoped proposal over exactly that source. */
export interface PromoteRequestV2 {
  operationId: string;
  finding: { source: string; digest: ContentDigest };
  namespace: string;
  bounds?: ScopeBoundsV2;
}

/** A promotion's outcome: the scoped proposal's own outcome, and whether it compiled the finding's exact bytes. */
export interface PromotedV2 {
  kind: "promoted";
  proposal: ProposalOutcome | ScopedUnsupportedV2;
  /** False when the source changed between the check and the compile: the proposal then names other bytes, said aloud. */
  compiledFindingBytes: boolean;
  notice: string;
}

/** What a store with both tiers declares. */
export interface TieredCapabilitiesV2 {
  tiers: readonly TierName[];
  index: "label-partitioned-postings";
  rawProvenance: { staged: "retained-original via current S3 reference"; version1: "source-object: current object, no original history" };
  reviewedProof: "committed scoped apply + verified approval + exact candidate and page digest";
  custody: "simulated-volatile-fixture";
  limits: typeof TIERS_LIMITS;
}

/** The negotiation answer. */
export interface TiersNegotiatedV2 { kind: "negotiated"; protocol: typeof TIERS_PROTOCOL_V2; capabilities: TieredCapabilitiesV2 }

/** The tier surface of one project session. */
export interface TieredProjectV2 {
  readonly protocol: typeof TIERS_PROTOCOL_V2;
  negotiate(): Promise<TiersNegotiatedV2 | TiersRefusedV2>;
  search(request: TieredSearchRequestV2): Promise<TieredResultsV2 | TiersRefusedV2>;
  triage(request: { source: string }): Promise<TriageResultV2 | TriageFencedV2 | TiersNotVisibleV2 | TiersRefusedV2>;
  promote(request: PromoteRequestV2): Promise<PromotedV2 | TiersRefusedV2>;
}
