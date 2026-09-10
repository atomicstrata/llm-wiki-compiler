/**
 * Embedding store shape and persistence.
 *
 * Owns the logical embedding contract (types, version, read/write facade) and
 * the active embedding CONFIGURATION resolution — the
 * provider backend, endpoint, and model that together tag and validate a store.
 * No retrieval or embedding logic lives here — this is the base module every
 * other embeddings-* module uses. Format selection and atomic persistence live
 * in embeddings-storage.ts; logical v1/v2/v3 migration remains unchanged.
 *
 * Confinement + resource-cap policy (B1):
 *  - READ: no mkdir on clean projects; no-follow, size-capped reads select an
 *    authoritative binary leaf before legacy JSON. Refusal never revives JSON.
 *  - WRITE: small stores retain JSON; oversized stores automatically use one
 *    binary container. Binary limits are enforced before atomic replacement.
 *  - Field caps and identity filtering handled by embeddings-validate.ts.
 *
 * Version-discriminated access (B3, §4.3):
 *  - {@link parseEmbeddingStore} — structural version discriminator; does NOT run
 *    v3-only id/grammar validation. Unknown/malformed → null.
 *  - {@link validateV3ForSearch} — strict read-time validator; shared vector/integrity
 *    checks for any version PLUS a v3-only pageId/embeddingTextHash grammar stub.
 *  - {@link readStoreForUpdate} — write-path read; accepts a v2 store WITHOUT
 *    calling validateV3ForSearch on it, so migration can transform it safely.
 */

