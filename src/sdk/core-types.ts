/**
 * @file src/sdk/core-types.ts
 * @description Public type surface for the llmwiki in-process SDK.
 *
 * Defines the `WikiCore` interface returned by `createWikiCore`, plus the
 * option shapes that callers pass to each method. All concrete result
 * types are imported directly from their owning modules so consumers
 * who need deeper access can follow the same import path.
 */
import type { PackProviderInvocationV1 } from "../operations-packs/runtime/runner-input.js";
import type { SdkOperationOptions, WikiOperationSurface } from "./operations-facade.js";

import type { CompileResult, IngestResult, QueryResult } from "../utils/types.js";
import type { IngestTextInput } from "../commands/ingest.js";
import type { LintSummary } from "../linter/types.js";
import type { TieredLintReportV1 } from "../linter/tiers.js";
import type { ContextPack } from "../context/types.js";
import type { EvalReport } from "../eval/types.js";
import type { WikiStatus } from "../status/collect.js";
import type { Page, PageRef, ListPagesOptions, ListPagesResult } from "../pages/list.js";
import type { PageRecord } from "../pages/read.js";
import type { SelectedPageRef, SearchWarning } from "../search/retrieval.js";
import type { JsonExportDocument, ExportJsonOptions } from "../export/json-export.js";
import type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "../sources/store.js";
import type { OkfExportReport } from "../export/okf/run.js";
import type { OkfImportReport } from "../import/run.js";
import type { SdkStageEntityPageInput } from "../trust/staging.js";
import type { StagedChange } from "../trust/staged-change.js";
import type { AppendRelationInput } from "../relations/store.js";
import type { RelationRef } from "../relations/types.js";
import type { ArtifactRef } from "../artifacts/ref.js";
import type { ArtifactHealth } from "../artifacts/resolve.js";
import type { VerifiedArtifactBodyV1 } from "../artifacts/read-verified.js";
import type { ArtifactSelectorV1, ArtifactDiscoveryV1 } from "../artifacts/discover.js";
import type { ArtifactMemberFileInput } from "../artifacts/members.js";
import type {
  CancelResultV1, FailResultV1, GateDecision, GateResultV1, HandoffResultV1,
  ListResultV1, PauseResultV1, PreparationGrant, PreparationHandoffObligationsV1,
  PreviewResultV1, PruneResultV1, RecoveryResultV1, ResumeResultV1, ShowResultV1,
  StageResultV1, SweepResultV1,
} from "../preparations/service.js";
import type { PackActionInputValueV2 } from "../operations-packs/types.js";
// Through the product layer (not the preparation substrate) so the SDK adapter
// stays within the preparation-service boundary; it re-exports the ref type.
import type { WorkflowParentRefV1 } from "../products/service.js";
import type { ProductInvokeResultV1, ProductPreviewResultV1 } from "../products/service.js";

/**
 * @experimental
 * SDK input for {@link WikiProductSurface.preview} / `.invoke`.
 *
 * `action` is the canonical action id OR an alias token the ACTIVE product's
 * pack exposes on the SDK surface — an alias resolves to the same canonical
 * action and the same surface, so the two forms compile a byte-identical plan.
 */
export interface SdkProductActionInput {
  /** The workspace the durable run is recorded under. Carries no authority. */
  workspaceId: string;
  /** The action id, or an alias token exposed on the SDK surface. */
  action: string;
  /** Declared action input; omitted, every field falls to its declared default. */
  input?: Record<string, PackActionInputValueV2>;
  /**
   * OPTIONAL outer-workflow parent this invocation serves (P6). Carries no
   * authority; it is deep-captured and grafted into the canonical plan so a
   * workflow coordinator can bind each stage's preparation to its journey run.
   */
  workflowParent?: WorkflowParentRefV1;
}

/**
 * @experimental
 * The product-action surface exposed as `createWiki().product`.
 *
 * TWO VERBS, THE PROPOSE HALF OF PROPOSE/APPROVE. `preview` is grant-free and
 * writes no project byte. `invoke` requires the `preparation.run` grant, because
 * it stages a durable preparation and drives it to a Milestone A handoff bundle —
 * it applies nothing, and the handoff CARRIES the compiled intent drafts as
 * evidence for a separate approval. That approval — `apply` — is a local-operator
 * action today (`llmwiki product apply`), not on this surface: approving charges
 * an operation grant `CreateWikiOptions` cannot carry.
 */
