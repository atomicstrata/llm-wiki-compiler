/**
 * Embedding store shape and persistence.
 *
 * Owns the on-disk JSON contract for .llmwiki/embeddings.json (types, version,
 * atomic read/write) and the active-model resolution used to tag and validate
 * a store. No retrieval or embedding logic lives here — this is the base module
 * every other embeddings-* module depends on, and it depends on none of them.
 *
 * Confinement + resource-cap policy (B1):
 *  - READ: routes through {@link resolveExistingConfinedPrivateDir} (no mkdir on
 *    clean projects), opens the leaf with O_RDONLY|O_NOFOLLOW (symlinked leaf →
 *    unavailable), fstat-checks the size before parsing.
 *  - WRITE: routes through {@link resolveConfinedPrivateDir} (creates .llmwiki),
 *    serializes first and rejects if over {@link MAX_EMBEDDING_STORE_BYTES} via
 *    {@link EmbeddingStoreFullError} before atomicWrite.
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

import { open } from "fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "path";
import { getActiveProviderName } from "./provider.js";
import { atomicWrite } from "./markdown.js";
import { EMBEDDINGS_FILE, EMBEDDING_MODELS, MAX_EMBEDDING_STORE_BYTES } from "./constants.js";
import { assertEmbeddingStoreValid, filterMalformedIdentities, assertFieldCaps } from "./embeddings-validate.js";
import { resolveExistingConfinedPrivateDir, resolveConfinedPrivateDir } from "./private-dir.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";

/**
 * Raised when a write would produce a serialized store that exceeds
 * {@link MAX_EMBEDDING_STORE_BYTES} — the same bound the reader fails closed at.
 * The write path fails BEFORE persisting so the store can never be driven past the
 * read ceiling into an unreadable-yet-writable (bricked) state.
 */
export class EmbeddingStoreFullError extends Error {
  constructor() {
    super("embedding store is full; rebuild or prune entries");
    this.name = "EmbeddingStoreFullError";
  }
}

/**
 * Current store version. Bumped 1 → 2 when chunk entries were added, and
 * 2 → 3 when records were re-keyed from a bare `slug` to a qualified `pageId`
 * (`<namespace>/<page-part>`) and a page `embeddingTextHash` was added. The live
 * writer now persists v3; v1/v2 stores on disk are migrated on the next write.
 */
export const STORE_VERSION = 3 as const;

/** Known on-disk versions; v3 does not yet exist on disk (B3 stub). */
const KNOWN_VERSIONS = new Set<number>([1, 2, 3]);

/**
 * Discriminated parse result: the numeric version plus the raw store shape.
 * Consumers narrow on `version` before applying version-specific logic.
 */
export interface ParsedStore {
  version: 1 | 2 | 3;
  store: Record<string, unknown>;
}

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
// v3 record types (not yet written to disk — writer still emits v2 until D7)
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

/** Root shape of a v3 .llmwiki/embeddings.json store (not yet on disk). */
export interface EmbeddingStoreV3 {
  version: 3;
  model: string;
  dimensions: number;
  entries: PageEmbeddingV3[];
  chunks?: ChunkEmbeddingV3[];
}

/**
 * Shared confined read: resolves the .llmwiki dir, opens embeddings.json with
 * O_RDONLY|O_NOFOLLOW (symlinked leaf → null), fstat-caps the size, and returns
 * the raw UTF-8 content. Returns null for all unavailable/absent/oversized cases.
 */
export async function readConfinedRaw(root: string): Promise<string | null> {
  const dir = await resolveExistingConfinedPrivateDir(root);
  if (dir === null) return null;
  const filePath = path.join(dir, path.basename(EMBEDDINGS_FILE));
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
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
 * Read .llmwiki/embeddings.json with confinement + size cap.
 * Returns null when:
 *  - .llmwiki does not exist (clean project — no mkdir);
 *  - embeddings.json does not exist;
 *  - embeddings.json is a symlink (O_NOFOLLOW → ELOOP, fail closed);
 *  - the file exceeds {@link MAX_EMBEDDING_STORE_BYTES} (fstat cap, no full parse);
 *  - the store fails vector integrity validation (whole store unavailable).
 * A symlinked .llmwiki dir throws (fail closed via private-dir confinement).
 */
export async function readEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  const raw = await readConfinedRaw(root);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    filterMalformedIdentities(parsed);
    assertEmbeddingStoreValid(parsed);
    return parsed as unknown as EmbeddingStore;
  } catch {
    return null;
  }
}

/**
 * Atomically persist the embedding store via a confined write.
 * Validates the store, enforces per-field caps, and rejects if the serialized
 * form would exceed {@link MAX_EMBEDDING_STORE_BYTES} (throws
 * {@link EmbeddingStoreFullError}). Creates `.llmwiki` if absent.
 */
export async function writeEmbeddingStore(
  root: string,
  store: EmbeddingStore | EmbeddingStoreV3,
): Promise<void> {
  assertEmbeddingStoreValid(store);
  assertFieldCaps(store as unknown as Record<string, unknown>);
  const serialized = JSON.stringify(store, null, 2);
  if (Buffer.byteLength(serialized, "utf-8") > MAX_EMBEDDING_STORE_BYTES) {
    throw new EmbeddingStoreFullError();
  }
  // resolveConfinedPrivateDir creates .llmwiki with confinement; use the original
  // root-relative path for atomicWrite so confineRoot comparison stays on the
  // same path form (avoids macOS /var → /private/var symlink mismatch).
  await resolveConfinedPrivateDir(root);
  const filePath = path.join(root, EMBEDDINGS_FILE);
  await atomicWrite(filePath, serialized, { confineRoot: root });
}

/**
 * Discriminate the version from parsed JSON WITHOUT running v3-specific id
 * validation. Returns a {@link ParsedStore} when the input is a plain object
 * with a known numeric `version`; returns null for unknown versions, non-objects,
 * or missing/non-numeric version fields.
 */
export function parseEmbeddingStore(raw: unknown): ParsedStore | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const version = rec.version;
  if (typeof version !== "number" || !KNOWN_VERSIONS.has(version)) return null;
  return { version: version as 1 | 2 | 3, store: rec };
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
  const raw = await readConfinedRaw(root);
  if (raw === null) return null;
  try {
    return parseEmbeddingStore(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Choose the active embedding model name, defaulting to anthropic's voyage model. */
export function resolveEmbeddingModel(): string {
  const providerName = getActiveProviderName();
  const configuredModel = process.env.LLMWIKI_EMBEDDING_MODEL?.trim();
  if (configuredModel && (providerName === "openai" || providerName === "ollama")) {
    return configuredModel;
  }
  return EMBEDDING_MODELS[providerName] ?? EMBEDDING_MODELS.anthropic;
}
