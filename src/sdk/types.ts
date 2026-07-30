/**
 * @file src/sdk/types.ts
 * @description Public type surface for the llmwiki in-process SDK.
 *
 * Defines the `Wiki` interface returned by `createWiki`, plus the
 * option shapes that callers pass to each method. All concrete result
 * types are imported directly from their owning modules so consumers
 * who need deeper access can follow the same import path.
 */

import type { CompileResult, IngestResult, QueryResult } from "../utils/types.js";
import type { IngestTextInput } from "../commands/ingest.js";
import type { LintSummary } from "../linter/types.js";
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
import type { ActionSummary, ActionDetail } from "../workflows/actions.js";
import type { WorkflowSummary } from "../workflows/list.js";
import type { WorkflowDetail } from "../workflows/show.js";
import type { WorkflowRun, WorkflowActorKind, WorkflowEvent } from "../workflows/types.js";
import type { RunStatus } from "../workflows/status.js";
import type { AdaptationPlan } from "../workflows/adapt.js";
import type { AdvanceResult } from "../workflows/advance.js";
import type { StageOutput, SubmitResult } from "../workflows/stage-output.js";
import type { ActionRunResult } from "../workflows/run-action.js";
import type { ProjectionResult } from "../workflows/projection.js";
import type { ArtifactRef } from "../artifacts/ref.js";
import type { ArtifactHealth } from "../artifacts/resolve.js";

/**
 * @experimental
 * SDK input for {@link Wiki.transitionLifecycle}: the entity page to transition
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
 * SDK input for {@link Wiki.writeArtifact}: the profile-declared artifact type,
 * slug, and raw body bytes (as a string). Mirrors the CLI `artifact write`
 * `--type`/`--slug`/`--body` flags; the SDK has no file-path body source.
 */
export interface SdkWriteArtifactInput {
  /** Profile-declared artifact type (`profile.artifacts[artifactType]`). */
  artifactType: string;
  /** Artifact slug (the identifier within its type). */
  slug: string;
  /** Raw artifact body bytes. Hashed as-is; no encoding is inferred. */
  body: string;
}

