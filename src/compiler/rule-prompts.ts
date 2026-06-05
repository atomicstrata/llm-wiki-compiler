/**
 * Rule-extraction prompt + tool schema (rule pipeline).
 *
 * Sibling of `prompts.ts`'s concept-extraction contract. Where concept
 * extraction yields prose wiki pages, rule extraction yields structured
 * `RuleCandidate.proposed` fields: a machine-actionable proposed rule with a
 * trigger predicate (`when`), an action discriminator (`then`), a category,
 * and an extraction confidence. The compiler maps this tool output into
 * `RuleCandidate` records that a downstream rule importer imports for human approval.
 *
 * The `when`/`then` language is interpreter-defined: a concise human-readable
 * condition/action string is sufficient at this stage.
 */

import type { RuleConfidence } from "../utils/rule-types.js";
import { languageDirective } from "../utils/output-language.js";

/**
 * Named version of the rule-extraction prompt + tool contract.
 *
 * Stamped onto `RuleCandidate.provenance.modelVersion` so a downstream auditor
 * can distinguish candidates produced under different prompt generations even
 * when the model id is identical. Bump on any wording change that could alter
 * extracted rules. Format is `vMAJOR`.
 */
export const RULE_PROMPT_VERSION = "v1";

/** Allowed confidence levels emitted by the rule-extraction tool schema. */
const RULE_CONFIDENCE_VALUES: RuleConfidence[] = ["low", "medium", "high"];

/**
 * Anthropic Tool definition for extracting actionable rules from a source.
 * Each extracted rule maps to a `RuleCandidate.proposed` plus `confidence`
 * and optional evidence hints (line spans within the source).
 */
export const RULE_EXTRACTION_TOOL = {
  name: "extract_rules",
  description:
    "Extract machine-actionable workflow rules from a source document. " +
    "A rule is a reusable guideline a team would want enforced.",
  input_schema: {
    type: "object" as const,
    properties: {
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "Coarse grouping for the rule, lowercase (e.g. 'process', 'security', 'docs', 'testing').",
            },
            title: {
              type: "string",
              description: "Short human-readable rule title.",
            },
            description: {
              type: "string",
              description: "What the rule enforces and why it matters.",
            },
            when: {
              type: "string",
              description:
                "Trigger predicate — a concise condition string describing when the rule should fire.",
            },
            then: {
              type: "string",
              description:
                "Action discriminator — what should happen when the rule fires (e.g. 'warn', 'block', 'suggest <x>').",
            },
            confidence: {
              type: "string",
              enum: RULE_CONFIDENCE_VALUES,
              description:
                "Extraction confidence: 'high' if directly stated, 'medium' if synthesised, 'low' if speculative.",
            },
            evidenceLineStart: {
              type: "number",
              description:
                "Optional 1-based start line in the numbered source content that supports this rule.",
            },
            evidenceLineEnd: {
              type: "number",
              description: "Optional 1-based end line supporting this rule.",
            },
          },
          required: ["category", "title", "description", "when", "then", "confidence"],
        },
      },
    },
    required: ["rules"],
  },
};

/** Build optional prompt lines, splicing the output-language directive when set. */
function withLangLine(...lines: string[]): string[] {
  const lang = languageDirective();
  return lang ? [...lines, lang] : lines;
}

/**
 * Build the system prompt for the rule-extraction phase.
 * Instructs the LLM to identify reusable, enforceable workflow rules.
 * @param sourceContent - Full text of the source document.
 * @returns System prompt string for the extraction call.
 */
export function buildRuleExtractionPrompt(sourceContent: string): string {
  return [
    ...withLangLine(
      "You are a rule extraction engine for a team-memory system. Analyze the",
      "source document and identify 1-6 reusable, enforceable workflow rules a",
      "team would want a guidance system to apply automatically.",
      "A good rule is specific, actionable, and triggerable — not a vague value.",
      "Use the extract_rules tool to return your findings.",
    ),
    "",
    "For every rule emit:",
    "  - category: lowercase coarse grouping (process, security, docs, testing, …).",
    "  - title + description: what the rule enforces and why.",
    "  - when: a concise trigger predicate (the condition that fires the rule).",
    "  - then: the action to take when it fires.",
    "  - confidence: 'high' if the source states it directly, 'medium' if you",
    "    synthesised it, 'low' if it is speculative.",
    "  - evidenceLineStart/evidenceLineEnd: the source line range supporting the",
    "    rule when you can identify it (1-based, from the numbered content below).",
    "",
    "--- SOURCE DOCUMENT ---",
    "",
    sourceContent,
  ].join("\n");
}

/** Raw rule shape as it arrives from the tool JSON, before validation. */
interface RawRule {
  category: unknown;
  title: unknown;
  description: unknown;
  when: unknown;
  then: unknown;
  confidence: unknown;
  evidenceLineStart?: unknown;
  evidenceLineEnd?: unknown;
}

/** A validated extracted rule with normalized field types. */
export interface ExtractedRule {
  category: string;
  title: string;
  description: string;
  when: string;
  then: string;
  confidence: RuleConfidence;
  evidenceLineStart?: number;
  evidenceLineEnd?: number;
}

/** True when every required string field is a non-empty string. */
function hasRequiredStrings(r: RawRule): boolean {
  const fields = [r.category, r.title, r.description, r.when, r.then];
  return fields.every((f) => typeof f === "string" && f.trim().length > 0);
}

/** True if the raw rule passes validation (required strings + known confidence). */
function isValidRawRule(r: RawRule): boolean {
  return (
    hasRequiredStrings(r) &&
    typeof r.confidence === "string" &&
    RULE_CONFIDENCE_VALUES.includes(r.confidence as RuleConfidence)
  );
}

/** Coerce an optional numeric line field; undefined when absent or invalid. */
function coerceLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Map a validated raw rule into an ExtractedRule with trimmed strings. */
function mapRawRule(r: RawRule): ExtractedRule {
  const rule: ExtractedRule = {
    category: (r.category as string).trim(),
    title: (r.title as string).trim(),
    description: (r.description as string).trim(),
    when: (r.when as string).trim(),
    then: (r.then as string).trim(),
    confidence: r.confidence as RuleConfidence,
  };
  assignEvidenceSpan(rule, coerceLine(r.evidenceLineStart), coerceLine(r.evidenceLineEnd));
  return rule;
}

/**
 * Attach a line span to a rule only when it is internally consistent. An
 * inverted span (end < start) is dropped entirely rather than shipped to the rule importer,
 * which would otherwise render a negative-length range. A lone start or end is
 * still carried — it is a valid single-anchor hint.
 */
function assignEvidenceSpan(
  rule: ExtractedRule,
  start: number | undefined,
  end: number | undefined,
): void {
  if (start !== undefined && end !== undefined && end < start) return;
  if (start !== undefined) rule.evidenceLineStart = start;
  if (end !== undefined) rule.evidenceLineEnd = end;
}

/**
 * Parse the JSON tool output from rule extraction into typed objects.
 * Malformed JSON or invalid entries are dropped rather than throwing so a
 * single bad rule never aborts a whole source's extraction.
 * @param toolOutput - Raw JSON string returned from the extract_rules tool.
 * @returns Array of validated ExtractedRule objects.
 */
export function parseRules(toolOutput: string): ExtractedRule[] {
  let parsed: { rules?: RawRule[] };
  try {
    parsed = JSON.parse(toolOutput) as { rules?: RawRule[] };
  } catch {
    return [];
  }
  const rules: RawRule[] = parsed.rules ?? [];
  return rules.filter(isValidRawRule).map(mapRawRule);
}
