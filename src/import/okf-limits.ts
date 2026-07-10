/**
 * @file Resource caps bounding untrusted OKF bundle ingestion (DoS guard).
 *
 * Note: imported frontmatter is bounded by `maxDocBytes` (the whole-doc cap) only —
 * v1 has no separate frontmatter byte/depth limit. This is acceptable because
 * js-yaml's default schema resolves aliases by shared reference (no billion-laughs
 * amplification) and `buildFrontmatter` re-emits frontmatter via `yaml.dump`.
 */
import type { OkfImportLimits } from "./types.js";

/** Conservative defaults; a malformed/hostile bundle is rejected, never processed unboundedly. */
export const DEFAULT_OKF_LIMITS: OkfImportLimits = {
  maxFiles: 5000,
  maxDocBytes: 2_000_000,
  maxTotalBytes: 100_000_000,
  // Total directory entries visited during the walk — bounds deep-empty-dir /
  // many-non-`.md` trees that wouldn't otherwise count toward maxFiles.
  maxEntries: 100_000,
  // Bundle-level `x-llmwiki` block caps (CLP 7.6, D-7.6.9). A block over the byte
  // cap is refused whole; an over-cap relation/workflow LIST is refused whole (a
  // partial list would misrepresent the graph) — pages still import regardless.
  maxIndexBlockBytes: 2_000_000,
  maxRelations: 10_000,
  maxWorkflowRuns: 1_000,
};
