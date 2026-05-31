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
import { readState } from "../utils/state.js";
import { detectChanges } from "./hasher.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { resolveActiveModelId } from "../utils/provider.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  RULE_EXTRACTION_TOOL,
  RULE_PROMPT_VERSION,
  buildRuleExtractionPrompt,
  parseRules,
  type ExtractedRule,
} from "./rule-prompts.js";
import {
  buildRuleCandidate,
  writeRuleCandidate,
} from "./rule-candidates.js";
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
): EvidenceRef[] {
  const origin = sourceMeta.source;
  if (isUrl(origin)) {
    return [{ kind: "url", url: origin }];
  }
  const fileRef: EvidenceRef = { kind: "file", path: sourceFile };
  if (rule.evidenceLineStart !== undefined) {
    fileRef.lineStart = rule.evidenceLineStart;
  }
  if (rule.evidenceLineEnd !== undefined) {
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

/** Call the LLM with the rule-extraction tool and parse the result. */
async function extractRulesFromContent(content: string): Promise<ExtractedRule[]> {
  const system = buildRuleExtractionPrompt(content);
  const raw = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the actionable rules from this source." }],
    tools: [RULE_EXTRACTION_TOOL],
  });
  return parseRules(raw);
}

/**
 * Build a candidate for a single extracted rule. The slug is derived from the
 * rule title; createdAt is injected by the caller for a single consistent
 * timestamp per run.
 */
function candidateForRule(
  sourceFile: string,
  sourceMeta: Record<string, unknown>,
  rule: ExtractedRule,
  provenance: RuleProvenance,
  createdAt: string,
): RuleCandidate {
  return buildRuleCandidate(
    {
      category: slugify(rule.category) || "general",
      slug: slugify(rule.title),
      title: rule.title,
      description: rule.description,
      when: rule.when,
      then: rule.then,
      evidence: buildEvidence(sourceFile, sourceMeta, rule),
      provenance,
      confidence: rule.confidence,
    },
    createdAt,
  );
}

/** Process one source file end-to-end: read, extract, build candidates. */
async function extractForSource(
  root: string,
  sourceFile: string,
  provenance: RuleProvenance,
  createdAt: string,
): Promise<{ candidates: RuleCandidate[]; note?: string }> {
  const sourcePath = path.join(root, SOURCES_DIR, sourceFile);
  const raw = await readFile(sourcePath, "utf-8");
  const { meta } = parseFrontmatter(raw);
  const rules = await extractRulesFromContent(raw);
  if (rules.length === 0) {
    return { candidates: [], note: `No rules extracted from ${sourceFile}` };
  }
  const candidates = rules
    .filter((rule) => slugify(rule.title).length > 0)
    .map((rule) => candidateForRule(sourceFile, meta, rule, provenance, createdAt));
  return { candidates };
}

/** Source filenames that are new or changed since the last recorded state. */
async function changedSources(root: string): Promise<string[]> {
  const state = await readState(root);
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
      await writeRuleCandidate(root, candidate);
      candidates.push(candidate);
    }
  }

  return { processedSources: sources, candidates, notes };
}
