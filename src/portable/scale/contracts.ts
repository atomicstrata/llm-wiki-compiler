/**
 * @file src/portable/scale/contracts.ts
 * @description The version 2 names of the paged project path (slice S1): the
 * protocol a client must state, the scale capability record, the paged
 * methods' OWN closed refusal union, and the shapes those methods answer with.
 *
 * Everything here sits BESIDE version 1. No `V1` shape, `REFUSAL_CODES`,
 * `REMOTE_METHODS` or `WikiProject` member is changed or extended: a client
 * that speaks only version 1 never sends a cursor and never receives a code
 * from this file. `stale_cursor` exists only in {@link PAGED_REFUSAL_CODES_V2}.
 *
 * A refusal here is a VALUE in the method's outcome, not a thrown version 1
 * refusal, so the two unions can never be confused on the wire.
 */

import type { ACCESS_NOTICE, ContentDigest, PrincipalContext } from "../contracts.js";
import type { ProjectSession } from "../project/api.js";

/** The protocol a client states to reach the paged methods. Never assumed. */
export const SCALE_PROTOCOL_V2 = "portable-scale/2";

/** The constant notice type, shared with version 1. */
type AccessNotice = typeof ACCESS_NOTICE;

/** Why a paged method served nothing. Closed, and separate from version 1's `REFUSAL_CODES`. */
export const PAGED_REFUSAL_CODES_V2 = [
  "stale_cursor", "permission_denied", "capability_unsupported", "limit_exceeded",
] as const;

/** One of the paged methods' own refusal codes. */
export type PagedRefusalCodeV2 = (typeof PAGED_REFUSAL_CODES_V2)[number];

/** The scale capabilities a store may be asked for by name. */
export type ScaleCapabilityName = "listing:cursor" | "keywordIndex" | "protocol:portable-scale/2";

/**
 * What every paged answer says about where it came from. S1 has exactly one
 * real store, and it is a fixture-loaded volatile simulation: never a person's
 * own imported project, never hosted, never durable.
 */
export type ScaleCustodyV2 = "simulated-volatile-fixture" | "v1-compatibility";

/** A paged method's refusal. `capability` is present only for `capability_unsupported`. */
export interface PagedRefusedV2 {
  kind: "refused";
  code: PagedRefusalCodeV2;
  capability?: ScaleCapabilityName;
  notice: AccessNotice;
}

/**
 * What a store can do at scale, declared BESIDE `AdapterCapabilitiesV1`. A
 * version 1 store behind the compatibility adapter declares array listing, no
 * stat and no index: it never claims paging it does not have.
 */
export interface AdapterScaleCapabilitiesV2 {
  listing: "cursor" | "array";
  listFence: "catalog-root" | "none";
  statWithoutRead: "authority-recorded" | "none";
  keywordIndex: "label-partitioned-postings" | "none";
  /** How index labels are kept current for ranking. One project-wide epoch fences every partition. */
  labelEpoch: "project-wide" | "none";
  custody: ScaleCustodyV2;
  limits: {
    defaultPageSize: number; maxPageSize: number; defaultSearchLimit: number; maxSearchLimit: number;
    /** Distinct terms one query may carry. More is refused `limit_exceeded`, never silently dropped. */
    maxQueryTerms: number; scanBudget: number;
  };
}

/** The answer to negotiation: the protocol agreed and what this project's store declares. */
export interface ScaleNegotiationV2 {
  kind: "negotiated";
  protocol: typeof SCALE_PROTOCOL_V2;
  capabilities: AdapterScaleCapabilitiesV2;
}

/** One listed page: catalog metadata only. No body was read to produce it. */
export interface PagedPageEntryV2 { id: string; path: string; title: string; digest: ContentDigest; byteCount: number }

/** One page of a listing. `cursor` is `null` on the last page. */
export interface PagedListingV2 {
  kind: "page";
  items: readonly PagedPageEntryV2[];
  cursor: string | null;
  /** The catalog root this page reflects. A cursor is valid only while it holds. */
  fence: string;
  custody: ScaleCustodyV2;
  notice: AccessNotice;
}

/** A request for one listing page. */
export interface ListPageRequestV2 { cursor?: string; limit?: number }

/** One page opened: the only paged read that touches a body. */
export interface PagedOpenedV2 {
  kind: "opened";
  page: PagedPageEntryV2 & { revision: string; body: string };
  custody: ScaleCustodyV2;
  notice: AccessNotice;
}

/** Absent, unlabelled and uncleared are one answer, as in version 1. */
export interface PagedNotVisibleV2 { kind: "not_visible"; notice: AccessNotice }

/** One search hit, from index postings confirmed against the ledger. No snippet: no body is read. */
export interface PagedSearchHitV2 { id: string; path: string; title: string; digest: ContentDigest; score: number }

/**
 * Bounded keyword search results.
 *
 * `truncated` says the scan budget ended the scan, and nothing else.
 * `availability` is a separate statement: `index_behind` means a partition the
 * caller IS cleared for was not opened because the index has not caught up
 * with the ledger. Neither field, nor any score, depends on an entry the
 * caller cannot see or on one that was dropped at serve time.
 */
export interface PagedSearchResultsV2 {
  kind: "results";
  items: readonly PagedSearchHitV2[];
  truncated: boolean;
  scan: { budget: number; postingsRead: number };
  availability: "current" | "index_behind";
  custody: ScaleCustodyV2;
  notice: AccessNotice;
}

/** A bounded search request. */
export interface SearchPageRequestV2 { text: string; limit?: number }

export type PagedListOutcomeV2 = PagedListingV2 | PagedRefusedV2;
export type PagedOpenOutcomeV2 = PagedOpenedV2 | PagedNotVisibleV2 | PagedRefusedV2;
export type PagedSearchOutcomeV2 = PagedSearchResultsV2 | PagedRefusedV2;
export type ScaleNegotiationOutcomeV2 = ScaleNegotiationV2 | PagedRefusedV2;

/** The paged reads of one project, beside (never instead of) the version 1 `WikiProject`. */
export interface PagedProjectV2 {
  readonly protocol: typeof SCALE_PROTOCOL_V2;
  negotiate(): Promise<ScaleNegotiationOutcomeV2>;
  pages: {
    listPage(request?: ListPageRequestV2): Promise<PagedListOutcomeV2>;
    open(id: string): Promise<PagedOpenOutcomeV2>;
  };
  search(request: SearchPageRequestV2): Promise<PagedSearchOutcomeV2>;
}

/** A session that negotiated the paged protocol: the version 1 session, unchanged, plus `paged`. */
export interface PagedProjectSessionV2 extends ProjectSession {
  readonly principal: PrincipalContext;
  readonly paged: PagedProjectV2;
}
