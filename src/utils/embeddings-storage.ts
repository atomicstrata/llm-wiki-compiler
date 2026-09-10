/**
 * Format-aware embedding persistence. A binary leaf is authoritative even when
 * corrupt; only its absence permits legacy JSON reads. One atomic rename commits
 * metadata and vectors together, preserving paid vectors on JSON-size overflow.
 */
import { lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic-write.js";
import { openFileNoFollow } from "./no-follow-open.js";
import { resolveConfinedPrivateDir, resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { EMBEDDINGS_FILE, MAX_EMBEDDING_STORE_BYTES } from "./constants.js";
import { decodeBinaryStore, encodeBinaryStore, MAX_BINARY_STORE_BYTES } from "./embeddings-binary.js";
import { serializeEmbeddingJson } from "./embeddings-json.js";
import type { EmbeddingStore, EmbeddingStoreV3 } from "./embeddings-store.js";
import { EmbeddingStoreFullError } from "./embeddings-errors.js";
import { note } from "./output.js";

/** One authoritative container; older JSON remains an untouched migration backup. */
const EMBEDDINGS_BINARY_FILE = ".llmwiki/embeddings.bin";

/** Discriminate logical versions independently of their container encoding. */
export interface ParsedStore {
  version: 1 | 2 | 3;
  store: Record<string, unknown>;
}

/** Keep legacy versions readable before version-specific migration/validation. */
export function parseEmbeddingStore(raw: unknown): ParsedStore | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const version = rec.version;
  if (typeof version !== "number" || ![1, 2, 3].includes(version)) return null;
  return { version: version as 1 | 2 | 3, store: rec };
}

/** Absence and refusal have different fallback and diagnostic semantics. */
export type StoredEmbeddingRead =
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "parsed"; parsed: ParsedStore };

/** Presence is independent of decoding; permission errors are not absence. */
async function leafStat(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(filePath); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read one selected regular file, checking size before allocating its contents. */
async function readSelected(filePath: string, binary: boolean): Promise<StoredEmbeddingRead> {
  try {
    const entry = await leafStat(filePath);
    if (entry === null) return binary ? { kind: "unavailable", reason: "Binary index disappeared." } : { kind: "absent" };
    if (!entry.isFile()) return { kind: "unavailable", reason: "Embedding index is not a regular file." };
    const handle = await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size;
      const cap = binary ? MAX_BINARY_STORE_BYTES : MAX_EMBEDDING_STORE_BYTES;
      if (size > cap) return { kind: "unavailable", reason: "Embedding index exceeds its byte limit." };
      const bytes = await handle.readFile();
      const parsed = parseEmbeddingStore(binary ? decodeBinaryStore(bytes) : JSON.parse(bytes.toString("utf8")));
      return parsed ? { kind: "parsed", parsed } : { kind: "unavailable", reason: "Embedding index has an unsupported or invalid format." };
    } finally { await handle.close(); }
  } catch {
    return { kind: "unavailable", reason: "Embedding index could not be read or failed integrity validation." };
  }
}

/** Resolve authority once; refused binary never falls through to old JSON. */
export async function readStoredEmbeddings(root: string): Promise<StoredEmbeddingRead> {
  const dir = await resolveExistingConfinedPrivateDir(root);
  if (dir === null) return { kind: "absent" };
  const binaryPath = path.join(dir, path.basename(EMBEDDINGS_BINARY_FILE));
  let binary;
  try { binary = await leafStat(binaryPath); }
  catch { return { kind: "unavailable", reason: "Binary embedding index could not be inspected." }; }
  return binary === null
    ? readSelected(path.join(dir, path.basename(EMBEDDINGS_FILE)), false)
    : readSelected(binaryPath, true);
}

/** Match the existing boolean-environment convention used for embeddings flags. */
function binaryRequested(): boolean {
  return ["1", "true", "yes", "on"].includes(process.env.LLMWIKI_BINARY_EMBEDDINGS?.trim().toLowerCase() ?? "");
}

/** Convert a binary format limit into the public persistence error contract. */
function encodeForWrite(store: EmbeddingStore | EmbeddingStoreV3): Buffer {
  try { return encodeBinaryStore(store); }
  catch (err) {
    if (err instanceof RangeError) throw new EmbeddingStoreFullError(err.message);
    throw err;
  }
}

/** Persist one selected format; only successful first automatic migration warns. */
export async function persistEmbeddingStore(root: string, store: EmbeddingStore | EmbeddingStoreV3): Promise<void> {
  const dir = await resolveExistingConfinedPrivateDir(root);
  const binaryLeaf = dir === null ? null : await leafStat(path.join(dir, path.basename(EMBEDDINGS_BINARY_FILE)));
  if (binaryLeaf !== null && !binaryLeaf.isFile()) throw new Error("refusing to replace a non-regular binary embedding index");
  const requested = binaryRequested();
  const json = binaryLeaf !== null || requested ? null : serializeEmbeddingJson(store);
  const binary = json === null;
  const content = binary ? encodeForWrite(store) : json;
  await resolveConfinedPrivateDir(root);
  await atomicWrite(path.join(root, binary ? EMBEDDINGS_BINARY_FILE : EMBEDDINGS_FILE), content, { confineRoot: root });
  if (binary && binaryLeaf === null && !requested) {
    note("Embedding index exceeded the JSON limit; saved embeddings.bin. Future updates remain binary.");
  }
}