export interface WikiProductSurface {
  /** Report what invoking this action WOULD do, writing no project byte. */
  preview(input: SdkProductActionInput): Promise<ProductPreviewResultV1>;
  /** Stage and drive this action to its Milestone A handoff bundle. */
  invoke(input: SdkProductActionInput): Promise<ProductInvokeResultV1>;
  /**
   * Continue a run this action invoked and left suspended at a gate. The same
   * drive `invoke` performs, re-entered: the run's OWN sealed input is
   * recompiled and must reproduce its sealed plan, so a resume can neither
   * smuggle new input nor continue under a different action. Costs the same
   * `preparation.run` grant invoking does — resuming drives.
   */
  resume(input: SdkProductResumeInput): Promise<ProductInvokeResultV1>;
}

/**
 * @experimental
 * SDK input for {@link WikiProductSurface.resume}: the suspended run and the
 * action token it was invoked through (the recompile guard's identity).
 */
export interface SdkProductResumeInput {
  /** The workspace the durable run is recorded under. Carries no authority. */
  workspaceId: string;
  /** The action id or alias token the run was invoked through. */
  action: string;
  /** The suspended run to continue. */
  runId: string;
}

/**
 * @experimental
 * SDK input for {@link WikiCore.transitionLifecycle}: the entity page to transition
 * and its target state, plus any frontmatter `evidence` a target state requires.
 */
export interface SdkTransitionLifecycleInput {
  /** Profile entity type whose page is transitioned (must declare a lifecycle). */
  entityType: string;
  /** Page slug (the filename stem) of the page to transition. */
  slug: string;
  /** The lifecycle state to transition the page into. */
  toState: string;
  /** Optional frontmatter fields a target state requires, merged into the page. */
  evidence?: Record<string, unknown>;
}

/**
 * @experimental
 * SDK input for {@link WikiCore.writeArtifact}: the profile-declared artifact type,
 * slug, and raw body bytes (as a string). Mirrors the CLI `artifact write`
 * `--type`/`--slug`/`--body` flags; the SDK has no file-path body source.
 */
export type SdkWriteArtifactInput = {
  /** Profile-declared artifact type (`profile.artifacts[artifactType]`). */
  artifactType: string;
  /** Artifact slug (the identifier within its type). */
  slug: string;
} & (
  | {
    /** Raw artifact body bytes (a single-file type). Hashed as-is; no encoding is inferred. */
    body: string;
    memberFiles?: undefined;
  }
  | {
    /**
     * The member leaves of a MEMBER-BEARING type (bytes only): core hashes
     * each, renders the canonical manifest, and derives the ref from it. A
     * `body` is refused for such a type, and `memberFiles` for any other.
     */
    memberFiles: readonly ArtifactMemberFileInput[];
    body?: undefined;
  }
);

/** Options for `createWiki`. */
export interface CreateWikiOptions {
  /** Absolute or relative path to the project root. Normalized once inside `createWiki`. */
  root: string;
  /**
   * @experimental
   * The preparation identity and grants this embedder acts under. Omit it and
   * the SDK can read preparations but not mutate them — an `sdk` principal
   * holds exactly the grants it was given, and a missing one fails closed.
   */
  preparation?: SdkPreparationOptions;
  /** Experimental host-assigned record preparation authority. Never approval/apply. */
  operations?: SdkOperationOptions;
}

/**
 * @experimental
 * The host-assigned preparation authority for an SDK embedder.
 *
 * There is deliberately NO `surface` field: the facade stamps `sdk` itself. A
 * caller that could name its own surface could claim `cli`, and a `cli`
 * principal holds the whole local-operator grant set by transport.
 */
