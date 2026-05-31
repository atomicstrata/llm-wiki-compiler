/**
 * Rule-candidate JSON export (radar W2).
 *
 * Emits the persisted `RuleCandidate` records as a JSON array for Atomic Radar
 * to import. The array element shape is the canonical Radar contract verbatim
 * — camelCase keys, tagged evidence, lowercase status/confidence — because the
 * on-disk candidates are already stored in that shape. Export is a pure read +
 * filter + serialize with no LLM calls.
 *
 * Approved candidates remain in `.llmwiki/rule-candidates/` with `status:
 * "approved"` (only rejects are archived out), so export reads the live
 * candidate directory and filters by status scope.
 */

import { listRuleCandidates } from "../compiler/rule-candidates.js";
import type { RuleCandidate } from "../utils/rule-types.js";

/** Which candidates to include in an export. */
export type RuleExportScope = "approved" | "proposed" | "all";

/** Valid export scopes, used to validate CLI input. */
export const RULE_EXPORT_SCOPES: readonly RuleExportScope[] = [
  "approved",
  "proposed",
  "all",
];

/**
 * Collect rule candidates for export, filtered by status scope. Ordering is
 * the deterministic createdAt-then-id order from {@link listRuleCandidates}.
 *
 * @param root - Project root directory.
 * @param scope - "approved" (default), "proposed", or "all".
 * @returns The candidates matching the scope.
 */
export async function collectRuleCandidatesForExport(
  root: string,
  scope: RuleExportScope = "approved",
): Promise<RuleCandidate[]> {
  const all = await listRuleCandidates(root);
  if (scope === "all") return all;
  return all.filter((c) => c.status === scope);
}

/**
 * Serialize rule candidates as a pretty-printed JSON array string.
 * @param candidates - Candidates to serialize.
 * @returns JSON array string matching Radar's RuleCandidate[] contract.
 */
export function buildRuleCandidatesJson(candidates: RuleCandidate[]): string {
  return `${JSON.stringify(candidates, null, 2)}\n`;
}