import { NoFollowOpenError, openFileNoFollow } from "./no-follow-open.js";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "path";
import {
  getActiveEmbeddingProviderName,
  hasEmbeddingConfigurationOverride,
  resolveEmbeddingBackend,
  resolveEmbeddingEndpoint,
} from "./embedding-provider.js";
import { EMBEDDINGS_FILE, EMBEDDING_MODELS, MAX_EMBEDDING_STORE_BYTES } from "./constants.js";
import { assertEmbeddingStoreValid, filterMalformedIdentities, assertFieldCaps } from "./embeddings-validate.js";
import { resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";
import { readStoredEmbeddings, persistEmbeddingStore, type ParsedStore } from "./embeddings-storage.js";
export { parseEmbeddingStore, type ParsedStore } from "./embeddings-storage.js";
export { EmbeddingStoreFullError } from "./embeddings-errors.js";

/**
 * Current store version. Bumped 1 → 2 when chunk entries were added, and
 * 2 → 3 when records were re-keyed from a bare `slug` to a qualified `pageId`
 * (`<namespace>/<page-part>`) and a page `embeddingTextHash` was added. The live
 * writer now persists v3; v1/v2 stores on disk are migrated on the next write.
 */
export const STORE_VERSION = 3 as const;

/** A single embedded page record. */
export interface EmbeddingEntry {
  slug: string;
  title: string;
  summary: string;
  vector: number[];
  updatedAt: string;
}

/** A single embedded chunk drawn from a page body. */
export interface ChunkEmbeddingEntry {
  slug: string;
  title: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  vector: number[];
  updatedAt: string;
}

/** Root shape of .llmwiki/embeddings.json. */
export interface EmbeddingStore {
  version: 1 | 2;
  model: string;
  dimensions: number;
  entries: EmbeddingEntry[];
  /** Optional in v2 stores; absent in v1 stores. */
  chunks?: ChunkEmbeddingEntry[];
}

// ---------------------------------------------------------------------------
// v3 record types
// ---------------------------------------------------------------------------

/**
 * A single page embedding record in a v3 store.
 * Uses a qualified `pageId` (`<namespace>/<page-part>`) instead of a bare slug,
 * and includes an `embeddingTextHash` covering the exact text sent to the provider.
 */
export interface PageEmbeddingV3 {
  pageId: PageId;
  title: string;
  summary: string;
  /** SHA-256 (hex) of the exact string passed to the embedding provider. */
  embeddingTextHash: string;
  vector: number[];
  updatedAt: string;
}

/**
 * A single chunk embedding record in a v3 store.
 * Chunk identity is always the pair `(pageId, chunkIndex)` — never a
 * delimited string like `${pageId}#${chunkIndex}`.
 */
export interface ChunkEmbeddingV3 {
  pageId: PageId;
  title: string;
  /** Zero-based chunk position within the page body. */
  chunkIndex: number;
  /** SHA-256 (hex) of the chunk text (for hash-based reuse). */
  contentHash: string;
  text: string;
  vector: number[];
  updatedAt: string;
}

/** Logical root shape of a v3 embedding store in either encoding. */
export interface EmbeddingStoreV3 {
  version: 3;
  model: string;
  /**
   * Identity of the configuration that produced these vectors — see
   * {@link resolveEmbeddingFingerprint}. Optional: a store written before this
   * field existed has none, and is compared on `model` alone so upgrading does
   * not force an unrequested re-embed of the whole wiki.
   */
  fingerprint?: string;
  dimensions: number;
  entries: PageEmbeddingV3[];
  chunks?: ChunkEmbeddingV3[];
}

/**
 * Legacy raw-JSON compatibility reader, not the format-aware production loader.
 * Resolves the .llmwiki dir, opens embeddings.json with
 * O_RDONLY|O_NOFOLLOW (symlinked leaf → null), fstat-caps the size, and returns
 * the raw UTF-8 content. Returns null for all unavailable/absent/oversized cases.
 */
export async function readConfinedRaw(root: string): Promise<string | null> {
  const dir = await resolveExistingConfinedPrivateDir(root);
  if (dir === null) return null;
  const filePath = path.join(dir, path.basename(EMBEDDINGS_FILE));
  let handle;
  try {
    handle = await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof NoFollowOpenError || code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > MAX_EMBEDDING_STORE_BYTES) return null;
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Read the authoritative binary or legacy JSON store with confinement + size cap.
 * Returns null when:
 *  - .llmwiki does not exist (clean project — no mkdir);
 *  - embeddings.json does not exist;
 *  - embeddings.json is a symlink (O_NOFOLLOW → ELOOP, fail closed);
 *  - the file exceeds {@link MAX_EMBEDDING_STORE_BYTES} (fstat cap, no full parse);
 *  - the store fails vector integrity validation (whole store unavailable).
 * A symlinked .llmwiki dir throws (fail closed via private-dir confinement).
 */
export async function readEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  const result = await readStoredEmbeddings(root);
  if (result.kind !== "parsed") return null;
  try {
    const parsed = result.parsed.store;
    filterMalformedIdentities(parsed);
    assertEmbeddingStoreValid(parsed);
    return parsed as unknown as EmbeddingStore;
  } catch {
    return null;
  }
}

/**
 * Validate and atomically persist through the format-aware confined writer.
 * JSON overflow selects binary without repeating provider work; exceeding binary
 * limits throws EmbeddingStoreFullError. Creates `.llmwiki` only for a write.
 */
export async function writeEmbeddingStore(
  root: string,
  store: EmbeddingStore | EmbeddingStoreV3,
): Promise<void> {
  assertEmbeddingStoreValid(store);
  assertFieldCaps(store as unknown as Record<string, unknown>);
  await persistEmbeddingStore(root, store);
}

/** Result of {@link validateV3ForSearch}. */
export interface SearchValidationResult {
  /** False when the whole store is unavailable (bad vectors or over-cap). */
  available: boolean;
  /** Warning messages for records dropped for malformed identity during this pass. */
  droppedIds: string[];
}

/**
 * Strict READ-time validator for any-version store. Applies the shared
 * vector/dimension/resource integrity (same policy as B1 {@link assertEmbeddingStoreValid}).
 * Also runs a v3-only pageId/embeddingTextHash grammar stub when `version === 3`.
 *
 * v3-only validation NEVER runs on a v2 store, so tightening this function
 * cannot reject healthy v2 stores that arrive via {@link readStoreForUpdate}.
 */
export function validateV3ForSearch(parsed: ParsedStore): SearchValidationResult {
  // v3 records are keyed by `pageId` (not `slug`), so identity filtering must be
  // pageId-grammar-aware; a v2 store still filters on `slug` as before.
  const droppedIds =
    parsed.version === 3
      ? filterMalformedPageIds(parsed.store)
      : filterMalformedIdentities(parsed.store).filter((w) => w.includes("dropped:"));
  try {
    assertEmbeddingStoreValid(parsed.store);
  } catch {
    return { available: false, droppedIds };
  }
  return { available: true, droppedIds };
}

/**
 * Drop v3 entries/chunks whose `pageId` fails the qualified-id grammar, mutating
 * the store in place. Returns one `dropped:`-tagged warning per removed record so
 * the read pipeline can surface them. The vector-integrity gate still runs after.
 */
function filterMalformedPageIds(store: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  for (const field of ["entries", "chunks"] as const) {
    const arr = store[field];
    if (!Array.isArray(arr)) continue;
    store[field] = arr.filter((item) => {
      const id = (item as Record<string, unknown> | null)?.pageId;
      if (typeof id === "string" && parseQualifiedPageId(id)) return true;
      dropped.push(`embedding ${field} dropped: malformed pageId`);
      return false;
    });
  }
  return dropped;
}

/**
 * Write-path read: reads the embedding store via the same B1 confined reader but
 * accepts a v2 store WITHOUT calling {@link validateV3ForSearch} on it. This lets
 * a subsequent migration transform a v2 store to v3 without pre-validation rejection.
 * Returns null when the file is absent, oversized, unconfined, or unparseable.
 */
export async function readStoreForUpdate(root: string): Promise<ParsedStore | null> {
  const result = await readStoredEmbeddings(root);
  return result.kind === "parsed" ? result.parsed : null;
}

/**
 * Choose the active embedding model name, defaulting to anthropic's voyage model.
 *
 * LLMWIKI_EMBEDDING_MODEL is honoured only when the effective embedding provider
 * is openai or ollama — the pre-existing rule. Anthropic and claude-agent always
 * ignore it, even when LLMWIKI_EMBEDDING_PROVIDER names one of them explicitly:
 * both delegate to Voyage's `VoyageEmbeddingProvider.embed()`, which calls the
 * Voyage API with no model argument and so always uses the hardcoded
 * EMBEDDING_MODELS.anthropic model. Honouring a configured name here would tag
 * the store — whose model field is its invalidation key — with a model that was
 * never actually used to produce its vectors, and a changed model rebuilds the
 * entire store.
 */
export function resolveEmbeddingModel(): string {
  const providerName = getActiveEmbeddingProviderName();
  const configuredModel = process.env.LLMWIKI_EMBEDDING_MODEL?.trim();
  const honoursConfigured = providerName === "openai" || providerName === "ollama";
  if (configuredModel && honoursConfigured) {
    return configuredModel;
  }
  return EMBEDDING_MODELS[providerName] ?? EMBEDDING_MODELS.anthropic;
}

/**
 * Identity of the configuration that PRODUCES a store's vectors: the embedding
 * provider, its model, and the endpoint serving it.
 *
 * The model name alone is not that identity. It was a sound proxy while the
 * embedding backend was pinned to the chat provider — the only pair sharing a
 * model tag was anthropic/claude-agent, which really is the same Voyage
 * backend. LLMWIKI_EMBEDDING_PROVIDER broke the proxy by making the backend
 * vary on its own, so two configurations can now tag a store identically while
 * producing vectors that do not share a space:
 *
 *  - setting or unsetting OPENAI_EMBEDDINGS_BASE_URL — both tag
 *    `text-embedding-3-small`, one is cloud OpenAI and the other is whatever a
 *    local server answers to under that alias;
 *  - moving between `openai` and `ollama` with LLMWIKI_EMBEDDING_MODEL pinned to
 *    a name both serve (`nomic-embed-text`, `bge-m3`).
 *
 * Neither changes the dimension, so nothing downstream catches it: the store is
 * silently mixed and cosine ranking degrades into noise with no error. Folding
 * provider and endpoint into the invalidation key is what makes that a clean
 * rebuild instead.
 */
export function resolveEmbeddingFingerprint(): string {
  const providerName = getActiveEmbeddingProviderName();
  // Keyed on the BACKEND, not the provider name: anthropic and claude-agent both
  // embed via Voyage, so moving between them must not trigger a rebuild.
  // NUL-separated: no env value can contain one, so no pair of distinct
  // configurations can collide by concatenation.
  const identity = [
    resolveEmbeddingBackend(providerName),
    resolveEmbeddingModel(),
    resolveEmbeddingEndpoint(providerName),
  ].join("\0");
  // HASHED because this is persisted. The endpoint component is a free-form URL
  // that routinely carries a credential as userinfo or a query parameter, and
  // .llmwiki/embeddings.json gets committed, copied between machines, and pasted
  // into bug reports. Nothing ever reads the fingerprint back — it is only
  // compared for equality — so opacity costs nothing, and `model` remains on the
  // store in cleartext for diagnostics.
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

/**
 * True when `store` was built by the ACTIVE embedding configuration, so its
 * vectors may be preserved and searched.
 *
 * A store that predates {@link resolveEmbeddingFingerprint} carries no record of
 * its provenance, leaving only the model name to compare. Forcing every existing
 * project into a full re-embed on upgrade would be a worse default than keeping
 * that weaker check until the next write stamps a fingerprint — but only while
 * nothing overrides the embedding backend or its endpoint. Under an override the
 * name is known to be ambiguous: repointing at a local OpenAI-compatible server
 * keeps the model tag identical while producing vectors from another space.
 *
 * Preserving there does not merely postpone the rebuild. A partial update mixes
 * old and new vectors and then stamps the result with the current fingerprint,
 * so the mixed store is trusted permanently by every check that follows. The
 * rebuild is a bounded one-time cost; the laundering is not recoverable.
 */
export function storeMatchesActiveEmbedding(store: Record<string, unknown> | null | undefined): boolean {
  if (!store) return false;
  if (typeof store.fingerprint === "string") return store.fingerprint === resolveEmbeddingFingerprint();
  if (hasEmbeddingConfigurationOverride()) return false;
  return store.model === resolveEmbeddingModel();
}
