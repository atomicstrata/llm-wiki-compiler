/**
 * Type definitions for the wiki linter.
 * Defines the shape of lint results, summaries, and rule functions
 * used across all lint rules and the orchestrator.
 */

export interface LintResult {
  rule: string;
  severity: "error" | "warning" | "info";
  file: string;
  message: string;
  line?: number;
  /**
   * Declared entity type a finding belongs to, set only by profile-aware
   * checks over non-default entity pages. Default-profile findings omit it,
   * so the field is absent (not `undefined`) on the default lint output and
   * the frozen parity golden stays byte-identical.
   */
  entityType?: string;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  info: number;
  results: LintResult[];
}

export type LintRule = (root: string) => Promise<LintResult[]>;

/**
 * Schema-aware lint rule signature. Some rules need the resolved schema
 * (e.g., per-kind cross-link minimums) and would require redundant disk
 * reads to load it themselves on every call.
 */
export type SchemaAwareLintRule = (
  root: string,
  schema: import("../schema/index.js").SchemaConfig,
) => Promise<LintResult[]>;
