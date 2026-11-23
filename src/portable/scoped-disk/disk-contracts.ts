/**
 * @file src/portable/scoped-disk/disk-contracts.ts
 * @description The version 2 names of slice S2b: a scoped proposal over a
 * REGISTERED DIRECTORY that has adopted portable format 2.
 *
 * Beside version 1 and beside slice S2a, never instead of either. No `V1`
 * shape and no S2a name changes meaning: the authority-only store's
 * prefix-namespace protocol keeps its fences, and this surface claims none.
 * A disk scope selects the ONE flat root concept directory, `wiki/concepts/`,
 * by a closed descriptor of its own; lexical context is refused by name.
 *
 * What a directory can honestly depend on is stated in the forms below:
 * full-digest objects, complete-list titles (any page create, retitle or body
 * edit in the directory stales them), and exact projections of the canonical
 * `.llmwiki/state.json` — the selected source entries and the kept-page and
 * modifier decisions — so an unrelated state entry stales nothing.
 */

import type { ACCESS_NOTICE, ApprovalOutcome, CandidateSummary, ContentDigest, LabelSet, ObjectImage, ProposalOutcome, PublicationOutcome } from "../contracts.js";
import type { ApplyRequest, ApproveRequest, CandidateView, LabelledResult, Listed } from "../project/api.js";
import { SCOPED_HOST_CEILINGS, type IncompleteReasonV2, type ScopeBoundsV2, type SourceNamesV2 } from "../scoped/contracts.js";
import type { CoverageOf } from "../scoped/coverage.js";

/** The protocol a caller states to reach the registered-directory scoped methods. Never assumed. */
export const DISK_SCOPED_PROTOCOL_V2 = "portable-scoped-disk/2";

/** The capability this surface needs and names when the project lacks it. */
export const DISK_SCOPED_CAPABILITY = "projectFormat:2";

/** The one page namespace of a registered directory: the flat root concept directory. */
export interface RootConceptsV2 { kind: "root-concepts" }

/** The closed scope of one disk proposal. All of it is in the intent digest. */
export interface DiskCompileScopeV2 {
  sources: SourceNamesV2;
  namespace: RootConceptsV2;
  /** Always `null`: lexical context over a directory is not offered in S2b. */
  context: null;
  bounds: ScopeBoundsV2;
}

/**
 * The disk ceilings. Source, expansion and candidate limits are S2a's; the
 * title, read and dependency ceilings are raised for one reason only: a
 * complete-list title dependency reads and records EVERY concept page, so a
 * bounded working set must still admit a directory of up to 1,000 pages. This
 * is a bounded envelope, not a capacity claim. Every object stays under the
 * store's 1 MiB per-object cap.
 */
export const DISK_SCOPED_CEILINGS = {
  ...SCOPED_HOST_CEILINGS,
  maxTitleEntries: 1000, maxReadBytes: 16 * 1024 * 1024, maxDependencies: 2048,
} as const;

/** Every scope bound at its disk ceiling: the widest scope a caller may declare. */
export const DISK_CEILING_BOUNDS: Readonly<ScopeBoundsV2> = {
  maxSources: DISK_SCOPED_CEILINGS.maxSources, maxExpandedSources: DISK_SCOPED_CEILINGS.maxExpandedSources,
  maxCandidates: DISK_SCOPED_CEILINGS.maxCandidates, maxCandidateBytes: DISK_SCOPED_CEILINGS.maxCandidateBytes,
  maxSourceBytes: DISK_SCOPED_CEILINGS.maxSourceBytes, maxReadBytes: DISK_SCOPED_CEILINGS.maxReadBytes,
  maxTitleEntries: DISK_SCOPED_CEILINGS.maxTitleEntries, maxDependencies: DISK_SCOPED_CEILINGS.maxDependencies,
};

/** A scoped disk proposal request. */
export interface DiskScopedProposeRequestV2 { operationId: string; scope: DiskCompileScopeV2; supersedes?: string }

