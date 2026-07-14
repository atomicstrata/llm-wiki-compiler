/**
 * `llmwiki status` — read-only project status snapshot on the CLI.
 *
 * Thin wrapper over collectStatus(), the same snapshot the MCP `wiki_status`
 * tool and the SDK `status()` method return. Default output is a short human
 * summary (counts, freshness, review queue, state health); `--json` emits the
 * WikiStatus envelope verbatim for scripts and agents. Credential-free: the
 * snapshot is derived from disk (state.json, source hashes, page frontmatter)
 * with no LLM calls.
 */

import { collectStatus, type WikiStatus } from "../status/collect.js";
import * as output from "../utils/output.js";

/** CLI-supplied options for `llmwiki status`. */
export interface StatusCommandOptions {
  /** Emit the WikiStatus envelope as JSON on stdout instead of the human summary. */
  json?: boolean;
}

/**
 * Run the status command against the current working directory.
 * Always exits 0 on a successful inspection — problems (stale pages, corrupt
 * state) are reported in the output, not via the exit code.
 */
export default async function statusCommand(
  options: StatusCommandOptions = {},
): Promise<number> {
  // Quiet mode suppresses status()/verbose() so the JSON envelope on stdout
  // stays machine-parseable; the JSON itself goes through process.stdout.write,
  // which quiet mode does not intercept. Same pattern as `context --json`.
  if (options.json) output.setQuiet(true);
  try {
    const status = await collectStatus(process.cwd());
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      renderHumanStatus(status);
    }
    return 0;
  } finally {
    if (options.json) output.setQuiet(false);
  }
}

/** Max slugs shown inline on a stale/orphaned line before "+N more". */
const MAX_INLINE_SLUGS = 8;

/** Render the human-readable summary. */
function renderHumanStatus(status: WikiStatus): void {
  output.header("llmwiki status");
  output.status("i", output.info(
    `Pages: ${status.pages.concepts} concept(s), ${status.pages.queries} quer(y/ies) — ${status.pages.total} total`,
  ));
  output.status("i", output.info(`Sources: ${status.sources}`));
  output.status("i", output.dim(`Last compiled: ${status.lastCompiledAt ?? "never"}`));
  renderFreshness(status);
  renderQueues(status);
  renderProfile(status);
  for (const warning of status.warnings ?? []) {
    output.status("!", output.warn(warning.message));
  }
  renderStateHealth(status);
}

/** Stale/orphaned page lines; a single success line when everything is fresh. */
function renderFreshness(status: WikiStatus): void {
  if (status.staleCount === 0 && status.orphanedCount === 0) {
    output.status("✓", output.success("Fresh: no stale or orphaned pages"));
    return;
  }
  if (status.staleCount > 0) {
    output.status("!", output.warn(
      `Stale: ${status.staleCount} page(s): ${formatSlugList(status.stalePages, status.staleCount)} — run \`llmwiki refresh --stale\``,
    ));
  }
  if (status.orphanedCount > 0) {
    output.status("!", output.warn(
      `Orphaned: ${status.orphanedCount} page(s): ${formatSlugList(status.orphanedPages, status.orphanedCount)} — run \`llmwiki refresh --stale\``,
    ));
  }
}

/** Pending compile work and the review queue; silent when both are empty. */
function renderQueues(status: WikiStatus): void {
  if (status.pendingChangesCount > 0) {
    output.status("~", output.info(
      `Pending changes: ${status.pendingChangesCount} source(s) awaiting compile — run \`llmwiki compile\``,
    ));
  }
  if (status.pendingCandidates > 0) {
    output.status("?", output.info(
      `Pending review: ${status.pendingCandidates} candidate(s) — run \`llmwiki review list\``,
    ));
  }
}

/** One-line active-profile summary; silent for the default profile. */
function renderProfile(status: WikiStatus): void {
  if (!status.profile) return;
  const entityTotal = Object.values(status.profile.entityCounts).reduce((sum, n) => sum + n, 0);
  const problems = status.profile.problemTotal
    ? `, ${status.profile.problemTotal} problem(s) — run \`llmwiki profile validate\``
    : "";
  output.status("i", output.info(
    `Profile: ${status.profile.profileId} (${entityTotal} typed page(s)${problems})`,
  ));
}

/** Per-state recovery hints; each names the command that actually fixes that state. */
const STATE_HINTS: Record<Exclude<WikiStatus["stateStatus"], "ok">, string> = {
  missing: "no compile has run yet — run `llmwiki compile`",
  corrupt: "run `llmwiki compile` to rebuild it",
  // Compile refuses a newer-versioned state, so recompiling is NOT the fix here.
  "too-new": "written by a newer version — upgrade llmwiki (`npm install -g llm-wiki-compiler`)",
};

/** State-file health with a recovery hint when it is not ok. */
function renderStateHealth(status: WikiStatus): void {
  if (status.stateStatus === "ok") {
    output.status("✓", output.success("State: ok"));
    return;
  }
  output.status("!", output.warn(
    `State: ${status.stateStatus} — ${STATE_HINTS[status.stateStatus]}`,
  ));
}

/**
 * Join up to MAX_INLINE_SLUGS slugs, summarizing the remainder as "+N more".
 * The remainder is computed from `total` — the true count — because the slug
 * array itself is capped at MAX_STATUS_LIST and may undercount.
 */
function formatSlugList(slugs: string[], total: number): string {
  const shown = slugs.slice(0, MAX_INLINE_SLUGS).join(", ");
  const rest = total - Math.min(slugs.length, MAX_INLINE_SLUGS);
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
