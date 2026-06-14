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
};
