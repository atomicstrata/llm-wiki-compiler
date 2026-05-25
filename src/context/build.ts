/**
 * `buildContextPack()` — Slice 1 orchestrator.
 *
 * Composes the v1 context-pack envelope by:
 *   1. Loading the frozen viewer snapshot (page metadata, frontmatter,
 *      citations, warnings, etc).
 *   2. Collecting project state via the shared `collectProjectState`
 *      helper so the lint cache and pending-candidate counts match
 *      what `llmwiki next` would report.
 *   3. Lexically ranking pages against the prompt via the Slice-1
 *      ranker.
 *   4. Delegating the recommendation prefix to
 *      `recommendNextAction(state)` so `context` does not introduce a
 *      second project-state engine.
 *
 * Semantic retrieval, graph expansion, source windows, and MCP are
 * intentionally left for later slices; this entry point already emits
 * the full stable v1 JSON field set with empty arrays / `null`
 * placeholders so agents written against Slice 1 will not break when
 * later slices add data.
 */

import { buildViewerSnapshot } from "../viewer/snapshot.js";
import { collectProjectState } from "../project/state.js";
import { recommendNextAction } from "../project/recommendations.js";
import type { Recommendation, RecommendedAction } from "../project/recommendations.js";
import type { ProjectState } from "../project/state.js";
import type { ViewerSnapshot } from "../viewer/types.js";
import { rankPages } from "./ranking.js";
import { retrieveSemanticChunks } from "./retrieval.js";
import type { SemanticRetrievalOutcome, SemanticRetrievalWarning } from "./retrieval.js";
import { expandGraphNeighborhood } from "./graph.js";
import type { GraphExpansionOutput } from "./graph.js";
import {
  createSourceWindowBudget,
  materializeSourceWindows,
} from "./provenance.js";
import type { GraphData, PageId } from "../viewer/types.js";
import { buildBudget, estimatePackTokens, trimToBudget } from "./budget.js";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_TOP_CHUNKS,
  DEFAULT_TOP_PAGES,
  MAX_DEPTH,
  MAX_TOP_CHUNKS,
  MAX_TOP_PAGES,
  PROMPT_ECHO_MAX_LENGTH,
} from "./types.js";
import type {
  ContextPack,
  ContextProject,
  ContextWarning,
} from "./types.js";

/** Caller-supplied build options; all fields except `prompt` are optional. */
interface BuildContextPackOptions {
  /** Project root; defaults to `process.cwd()` at the call site. */
  root: string;
  /** Free-text prompt the agent supplied. */
  prompt: string;
  /** Token budget; defaults to {@link DEFAULT_BUDGET_TOKENS}. */
  budget?: number;
  /** Graph depth; clamped to {@link MAX_DEPTH} when supplied. */
  depth?: number;
  /** Max primary pages; clamped into the documented safe range. */
  topPages?: number;
  /** Max semantic chunks; pinned to the documented safe range. */
  topChunks?: number;
  /** When true, `project.root` is emitted as `null` for privacy. */
  omitRoot?: boolean;
  /** When false, graph expansion is suppressed (neighbors + gaps stay empty). */
  neighbors?: boolean;
  /** When true, populate `primary[].sourceWindows` from claim-level citation spans. */
  includeSources?: boolean;
}

/**
 * Build the v1 context pack. Never throws on read-only filesystem
 * issues — the project-state collector returns conservative defaults
 * (`broken-project` state) which the orchestrator faithfully surfaces.
 */
export async function buildContextPack(options: BuildContextPackOptions): Promise<ContextPack> {
  const normalized = normalizeOptions(options);
  const snapshot = await buildViewerSnapshot(options.root);
  const state = await collectProjectState(options.root);
  const recommendation = recommendNextAction(state);
  // Semantic retrieval is opportunistic — failures surface as stable
  // warning codes on the returned outcome rather than thrown errors so
  // lexical-only flows stay the default behaviour for credential-free
  // users.
  const semantic = await retrieveSemanticChunks(
    options.root,
    normalized.rankingPrompt,
    normalized.topChunks,
  );
  const draft = assembleDraft({
    snapshot,
    state,
    recommendation,
    options: normalized,
    semantic,
  });
  // Source windows are materialized AFTER ranking so the per-pack
  // budget sees the final primary list, not every candidate.
  // Skipped entirely when `--include-sources` is off.
  const withSources = normalized.includeSources
    ? await attachSourceWindows(draft, options.root)
    : draft;
  // Project-state warnings (pending candidates, lint errors,
  // source-window unavailability) need the post-materialization
  // primary list, so they land after attachSourceWindows and BEFORE
  // budget trimming. Trimming may drop sourceWindows for budget
  // reasons; the warning still correctly reports "windows missing".
  const withProjectWarnings = appendProjectWarnings(withSources, state, normalized);
  const graph = normalized.neighborsEnabled && normalized.depth >= 1
    ? snapshot.graph
    : null;
  return finalizeBudget(withProjectWarnings, normalized.budget, graph);
}

