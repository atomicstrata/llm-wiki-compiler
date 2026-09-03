/**
 * Shared LLM helper with provider abstraction.
 *
 * Provides callClaude() for backward compatibility — delegates to the
 * active LLMProvider while preserving retry logic with exponential backoff.
 * The provider is selected via LLMWIKI_PROVIDER env var (see provider.ts).
 */

import { RETRY_COUNT, RETRY_BASE_MS, RETRY_MULTIPLIER } from "./constants.js";
import { getProvider } from "./provider.js";
import type { LLMMessage, LLMTool } from "./provider.js";
import { note } from "./output.js";

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Matches 4xx status codes at the start of an error message, excluding 429
// (rate-limit), which is transient and worth retrying.
const NON_RETRIABLE_RE = /^4(?!29)\d\d\b/;

/** Return true for client errors that will never succeed on retry (e.g. 401, 403). */
function isNonRetriable(error: unknown): boolean {
  if ((error as { nonRetryable?: unknown })?.nonRetryable === true) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return NON_RETRIABLE_RE.test(msg);
}

/**
 * Exponential backoff with equal jitter for retry attempt N.
 *
 * The base grows as RETRY_BASE_MS * RETRY_MULTIPLIER^attempt; the returned
 * delay is a random point in [base/2, base]. The jitter matters when many
 * compile-time calls run concurrently (high LLMWIKI_COMPILE_CONCURRENCY): a
 * deterministic delay would make all of them retry in lockstep after a shared
 * rate-limit hit, producing synchronized bursts that keep tripping the limiter.
 * @param attempt - Zero-based retry attempt number.
 * @returns Delay in milliseconds for this attempt.
 */
export function computeBackoffMs(attempt: number): number {
  const base = RETRY_BASE_MS * Math.pow(RETRY_MULTIPLIER, attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

interface CallClaudeOptions {
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  maxTokens?: number;
  stream?: boolean;
  onToken?: (text: string) => void;
}

/**
 * Call the active LLM provider with retry logic.
 * Supports streaming, tool-use, and basic completion modes.
 * Preserves the original callClaude interface for backward compatibility.
 */
export async function callClaude(options: CallClaudeOptions): Promise<string> {
  const { system, messages, tools, maxTokens = 4096, stream = false, onToken } = options;
  const provider = getProvider();

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      if (stream) {
        return await provider.stream(system, messages, maxTokens, onToken);
      }

      if (tools && tools.length > 0) {
        return await provider.toolCall(system, messages, tools, maxTokens);
      }

      return await provider.complete(system, messages, maxTokens);
    } catch (error) {
      if (attempt === RETRY_COUNT || isNonRetriable(error)) throw error;

      const delayMs = computeBackoffMs(attempt);
      const errMsg = error instanceof Error ? error.message : String(error);
      note(`⚠ API call failed (attempt ${attempt + 1}/${RETRY_COUNT + 1}): ${errMsg}`);
      note(`  Retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }

  throw new Error("Unreachable");
}
