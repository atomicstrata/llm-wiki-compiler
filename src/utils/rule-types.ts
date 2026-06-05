/**
 * RuleCandidate protocol types (rule pipeline).
 *
 * These shapes mirror a downstream rule importer's `RuleCandidate` import contract exactly:
 * the compiler is the "recommend rules" producer in the learning loop, emitting
 * machine-actionable proposed rules that the rule importer imports and a human approves.
 *
 * Wire encoding is camelCase JSON. Evidence is a tagged union discriminated by
 * `kind`. Status and confidence are lowercase string literals. Because these
 * records cross the boundary into the rule importer, the field names and casing here are
 * load-bearing — do not rename them for local convenience.
 */

/** Confidence in an extracted rule, on the rule importer's three-level scale. */
export type RuleConfidence = "low" | "medium" | "high";

/**
 * Lifecycle status of a candidate. Newly extracted candidates are always
 * `proposed`; `approve`/`reject` flip them to `approved`/`rejected`.
 */
export type RuleStatus = "proposed" | "approved" | "rejected";

/**
 * Evidence reference backing a proposed rule. Tagged union discriminated by
 * `kind`. For compiled-wiki sources the producer emits `url` (when the source
 * is a URL) or `file` (referencing the page's `sources` filename).
 */
export type EvidenceRef =
  | { kind: "file"; path: string; lineStart?: number; lineEnd?: number }
  | { kind: "memory"; memoryId: string }
  | { kind: "audit"; auditId: string }
  | { kind: "url"; url: string };

/** The rule that a candidate becomes when approved. Starts at version 1. */
export interface ProposedRule {
  /** Stable rule id: `rule.<category>.<slug>`. */
  id: string;
  /** Coarse grouping (e.g. "process", "security", "docs"). */
  category: string;
  /** Short human-readable rule title. */
  title: string;
  /** Longer description of what the rule enforces and why. */
  description: string;
  /** Trigger predicate — a concise, interpreter-defined condition string. */
  when: string;
  /** Action discriminator emitted when the rule fires. */
  then: string;
  /** Monotonic rule version; new rules start at 1. */
  version: number;
}

/** Lineage of a candidate so a downstream auditor can trace its origin. */
export interface RuleProvenance {
  /** Producing system; always "llm-wiki-compiler" for this surface. */
  source: string;
  /** Model id the extraction ran against (W4 `resolveActiveModelId`). */
  modelId?: string;
  /** Prompt/model version stamp for auditability. */
  modelVersion?: string;
}

/**
 * A proposed rule awaiting human approval in the rule importer. Persisted as JSON under
 * `.llmwiki/rule-candidates/<id>.json` and exported as a JSON array for the rule importer
 * to consume.
 */
export interface RuleCandidate {
  /** Candidate id: `rulecand.<category>.<slug>`. */
  id: string;
  /** The rule this candidate becomes on approval. */
  proposed: ProposedRule;
  /** Evidence backing the proposal. */
  evidence: EvidenceRef[];
  /** Where this candidate came from. */
  provenance: RuleProvenance;
  /** Extraction confidence. */
  confidence: RuleConfidence;
  /** Lifecycle status: proposed → approved | rejected. */
  status: RuleStatus;
  /** RFC3339 timestamp recorded when the candidate was created. */
  createdAt: string;
}
