/**
 * `llmwiki context` — agent-ready evidence pack over the compiled wiki.
 *
 * Slice 1 ships the stable v1 JSON envelope shape and a basic markdown
 * renderer over lexical-only ranking. Semantic retrieval, graph
 * expansion, source windows, and MCP land in later slices; the
 * envelope's field set is already complete (later-slice fields are
 * empty arrays / `null`) so agents written against Slice 1 keep
 * working as data fills in.
 *
 * No provider credentials are required. Empty wikis emit a stable
 * empty packet whose `suggestedActions[]` steers the user toward
 * `quickstart`/`ingest` via the shared recommendation engine.
 */

import path from "path";
import { buildContextPack } from "../context/build.js";
import type {
  ContextPack,
  ContextPrimary,
  ContextWarning,
} from "../context/types.js";
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_TOP_CHUNKS,
  DEFAULT_TOP_PAGES,
} from "../context/types.js";
import type { RecommendedAction } from "../project/recommendations.js";

/** CLI-supplied options for `llmwiki context`. */
export interface ContextCommandOptions {
  /** Token budget. Coerced from the Commander string into a number. */
  budget?: string | number;
  /** Output format; `json` wins when both `--json` and `--format` are set. */
  format?: "json" | "markdown" | string;
  /** Shortcut for `--format json`. */
  json?: boolean;
  /** Graph depth (capped at 2). 0 disables expansion the same way `--no-neighbors` does. */
  depth?: string | number;
  /** Max primary pages. */
  topPages?: string | number;
  /** Max semantic chunks; pinned default 8 even though Slice 1 emits no chunks. */
  topChunks?: string | number;
  /** Set `project.root` to `null` for privacy. */
  omitRoot?: boolean;
  /**
   * Set by Commander's `--no-neighbors` negated flag. When absent (the
   * default), graph expansion runs; when `false`, expansion is skipped
   * and both `neighbors[]` and `gaps[]` stay empty arrays.
   */
  neighbors?: boolean;
  /**
   * When true (`--include-sources`), populate
   * `primary[].sourceWindows` from claim-level citation spans, capped
   * at 20 windows per pack and 30 lines per window. Path-confined to
   * `sources/`; absolute paths, parent traversal, and symlink escapes
   * are rejected. Off by default to keep the JSON small.
   */
  includeSources?: boolean;
}

/**
 * Run the `context` command. Returns the exit code the CLI shim should
 * propagate. Always exits 0 on a successful inspection; failures
 * surface as a thrown error caught by the CLI wrapper.
 */
export default async function contextCommand(
  prompt: string,
  options: ContextCommandOptions = {},
): Promise<number> {
  const pack = await buildContextPack({
    root: process.cwd(),
    prompt,
    budget: coerceNumber(options.budget, DEFAULT_BUDGET_TOKENS),
    depth: coerceNumber(options.depth, DEFAULT_DEPTH),
    topPages: coerceNumber(options.topPages, DEFAULT_TOP_PAGES),
    topChunks: coerceNumber(options.topChunks, DEFAULT_TOP_CHUNKS),
    omitRoot: options.omitRoot === true,
    neighbors: options.neighbors,
    includeSources: options.includeSources === true,
  });
  emit(pack, resolveFormat(options));
  return 0;
}

