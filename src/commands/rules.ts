/**
 * Commander actions for `llmwiki rules …` (radar W2).
 *
 * The rule-candidate lifecycle mirrors the concept review flow but emits
 * structured `RuleCandidate` records for Atomic Radar instead of prose pages:
 *
 *   rules extract            — LLM-extract rules from changed sources into
 *                              .llmwiki/rule-candidates/<id>.json (status proposed)
 *   rules list               — list pending candidates
 *   rules approve <id>       — flip status → approved (in place)
 *   rules reject  <id>       — flip status → rejected, archive out of pending
 *   rules export [--scope]   — write the candidate array as JSON for Radar
 *
 * Mutations run under `.llmwiki/lock` to serialize against a concurrent
 * extract/approve/reject, matching the concept review lock discipline.
 */

import { existsSync } from "fs";
import path from "path";
import { atomicWrite } from "../utils/markdown.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  extractRuleCandidates,
  type RuleExtractionResult,
} from "../compiler/rule-extractor.js";
import {
  archiveRuleCandidate,
  readRuleCandidate,
  setRuleCandidateStatus,
} from "../compiler/rule-candidates.js";
import { candidateFileId } from "../utils/candidate-store.js";
import {
  RULE_EXPORT_SCOPES,
  buildRuleCandidatesJson,
  collectRuleCandidatesForExport,
  type RuleExportScope,
} from "../export/rule-candidates-json.js";

/** Default output path (relative to root) for `rules export`. */
const RULE_EXPORT_PATH = "dist/exports/rule-candidates.json";

/**
 * Extract rule candidates from changed sources. Requires the sources/ folder
 * and an available provider (the caller's CLI guard enforces the latter).
 */
export async function rulesExtractCommand(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(path.join(root, SOURCES_DIR))) {
    output.status("!", output.warn("No sources found. Run `llmwiki ingest <url>` first."));
    return;
  }

  const locked = await acquireLock(root);
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    output.header("Extracting rule candidates");
    reportExtraction(await extractRuleCandidates(root));
  } finally {
    await releaseLock(root);
  }
}

/** Print extraction notes, each candidate, and a one-line summary. */
function reportExtraction(result: RuleExtractionResult): void {
  for (const note of result.notes) output.status("i", output.dim(note));
  for (const candidate of result.candidates) {
    output.status("?", output.info(`Rule candidate ready: ${candidate.id}`));
  }
  output.status(
    "✓",
    output.success(
      `${result.candidates.length} rule candidate(s) from ${result.processedSources.length} source(s).`,
    ),
  );
}

/** List pending rule candidates with their proposed-rule summary line. */
export async function rulesListCommand(): Promise<void> {
  const pending = await collectRuleCandidatesForExport(process.cwd(), "proposed");
  if (pending.length === 0) {
    output.status("i", output.dim("No pending rule candidates."));
    return;
  }
  for (const c of pending) {
    output.status(
      "?",
      output.info(`${c.id} [${c.confidence}] — ${c.proposed.title}`),
    );
  }
}

/** Approve a candidate by flipping its status to "approved" under the lock. */
export async function rulesApproveCommand(id: string): Promise<void> {
  await mutateUnderLock(id, async (root, fileId) => {
    const updated = await setRuleCandidateStatus(root, fileId, "approved");
    if (!updated) return false;
    output.status("+", output.success(`Approved rule candidate ${updated.id}.`));
    return true;
  });
}

/** Reject a candidate: flip status to "rejected" then archive it out of pending. */
export async function rulesRejectCommand(id: string): Promise<void> {
  await mutateUnderLock(id, async (root, fileId) => {
    const updated = await setRuleCandidateStatus(root, fileId, "rejected");
    if (!updated) return false;
    await archiveRuleCandidate(root, fileId);
    output.status("-", output.warn(`Rejected rule candidate ${updated.id} — archived.`));
    return true;
  });
}

/**
 * Export rule candidates as a JSON array for Radar. Defaults to approved-only;
 * `--scope proposed|all` widens the selection. Writes to
 * dist/exports/rule-candidates.json.
 */
export async function rulesExportCommand(options: { scope?: string } = {}): Promise<void> {
  const root = process.cwd();
  const scope = resolveScope(options.scope);
  const candidates = await collectRuleCandidatesForExport(root, scope);
  const outPath = path.join(root, RULE_EXPORT_PATH);
  await atomicWrite(outPath, buildRuleCandidatesJson(candidates));
  output.status(
    "+",
    output.success(`Exported ${candidates.length} rule candidate(s) → ${output.source(outPath)}`),
  );
}

/** Validate the --scope flag, defaulting to "approved". Throws on bad input. */
function resolveScope(raw: string | undefined): RuleExportScope {
  if (!raw) return "approved";
  if (!(RULE_EXPORT_SCOPES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown --scope value "${raw}". Valid: ${RULE_EXPORT_SCOPES.join(", ")}`,
    );
  }
  return raw as RuleExportScope;
}

/**
 * Shared approve/reject skeleton: pre-check the candidate exists, acquire the
 * lock, re-read under it (TOCTOU guard), run the mutation, release. Sets exit
 * code 1 when the candidate is missing at either check.
 */
async function mutateUnderLock(
  id: string,
  underLock: (root: string, fileId: string) => Promise<boolean>,
): Promise<void> {
  const root = process.cwd();
  const fileId = candidateFileId(id);

  const preCheck = await readRuleCandidate(root, fileId);
  if (!preCheck) {
    output.status("!", output.error(`Rule candidate not found: ${id}`));
    process.exitCode = 1;
    return;
  }

  const locked = await acquireLock(root);
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    const ok = await underLock(root, fileId);
    if (!ok) {
      output.status("!", output.error(`Rule candidate ${id} was removed during review.`));
      process.exitCode = 1;
    }
  } finally {
    await releaseLock(root);
  }
}
