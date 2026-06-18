/**
 * Batch embedding primitive and its failure taxonomy.
 *
 * embedTextBatch is the single entry point both the page and chunk passes use.
 * It sub-batches a flat text list, calls the provider's native embedBatch when
 * available, validates every response (cardinality, index order, per-vector
 * integrity), and degrades to sequential embed() for the cases where that is
 * safe (no embedBatch, request-too-large, retried-transient). Integrity and
 * auth failures throw — never silently fall back.
 *
 * Imports only a TYPE from provider.ts (erased at compile) and never a value,
 * so it introduces no runtime dependency on provider.ts. The provider name for
 * batch sizing is passed in explicitly by the orchestrator.
 */

import type { LLMProvider } from "./provider.js";
import {
  EMBED_BATCH_SIZES,
  EMBED_BATCH_SIZE_FALLBACK,
  EMBED_BATCH_CAPS,
  EMBED_BATCH_CAP_FALLBACK,
  ENV_EMBED_BATCH_SIZE,
} from "./constants.js";
import * as output from "./output.js";
import { EmbeddingIntegrityError } from "./embeddings-validate.js";

// Re-export so existing test imports `{ EmbeddingIntegrityError } from embeddings-batch.js` keep working.
export { EmbeddingIntegrityError } from "./embeddings-validate.js";

/** Read a numeric HTTP status off an error if present. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isIntegrityError(err: unknown): boolean {
  return err instanceof EmbeddingIntegrityError;
}

export function isAuthError(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 401 || s === 403) return true;
  return /api[_ ]?key|unauthor|forbidden|not set/i.test(messageOf(err));
}

export function isRequestTooLarge(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 413) return true;
  if (s === 400 && /too large|maximum context|max .*token|token.*limit|payload|size/i.test(messageOf(err))) {
    return true;
  }
  return false;
}

export function isTransient(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 429 || (s !== undefined && s >= 500)) return true;
  return /etimedout|econnreset|socket hang up|network|fetch failed|timeout/i.test(messageOf(err));
}

/**
 * Resolve the embedding batch size for the active provider. Per-provider default,
 * overridable by LLMWIKI_EMBED_BATCH_SIZE (positive integer), clamped to the
 * provider's documented input cap. Invalid overrides warn and fall back.
 */
export function resolveEmbedBatchSize(providerName: string): number {
  const def = EMBED_BATCH_SIZES[providerName] ?? EMBED_BATCH_SIZE_FALLBACK;
  const cap = EMBED_BATCH_CAPS[providerName] ?? EMBED_BATCH_CAP_FALLBACK;
  const raw = process.env[ENV_EMBED_BATCH_SIZE]?.trim();
  if (!raw) return def;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    output.status("!", output.warn(`${ENV_EMBED_BATCH_SIZE}="${raw}" is not a positive integer; using ${def}.`));
    return def;
  }
  if (n > cap) {
    output.status("!", output.warn(`${ENV_EMBED_BATCH_SIZE}=${n} exceeds the ${providerName} cap; clamping to ${cap}.`));
    return cap;
  }
  return n;
}

// Placeholder — will be filled in Task 10.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function embedTextBatch(
  _provider: LLMProvider,
  _texts: string[],
  _batchSize: number,
  _expectedDim?: number,
): Promise<number[][]> {
  throw new Error("not implemented");
}