/**
 * Walk the ranked primary list once with a shared
 * {@link createSourceWindowBudget}, filling in each entry's
 * `sourceWindows` from its (already-flattened) claim-level citations.
 * Pages without claim-level spans (paragraph-only or no citations)
 * return empty windows; the global 20-window cap is enforced as the
 * walk progresses.
 */
async function attachSourceWindows(pack: ContextPack, root: string): Promise<ContextPack> {
  const budget = createSourceWindowBudget();
  // Serial loop — `budget.remaining` is mutated between awaits inside
  // `materializeSourceWindows`, so running pages in parallel would
  // race on the shared counter and overshoot the 20-window cap.
  const primary: ContextPack["primary"] = [];
  for (const entry of pack.primary) {
    const windows = await materializeSourceWindows(root, entry.citations, budget);
    primary.push({ ...entry, sourceWindows: windows });
  }
  return { ...pack, primary };
}

/**
 * Frozen, validated copy of the user-supplied options.
 *
 * The prompt is intentionally split into two fields:
 *   - `displayPrompt` is the echo-safe form that lands in
 *     `ContextPack.prompt` (truncated at PROMPT_ECHO_MAX_LENGTH so the
 *     envelope cannot balloon on a 10KB agent input).
 *   - `rankingPrompt` is the original, untruncated prompt that flows
 *     into every retrieval signal — lexical, semantic (Slice 2+), and
 *     exact match. Truncating before ranking would silently drop
 *     content the agent expected to drive selection.
 *
 * In Slice 1 the two values are observationally equivalent at the
 * lexical layer because `searchPages` caps queries at its own internal
 * MAX_QUERY_LENGTH (200 chars) and exact-match requires whole-prompt
 * equality. Slice 2's semantic retrieval will see the full
 * `rankingPrompt` and produce different scores than it would against
 * `displayPrompt`.
 */
interface NormalizedOptions {
  displayPrompt: string;
  rankingPrompt: string;
  budget: number;
  depth: number;
  topPages: number;
  topChunks: number;
  omitRoot: boolean;
  neighborsEnabled: boolean;
  includeSources: boolean;
  promptTruncated: boolean;
}

/** Apply defaults and clamps so downstream code can trust the field types. */
function normalizeOptions(options: BuildContextPackOptions): NormalizedOptions {
  const rankingPrompt = options.prompt ?? "";
  const { display, truncated } = truncatePrompt(rankingPrompt);
  return {
    displayPrompt: display,
    rankingPrompt,
    budget: clampPositive(options.budget, DEFAULT_BUDGET_TOKENS),
    depth: clampDepth(options.depth),
    topPages: clampBounded(options.topPages, DEFAULT_TOP_PAGES, MAX_TOP_PAGES),
    topChunks: clampBounded(options.topChunks, DEFAULT_TOP_CHUNKS, MAX_TOP_CHUNKS),
    omitRoot: options.omitRoot === true,
    // `--no-neighbors` is a Commander negated flag: absence means
    // expansion is ON; only `options.neighbors === false` disables it.
    neighborsEnabled: options.neighbors !== false,
    includeSources: options.includeSources === true,
    promptTruncated: truncated,
  };
}

/** Truncate the echoed prompt without mutating the prompt used for ranking. */
function truncatePrompt(raw: string): { display: string; truncated: boolean } {
  if (raw.length <= PROMPT_ECHO_MAX_LENGTH) return { display: raw, truncated: false };
  return { display: raw.slice(0, PROMPT_ECHO_MAX_LENGTH), truncated: true };
}

/** Clamp a numeric option to a non-negative integer with a fallback default. */
function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Clamp a numeric option into `[0, max]` with a fallback default. */
function clampBounded(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, clampPositive(value, fallback));
}

/** Clamp `--depth` into `[0, MAX_DEPTH]`. */
function clampDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DEPTH;
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(value)));
}

