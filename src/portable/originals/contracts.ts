/**
 * @file src/portable/originals/contracts.ts
 * @description The version 2 names of slice S3: retained originals, ranged
 * reads and a streamed export, negotiated as `portable-originals/2`.
 *
 * Everything here sits BESIDE version 1, S1 and S2. No `V1` shape, operation
 * kind, refusal code, remote method or cap changes. A staged source still
 * publishes through the authority as a `source.add` — with its own intent
 * payload — and answers with the version 1 publication arms; this protocol's
 * own refusals are values in its own closed union and never reach a version 1
 * client.
 *
 * THE CAPS ARE DISTINCT (alignment §6.2): one page or record stays at 1 MiB;
 * every streamed payload chunk, of ANY object, is at most 64 KiB; one original
 * is at most 64 MiB; staged bytes are bounded in aggregate per project and per
 * host-derived principal. No retained-original aggregate quota exists, and no
 * capacity claim follows from these numbers.
 */

import type { ACCESS_NOTICE, ContentDigest, LabelSet, PublicationOutcome } from "../contracts.js";

/** The protocol a client states to reach these methods. Never assumed. */
export const ORIGINALS_PROTOCOL_V2 = "portable-originals/2";

/** The path prefix of this protocol's isolated route. Version 1 stays under `/v1/`, paged reads under `/v2/`. */
export const ORIGINALS_PATH_PREFIX = "/v2o/";

/** The capability name a store or adapter without this protocol refuses. */
export const ORIGINALS_CAPABILITY = "stagedWrites";

/** The limits of slice S3, each bounding one thing. */
export const ORIGINALS_LIMITS = {
  /** Largest payload of one frame, for every object streamed: pages, sources, references and originals. */
  maxChunkBytes: 64 * 1024,
  /** Largest frame header or control JSON body. */
  maxHeaderBytes: 4 * 1024,
  /** Largest retained original. */
  maxOriginalBytes: 64 * 1024 * 1024,
  /** The bounded text derivative: the existing single-source caps. */
  maxDerivativeChars: 100_000,
  maxDerivativeBytes: 1024 * 1024,
  /** Live staged bytes and handles, reserved from the declared size before any byte is accepted. */
  quota: { projectBytes: 256 * 1024 * 1024, principalBytes: 128 * 1024 * 1024, projectHandles: 16, principalHandles: 8 },
  /** The host's cap on a staged handle's lease. */
  maxHandleTtlMs: 10 * 60 * 1000,
  /** Catalog entries one export seek reads. Internal, not a caller option. */
  exportPageSize: 200,
} as const;

/** This protocol's own closed refusal codes. Separate from version 1's `REFUSAL_CODES` and the paged union. */
export const ORIGINALS_REFUSAL_CODES_V2 = [
  "permission_denied", "policy_changed", "stale_cursor", "limit_exceeded", "capability_unsupported",
  /** One answer for a handle of another project, principal or operation, a missing handle and an expired one. */
  "handle_unavailable",
  /** The inspected prefix of an original is not UTF-8 text, so no derivative can be built. */
  "not_text",
  /** The stage would exceed an aggregate staged quota; refused before any byte is accepted. */
  "quota_exceeded",
] as const;

/** One of this protocol's refusal codes. */
export type OriginalsRefusalCodeV2 = (typeof ORIGINALS_REFUSAL_CODES_V2)[number];

/** A refusal of this protocol. `capability` is present only for `capability_unsupported`. */
export interface OriginalsRefusedV2 {
  kind: "refused";
  code: OriginalsRefusalCodeV2;
  capability?: typeof ORIGINALS_CAPABILITY;
  notice: typeof ACCESS_NOTICE;
}

/** What the store declares when negotiation succeeds. */
export interface OriginalsCapabilitiesV2 {
  stagedWrites: "host-file-cas";
  blobRead: "stream+range";
  export: "cursor-stream";
  custody: "simulated-volatile-host-tempfiles";
  limits: typeof ORIGINALS_LIMITS;
}

/** The answer to negotiation. */
export type OriginalsNegotiationV2 =
  | { kind: "negotiated"; protocol: typeof ORIGINALS_PROTOCOL_V2; capabilities: OriginalsCapabilitiesV2 }
  | OriginalsRefusedV2;

/** A staged handle as its holder sees it. The id is a lookup key the host resolves, never a bearer path. */
export interface StagedHandleV2 {
  kind: "staged";
  handle: string;
  state: "open" | "sealed";
  declaredBytes: number;
  receivedBytes: number;
  expiresAt: string;
  /** Present once sealed: what the HOST computed. */
  digest?: ContentDigest;
}

/** A request to open a stage. Bound to the source.add operation that will reference it. */
export interface StageOpenRequestV2 { operationId: string; declaredBytes: number; ttlMs?: number }

/** A request to publish a sealed stage as a source. */
export interface AddStagedRequestV2 { operationId: string; name: string; handle: string; digest: ContentDigest; supersedes?: string }

/** How the derivative was produced from the original. */
export interface DerivativeDescriptionV2 {
  /** Character counts are UTF-16 code units, as JavaScript strings count them; a surrogate pair is never split. */
  rule: "utf8-prefix/utf16-units";
  limitChars: number;
  chars: number;
  bytes: number;
  /** Bytes of the original the decoder inspected. The rest is NOT certified as UTF-8. */
  inspectedBytes: number;
  truncated: boolean;
  digest: ContentDigest;
}

/** The authoritative reference record of one retained original, published with its derivative. */
export interface OriginalReferenceV2 {
  kind: "llmwiki-original-reference";
  version: 2;
  /** The source path whose current derivative this original produced. */
  sourcePath: string;
  original: { digest: ContentDigest; byteCount: number };
  derivative: DerivativeDescriptionV2;
}

/** What `stat` answers: metadata only. */
export interface OriginalStatV2 {
  kind: "original";
  name: string;
  digest: ContentDigest;
  byteCount: number;
  derivative: DerivativeDescriptionV2;
  labels: LabelSet;
}

/** A staged add's answer: the version 1 publication arms, or this protocol's refusal before any operation began. */
export type AddStagedOutcomeV2 = PublicationOutcome | OriginalsRefusedV2;

/** A frame header of a streamed answer. Every frame carries `bytes` of payload after its header (≤ 64 KiB). */
export type FrameHeaderV2 =
  | { kind: "object"; role: "page" | "source" | "reference" | "original"; path: string; digest: ContentDigest; byteCount: number; labels: LabelSet; bytes: 0 }
  | { kind: "range"; name: string; digest: ContentDigest; byteCount: number; start: number; end: number; bytes: 0 }
  | { kind: "data"; bytes: number }
  | { kind: "completed"; count: number; fence: { catalogRoot: string; labelEpoch: string; policyRevision: number }; bytes: 0 }
  | { kind: "end"; bytes: 0 }
  | { kind: "refused"; code: OriginalsRefusalCodeV2; bytes: 0 };

/** The terminal frame of a stream. A stream without one ended early and claims nothing. */
export type TerminalFrameV2 = Extract<FrameHeaderV2, { kind: "completed" | "end" | "refused" }>;
