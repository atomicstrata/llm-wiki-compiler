/**
 * Pure recommendation rules for `llmwiki next`.
 *
 * Classifies a {@link ProjectState} snapshot into exactly one of seven
 * primary states and produces a primary {@link RecommendedAction} plus
 * the per-state `otherActions` table from the implementation plan.
 *
 * Actions with user-supplied input (a source path, a question, a
 * candidate id) are templates: the display `command` carries a
 * `<placeholder>` and `executable.placeholders` lists the slots. Agents
 * must populate placeholders themselves; the contract never returns a
 * shell-ready command line.
 */

import type { ProjectState } from "./state.js";

/** Primary state enum surfaced as `state` in the JSON envelope. */
export type ProjectStateKind =
  | "fresh"
  | "sources-only"
  | "review-pending"
  | "lint-attention"
  | "wiki-ready"
  | "empty-wiki"
  | "broken-project";

/** Single recommended action; `command` is for display, `executable` is for agents. */
export interface RecommendedAction {
  command: string | null;
  reason: string;
  executable: ExecutableSpec | null;
}

/** Structured form of an executable command. Placeholders are slot names, not literals. */
interface ExecutableSpec {
  binary: "llmwiki";
  args: string[];
  placeholders?: string[];
}

/** Full recommendation envelope returned to the renderer. */
export interface Recommendation {
  state: ProjectStateKind;
  recommended: RecommendedAction;
  otherActions: RecommendedAction[];
}

/**
 * Classify a ProjectState and produce its primary + secondary actions.
 * Precedence (top wins): broken-project, fresh, sources-only,
 * review-pending, lint-attention, wiki-ready, empty-wiki.
 */
export function recommendNextAction(state: ProjectState): Recommendation {
  const kind = classifyState(state);
  return { state: kind, recommended: primaryAction(kind), otherActions: otherActionsFor(kind) };
}

/** Apply the precedence rules from the spec to choose the primary state kind. */
function classifyState(state: ProjectState): ProjectStateKind {
  if (isBrokenProject(state)) return "broken-project";
  if (isSourcesOnly(state)) return "sources-only";
  if (state.pendingCandidates > 0) return "review-pending";
  if (hasLintErrors(state)) return "lint-attention";
  if (hasWikiPages(state)) return "wiki-ready";
  if (isEmptyWiki(state)) return "empty-wiki";
  return "fresh";
}

/** True when the collector flagged the root as unreadable. */
function isBrokenProject(state: ProjectState): boolean {
  return state.warnings.some((w) => w.code === "project-unreadable");
}

/**
 * `empty-wiki` requires `wiki/` to actually exist with zero pages. The
 * spec wording is "wiki/ exists but page count is zero", and the human
 * renderer says so — we must not surface that line when wiki/ is missing.
 */
function isEmptyWiki(state: ProjectState): boolean {
  return state.hasWikiDir && !hasWikiPages(state);
}

/** Sources exist but no concept or query pages have been compiled yet. */
function isSourcesOnly(state: ProjectState): boolean {
  return state.sourceCount > 0 && !hasWikiPages(state);
}

/** True when the lint cache parsed and reports at least one error. */
function hasLintErrors(state: ProjectState): boolean {
  return state.lint.entry !== null && state.lint.entry.errors > 0;
}

/** True when the wiki carries any concept or query page. */
function hasWikiPages(state: ProjectState): boolean {
  return state.conceptCount > 0 || state.queryCount > 0;
}

/** Map a state kind to its primary recommended action. */
function primaryAction(kind: ProjectStateKind): RecommendedAction {
  return PRIMARY_ACTIONS[kind];
}

/** Map a state kind to its `otherActions` list. */
function otherActionsFor(kind: ProjectStateKind): RecommendedAction[] {
  return OTHER_ACTIONS[kind].map((a) => ({ ...a }));
}

/** Template action: `llmwiki quickstart <source>` with a `source` placeholder. */
const QUICKSTART_ACTION: RecommendedAction = {
  command: "llmwiki quickstart <source>",
  reason: "Ingest a source and compile a wiki in one step.",
  executable: { binary: "llmwiki", args: ["quickstart"], placeholders: ["source"] },
};