/** Composite input passed to the assembler; grouped to keep argument lists short. */
interface AssembleInput {
  snapshot: ViewerSnapshot;
  state: ProjectState;
  recommendation: Recommendation;
  options: NormalizedOptions;
  semantic: SemanticRetrievalOutcome;
}

/** Build the unbudgeted draft pack before token-budget finalization. */
function assembleDraft(input: AssembleInput): ContextPack {
  const { snapshot, state, recommendation, options, semantic } = input;
  const project = buildProject(snapshot, state, options.omitRoot);
  // Rank against the ORIGINAL prompt — the truncated echo is a
  // display-only courtesy and must not silently drop ranking signal.
  const primary = rankPages(snapshot, options.rankingPrompt, options.topPages, semantic.hits);
  const graphEnabled = options.neighborsEnabled && options.depth >= 1;
  const expansion = graphEnabled
    ? expandGraphNeighborhood({
        graph: snapshot.graph,
        pages: snapshot.pages,
        primaryIds: collectPrimaryIds(primary),
        depth: options.depth,
      })
    : emptyExpansion();
  // Additive `graph-neighbor` reason only: cannot promote a page into
  // primary[], only annotate entries that earned their slot via
  // semantic/lexical/exact signals AND link to another primary page.
  // Gated on `graphEnabled` so `--no-neighbors` / `--depth 0` runs
  // never surface the reason (no graph context to justify it).
  const annotatedPrimary = graphEnabled
    ? annotateGraphNeighbors(primary, snapshot.graph)
    : primary;
  return {
    version: 1,
    prompt: options.displayPrompt,
    budget: buildBudget(options.budget, 0),
    project,
    primary: annotatedPrimary,
    neighbors: expansion.neighbors,
    warnings: buildTopLevelWarnings(options.promptTruncated, semantic.warning),
    gaps: expansion.gaps,
    suggestedActions: collectSuggestedActions(recommendation, {
      hasPages: snapshot.pages.length > 0,
      semanticWarning: semantic.warning,
    }),
  };
}

/**
 * Append `graph-neighbor` to existing primary entries that have a
 * wikilink edge (outgoing OR incoming) to another primary entry. Pure:
 * never reorders, rescores, or admits new entries — only widens the
 * `reasons[]` set on entries that already passed ranking. Reasons stay
 * sorted alphabetically and de-duped so snapshot comparisons remain
 * stable.
 */
function annotateGraphNeighbors(
  primary: ContextPack["primary"],
  graph: GraphData,
): ContextPack["primary"] {
  if (primary.length < 2) return primary;
  const primaryIds = collectPrimaryIds(primary);
  const connected = new Set<PageId>();
  for (const edge of graph.edges) {
    if (primaryIds.has(edge.source) && primaryIds.has(edge.target)) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
  }
  if (connected.size === 0) return primary;
  return primary.map((entry) => {
    if (!connected.has(entry.id)) return entry;
    if (entry.reasons.includes("graph-neighbor")) return entry;
    const widened = Array.from(new Set([...entry.reasons, "graph-neighbor" as const])).sort();
    return { ...entry, reasons: widened };
  });
}

/** Collapse the ranked primary list into a Set keyed by PageId for fast lookups. */
function collectPrimaryIds(primary: ContextPack["primary"]): Set<PageId> {
  const ids = new Set<PageId>();
  for (const entry of primary) ids.add(entry.id);
  return ids;
}

/** Strip graph-derived reasons so they can be recomputed after budget trimming. */
function stripGraphNeighborReason(
  primary: ContextPack["primary"],
): ContextPack["primary"] {
  return primary.map((entry) => ({
    ...entry,
    reasons: entry.reasons.filter((reason) => reason !== "graph-neighbor"),
  }));
}

/** Reconcile graph-neighbor after trimToBudget may have removed a connected peer. */
function reconcileGraphNeighborReasons(
  pack: ContextPack,
  graph: GraphData | null,
): ContextPack {
  const stripped = stripGraphNeighborReason(pack.primary);
  const primary = graph ? annotateGraphNeighbors(stripped, graph) : stripped;
  return primary === pack.primary ? pack : { ...pack, primary };
}

/** Empty expansion used when `--no-neighbors` suppresses graph traversal. */
function emptyExpansion(): GraphExpansionOutput {
  return { neighbors: [], gaps: [] };
}

/** Materialize the `project` block; `root` honors the `--omit-root` flag. */
function buildProject(
  snapshot: ViewerSnapshot,
  state: ProjectState,
  omitRoot: boolean,
): ContextProject {
  return {
    root: omitRoot ? null : snapshot.root,
    pages: snapshot.pages.length,
    pendingCandidates: state.pendingCandidates,
    lint: state.lint.entry,
  };
}