/** One dependency a disk scoped generation recorded, in the narrowest form sound for what it read. */
export type DiskScopedDependencyV2 =
  /** The bytes (or a protected fact about them) were given to the compile: their digest AND their label binding. */
  | { form: "exact"; path: string; digest: ContentDigest; labels: LabelSet }
  /** The compile looked and found nothing. */
  | { form: "absence"; path: string }
  /** The compile learned only whether the object exists; a present object's labels are bound too. */
  | { form: "existence"; path: string; exists: boolean; labels: LabelSet | null }
  /** Every member of `prefix` with its full content digest: any create, delete or edit there stales it. */
  | { form: "complete-list"; prefix: string; completeListDigest: ContentDigest; entries: number }
  /** One canonical source entry exactly as the compile was given it, or its absence. */
  | { form: "state-entry"; source: string; entryDigest: ContentDigest | "absent" }
  /** The kept-page and prompt-modifier decisions of the canonical state, as used. */
  | { form: "state-decisions"; decisionsDigest: ContentDigest }
  /**
   * The labels of a file whose PROJECTIONS were consumed (the canonical state,
   * its custody): whatever its bytes now, its current binding — exact, else
   * latest — must still be exactly these labels.
   */
  | { form: "labels"; path: string; labels: LabelSet }
  /** The canonical owners of every concept page the closure and the target guard consulted. */
  | { form: "state-owners"; entries: readonly { path: string; owners: readonly string[] }[] };

/** Every semantic input of a disk scoped proposal: validated at persist, approval and apply. */
export interface DiskScopedDependenciesV2 {
  protocol: typeof DISK_SCOPED_PROTOCOL_V2;
  scopeDigest: ContentDigest;
  forms: readonly DiskScopedDependencyV2[];
  /** Each target's pre-image. A created page carries exact absence on its own path. */
  targets: readonly { path: string; pre: ObjectImage }[];
}

/** Why a source is incomplete on disk: S2a's reasons, plus a kept page the compile must not overwrite. */
export type DiskIncompleteReasonV2 = IncompleteReasonV2 | "kept_page";

/** What a disk proposal covered, stated honestly. Only `complete` sources are ever merged into state. */
export type DiskScopedCoverageV2 = CoverageOf<DiskCompileScopeV2, DiskIncompleteReasonV2>;

/** Where one source's canonical state stands. `unknown` is reported, never repaired by spending. */
export type DiskSourceStatusV2 =
  | { kind: "compiled"; hash: string; concepts: readonly string[]; compiledAt: string }
  | { kind: "never_compiled" }
  | { kind: "unknown"; dirty: true };

/** What the disk scoped surface declares. */
export interface DiskScopedCapabilitiesV2 {
  projectFormat: 2;
  namespaces: "root-concepts";
  titles: "complete-list";
  contextIndex: "none";
  stateCustody: "canonical-state-json";
  ceilings: typeof DISK_SCOPED_CEILINGS;
}

/** A disk scoped method refused by name: the project has not adopted format 2. */
export interface DiskScopedUnsupportedV2 {
  kind: "refused"; code: "capability_unsupported"; capability: typeof DISK_SCOPED_CAPABILITY;
  notice: typeof ACCESS_NOTICE;
}

/** The answer to disk scoped negotiation. */
export type DiskScopedNegotiationV2 =
  | { kind: "negotiated"; protocol: typeof DISK_SCOPED_PROTOCOL_V2; capabilities: DiskScopedCapabilitiesV2 }
  | DiskScopedUnsupportedV2;

/** The scoped surface of one registered directory, beside (never instead of) its version 1 `WikiProject`. */
export interface DiskScopedProjectV2 {
  readonly protocol: typeof DISK_SCOPED_PROTOCOL_V2;
  negotiate(): Promise<DiskScopedNegotiationV2>;
  propose(request: DiskScopedProposeRequestV2): Promise<ProposalOutcome | DiskScopedUnsupportedV2>;
  coverage(proposalOperationId: string): Promise<LabelledResult<DiskScopedCoverageV2>>;
  candidates: {
    list(proposalOperationId: string): Promise<Listed<CandidateSummary>>;
    get(proposalOperationId: string, candidateId: string): Promise<LabelledResult<CandidateView>>;
    approve(request: ApproveRequest): Promise<ApprovalOutcome | DiskScopedUnsupportedV2>;
  };
  apply(request: ApplyRequest): Promise<PublicationOutcome | DiskScopedUnsupportedV2>;
  sourceStatus(name: string): Promise<LabelledResult<DiskSourceStatusV2>>;
}
