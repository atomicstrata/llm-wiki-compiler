/**
 * Rule-extraction orchestrator (radar W2).
 *
 * Drives the `RuleCandidate` producer half of the learning loop: for each
 * changed source file (gated by the same SHA-256 change detection the concept
 * compiler uses), call the LLM with the rule-extraction tool, map each
 * extracted rule into a `RuleCandidate`, and persist it under
 * `.llmwiki/rule-candidates/`.
 *
 * Provenance is stamped with the active model id (W4's `resolveActiveModelId`)
 * and the rule-prompt version so each recommendation is auditable even though
 * the extraction itself is nondeterministic. The createdAt timestamp is the
 * only nondeterministic field by design (RFC3339 wall-clock).
 */

import { readFile } from "fs/promises";
import path from "path";
import { detectChanges } from "./hasher.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { resolveActiveModelId } from "../utils/provider.js";
import { budgetAndNumberSource } from "./prompt-budget.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  readRuleState,
  updateRuleSourceState,
} from "./rule-state.js";
import {
  RULE_EXTRACTION_TOOL,
  RULE_PROMPT_VERSION,
  buildRuleExtractionPrompt,
  parseRules,
  type ExtractedRule,
} from "./rule-prompts.js";
import {
  buildRuleCandidate,
  buildRuleSlug,
  readRuleCandidate,
  sanitizeRuleCategory,
  validateRuleCandidate,
  writeRuleCandidate,
} from "./rule-candidates.js";
import { candidateFileId } from "../utils/candidate-store.js";
import { createHash } from "node:crypto";
import type { EvidenceRef, RuleCandidate, RuleProvenance } from "../utils/rule-types.js";

/** Producer tag stamped on every candidate's provenance. */
const PROVENANCE_SOURCE = "llm-wiki-compiler";

/** Structured outcome of a rules-extraction run, for CLI + programmatic use. */
export interface RuleExtractionResult {
  /** Source files processed (changed/new since last state). */
  processedSources: string[];
  /** Candidates written this run. */
  candidates: RuleCandidate[];
  /** Non-fatal problems (e.g. a source that yielded no rules). */
  notes: string[];
}

/** Determine whether a source's `source` frontmatter field is a URL. */
function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/**
 * Build the evidence list for an extracted rule from its source file.
 *
 * URL-origin sources emit a `url` evidence ref; everything else emits a `file`
 * ref keyed on the source filename, carrying the extraction's line span when
 * present. Exactly one evidence ref is produced per rule so the contract stays
 * predictable for Radar.
 */
function buildEvidence(
  sourceFile: string,
  sourceMeta: Record<string, unknown>,
  rule: ExtractedRule,
  maxLine: number,
): EvidenceRef[] {
  const origin = sourceMeta.source;
  if (isUrl(origin)) {
    return [{ kind: "url", url: origin }];
  }
  const fileRef: EvidenceRef = { kind: "file", path: sourceFile };
  // Drop spans pointing past the content actually shown to the model — an
  // out-of-bounds anchor is a hallucination, not evidence.
  if (rule.evidenceLineStart !== undefined && rule.evidenceLineStart <= maxLine) {
    fileRef.lineStart = rule.evidenceLineStart;
  }
  if (rule.evidenceLineEnd !== undefined && rule.evidenceLineEnd <= maxLine) {
    fileRef.lineEnd = rule.evidenceLineEnd;
  }
  return [fileRef];
}

/** Build the provenance stamp shared by every candidate from a run. */
function buildProvenance(): RuleProvenance {
  return {
    source: PROVENANCE_SOURCE,
    modelId: resolveActiveModelId(),
    modelVersion: RULE_PROMPT_VERSION,
  };
}

/**
 * Call the LLM with the rule-extraction tool and parse the result.
 * @param numberedContent - Source content with 1-based line numbers already
 *   prepended (and clipped to the prompt budget), so the model's line-span
 *   citations refer to anchors it can actually see.
 */
async function extractRulesFromContent(numberedContent: string): Promise<ExtractedRule[]> {
  const system = buildRuleExtractionPrompt(numberedContent);
  const raw = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the actionable rules from this source." }],
    tools: [RULE_EXTRACTION_TOOL],
  });
  return parseRules(raw);
}

/** A rule paired with the source line count the model was shown, for span bounding. */
interface RuleInContext {
  rule: ExtractedRule;
  maxLine: number;
}

