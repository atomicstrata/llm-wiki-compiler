/**
 * `llmwiki next` — read-only project-state orientation command.
 *
 * Inspects the current working directory, classifies it into one of the
 * seven project states, and prints either a short human summary or a
 * stable JSON envelope (`--json`). The JSON envelope is `version: 1`
 * and is incremented independently from `quickstart`'s JSON version.
 *
 * Never writes files. Never acquires locks. Exits 0 for any successful
 * inspection (including states with lint errors); exits 1 only for
 * unexpected filesystem failures.
 */

import { collectProjectState } from "../project/state.js";
import type { ProjectState, ProjectStateWarning } from "../project/state.js";
import { recommendNextAction } from "../project/recommendations.js";
import type {
  ProjectStateKind,
  Recommendation,
  RecommendedAction,
} from "../project/recommendations.js";

type StateLineRenderer = (state: ProjectState) => string;

/** Options surfaced by Commander for `llmwiki next`. */
interface NextCommandOptions {
  json?: boolean;
}

/** Versioned JSON envelope shape — incremented independently from quickstart. */
const NEXT_JSON_VERSION = 1;

const STATE_LINE_RENDERERS: Record<ProjectStateKind, StateLineRenderer> = {
  "broken-project": () => "project root unreadable",
  fresh: () => "no llmwiki project detected",
  "sources-only": (state) =>
    `${state.sourceCount} source${plural(state.sourceCount)}, no wiki pages yet`,
  "review-pending": (state) =>
    `review pending, ${state.pendingCandidates} candidate${plural(state.pendingCandidates)}`,
  "lint-attention": formatLintAttentionLine,
  "empty-wiki": () => "wiki/ exists but is empty",
  "wiki-ready": formatWikiReadyLine,
};

/**
 * Run the `next` command. Stdout receives the human or JSON payload;
 * never throws on filesystem absence (handled by the collector). Returns
 * the exit code the CLI wrapper should propagate.
 */
export default async function nextCommand(options: NextCommandOptions = {}): Promise<number> {
  const state = await collectProjectState(process.cwd());
  const recommendation = recommendNextAction(state);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildJsonPayload(state, recommendation), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(state, recommendation)}\n`);
  }
  return 0;
}

/** JSON envelope for `--json`. Field order and shape pinned by snapshot tests. */
function buildJsonPayload(state: ProjectState, recommendation: Recommendation): JsonPayload {
  return {
    version: NEXT_JSON_VERSION,
    projectRoot: state.root,
    state: recommendation.state,
    summary: buildSummary(state),
    recommended: recommendation.recommended,
    otherActions: recommendation.otherActions,
    warnings: state.warnings,
  };
}

/** Top-level JSON envelope. */
interface JsonPayload {
  version: number;
  projectRoot: string;
  state: ProjectStateKind;
  summary: JsonSummary;
  recommended: RecommendedAction;
  otherActions: RecommendedAction[];
  warnings: ProjectStateWarning[];
}

/** `summary` sub-envelope; lint follows the three-state contract. */
interface JsonSummary {
  sourceCount: number;
  conceptCount: number;
  queryCount: number;
  pendingCandidates: number;
  hasIndex: boolean;
  hasLintCache: boolean;
  lint: { warnings: number; errors: number; at: string } | null;
  /** Stale/orphaned counts from the last lint, or null when lint has not run. */
  freshness: { stalePages: number; orphanedPages: number } | null;
}

/** Build the `summary` block, mapping LintCacheStatus to the documented shape. */
function buildSummary(state: ProjectState): JsonSummary {
  return {
    sourceCount: state.sourceCount,
    conceptCount: state.conceptCount,
    queryCount: state.queryCount,
    pendingCandidates: state.pendingCandidates,
    hasIndex: state.hasIndex,
    hasLintCache: state.lint.present,
    lint: state.lint.entry
      ? { warnings: state.lint.entry.warnings, errors: state.lint.entry.errors, at: state.lint.entry.at }
      : null,
    freshness: state.lint.entry?.freshness ?? null,
  };
}

/** Render the human output. Header + state line + recommended + other actions. */
function renderHuman(state: ProjectState, recommendation: Recommendation): string {
  const lines: string[] = [];
  lines.push("llmwiki next");
  lines.push("------------");
  lines.push("");
  lines.push(`Project: ${state.root}`);
  lines.push(`State: ${describeStateLine(state, recommendation.state)}`);
  appendHumanRecommendation(lines, recommendation.recommended);
  appendHumanOtherActions(lines, recommendation.otherActions);
  appendHumanWarnings(lines, state.warnings);
  return lines.join("\n");
}

/** Append the recommended-action block (label + command line). */
function appendHumanRecommendation(lines: string[], action: RecommendedAction): void {
  lines.push("");
  lines.push("Recommended next action:");
  lines.push(`  ${action.command ?? action.reason}`);
}

/** Append the other-actions list when present; quietly skip when empty. */
function appendHumanOtherActions(lines: string[], actions: RecommendedAction[]): void {
  if (actions.length === 0) return;
  lines.push("");
  lines.push("Other useful actions:");
  for (const action of actions) {
    if (action.command) lines.push(`  ${action.command}`);
  }
}

/** Surface structural warnings as a short "Notes" block under the actions. */
function appendHumanWarnings(lines: string[], warnings: ProjectStateWarning[]): void {
  if (warnings.length === 0) return;
  lines.push("");
  lines.push("Notes:");
  for (const warning of warnings) lines.push(`  - ${warning.message}`);
}

/** Human-friendly state-line description; pairs the state kind with key counters. */
function describeStateLine(state: ProjectState, kind: ProjectStateKind): string {
  return STATE_LINE_RENDERERS[kind](state);
}

/** Ready-state summary keeps page and pending-candidate counts visible. */
function formatWikiReadyLine(state: ProjectState): string {
  return `wiki ready, ${pageTotal(state)} page${plural(pageTotal(state))}, ${state.pendingCandidates} pending candidate${plural(state.pendingCandidates)}`;
}

/** Lint-attention line surfaces error and warning counts the user just learned about. */
function formatLintAttentionLine(state: ProjectState): string {
  const entry = state.lint.entry;
  if (!entry) return "lint cache reports errors";
  return `lint reports ${entry.errors} error${plural(entry.errors)}, ${entry.warnings} warning${plural(entry.warnings)}`;
}

/** Total compiled page count across concepts and queries. */
function pageTotal(state: ProjectState): number {
  return state.conceptCount + state.queryCount;
}

/** Return "s" for any count other than 1; used for inline pluralization. */
function plural(count: number): string {
  return count === 1 ? "" : "s";
}