/** Coerce a Commander string/number into a non-NaN number, falling back to `fallback`. */
function coerceNumber(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Resolve the output format; `--json` wins over `--format`. */
function resolveFormat(options: ContextCommandOptions): "json" | "markdown" {
  if (options.json === true) return "json";
  if (options.format === "json") return "json";
  return "markdown";
}

/** Write the chosen rendering to stdout. */
function emit(pack: ContextPack, format: "json" | "markdown"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderMarkdown(pack)}\n`);
}

/** Build a basic markdown rendering that mirrors the plan §Markdown Output skeleton. */
function renderMarkdown(pack: ContextPack): string {
  const lines: string[] = [];
  appendHeader(lines, pack);
  appendPrimaryPages(lines, pack.primary);
  appendGraphNeighborhood(lines, pack.neighbors);
  appendWarnings(lines, pack.warnings);
  appendSuggestedActions(lines, pack.suggestedActions);
  return lines.join("\n");
}

/**
 * `## Graph Neighborhood` block listing each emitted neighbor edge.
 * Empty `neighbors[]` (e.g. depth 0, `--no-neighbors`, or no graph
 * topology) skips the section entirely so the human output stays
 * focused on what's actually in the pack.
 */
function appendGraphNeighborhood(
  lines: string[],
  neighbors: ContextPack["neighbors"],
): void {
  if (neighbors.length === 0) return;
  lines.push("## Graph Neighborhood");
  lines.push("");
  for (const neighbor of neighbors) {
    const arrow = neighbor.direction === "outgoing" ? "->" : "<-";
    lines.push(
      `- \`${neighbor.from}\` ${arrow} \`${neighbor.to}\`` +
        ` (${neighbor.reason}, distance ${neighbor.distance})`,
    );
  }
  lines.push("");
}

/** Top block: title, prompt echo, budget line. */
function appendHeader(lines: string[], pack: ContextPack): void {
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`Prompt: ${pack.prompt}`);
  lines.push(`Budget: ${pack.budget.estimatedTokens} / ${pack.budget.requestedTokens} estimated tokens`);
}

/** `## Primary Pages` section or an empty-state placeholder. */
function appendPrimaryPages(lines: string[], primary: ContextPrimary[]): void {
  lines.push("");
  lines.push("## Primary Pages");
  lines.push("");
  if (primary.length === 0) {
    lines.push("_No primary pages matched the prompt._");
    return;
  }
  for (const page of primary) appendPrimaryPage(lines, page);
}

/** Render one `### Title` block with the page filename + ranking reasons. */
function appendPrimaryPage(lines: string[], page: ContextPrimary): void {
  const pageFile = path.join("wiki", page.pageDirectory, `${slugFromId(page.id)}.md`);
  lines.push(`### ${page.title} (\`${pageFile}\`)`);
  lines.push("");
  lines.push(`Why included: ${page.reasons.join(", ") || "(no signals)"}`);
  if (page.summary) {
    lines.push("");
    lines.push(page.summary);
  }
  appendCitations(lines, page);
  appendSourceWindows(lines, page);
  lines.push("");
}

/** `Sources: a.md:1-3, b.md` line — omitted when no citations exist. */
function appendCitations(lines: string[], page: ContextPrimary): void {
  if (page.citations.length === 0) return;
  const refs = page.citations.map(renderCitation).join(", ");
  lines.push("");
  lines.push(`Sources: ${refs}`);
}

/** Single citation reference string for the human renderer. */
function renderCitation(citation: ContextPrimary["citations"][number]): string {
  if (citation.start !== undefined && citation.end !== undefined) {
    return `\`${citation.file}:${citation.start}-${citation.end}\``;
  }
  return `\`${citation.file}\``;
}

/** `> source.md:1-3` quoted blocks for each materialized source window. */
function appendSourceWindows(lines: string[], page: ContextPrimary): void {
  if (page.sourceWindows.length === 0) return;
  for (const window of page.sourceWindows) {
    lines.push("");
    lines.push(`From \`${window.file}:${window.start}-${window.end}\`:`);
    lines.push("");
    for (const line of window.text.split(/\r?\n/)) lines.push(`> ${line}`);
  }
}

/** Page ID is `<directory>/<slug>`; pull the slug out for the filename hint. */
function slugFromId(id: string): string {
  const idx = id.indexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

/** `## Warnings` section; quietly skipped when nothing fired. */
function appendWarnings(lines: string[], warnings: ContextWarning[]): void {
  if (warnings.length === 0) return;
  lines.push("## Warnings");
  lines.push("");
  for (const warning of warnings) lines.push(`- ${warning.message}`);
  lines.push("");
}

/** `## Suggested Next Actions`; surfaces the recommendation prefix. */
function appendSuggestedActions(lines: string[], actions: RecommendedAction[]): void {
  if (actions.length === 0) return;
  lines.push("## Suggested Next Actions");
  lines.push("");
  for (const action of actions) {
    if (action.command) lines.push(`- \`${action.command}\``);
  }
}
