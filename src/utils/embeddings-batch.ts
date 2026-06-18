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
import { EmbeddingIntegrityError, assertVectorValid, assertEveryVectorValid } from "./embeddings-validate.js";

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

/** Split an array into fixed-size chunks. */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Native batch call with full response validation. Throws EmbeddingIntegrityError. */
async function validatedBatch(
  provider: LLMProvider,
  sub: string[],
  expectedDim?: number,
): Promise<number[][]> {
  const vecs = await provider.embedBatch!(sub); // already index-normalized by the provider
  if (vecs.length !== sub.length) {
    throw new EmbeddingIntegrityError(`cardinality: got ${vecs.length} for ${sub.length} inputs`);
  }
  assertEveryVectorValid(vecs, expectedDim);
  return vecs;
}

/** Validated single-item fallback path. */
async function sequentialEmbed(
  provider: LLMProvider,
  sub: string[],
  expectedDim?: number,
): Promise<number[][]> {
  const out: number[][] = [];
  for (const text of sub) {
    const v = await provider.embed(text);
    assertVectorValid(v, expectedDim);
    out.push(v);
  }
  return out;
}

/**
 * Embed one sub-batch with the fallback policy:
 *   - no embedBatch         → sequential
 *   - integrity / auth      → throw (never fall back)
 *   - request-too-large     → sequential immediately (no retry)
 *   - transient             → ONE retry; if the retry fails with another
 *                             transient/oversized error → sequential; any other
 *                             retry error (integrity, auth, unknown) → throw
 *   - unknown               → throw
 */
async function embedSubBatch(
  provider: LLMProvider,
  sub: string[],
  expectedDim?: number,
): Promise<number[][]> {
  if (!provider.embedBatch) return sequentialEmbed(provider, sub, expectedDim);
  try {
    return await validatedBatch(provider, sub, expectedDim);
  } catch (err) {
    if (isIntegrityError(err) || isAuthError(err)) throw err;
    if (isRequestTooLarge(err)) return sequentialEmbed(provider, sub, expectedDim);
    if (isTransient(err)) {
      try {
        return await validatedBatch(provider, sub, expectedDim);
      } catch (retryErr) {
        if (isTransient(retryErr) || isRequestTooLarge(retryErr)) {
          return sequentialEmbed(provider, sub, expectedDim);
        }
        throw retryErr; // integrity / auth / unknown — surface it
      }
    }
    throw err; // unknown — surface it
  }
}

/**
 * Embed `texts` in sequential sub-batches via embedSubBatch. On a terminal
 * failure, annotate the thrown error with `failedIndex` (the global index of the
 * first item in the failing sub-batch) so the page/chunk pass can name the
 * offending slug in its report. The error type is preserved (no wrapper), so
 * the taxonomy classifiers still apply to it directly.
 */
export async function embedTextBatch(
  provider: LLMProvider,
  texts: string[],
  batchSize: number,
  expectedDim?: number,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (const sub of chunked(texts, batchSize)) {
    const startIndex = out.length;
    try {
      out.push(...(await embedSubBatch(provider, sub, expectedDim)));
    } catch (err) {
      if (err && typeof err === "object" && (err as { failedIndex?: number }).failedIndex === undefined) {
        (err as { failedIndex?: number }).failedIndex = startIndex;
      }
      throw err;
    }
  }
  return out;
}