/**
 * Build a candidate for a single extracted rule. The category is normalized to
 * Radar's `[a-z0-9_]` alphabet and the slug carries a content-hash suffix so
 * distinct rules never collide on the same id/file. createdAt is injected by
 * the caller for a single consistent timestamp per run.
 */
function candidateForRule(
  sourceFile: string,
  sourceMeta: Record<string, unknown>,
  context: RuleInContext,
  provenance: RuleProvenance,
  createdAt: string,
): RuleCandidate {
  const { rule, maxLine } = context;
  const signature = `${sourceFile}\n${rule.when}\n${rule.then}\n${rule.description}`;
  return buildRuleCandidate(
    {
      category: sanitizeRuleCategory(rule.category),
      slug: buildRuleSlug(rule.title, signature),
      title: rule.title,
      description: rule.description,
      when: rule.when,
      then: rule.then,
      evidence: buildEvidence(sourceFile, sourceMeta, rule, maxLine),
      provenance,
      confidence: rule.confidence,
    },
    createdAt,
  );
}

/** Process one source file end-to-end: read, number, extract, build candidates. */
async function extractForSource(
  root: string,
  sourceFile: string,
  provenance: RuleProvenance,
  createdAt: string,
): Promise<{ candidates: RuleCandidate[]; note?: string; hash: string }> {
  const sourcePath = path.join(root, SOURCES_DIR, sourceFile);
  const raw = await readFile(sourcePath, "utf-8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const { meta } = parseFrontmatter(raw);
  const numbered = budgetAndNumberSource(sourceFile, raw);
  const maxLine = numbered.split("\n").length;
  const rules = await extractRulesFromContent(numbered);
  if (rules.length === 0) {
    return { candidates: [], note: `No rules extracted from ${sourceFile}`, hash };
  }
  const candidates = rules
    .filter((rule) => slugify(rule.title).length > 0)
    .map((rule) => candidateForRule(sourceFile, meta, { rule, maxLine }, provenance, createdAt));
  return { candidates, hash };
}

/**
 * Source filenames that are new or changed since rule extraction last ran.
 * Compares against `.llmwiki/rule-state.json` — NOT the concept compiler's
 * state — so extraction has an independent change-detection cursor.
 */
async function changedSources(root: string): Promise<string[]> {
  const state = await readRuleState(root);
  const changes = await detectChanges(root, state);
  return changes
    .filter((c) => c.status === "new" || c.status === "changed")
    .map((c) => c.file);
}

/**
 * Extract rule candidates for every changed source and persist them.
 *
 * @param root - Project root directory.
 * @param createdAt - RFC3339 timestamp injected once per run for determinism in
 *   tests; defaults to the current wall-clock time.
 * @returns Structured result with processed sources, written candidates, notes.
 */
export async function extractRuleCandidates(
  root: string,
  createdAt: string = new Date().toISOString(),
): Promise<RuleExtractionResult> {
  const provenance = buildProvenance();
  const sources = await changedSources(root);

  const candidates: RuleCandidate[] = [];
  const notes: string[] = [];
  for (const sourceFile of sources) {
    const outcome = await extractForSource(root, sourceFile, provenance, createdAt);
    if (outcome.note) notes.push(outcome.note);
    for (const candidate of outcome.candidates) {
      if (await persistCandidate(root, candidate, notes)) candidates.push(candidate);
    }
    // Advance the rule cursor whether or not this source yielded candidates, so
    // an unchanged source is not re-extracted (and approvals are never re-fired)
    // on the next run.
    await updateRuleSourceState(root, sourceFile, {
      hash: outcome.hash,
      concepts: [],
      compiledAt: createdAt,
    });
  }

  return { processedSources: sources, candidates, notes };
}

/**
 * Persist a freshly-extracted candidate, refusing to clobber a human decision.
 * Returns true when the candidate was written. An existing candidate that has
 * already been approved or rejected is preserved as-is; a candidate that would
 * fail Radar's import gate is dropped with a note instead of being emitted.
 */
async function persistCandidate(
  root: string,
  candidate: RuleCandidate,
  notes: string[],
): Promise<boolean> {
  const existing = await readRuleCandidate(root, candidateFileId(candidate.id));
  if (existing && existing.status !== "proposed") {
    notes.push(`Kept ${existing.status} candidate ${candidate.id} (re-extraction did not overwrite it).`);
    return false;
  }
  const invalid = validateRuleCandidate(candidate);
  if (invalid) {
    notes.push(`Dropped candidate ${candidate.id}: ${invalid}`);
    return false;
  }
  await writeRuleCandidate(root, candidate);
  return true;
}