/** Template action: `llmwiki ingest <source>`. */
const INGEST_ACTION: RecommendedAction = {
  command: "llmwiki ingest <source>",
  reason: "Add sources manually before compiling.",
  executable: { binary: "llmwiki", args: ["ingest"], placeholders: ["source"] },
};

/** Bare action: `llmwiki compile`. */
const COMPILE_ACTION: RecommendedAction = {
  command: "llmwiki compile",
  reason: "Compile sources/ into wiki pages.",
  executable: { binary: "llmwiki", args: ["compile"] },
};

/** Bare action: `llmwiki review list`. */
const REVIEW_LIST_ACTION: RecommendedAction = {
  command: "llmwiki review list",
  reason: "List pending candidate pages.",
  executable: { binary: "llmwiki", args: ["review", "list"] },
};

/** Template action: `llmwiki review approve <id>`. */
const REVIEW_APPROVE_ACTION: RecommendedAction = {
  command: "llmwiki review approve <id>",
  reason: "Approve a candidate after inspecting it with `llmwiki review show <id>`.",
  executable: { binary: "llmwiki", args: ["review", "approve"], placeholders: ["id"] },
};

/** Bare action: `llmwiki lint`. */
const LINT_ACTION: RecommendedAction = {
  command: "llmwiki lint",
  reason: "Re-run lint to inspect outstanding errors.",
  executable: { binary: "llmwiki", args: ["lint"] },
};

/** Bare action: `llmwiki view --open`. */
const VIEW_OPEN_ACTION: RecommendedAction = {
  command: "llmwiki view --open",
  reason: "Browse the compiled wiki in the local viewer.",
  executable: { binary: "llmwiki", args: ["view", "--open"] },
};

/** Template action: `llmwiki query "<question>"`. */
const QUERY_ACTION: RecommendedAction = {
  command: 'llmwiki query "<question>"',
  reason: "Ask a natural-language question against the compiled wiki.",
  executable: { binary: "llmwiki", args: ["query"], placeholders: ["question"] },
};

/** Sentinel for the broken-project state: no command, no executable. */
const BROKEN_PROJECT_ACTION: RecommendedAction = {
  command: null,
  reason: "Project root is unreadable or could not be inspected.",
  executable: null,
};

/** Primary recommendation for each state kind. */
const PRIMARY_ACTIONS: Record<ProjectStateKind, RecommendedAction> = {
  "broken-project": BROKEN_PROJECT_ACTION,
  fresh: { ...QUICKSTART_ACTION, reason: "No sources or wiki pages were found." },
  "sources-only": { ...COMPILE_ACTION, reason: "Sources exist but no wiki pages have been compiled." },
  "review-pending": { ...REVIEW_LIST_ACTION, reason: "Generated candidates are waiting for review." },
  "lint-attention": { ...LINT_ACTION, reason: "Lint has reported errors; rerun lint to inspect them." },
  "wiki-ready": { ...VIEW_OPEN_ACTION, reason: "Wiki pages are ready to browse." },
  "empty-wiki": {
    ...COMPILE_ACTION,
    reason: "wiki/ exists but is empty; run compile or add sources first.",
  },
};

/** Per-state otherActions table from the implementation plan (Slice 1 scope). */
const OTHER_ACTIONS: Record<ProjectStateKind, RecommendedAction[]> = {
  fresh: [INGEST_ACTION, QUICKSTART_ACTION],
  "sources-only": [COMPILE_ACTION, QUICKSTART_ACTION],
  "empty-wiki": [COMPILE_ACTION, INGEST_ACTION],
  "review-pending": [REVIEW_LIST_ACTION, REVIEW_APPROVE_ACTION],
  "lint-attention": [LINT_ACTION, VIEW_OPEN_ACTION],
  "wiki-ready": [VIEW_OPEN_ACTION, QUERY_ACTION],
  "broken-project": [],
};
