/**
 * Project-level review policy config loader.
 *
 * `.llmwiki/config.json` is intentionally fail-closed for review policy:
 * a missing file means policy off, but a present corrupt or invalid file is a
 * hard error so a typo cannot silently disable the review gate. The normalized
 * shape returned here is consumed by the compile pipeline and by tests without
 * needing to understand the raw JSON file shape.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { LLMWIKI_DIR, LOW_CONFIDENCE_THRESHOLD } from "../utils/constants.js";
import type { MissingConfidencePolicy, ReviewPolicy, ReviewPolicyMode } from "./policy.js";

/** Project config file path relative to root. */
const PROJECT_CONFIG_FILE = path.join(LLMWIKI_DIR, "config.json");

/** Normalized off policy used when config is absent or review.hold is empty. */
const REVIEW_POLICY_OFF: ReviewPolicy = {
  hold: [],
  lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
  treatMissingConfidenceAs: "low",
};

/** Error type used for fail-closed review config validation. */
export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConfigError";
  }
}

const SIGNAL_MODES: readonly ReviewPolicyMode[] = [
  "low-confidence",
  "contradicted",
  "schema-violating",
  "provenance-violating",
];

const MODE_VALUES = new Set<ReviewPolicyMode>([
  ...SIGNAL_MODES,
  "all",
  "off",
]);

/** Load and normalize review policy from `.llmwiki/config.json`. */
export async function loadReviewPolicy(root: string): Promise<ReviewPolicy> {
  const filePath = path.join(root, PROJECT_CONFIG_FILE);
  if (!existsSync(filePath)) return { ...REVIEW_POLICY_OFF };
  const raw = await readConfigJson(filePath);
  return normalizeReviewPolicy(raw);
}

/** Parse the raw JSON config or fail closed on corruption. */
async function readConfigJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ReviewConfigError(`Invalid .llmwiki/config.json: ${message}`);
  }
}

/** Normalize raw project config into review policy. */
export function normalizeReviewPolicy(raw: unknown): ReviewPolicy {
  const config = requireRecord(raw, "config");
  validateVersion(config.version);
  const review = config.review;
  if (review === undefined) return { ...REVIEW_POLICY_OFF };
  const reviewConfig = requireRecord(review, "review");
  const hold = normalizeHoldModes(reviewConfig.hold);
  if (hold.length === 0 || hold.includes("off")) {
    return { ...REVIEW_POLICY_OFF };
  }
  return {
    hold,
    lowConfidenceThreshold: normalizeThreshold(reviewConfig.lowConfidenceThreshold),
    treatMissingConfidenceAs: normalizeMissingConfidence(reviewConfig.treatMissingConfidenceAs),
  };
}

/** Return object records only; arrays/scalars are invalid config roots. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewConfigError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Validate config version when present. */
function validateVersion(version: unknown): void {
  if (version === undefined || version === 1) return;
  throw new ReviewConfigError("Unsupported .llmwiki/config.json version; expected 1");
}

/** Normalize and validate review.hold. */
function normalizeHoldModes(value: unknown): ReviewPolicyMode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ReviewConfigError("review.hold must be an array");
  const modes = value.map(readMode);
  validateModeCombination(modes);
  return [...new Set(modes)];
}

/** Validate one hold mode string. */
function readMode(value: unknown): ReviewPolicyMode {
  if (typeof value !== "string" || !MODE_VALUES.has(value as ReviewPolicyMode)) {
    throw new ReviewConfigError(`Unknown review.hold mode: ${String(value)}`);
  }
  return value as ReviewPolicyMode;
}

/** `off` and `all` are standalone by contract. */
function validateModeCombination(modes: ReviewPolicyMode[]): void {
  if (modes.length <= 1) return;
  if (modes.includes("off")) {
    throw new ReviewConfigError('review.hold mode "off" cannot be combined with other modes');
  }
  if (modes.includes("all")) {
    throw new ReviewConfigError('review.hold mode "all" cannot be combined with other modes');
  }
}

/** Normalize optional low-confidence threshold. */
function normalizeThreshold(value: unknown): number {
  if (value === undefined) return LOW_CONFIDENCE_THRESHOLD;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ReviewConfigError("review.lowConfidenceThreshold must be a finite number in [0,1]");
  }
  return value;
}

/** Normalize optional missing-confidence handling. */
function normalizeMissingConfidence(value: unknown): MissingConfidencePolicy {
  if (value === undefined) return "low";
  if (value === "low" || value === "ok") return value;
  throw new ReviewConfigError('review.treatMissingConfidenceAs must be "low" or "ok"');
}
