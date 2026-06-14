/** @file Resource caps bounding untrusted OKF bundle ingestion (DoS guard). */
import type { OkfImportLimits } from "./types.js";

/** Conservative defaults; a malformed/hostile bundle is rejected, never processed unboundedly. */
export const DEFAULT_OKF_LIMITS: OkfImportLimits = {
  maxFiles: 5000,
  maxDocBytes: 2_000_000,
  maxTotalBytes: 100_000_000,
};