export interface SdkPreparationOptions {
  /**
   * The embedder's ability to execute PROVIDER phases.
   *
   * llmwiki SHIPS NO PROVIDER BACKEND, so this is the only way a provider phase
   * can run: an embedder that installs providers supplies its own invocation
   * and the pack runtime routes provider phases to it. Omitting it — the
   * default — leaves provider phases settling `failed`, which is the honest
   * state of a host that cannot launch one.
   *
   * SUPPLYING IT WIDENS NOTHING. The plan's sealed executor still decides WHICH
   * provider runs; the leg refuses any request that names another.
   */
  providerInvocation?: PackProviderInvocationV1;
  /**
   * The identity recorded as the actor on anything this embedder writes.
   *
   * EMBEDDER-CHOSEN AND NOT AUTHORITATIVE. Nothing authenticates it and nothing
   * grants anything on the strength of it — an embedder may name itself
   * `cli-operator` and gain nothing by it, because `surface` is the only field
   * authority is read from and the facade stamps that itself. Treat it as a
   * label for reading transition records, not as an identity claim.
   */
  id?: string;
  /**
   * The grants this embedder holds. Narrower than the local operator by
   * default — an empty set — and never widened by any other input.
   *
   * Read as an OWN property: an inherited `grants` is not read as though the
   * embedder had supplied it. The array is copied at construction, so mutating
   * it afterwards grants nothing.
   */
  grants?: readonly PreparationGrant[];
}

/**
 * @experimental
 * SDK input for {@link WikiCore.stagePreparation}.
 *
 * Both documents are TEXT rather than parsed objects, deliberately: the service
 * parses them through the same duplicate-key-rejecting, size- and depth-bounded
 * reader the CLI uses, so the two surfaces accept and refuse exactly the same
 * documents. Handing over an already-parsed value would quietly buy this surface
 * different acceptance semantics.
 */
export interface SdkStagePreparationInput {
  /** The plan document, as JSON text. */
  planDocument: string;
  /** The bytes the plan's declared initial input set hashes to, as JSON text. */
  seedDocument: string;
  /** The control-transition budget this run is allowed. Defaults to 16. */
  controlTransitionAllowance?: number;
}

/** Compile options exposed through the SDK. A public subset of the core CompileOptions shape. */
export interface SdkCompileOptions {
  /** Write generated pages as candidates for review instead of mutating wiki/. */
  review?: boolean;
  /**
   * Maximum concurrent LLM calls during compile (extraction + page generation).
   * Overrides LLMWIKI_COMPILE_CONCURRENCY and the built-in default of 5;
   * out-of-range values are clamped with a warning.
   */
  concurrency?: number;
  /**
   * Extra instructions appended to the built-in compile prompts, for a host that
   * needs deployment-specific editorial or publication guidance without forking
   * the prompts. Additive, never a replacement; blank is the same as omitted.
   *
   * Advisory rather than enforceable: it makes the model more likely to follow a
   * rule, and nothing verifies that it did.
   *
   * Changing it invalidates pages compiled under the previous policy, the same
   * way changing the output language does.
   */
  systemPolicy?: string;
  /**
   * Refresh semantic embeddings after compilation. Defaults to true.
   * False prevents embedding-provider calls and pending-embedding retries.
   */
  embeddings?: boolean;
}

/** Options for `getContextPack`. Maps onto the subset of BuildContextPackOptions needed externally. */
export interface ContextPackOptions {
  /** Free-text prompt the agent supplied. */
  prompt: string;
  /** Token budget (tokens ≈ chars/4). */
  budget?: number;
  /** Graph traversal depth (0–2). */
  depth?: number;
  /** Maximum primary pages to include. */
  topPages?: number;
  /** Maximum semantic chunks to include. */
  topChunks?: number;
}

/**
 * Result of {@link WikiCore.search}: the hydrated relevant pages, the qualified
 * page refs that produced them, and any embedding-load `warnings` (e.g.
 * `embedding-index-outdated` when the on-disk index is not yet v3).
 */
export interface SearchResult {
  pages: PageRecord[];
  refs: SelectedPageRef[];
  warnings: SearchWarning[];
}

/**
 * The facade object returned by `createWiki`. Every method runs silently
 * (no console output) and normalizes all paths against the project root
 * supplied at construction time.
 */
