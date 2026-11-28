/**
 * @file src/portable/scoped/contracts.ts
 * @description The version 2 names of slice S2a: a scoped proposal that reads
 * a declared, bounded part of a project and depends on exactly that part.
 *
 * Everything here sits BESIDE version 1. No `V1` shape, closed union or
 * `WikiProject` member is changed. A scoped write returns the existing V1
 * outcome arms with existing refusal codes only, so a version 1 client that
 * reads a scoped operation's status never meets a code it does not know. The
 * records a scoped proposal stores are new records at new paths; the V1
 * read-set record is never written for one, so no V1 reader can adopt it.
 *
 * S2a runs on the volatile, authority-only store only. A store without
 * authority-maintained scope fences refuses the protocol by name.
 */

import type {
  ACCESS_NOTICE, ApprovalOutcome, CandidateSummary, ContentDigest, LabelSet, ObjectImage, ProposalOutcome, PublicationOutcome,
} from "../contracts.js";
import type { ApplyRequest, ApproveRequest, CandidateView, LabelledResult, Listed } from "../project/api.js";

/** The protocol a caller states to reach the scoped methods. Never assumed. */
export const SCOPED_PROTOCOL_V2 = "portable-scoped/2";

/** The one capability S2a needs and names when it is missing. */
export const SCOPE_FENCES_CAPABILITY = "scopeFences:authority-maintained";

/** What a scoped answer says about where it came from. */
export type ScopedCustodyV2 = "simulated-volatile-fixture";

/** A declared page namespace: the managed logical prefix `wiki/concepts/<name>/`. Membership is by path alone. */
export interface ConceptNamespaceV2 { kind: "concept-namespace"; name: string }

/** The sources a scoped proposal compiles: an explicit, closed list of names under `sources/`. */
export interface SourceNamesV2 { kind: "source-names"; names: readonly string[] }

/** An explicit opt-in to bounded keyword context from the selected namespace. */
export interface LexicalContextV2 { query: string; k: number; scanBudget: number }

/**
 * The bounds a proposal declares. Each is capped by {@link SCOPED_HOST_CEILINGS},
 * and each is enforced where the work happens, so nothing is first collected
 * whole and then cut:
 *
 * - `maxSourceBytes`: the AGGREGATE bytes of every source the generation reads
 *   (named and expanded together), not a per-source cap;
 * - `maxReadBytes`: the aggregate bytes of EVERY object handed to or retained
 *   by the generation — sources, state records, configuration and schema, the
 *   target pages it reads, context pages. It bounds the working set it holds;
 * - `maxTitleEntries`: the namespace members a title projection may carry,
 *   checked from the recorded count before the model runs;
 * - `maxCandidates` and `maxCandidateBytes`: the candidates kept and the sum of
 *   their bodies; over either, the excess is skipped and its sources stay incomplete;
 * - `maxDependencies`: recorded dependency entries plus targets.
 */
export interface ScopeBoundsV2 {
  maxSources: number;
  /** Sources outside the named set admitted because they share a concept; the rest become the frontier. */
  maxExpandedSources: number;
  maxCandidates: number;
  maxCandidateBytes: number;
  maxSourceBytes: number;
  maxReadBytes: number;
  maxTitleEntries: number;
  maxDependencies: number;
}

/** The closed scope of one proposal. All of it is in the intent digest. */
export interface CompileScopeV2 {
  sources: SourceNamesV2;
  namespace: ConceptNamespaceV2;
  context: LexicalContextV2 | null;
  bounds: ScopeBoundsV2;
}

/** The host's ceilings. A declared bound above one is refused `limit_exceeded` before anything runs. */
export const SCOPED_HOST_CEILINGS = {
  maxSources: 16, maxExpandedSources: 8, maxCandidates: 16, maxCandidateBytes: 1024 * 1024,
  maxSourceBytes: 1024 * 1024, maxReadBytes: 4 * 1024 * 1024, maxTitleEntries: 256, maxDependencies: 256,
  maxContextK: 8, maxContextScanBudget: 500, maxContextTerms: 8,
  /** Co-owners beyond the admitted expansion that may be REPORTED as a frontier; more refuses before the model runs. */
  maxFrontier: 16,
} as const;

/** A scoped proposal request. */
export interface ScopedProposeRequestV2 { operationId: string; scope: CompileScopeV2; supersedes?: string }