/**
 * Top-level state warnings. Slice 1 wired `truncated-prompt`; Slice 2
 * adds the two semantic-retrieval fallback codes so consumers can tell
 * "lexical-only because no embeddings on disk" apart from "lexical-only
 * because the provider rejected our embed call."
 */
function buildTopLevelWarnings(
  promptTruncated: boolean,
  retrievalWarning: SemanticRetrievalWarning | null,
): ContextWarning[] {
  const warnings: ContextWarning[] = [];
  if (promptTruncated) {
    warnings.push({
      code: "truncated-prompt",
      message: `Prompt exceeded ${PROMPT_ECHO_MAX_LENGTH} characters; the echoed copy was truncated.`,
    });
  }
  if (retrievalWarning === "embedding-store-missing") {
    warnings.push({
      code: "embedding-store-missing",
      message:
        "No usable embedding store found; semantic retrieval skipped. " +
        "Run `llmwiki compile` to populate embeddings.",
    });
  } else if (retrievalWarning === "query-embedding-unavailable") {
    warnings.push({
      code: "query-embedding-unavailable",
      message:
        "Could not embed the prompt with the active provider; " +
        "semantic retrieval skipped, lexical signals still applied.",
    });
  } else if (retrievalWarning === "semantic-retrieval-error") {
    warnings.push({
      code: "semantic-retrieval-error",
      message:
        "Semantic retrieval failed unexpectedly; " +
        "lexical signals still applied and raw provider errors were not exposed.",
    });
  }
  return warnings;
}

/**
 * Flatten the recommendation engine's output into the array-shaped
 * `suggestedActions[]`. Per plan §Suggested Actions:
 *   - index 0 is the primary recommendation
 *   - subsequent entries are `otherActions` in declared order
 *   - tests pin the prefix only; context-specific additions land in
 *     later slices.
 */
interface ContextActionInput {
  hasPages: boolean;
  semanticWarning: SemanticRetrievalWarning | null;
}

/** Context-specific suffix: rebuild embeddings when pages exist but no store is usable. */
const CONTEXT_COMPILE_ACTION: RecommendedAction = {
  command: "llmwiki compile",
  reason: "Refresh compiled pages and rebuild the embedding store for semantic context.",
  executable: { binary: "llmwiki", args: ["compile"] },
};

/** Context-specific suffix: open the selected wiki when shared recommendations omit it. */
const CONTEXT_VIEW_ACTION: RecommendedAction = {
  command: "llmwiki view --open",
  reason: "Browse the compiled wiki in the local viewer.",
  executable: { binary: "llmwiki", args: ["view", "--open"] },
};

/** Context-specific suffix: use the same prompt to generate an answer after reviewing evidence. */
const CONTEXT_QUERY_ACTION: RecommendedAction = {
  command: 'llmwiki query "<prompt>"',
  reason: "Generate an answer with the same prompt after reviewing this context pack.",
  executable: { binary: "llmwiki", args: ["query"], placeholders: ["prompt"] },
};

function collectSuggestedActions(
  recommendation: Recommendation,
  input: ContextActionInput,
): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  for (const action of [recommendation.recommended, ...recommendation.otherActions]) {
    appendUniqueAction(actions, action);
  }
  if (input.hasPages && input.semanticWarning === "embedding-store-missing") {
    appendUniqueAction(actions, CONTEXT_COMPILE_ACTION);
  }
  if (input.hasPages) {
    appendUniqueAction(actions, CONTEXT_VIEW_ACTION);
    appendUniqueAction(actions, CONTEXT_QUERY_ACTION);
  }
  return actions;
}

/** Add `candidate` unless an equivalent executable action is already present. */
function appendUniqueAction(actions: RecommendedAction[], candidate: RecommendedAction): void {
  if (actions.some((action) => actionKey(action) === actionKey(candidate))) return;
  actions.push(candidate);
}

/** Dedupe by executable intent, falling back to display command for non-executable actions. */
function actionKey(action: RecommendedAction): string {
  if (!action.executable) return action.command ?? action.reason;
  return `${action.executable.binary} ${action.executable.args.join(" ")}`;
}