export interface WikiCore {
  /**
   * Ingest a file path or URL as a new source document. Requires no LLM credentials.
   *
   * **Trust boundary (SSRF + local-file-read primitive):** this method fetches any URL
   * or reads any local file path the caller supplies — server-side — and writes the
   * resulting content into the wiki. Treat `source` as **trusted input only**. Do not
   * pass user-supplied or otherwise untrusted strings here. For untrusted content, use
   * `ingestText` instead (it accepts pre-extracted `{title, text}` with no fetch or
   * file-read step).
   *
   * **Prompt-injection surface:** ingested content is later processed by an LLM during
   * `compile`. Untrusted or adversarially crafted content in sources is therefore a
   * prompt-injection vector into page generation.
   */
  ingest(input: { source: string }): Promise<IngestResult>;
  /**
   * Ingest raw text as a new source document. Requires no LLM credentials.
   *
   * Safe path for untrusted content: no network fetch or local file read is performed.
   * The caller supplies the text directly, so there is no SSRF or path-traversal risk
   * at ingest time (prompt-injection into `compile` still applies if the text itself is
   * adversarial).
   */
  ingestText(input: IngestTextInput): Promise<IngestResult>;
  /**
   * Compile all pending sources into wiki pages. Requires LLM credentials.
   *
   * **Data egress:** source content is sent to the configured LLM provider during
   * compilation. Do not compile wikis that contain confidential data unless the
   * provider's data-handling policies are acceptable for that content.
   *
   * **Silent operation:** progress output is suppressed by the SDK facade. There is no
   * progress callback in v1; structured `onLog` event delivery is planned for v1.x.
   * For long corpora this call may take several minutes with no intermediate feedback.
   */
  compile(options?: SdkCompileOptions): Promise<CompileResult>;
  /**
   * Pick and hydrate the most relevant pages for a question. Requires LLM credentials.
   *
   * **Data egress:** the question (and embedding request) is sent to the configured LLM
   * provider. Wiki page content may also be sent during retrieval scoring.
   *
   * Returns the hydrated pages plus any `warnings` from the embedding load: an
   * outdated (non-v3) or unavailable index degrades to lexical/index selection
   * and reports `embedding-index-outdated` so the caller SEES why semantic
   * retrieval contributed nothing (S6).
   */
  search(question: string, options?: { embeddingFailure?: "throw" | "fallback" }): Promise<SearchResult>;
  /**
   * Generate a grounded answer from the wiki. Requires LLM credentials.
   *
   * **Data egress:** the question and relevant wiki page content are sent to the
   * configured LLM provider to produce the answer.
   *
   * Streaming token delivery (`onToken`) is intentionally NOT exposed by the
   * facade. Callers needing
   * per-token streaming should use `generateAnswer` directly.
   */
  query(question: string, options?: {
    save?: boolean; debug?: boolean; pageScope?: readonly string[];
    /** Opt-in error recovery; scoped queries default to fallback. */
    embeddingFailure?: "throw" | "fallback";
    /** Opt-in hydrated provenance; scoped queries always use this mode. */
    grounding?: "hydrated";
  }): Promise<QueryResult>;
  /** Fetch a single page by directory and slug. No LLM required. */
  getPage(ref: PageRef): Promise<Page | null>;
  /** List wiki pages with optional filters and cursor-based pagination. No LLM required. */
  listPages(options?: ListPagesOptions): Promise<ListPagesResult>;
  /** List source files under `sources/` with optional cursor pagination. Bodies are opt-in via `includeBody`. No LLM required. */
  listSources(options?: ListSourcesOptions): Promise<ListSourcesResult>;
  /** Fetch a single source record by its basename id (e.g. "note.md"); returns null if absent. Always includes body. No LLM required. */
  getSource(id: string): Promise<SourceRecord | null>;
  /** Delete the source file for the given id (the id is the `IngestResult.filename`, e.g. "note.md").
   *  Returns true if deleted, false if not found. The compiled page in `wiki/` is NOT removed
   *  immediately — reconciliation happens on the next `compile()`. No LLM required. */
  deleteSource(id: string): Promise<boolean>;
  /**
   * Collect a read-only status snapshot of the wiki. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  status(): Promise<WikiStatus>;
  /**
   * Run all lint rules and return a severity-counted summary. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  lint(): Promise<LintSummary>;
  /**
   * The same check as {@link lint}, split by the KIND of claim each finding
   * makes: `deterministic` facts, `providerJudgement` (a model's stored
   * assessment, never grounds for failing on its own), and `derivedView`
   * (regenerable artifacts that are out of date). One collection pass; no LLM
   * required. Same per-call cost as `lint()`.
   */
  lintByTier(): Promise<TieredLintReportV1>;
  /**
   * Build a v1 context pack for agent consumption. Lexical retrieval works
   * credential-free; semantic retrieval is opportunistic (skipped when no
   * embeddings are available).
   */
  getContextPack(options: ContextPackOptions): Promise<ContextPack>;
  /**
   * Export the wiki as a structured JSON document. No LLM required.
   *
   * **Per-call cost:** each call hashes and reads the full source corpus —
   * O(total source bytes) — with no cross-call caching. Avoid calling this in a
   * hot loop; an mtime-keyed cache is planned for v1.x.
   */
  exportJson(options?: ExportJsonOptions): Promise<JsonExportDocument>;
  /**
   * Run the eval harness. "fast" mode is credential-free; "full" mode
   * requires LLM credentials for citation-support judging.
   *
   * **Silent operation:** the SDK suppresses all progress output. There is no
   * progress callback in v1; structured `onLog` event delivery is planned for v1.x.
   */
  runEval(options: { mode: "fast" | "full"; record?: boolean }): Promise<EvalReport>;
  /** Export the wiki as an OKF v0.1 bundle (default dist/exports/okf). */
  exportOkf(opts?: { out?: string }): Promise<OkfExportReport>;
  /**
   * Import an OKF bundle. Default stages review candidates; `trusted:true` writes live
   * (and runs the full refresh — links/index/MOC/EMBEDDINGS, which may incur provider
   * latency/cost); `dryRun:true` writes nothing.
   */
  importOkf(dir: string, opts?: { trusted?: boolean; dryRun?: boolean }): Promise<OkfImportReport>;
  /**
   * @experimental
   * Stage a NON-DEFAULT entity page for review. The SDK loads the active
   * non-default profile internally — the caller passes no `ProfilePack`. Throws
   * `StagingRequiresProfileError` when the project has no non-default profile
   * (staging targets a typed `wiki/<entityType>/<slug>.md` path that only a
   * non-default profile declares). `existingStagedCount` is the caller's
   * per-session bookkeeping (defaults to 0). No LLM required.
   *
   * READ-INTEGRATION STATUS: typed entity pages are surfaced in `status`, the
   * JSON export, the wiki INDEX, the viewer graph, agent context packs (lexical
   * ranking + relation-edge expansion), and semantic search (under their qualified
   * EntityId). Per-entity-type viewer UI beyond basic node/edge distinction and
   * cross-type wikilink resolution remain deferred.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  stageEntityPage(input: SdkStageEntityPageInput): Promise<StagedChange>;
  /**
   * @experimental
   * Promote a staged entity page candidate into the live wiki under one held
   * lock: re-reads the candidate, re-validates its type against the active
   * profile, re-plans + applies, and clears the candidate. The page lands at
   * `wiki/<entityType>/<slug>.md`, or nothing does. No LLM required.
   *
   * READ-INTEGRATION STATUS: the promoted page is surfaced in `status`, the JSON
   * export, the wiki INDEX, the viewer graph, agent context packs (lexical
   * ranking + relation-edge expansion), and semantic search (under its qualified
   * EntityId, on the next compile).
   *
   * Foundation API — the shape may change in a future minor release.
   */
  promoteStagedPage(candidateId: string): Promise<void>;
  /**
   * @experimental
   * Create a typed RELATION through the trust planner. The SDK loads the active
   * non-default profile internally — the caller passes no `ProfilePack`. The
   * write routes through ONE planner decision (endpoint validity + required
   * attributes) and, only when allowed, appends to the relation store under one
   * lock. Throws `RelationsRequireProfileError` on a default project (no
   * `relations` block) and `RelationWriteDeniedError` when the planner denies the
   * write (undeclared type, disallowed endpoint, missing required attribute) —
   * nothing is written in either case. No LLM required.
   *
   * READ-INTEGRATION STATUS: a created relation lands in the relation store and is
   * surfaced in `status`, the JSON export, lint, the viewer graph (as an edge), and
   * agent context packs (relation-edge expansion). Per-entity-type viewer UI beyond
   * basic node/edge distinction remains deferred.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  createRelation(input: AppendRelationInput): Promise<RelationRef>;
  /**
   * @experimental
   * Transition a typed entity page's lifecycle field to `input.toState` as a
   * validated page update. The SDK loads the active non-default profile
   * internally. The write routes through the executor `lifecycle-transition` kind
   * and the shared page-apply primitive, re-running the lifecycle gate — an
   * illegal transition (or one missing required `evidence`) is REFUSED
   * (`LifecycleTransitionError`) and the page is left unchanged.
   * Throws `LifecycleTransitionUnavailableError` when the project has no profile,
   * the type is unknown, the type has no lifecycle, or the page does not exist.
   * No LLM required.
   *
   * READ-INTEGRATION STATUS: the transition writes the new lifecycle-field value
   * into the page. A field-flip is surfaced in TWO read surfaces: `status` (the
   * per-entity-type `profile.lifecycleStates` tally — the new state shifts the
   * per-state counts, so `wiki_status` and the SDK `status()` show the change),
   * and the JSON export (the value lives in the page frontmatter). It is NOT
   * reflected by a bare field-flip in the viewer graph (which drops the field),
   * in lint (which flags only an INVALID state, not a legal transition), or in
   * semantic search (a frontmatter-only change re-embeds nothing).
   *
   * Foundation API — the shape may change in a future minor release.
   */
  transitionLifecycle(input: SdkTransitionLifecycleInput): Promise<void>;