/** Options for `createWiki`. */
export interface CreateWikiOptions {
  /** Absolute or relative path to the project root. Normalized once inside `createWiki`. */
  root: string;
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
 * Result of {@link Wiki.search}: the hydrated relevant pages, the qualified
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
export interface Wiki {
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
  search(question: string): Promise<SearchResult>;
  /**
   * Generate a grounded answer from the wiki. Requires LLM credentials.
   *
   * **Data egress:** the question and relevant wiki page content are sent to the
   * configured LLM provider to produce the answer.
   *
   * Streaming token delivery (`onToken`) is intentionally NOT exposed by the
   * facade in v1 — only `save` and `debug` are surfaced. Callers needing
   * per-token streaming should use `generateAnswer` directly.
   */
  query(question: string, options?: { save?: boolean; debug?: boolean }): Promise<QueryResult>;
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
   * List the workflow ACTIONS declared in the active profile (id, label,
   * workflow, operation), sorted by id. A default-profile project (which declares
   * no actions) yields an empty array. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listActions(): Promise<ActionSummary[]>;
  /**
   * @experimental
   * Show one declared workflow action with its EFFECTIVE permission per surface
   * (`min(profile request, local grant, surface hard cap)`) — so an `mcp` request
   * for `trusted-write` surfaces as `staged-write`. Resolves the id by an
   * OWN-property check; an undeclared id throws `UnknownActionError`. Read-only;
   * no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  showAction(actionId: string): Promise<ActionDetail>;
  /**
   * @experimental
   * List the workflows declared in the active profile, each with its stage ids
   * (in declared order). A default-profile project (which declares no workflows)
   * yields an empty array. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /**
   * @experimental
   * Show ONE declared workflow's full detail: each stage's
   * `reads`/`writes`/`gate`/`previousIds`, the workflow's `projectionFile`, and the
   * ids of declared actions that target it. Resolves the id by an OWN-property
   * check; an undeclared id throws `UnknownWorkflowError`. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  showWorkflow(workflowId: string): Promise<WorkflowDetail>;
  /**
   * @experimental
   * List one run's recorded audit `events[]`, in append order (the genesis
   * `workflow-start`, each `stage-advanced`/`gate-approved`/`stage-output`/…, with
   * actor + stage/gate/decision/detail + state versions). Read-only and
   * fail-visible: an absent/unavailable/unknown run throws `RunUnavailableError`
   * rather than an empty list. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listRunEvents(runId: string): Promise<WorkflowEvent[]>;
  /**
   * @experimental
   * Start a new run of a declared workflow, recording any caller `inputs`
   * (default `{}`). Mints + persists a `pending` run under the project lock;
   * performs NO stage execution, gate evaluation, or wiki write. Throws
   * `UnknownWorkflowError` when the id is not declared and `LockBusyError` when
   * the project is locked — nothing is written in either case. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  startWorkflow(workflowId: string, inputs?: Record<string, unknown>): Promise<WorkflowRun>;
  /**
   * @experimental
   * Report the status of one run (by id) or of all runs, classified against the
   * active profile (`current` / `historical` / `needs-adaptation` /
   * `blocked-by-config`). Read-only and fail-closed: a malformed or unknown run
   * is surfaced as a `problem`, never thrown. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  workflowStatus(runId?: string): Promise<RunStatus[]>;
  /**
   * @experimental
   * Advance an active run by one stage. Clears the current stage and steps to the
   * next (`outcome:"advanced"`), finishes the run (`"completed"`), parks an
   * unsatisfied `human:`/`agent:` gate (`"awaiting-gate"`), or parks a
   * write-declaring / `trust:`-gated stage awaiting a `submitStageOutput`
   * (`"awaiting-output"`). A terminal run throws `RunNotActiveError`. Runs under
   * the project lock; no wiki write. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  advanceWorkflow(runId: string): Promise<AdvanceResult>;
  /**
   * @experimental
   * Approve a `human:`/`agent:` gate on the run's current stage. Enforces the
   * security rule that an `agent` actor can never satisfy a `human:` gate
   * (`GateActorMismatchError`); rejects an unknown gate (`UnknownGateError`), a
   * `trust:` gate (`TrustGateNotHereError`), and a terminal run
   * (`RunNotActiveError`). Idempotent for an already-satisfied gate. Runs under
   * the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  approveGate(
    runId: string,
    gateId: string,
    opts: { actorKind: WorkflowActorKind; actorLabel?: string },
  ): Promise<WorkflowRun>;
  /**
   * @experimental
   * Cancel an active run (move it to terminal `cancelled`). A terminal run throws
   * `RunNotActiveError`. Runs under the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  cancelWorkflow(runId: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Fail an active run (move it to terminal `failed`), recording `detail` as the
   * reason on the `run-failed` event. Owner-enforced + lock-guarded; a terminal
   * run throws `RunNotActiveError` and an over-long `detail` throws
   * `WorkflowFieldTooLongError`. A run failed here is retryable via `resumeWorkflow`.
   * No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  failWorkflow(runId: string, detail: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Resume a `failed` run (retry → `running`), or return an already-active run
   * unchanged as a position report. A `completed`/`cancelled` run throws
   * `RunNotActiveError`. Runs under the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  resumeWorkflow(runId: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Submit a typed `output` (`page` / `relation` / `lifecycle-transition`) to a
   * run's current write-declaring stage, routing the write through the
   * scope-gated planner→executor seam under the project lock. A stage may write
   * ONLY the entity types it declares (`StageWriteScopeError` otherwise). An
   * `allow`/`allow-with-warning` lands the write live (`applied:true`) and
   * satisfies a `trust:` gate; a blocked page write stages for review
   * (`applied:false`); a `deny` / relation / lifecycle denial throws. Rejects a
   * no-writes stage (`StageHasNoWritesError`) and a terminal/absent run
   * (`RunNotActiveError`/`RunUnavailableError`). No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  submitStageOutput(runId: string, output: StageOutput): Promise<SubmitResult>;
  /**
   * @experimental
   * Run a declared workflow action under the COMPOSED authority on the fixed
   * `sdk` surface (`min(profile request, local grant, sdk hard cap)`) — the
   * surface is NOT caller-overridable, so a caller cannot claim a higher-cap
   * surface. Validates `inputs` (default `{}`) against the action's
   * `inputSchema`, enforces the operation's required capability, then dispatches
   * to the existing run-lifecycle op. Throws `UnknownActionError` (undeclared
   * id), `ActionInputError` (input-schema violation), or `ActionDeniedError`
   * (effective permission cannot satisfy the op) — nothing is written in any of
   * those cases. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  runAction(actionId: string, inputs?: Record<string, unknown>): Promise<ActionRunResult>;
  /**
   * @experimental
   * Preview the adaptation plan(s) for one run (by id) or every readable run when
   * the workflow definition has changed — READ-ONLY (no lock, no write). Each plan
   * reports the old→new digest, the per-stage old→new mapping, any unmappable
   * stage ids, and a `lossless` flag. A named-but-unreadable run / unresolvable id
   * / unavailable store throws (a named run never vanishes as `[]`). No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  adaptDryRun(runId?: string): Promise<AdaptationPlan[]>;
  /**
   * @experimental
   * Re-anchor a run to the active workflow def under the project lock. A LOSSLESS
   * adapt remaps the current stage + stage log and re-anchors the digest, so the
   * run then classifies `current`. A LOSSY adapt (an unmappable stage the run
   * references) fails closed unless `confirm` — leaving the run byte-unchanged;
   * with `confirm`, a confirmed unmappable current stage CANCELS the run, the drop
   * recorded on a `workflow-adapted` event. Throws `AlreadyCurrentError` (no-op),
   * `UnknownWorkflowError` (workflow removed), `AdaptationRequiresConfirmError`
   * (lossy + unconfirmed), `RunUnavailableError`/`LockBusyError`. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  adaptWorkflowRun(runId: string, opts?: { confirm?: boolean }): Promise<WorkflowRun>;
  /**
   * @experimental
   * Write a run's DERIVED markdown projection to its workflow's declared
   * `projectionFile` under `wiki/`. The projection is computed FROM the run JSON
   * and is a one-way `wiki/` OUTPUT — editing it never affects run state. Returns
   * `written` with the project-relative path, `no-target` when the workflow
   * declares no `projectionFile`, or `unavailable` (fail-visible) when the run is
   * absent/unreadable or the path escapes `wiki/`. Takes NO run lock; no run
   * mutation. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  projectWorkflowRun(runId: string): Promise<ProjectionResult>;
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
}
