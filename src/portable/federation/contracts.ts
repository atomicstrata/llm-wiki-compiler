/**
 * @file src/portable/federation/contracts.ts
 * @description The wire contract of slice S6, `portable-federation/2`: two
 * leaf projects with distinct owners and a separate receiver, on ONE local
 * simulated host with catalog/scoped memory stores.
 *
 * A federation is a host-owned manifest of at most eight member projects.
 * Membership grants NOTHING: every shard a call touches is opened with that
 * shard's own current token, supplied by the caller, and decided from that
 * shard's own current control record. Tokens travel only in the request
 * (the receiver's as the bearer, the others in the body); they never enter
 * an operation intent, a record, an audit event, an error or a response.
 *
 * Observable shapes are REDUCED on purpose: search returns merged items and a
 * constant notice; quality returns items only for shards with a cleared
 * sample; links answer one fixed unresolved shape for every failure kind; the
 * queue cursor carries only the last path returned. No per-shard summary,
 * availability, count, cost, epoch or fence is ever returned, so a denied,
 * absent, nonmember, tokenless or admitted-but-empty shard is byte-identical.
 */

import type { ApprovalOutcome, CandidateSummary, ObjectImage, ProposalOutcome, PublicationOutcome } from "../contracts.js";
import type { AccessNotice, ApprovalView, CandidateView, LabelledResult } from "../project/api.js";

/** The negotiated protocol name. */
export const FEDERATION_PROTOCOL_V2 = "portable-federation/2";

/** The capability a host without federation names when it refuses. */
export const FEDERATION_CAPABILITY = "federation";

/** The isolated HTTP route prefix: `/v2f/<receiver>/<method>`. */
export const FEDERATION_PATH_PREFIX = "/v2f/";

/** The host's default ceilings. A fixture may only lower them. */
export const FEDERATION_LIMITS = {
  maxMembers: 8,
  maxChildren: 8,
  maxLinks: 16,
  maxHoldable: 16,
  maxSampled: 8,
  maxHits: 50,
  maxPromptBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxChildBytes: 1024 * 1024,
  maxTotalChildBytes: 2 * 1024 * 1024,
  maxStringBytes: 256,
  maxPathBytes: 512,
  maxTokenChars: 128,
  maxCredentials: 8,
  maxRequestBytes: 8 * 1024,
  maxGroupEntries: 8,
  maxQueuePage: 50,
  /** Catalog entries one quality call may list per shard: two windows' worth, so a wrap fits. */
  qualityScanBudget: 16,
  /** Bytes of one source page a link resolution may read. */
  maxLinkSourceBytes: 256 * 1024,
} as const;

/** The limits a host runs with. */
export type FederationLimits = { -readonly [K in keyof typeof FEDERATION_LIMITS]: number };

/** The closed refusal codes of this protocol. */
export const FEDERATION_REFUSAL_CODES_V2 = [
  "permission_denied", "capability_unsupported", "limit_exceeded", "invalid_request", "compartment_not_holdable", "not_one_level",
] as const;
export type FederationRefusalCodeV2 = (typeof FEDERATION_REFUSAL_CODES_V2)[number];

/** A refusal of this protocol. It never names a shard, a project or a reason. */
export interface FederationRefusedV2 { kind: "refused"; code: FederationRefusalCodeV2; capability?: string; notice: AccessNotice }

/** One shard credential: a project id and that project's own token. */
export interface ShardCredentialV2 { project: string; token: string }

/** What every request names besides its method inputs. The receiver's token is the bearer. */
export interface FederationScopeV2 { federationId: string; shards: readonly ShardCredentialV2[] }

/** A host-owned federation manifest. It grants nothing. */
export interface FederationManifestV2 { federationId: string; revision: number; members: readonly string[] }

/** A receiver's host-owned foreign clearances: compartments it may hold, and which subjects may read them here. */
export interface ForeignClearancesV2 {
  projectId: string;
  revision: number;
  holdable: readonly string[];
  readers: readonly { subject: string; compartments: readonly string[] }[];
}

/** A merged search request. */
export interface FederatedSearchRequestV2 extends FederationScopeV2 { text: string; limit?: number }

/** One merged hit, attributed to the shard as the caller supplied it. */
export interface FederatedHitV2 { shard: string; id: string; path: string; title: string; digest: string; score: number }

/** Merged results: items and the constant notice, nothing else. */
export interface FederatedResultsV2 { kind: "results"; items: readonly FederatedHitV2[]; notice: AccessNotice }

/** Resolve the explicit cross-shard links of one source page. */
export interface LinksRequestV2 extends FederationScopeV2 { source: { shard: string; id: string } }

/** One link's answer. Every failure kind is the same `{resolved: false}`. */
export type LinkAnswerV2 = { link: string; resolved: true; title: string; digest: string } | { link: string; resolved: false };

/** The links of a source page the caller may read. */
export interface LinksResultV2 { kind: "links"; items: readonly LinkAnswerV2[]; notice: AccessNotice }

/** The answer when the source page is not readable: one fixed shape. */
export interface NotVisibleV2 { kind: "not_visible"; notice: AccessNotice }

/** A sampled-quality request. Rotation is host-owned; there is no caller cursor. */
export type QualityRequestV2 = FederationScopeV2;

/** One shard's sample: its window — the first cleared page sampled and how many — and the structure metric. */
export interface QualityItemV2 {
  shard: string;
  window: { from: string; size: number };
  metric: "sampled-structure/v1";
  /** Pages sampled, those with a frontmatter title, and those with at least one inline `^[…]` citation. */
  value: { sampled: number; titled: number; cited: number };
}