  /**
   * @experimental
   * Write a profile-declared artifact's bytes through the trust planner, on the
   * `sdk` origin — the SDK mirror of `artifact write`. Routes through the SAME
   * under-lock authority ({@link applyApprovedMutations} → `applyArtifactLocked`)
   * the CLI uses: re-loads the profile, re-composes the decision (an undeclared
   * type or body-contract violation denies without the grant hint — a grant
   * cannot override a planner block), then gates the live-decision case on the
   * out-of-band `LLMWIKI_TRUSTED_WRITE` operator grant. Rejects with a message
   * naming `LLMWIKI_TRUSTED_WRITE` when the grant is absent; nothing is written
   * in any refusal case. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  writeArtifact(input: SdkWriteArtifactInput): Promise<{ ref: ArtifactRef }>;
  /**
   * @experimental
   * Resolve a hash-pinned artifact ref to its {@link ArtifactHealth} verdict —
   * the SDK mirror of `artifact verify`. Recomputes the hash over the ACTUAL
   * on-disk bytes rather than trusting the stored manifest alone. Returns
   * metadata/health ONLY — never the artifact body. No LLM required.
   *
   * @throws {ArtifactVerifyUnavailableError} When the project has no active
   * non-default profile, or that profile declares no artifact types — no ref
   * could ever resolve there, so this refuses instead of returning a
   * misleading `"artifact-dangling"` verdict.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  verifyArtifact(ref: ArtifactRef): Promise<{ health: ArtifactHealth }>;
  /**
   * @experimental
   * Read a hash-pinned artifact's VERIFIED body bytes — what `verifyArtifact`
   * deliberately omits. Resolves + verifies through the same confined reader,
   * and returns the bytes ONLY on a fully-`ok` verdict, cryptographically
   * re-bound to the pinned ref's sha256. A coordinator uses this to re-verify a
   * checkpoint body or an exact result artifact on resume. Generic — no product
   * vocabulary. Same profile gate as {@link verifyArtifact}.
   *
   * @throws {ArtifactVerifyUnavailableError} Same conditions as verifyArtifact.
   * Foundation API — the shape may change in a future minor release.
   */
  readVerifiedArtifactBody(ref: ArtifactRef): Promise<VerifiedArtifactBodyV1>;
  /** Discover after rehashing bytes; no operation authority is implied.
   * Invalid selectors and unavailable active profiles reject. Valid lookup failures return unavailable. */
  discoverArtifact(selector: ArtifactSelectorV1): Promise<ArtifactDiscoveryV1>;
  /**
   * @experimental
   * Stage a plan document as a durable preparation run — the SDK mirror of
   * `llmwiki preparation stage`, through the same service.
   *
   * Requires the `preparation.run` grant. An embedder that named none gets a
   * {@link PrincipalAuthorityError} with code `missing-grant` and nothing is
   * written; a refused stage returns `{ status: "refused", reason }` and leaves
   * no partial run either. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  stagePreparation(input: SdkStagePreparationInput): Promise<StageResultV1>;
  /**
   * @experimental
   * Report what {@link stagePreparation} WOULD do, writing no project byte — the
   * SDK mirror of `llmwiki preparation preview`.
   *
   * Read-only and GRANT-FREE, as `list` and `show` are: it takes no lock, writes
   * no byte, and reaches no path the caller names — the plan and seed arrive as
   * strings the embedder already holds. It routes through the substrate's own
   * forced dry-run path, so a check added to staging is a check preview inherits.
   *
   * It answers `previewed` and names NO run. The substrate reports `staged` on
   * its dry-run path — that is what staging would have answered — but the
   * identity in that answer belongs to a run this call did not create, so it
   * never reaches an embedder. It takes no lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  previewPreparation(input: SdkStagePreparationInput): Promise<PreviewResultV1>;
  /**
   * @experimental
   * Enumerate preparation runs and the problems observed while reading them —
   * the SDK mirror of `llmwiki preparation list`.
   *
   * Read-only and grant-free: it takes no lock and writes no byte. A run that
   * could not be READ stays in the listing with a null state and a `detail`
   * saying why, because dropping it would read as "does not exist". No LLM
   * required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listPreparations(): Promise<ListResultV1>;
  /**
   * @experimental
   * Drive one planned preparation run to the terminal `failed` state — the SDK
   * mirror of `llmwiki preparation fail`.
   *
   * Requires the `preparation.run` grant, and refuses (rather than throwing) for
   * every domain reason: an unknown or unreadable run, a state that cannot reach
   * `failed`, a live execution owner, or a busy project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  failPreparation(runId: string): Promise<FailResultV1>;
  /**
   * @experimental
   * Request cancellation of one preparation run — the SDK mirror of
   * `llmwiki preparation cancel`.
   *
   * Requires the `preparation.cancel` grant. It TAKES NO PROJECT LOCK, by
   * design: cancellation must land when a run is wedged, which is exactly when
   * every locked operation refuses. It publishes intent and settles nothing — a
   * lock-holding orchestrator validates state and drives the run to its honest
   * terminal — so a successful call means the request is durable, not that the
   * run has stopped. The requester recorded is the identity this facade was
   * constructed with, never an argument. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  cancelPreparation(runId: string): Promise<CancelResultV1>;
  /**
   * @experimental
   * Describe ONE preparation run — the SDK mirror of `llmwiki preparation show`.
   *
   * GRANT-FREE, exactly as `listPreparations` is: it takes no lock, writes no
   * byte, and reports REFERENCES — evidence digests and the bound plan's digest,
   * never the objects behind them. It distinguishes `refused` (a settled fact
   * about the store: no such run, or not a project) from `unavailable` (a fact
   * about this observer: something could not be read), because only the second
   * is worth retrying. The execution owner's liveness is reported uncollapsed,
   * including whether observing it again could ever answer differently. No LLM
   * required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  showPreparation(runId: string): Promise<ShowResultV1>;
  /**
   * @experimental
   * Hold one preparation run at a durable safe checkpoint — the SDK mirror of
   * `llmwiki preparation pause`.
   *
   * Requires the `preparation.run` grant. It refuses while an attempt is IN
   * FLIGHT rather than interrupting one, because `paused` means every active
   * attempt already reached a checkpoint; the refusal names the exit that fits
   * the executor's state — wait, cancel, or recover. Pausing a run that is
   * already paused reports `already-paused` rather than refusing an idempotent
   * retry. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  pausePreparation(runId: string): Promise<PauseResultV1>;
  /**
   * @experimental
   * Return one paused preparation run to `running` — the SDK mirror of
   * `llmwiki preparation resume`, and the exit that makes
   * {@link pausePreparation} safe to call.
   *
   * Requires the SAME `preparation.run` grant as pausing, and that equality is
   * the guarantee rather than a convenience: a paused run is escapable by a
   * principal holding `preparation.run` and nothing more. No destructive grant
   * and no cancellation route is needed, or counts. Resuming a run that is
   * already running reports `already-running` rather than refusing an idempotent
   * retry. A run parked for RECOVERY is not resumed here — it is refused with the
   * verb that applies, because recovery re-drives a stranded attempt while resume
   * only lifts an operator's own pause. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  resumePreparation(runId: string): Promise<ResumeResultV1>;
  /**
   * @experimental
   * Park one STRANDED preparation run and report the project's outstanding
   * lifecycle maintenance — the SDK mirror of `llmwiki preparation recover`.
   *
   * Requires the `preparation.recovery` grant. A run whose executor process is
   * still LIVE is busy rather than stranded and is refused untouched; a run
   * already parked reports `already-parked` rather than refusing an idempotent
   * retry. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  recoverPreparation(runId: string): Promise<RecoveryResultV1>;
  /**
   * @experimental
   * Record one host-authored gate decision on a preparation run — the SDK
   * mirror of `llmwiki preparation gate`.
   *
   * IT RECORDS AUTHORITY AND PERFORMS NOTHING. A recorded approval is consumed
   * later by the operation that owns the work the gate governs; this call never
   * starts an effect, resumes a phase, or moves the run. The grant it requires
   * is the one the gate KIND costs, and the kind is read from the run's own
   * plan — so an embedder holding `preparation.gate.decide` can decide a review
   * gate and is refused an effect gate. Refuses (rather than throwing) for every
   * domain reason: an unknown run, a gate the plan does not declare, a state
   * that cannot carry a decision, or a busy project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  gatePreparation(input: SdkGatePreparationInput): Promise<GateResultV1>;
  /**
   * @experimental
   * Stage one settled preparation run into its immutable Milestone A operation
   * bundle. There is no CLI mirror: the obligation set below is host-authored
   * typed material with no textual operator form.
   *
   * Requires the `preparation.run` grant — handoff STAGES the bundle and does
   * not approve or apply it. The flow is crash-idempotent: a call that finds a
   * durable `handoff-started` record resumes the EXACT same creation and returns
   * `resumed` rather than minting a second bundle. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  handoffPreparation(
    runId: string, obligations: PreparationHandoffObligationsV1,
  ): Promise<HandoffResultV1>;

  /**
   * @experimental
   * Reclaim one retention-eligible terminal preparation run's exact bytes — the
   * SDK mirror of `llmwiki preparation prune`.
   *
   * Requires the `preparation.quarantine` grant, which is DELIBERATELY not the
   * `preparation.run` grant that creates and drives runs: destroying a run's
   * bytes irreversibly is a decision a host makes separately from letting an
   * embedder work with runs at all. An embedder that named no grants can neither
   * prune nor sweep.
   *
   * It refuses rather than throwing for every project-state answer: a run inside
   * its thirty-day retention floor, a non-terminal run, a busy lock, or
   * unfinished destructive work this prune does not own.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  prunePreparation(runId: string): Promise<PruneResultV1>;

  /**
   * @experimental
   * Reclaim the bytes of every preparation whose run is PROVABLY absent — the
   * SDK mirror of `llmwiki preparation sweep`.
   *
   * Requires the `preparation.quarantine` grant. It takes no argument: its
   * target is the project's own registry, and the exact unfinished unit it may
   * resume is decided under the project lock rather than named by the caller.
   * `nothing-to-sweep` is a SUCCESS — the ordinary answer for a healthy project
   * — and is distinct from the refusal returned when the key could not be read
   * and orphan owners therefore could not be classified.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  sweepPreparations(): Promise<SweepResultV1>;

  /**
   * @experimental
   * Invoke or preview an ACTIVATED product's actions — the WOP V3 product
   * surface.
   *
   * The project must have a product activated; there is no fallback to the
   * legacy profile path, so a project in legacy mode refuses rather than
   * guessing. Authority is the preparation authority: `product.preview` is
   * grant-free, `product.invoke` requires `preparation.run`.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  product: WikiProductSurface;
  /** Experimental prepare/observe/retire surface; apply remains a separate operator action. */
  operations: WikiOperationSurface;
}

/**
 * @experimental
 * SDK input for {@link WikiCore.gatePreparation}.
 *
 * It names the gate and the choice, and NOTHING the proof binds. Every digest a
 * gate proof carries — plan, phase, input, effect, authority — is recomputed by
 * the host from the run's authenticated manifest, and the gate KIND that selects
 * the required grant is read from the same place. An embedder that could present
 * any of them could bind an approval to bytes the operator never saw, or pick
 * the cheaper of three grants for a gate the plan declared as the dearer one.
 */
export interface SdkGatePreparationInput {
  /** The run whose gate is being decided. */
  runId: string;
  /** The gate id the run's own plan declares. */
  gateId: string;
  /** The exact choice, from the three closed decisions. */
  decision: GateDecision;
  /** An optional bounded reason code recorded on the proof. */
  reasonCode?: string;
}