/**
 * Compute `budget.estimatedTokens` from the serialized draft and
 * trim down the lower-priority sections deterministically when the
 * draft overshoots `requestedTokens`. See `src/context/budget.ts`
 * for the trim order. Always emits valid JSON; the structured
 * envelope is mutated section-by-section rather than slicing the
 * serialized string.
 *
 * `budget.truncated` is `true` when EITHER any section was trimmed
 * OR the final estimated envelope still exceeds `requestedTokens`
 * (irreducible-envelope edge case: empty wiki + very small budget).
 * In the latter case `trimmedSections` stays `[]` — the closed
 * section-key contract is not bent to record "nothing was trimmable".
 *
 * `budget.estimatedTokens` is recomputed against the FINAL envelope
 * shape (post-trim, post-truncated-flag, post-trimmedSections) via a
 * two-pass estimate that converges on the digit-count fixed point of
 * `estimatedTokens` itself. The residual drift between the reported
 * `estimatedTokens` and `estimatePackTokens(returnedPack)` is bounded
 * to a single character of the integer's decimal representation —
 * well under one token for any realistic budget.
 */
function finalizeBudget(
  draft: ContextPack,
  requestedTokens: number,
  graph: GraphData | null = null,
): ContextPack {
  const initialEstimate = estimatePackTokens(draft);
  const trim = initialEstimate <= requestedTokens
    ? { pack: draft, trimmedSections: [] as string[] }
    : trimToBudget(draft, requestedTokens);
  const trimmedAny = trim.trimmedSections.length > 0;
  const reconciledPack = reconcileGraphNeighborReasons(trim.pack, graph);
  // First pass: write the eventual `truncated`/`trimmedSections`
  // strings into the budget block with a placeholder zero estimate so
  // the JSON shape the estimator sees matches what we'll ultimately
  // ship. Second pass: write the first estimate back and re-measure
  // so the reported value converges on the digit-count fixed point.
  const e1 = estimatePackTokens(
    applyBudget(reconciledPack, {
      requestedTokens, estimatedTokens: 0,
      truncated: trimmedAny, trimmedSections: trim.trimmedSections,
    }),
  );
  const e2 = estimatePackTokens(
    applyBudget(reconciledPack, {
      requestedTokens, estimatedTokens: e1,
      truncated: trimmedAny, trimmedSections: trim.trimmedSections,
    }),
  );
  const truncated = trimmedAny || e2 > requestedTokens;
  return applyBudget(reconciledPack, {
    requestedTokens,
    estimatedTokens: e2,
    truncated,
    trimmedSections: trim.trimmedSections,
  });
}

/** Replace `pack.budget` with `budget`, returning a fresh shallow-cloned envelope. */
function applyBudget(pack: ContextPack, budget: ContextPack["budget"]): ContextPack {
  return { ...pack, budget };
}

/**
 * Append `pending-candidates`, `lint-errors`, and
 * `source-window-unavailable` to the top-level warnings list.
 *
 * Runs AFTER source-window materialization so we can detect the gap
 * where `--include-sources` was on but a line-range citation
 * produced no window (path-confined rejection, missing source file,
 * 20-window cap reached, …). Runs BEFORE budget trimming so a
 * budget-induced window drop does NOT spuriously add the warning;
 * the trimmer mutates sourceWindows only after this pass.
 */
function appendProjectWarnings(
  pack: ContextPack,
  state: ProjectState,
  options: NormalizedOptions,
): ContextPack {
  const warnings = [...pack.warnings];
  if (state.pendingCandidates > 0) {
    warnings.push({
      code: "pending-candidates",
      message:
        `${state.pendingCandidates} review candidate${state.pendingCandidates === 1 ? "" : "s"} ` +
        "pending approval. Run `llmwiki review list` to inspect.",
    });
  }
  const lintErrors = state.lint.entry?.errors ?? 0;
  if (lintErrors > 0) {
    warnings.push({
      code: "lint-errors",
      message: `Last lint run reported ${lintErrors} error${lintErrors === 1 ? "" : "s"}.`,
    });
  }
  if (options.includeSources && hasUnmaterializedSpans(pack)) {
    warnings.push({
      code: "source-window-unavailable",
      message:
        "One or more line-range citations did not produce a source window " +
        "(path-confined, missing source file, or per-pack window cap reached).",
    });
  }
  return { ...pack, warnings };
}

/** True when any primary page has line-range citations missing matching sourceWindows. */
function hasUnmaterializedSpans(pack: ContextPack): boolean {
  for (const entry of pack.primary) {
    const lineRangeCount = entry.citations.filter(
      (c) => c.start !== undefined && c.end !== undefined,
    ).length;
    if (lineRangeCount > entry.sourceWindows.length) return true;
  }
  return false;
}