/** One dependency a scoped generation recorded, in the narrowest form that is sound for what it read. */
export type ScopedDependencyV2 =
  /** The bytes (or a protected fact about them) were given to the compile: their digest AND their label binding. */
  | { form: "exact"; path: string; digest: ContentDigest; labels: LabelSet }
  /** The compile looked and found nothing. */
  | { form: "absence"; path: string }
  /** The compile learned only whether the object exists, never its bytes; a present object's labels are bound too. */
  | { form: "existence"; path: string; exists: boolean; labels: LabelSet | null }
  /** The compile was given the namespace's titles and nothing else from its pages. */
  | { form: "title-projection"; namespace: string; titleFence: string; titlesDigest: ContentDigest }
  /**
   * The shared-concept closure and the target guard were decided from these
   * authoritative owner lists: exactly the concept pages they consulted.
   */
  | { form: "owners"; namespace: string; entries: readonly { path: string; owners: readonly string[] }[] }
  /** Conservative retrieval: the result set plus the namespace's member fence. Any member change stales it. */
  | {
    form: "retrieval"; namespace: string; index: { name: string; root: string; labelEpoch: string };
    query: string; k: number; scanBudget: number; results: readonly { path: string; digest: ContentDigest }[];
    truncated: boolean; availability: "current" | "index_behind"; memberFence: string;
  };

/** Every semantic input of a scoped proposal: what is validated at persist, approval and apply. */
export interface ScopedDependenciesV2 {
  protocol: typeof SCOPED_PROTOCOL_V2;
  scopeDigest: ContentDigest;
  /** The one namespace the proposal read from and writes into. */
  namespace: string;
  forms: readonly ScopedDependencyV2[];
  /** Each target's pre-image. A created page carries exact absence on its own path. */
  targets: readonly { path: string; pre: ObjectImage }[];
}

/** Why a source's compile is not complete in this proposal. */
export type IncompleteReasonV2 = "candidate_limit" | "floor_blocked" | "not_generated" | "deferred";

/** What a proposal covered, stated honestly. A deferred or incomplete source is never recorded as compiled. */
export interface ScopedCoverageV2 {
  /** The scope as declared, so a reviewer sees exactly what was asked for. */
  scope: CompileScopeV2;
  /** Sources admitted beside the named ones because they share a concept. */
  expanded: readonly string[];
  complete: readonly string[];
  /** Readable sources whose durable record already matched their bytes: nothing was generated for them. */
  unchanged: readonly string[];
  incomplete: readonly { source: string; reason: IncompleteReasonV2 }[];
  /** Sources that share a concept with this scope but were not admitted under its bounds. */
  deferredFrontier: readonly string[];
}

/**
 * The durable, narrow completion record of one source, committed with the
 * apply that establishes it. Every field is a function of retained evidence
 * (the proposal's committed candidates and receipts), so a lost record can be
 * re-materialized exactly and checked against the digest its receipt names.
 */
export interface ScopedSourceRecordV2 {
  source: string;
  namespace: string;
  hash: string;
  /** Logical paths of the pages this source owns. */
  concepts: readonly string[];
  promptModifiers: string;
  proposalOperationId: string;
  /** When the proposal that produced it was committed. */
  compiledAt: string;
}

/** Where one source's durable state stands. `unknown` is reported, never repaired by spending. */
export type ScopedSourceStatusV2 =
  | { kind: "compiled"; record: ScopedSourceRecordV2 }
  | { kind: "never_compiled" }
  | { kind: "unknown"; dirty: true };

/** What the scoped store declares. */
export interface ScopedCapabilitiesV2 {
  scopeFences: "authority-maintained";
  namespaces: "concept-prefix";
  contextIndex: "namespace-keyword-postings";
  custody: ScopedCustodyV2;
  ceilings: typeof SCOPED_HOST_CEILINGS;
}

/** A scoped method refused by name: the store cannot honestly offer it. */
export interface ScopedUnsupportedV2 {
  kind: "refused"; code: "capability_unsupported"; capability: typeof SCOPE_FENCES_CAPABILITY;
  notice: typeof ACCESS_NOTICE;
}

/** The answer to scoped negotiation. */
export type ScopedNegotiationV2 =
  | { kind: "negotiated"; protocol: typeof SCOPED_PROTOCOL_V2; capabilities: ScopedCapabilitiesV2 }
  | ScopedUnsupportedV2;

/** A namespace view: derived, rebuildable, never published. */
export interface NamespaceViewV2 { namespace: string; index: string; moc: string; builtFromMemberFence: string }

/** The scoped surface of one project, beside (never instead of) the version 1 `WikiProject`. */
export interface ScopedProjectV2 {
  readonly protocol: typeof SCOPED_PROTOCOL_V2;
  negotiate(): Promise<ScopedNegotiationV2>;
  propose(request: ScopedProposeRequestV2): Promise<ProposalOutcome | ScopedUnsupportedV2>;
  coverage(proposalOperationId: string): Promise<LabelledResult<ScopedCoverageV2>>;
  candidates: {
    list(proposalOperationId: string): Promise<Listed<CandidateSummary>>;
    get(proposalOperationId: string, candidateId: string): Promise<LabelledResult<CandidateView>>;
    approve(request: ApproveRequest): Promise<ApprovalOutcome | ScopedUnsupportedV2>;
  };
  apply(request: ApplyRequest): Promise<PublicationOutcome | ScopedUnsupportedV2>;
  sourceStatus(name: string): Promise<LabelledResult<ScopedSourceStatusV2>>;
  view(namespace: string): Promise<LabelledResult<NamespaceViewV2>>;
}