/** Items only for shards with at least one cleared sample, and the constant notice. */
export interface QualityResultV2 { kind: "quality"; items: readonly QualityItemV2[]; notice: AccessNotice }

/** One child of an overview: an explicit leaf concept page in a member project. */
export interface OverviewChildV2 { project: string; path: string }

/** Propose an overview of explicit children. */
export interface OverviewProposeRequestV2 extends FederationScopeV2 {
  operationId: string;
  slug: string;
  title: string;
  children: readonly OverviewChildV2[];
}

/** Review requests carry the reader's own credentials. */
export interface OverviewListRequestV2 extends FederationScopeV2 { proposalOperationId: string }
export interface OverviewGetRequestV2 extends OverviewListRequestV2 { candidateId: string }
export interface OverviewApprovalRequestV2 extends FederationScopeV2 { approvalId: string }

/** Approve exactly what was reviewed, with the approver's own child credentials. */
export interface OverviewApproveRequestV2 extends FederationScopeV2 {
  operationId: string;
  proposalOperationId: string;
  candidateSetDigest: string;
  planDigest: string;
  applyDependenciesDigest: string;
  requestedExpiresAt: string;
}

/** Apply one approval, with the applier's own child credentials. */
export interface OverviewApplyRequestV2 extends FederationScopeV2 { operationId: string; approvalId: string }

/** Read one committed overview. */
export interface OverviewReadRequestV2 extends FederationScopeV2 { slug: string }

/** A committed overview as served. */
export interface OverviewPageV2 { path: string; title: string; digest: string; body: string }
export interface OverviewOpenedV2 { kind: "opened"; page: OverviewPageV2; notice: AccessNotice }

/** One page of the recompile queue. The cursor carries only the last path returned. */
export interface QueueRequestV2 { federationId: string; cursor?: string; limit?: number }

/** An overview's state. `custody_unknown` when its mandatory proof is missing or corrupt. */
export type OverviewStateV2 = "current" | "needs_recompile" | "replaced" | "custody_unknown";
export interface QueueItemV2 { path: string; state: OverviewStateV2 }
export interface QueuePageV2 { kind: "queue"; items: readonly QueueItemV2[]; cursor: string | null; notice: AccessNotice }

/** One grouped entry: an ordinary operation on its own shard, with its own preallocated id. */
export type GroupEntryV2 =
  | { kind: "source.add"; project: string; operationId: string; name: string; text: string }
  | { kind: "scoped.apply"; project: string; operationId: string; approvalId: string };

/** A grouped request. There is no group authority, id, transaction or rollback. */
export interface GroupRequestV2 extends FederationScopeV2 { entries: readonly GroupEntryV2[] }

/** One entry's own outcome, or the one shape every unreachable shard gives. */
export type GroupEntryResultV2 = { index: number; outcome: PublicationOutcome } | { index: number; kind: "not_visible" };

/** Per-entry outcomes. `complete` is true only when every entry committed. */
export interface GroupResultV2 { kind: "grouped"; complete: boolean; entries: readonly GroupEntryResultV2[]; notice: AccessNotice }

/** The proposal federation read-set: the dependency record of an overview proposal. */
export interface FederationReadSetV2 {
  protocol: typeof FEDERATION_PROTOCOL_V2;
  federationId: string;
  target: { path: string; pre: ObjectImage };
  /** The receiver target's labels when the proposal was made: the floor it kept. */
  targetFloor: readonly string[];
  children: readonly ObservedChildV2[];
}

/** One child as an actor observed it under their own authority. */
export interface ObservedChildV2 { project: string; path: string; digest: string; labels: readonly string[]; revision: string }

/** The apply observation companion: what the applier observed of every child, bound by the apply receipt. */
export interface FederationObservationV2 {
  protocol: typeof FEDERATION_PROTOCOL_V2;
  federationId: string;
  proposalOperationId: string;
  approvalId: string;
  applyOperationId: string;
  children: readonly ObservedChildV2[];
  observedAt: string;
}

/** The SDK surface of one federation, opened on its receiver. */
export interface FederationSessionV2 {
  readonly protocol: typeof FEDERATION_PROTOCOL_V2;
  search(request: Omit<FederatedSearchRequestV2, keyof FederationScopeV2>): Promise<FederatedResultsV2 | FederationRefusedV2>;
  links(request: Omit<LinksRequestV2, keyof FederationScopeV2>): Promise<LinksResultV2 | NotVisibleV2 | FederationRefusedV2>;
  quality(): Promise<QualityResultV2 | FederationRefusedV2>;
  overview: {
    propose(request: Omit<OverviewProposeRequestV2, keyof FederationScopeV2>): Promise<ProposalOutcome | FederationRefusedV2>;
    list(proposalOperationId: string): Promise<{ items: readonly CandidateSummary[]; notice: AccessNotice } | FederationRefusedV2>;
    get(proposalOperationId: string, candidateId: string): Promise<LabelledResult<CandidateView> | FederationRefusedV2>;
    approve(request: Omit<OverviewApproveRequestV2, keyof FederationScopeV2>): Promise<ApprovalOutcome | FederationRefusedV2>;
    approval(approvalId: string): Promise<LabelledResult<ApprovalView> | FederationRefusedV2>;
    apply(request: Omit<OverviewApplyRequestV2, keyof FederationScopeV2>): Promise<PublicationOutcome | FederationRefusedV2>;
    read(slug: string): Promise<OverviewOpenedV2 | NotVisibleV2 | FederationRefusedV2>;
  };
  queue(request?: { cursor?: string; limit?: number }): Promise<QueuePageV2 | FederationRefusedV2>;
  group(entries: readonly GroupEntryV2[]): Promise<GroupResultV2 | FederationRefusedV2>;
}
