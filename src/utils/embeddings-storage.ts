/**
 * Format-aware embedding persistence. A binary leaf is authoritative even when
 * corrupt; only its absence permits legacy JSON reads. One atomic rename commits
 * metadata and vectors together, preserving paid vectors on JSON-size overflow.
 *
 * The READER has one body, {@link readStoredEmbeddingsFrom}, over three raw facts
 * of the private directory ({@link StoredEmbeddingReads}); `readStoredEmbeddings`
 * hands it the local disk's. The WRITER likewise has one body,
 * {@link persistEmbeddingStoreFrom}, over the physical mechanisms it runs
 * ({@link StoredEmbeddingWrites}); `persistEmbeddingStore` hands it the local
 * disk's. The binary opt-in is still read from the AMBIENT environment
 * (`LLMWIKI_BINARY_EMBEDDINGS`), and the migration notice still goes to the
 * process output: neither is storage.
 */
import path from "node:path";
import { replaceLeafAtomicWithin } from "../storage/disk-guarded-leaves.js";
import { leafKindNoFollow, readPrivateLeafBytes, type PrivateLeafKind } from "../storage/disk-private-leaves.js";
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

/**
 * The raw facts the stored-embedding reader asks for. No member chooses a
 * format, decodes anything or gives a verdict: which leaf is authoritative, the
 * cap for each format, and what absence, refusal and a failed read mean are all
 * decided in {@link readStoredEmbeddingsFrom}.
 *
 * `dir` is whatever `resolvePrivateDir` returned and is only handed back. On
 * local disk it is the confined real path of `.llmwiki`; resolving and confining
 * it, the no-follow open, the size check on the open handle and the close all
 * stay in the disk primitives. This is the legacy local binding: not
 * `ProjectStore`, not a hosted contract and not an access-control layer.
 */
export interface StoredEmbeddingReads {
  /** The existing private directory, resolved WITHOUT creating it, or `null` when there is none. REJECTS on a confinement fault and on any other failure. */
  resolvePrivateDir(): Promise<string | null>;
  /** What is at one leaf of a resolved private directory, a link NOT followed: absent, a regular file, or anything else. REJECTS raw for any failure other than absence. */
  leafKind(dir: string, name: string): Promise<PrivateLeafKind>;
  /** The leaf's raw bytes, or `null` when it is larger than `maxBytes`, decided before anything is read. REJECTS raw for every failure: absent, a link, a non-regular leaf, a failed read or close. */
  readLeafBytes(dir: string, name: string, maxBytes: number): Promise<Buffer | null>;
}

/** LOCAL DISK. The reads for the project at `root`, built per call. Building them does no I/O. In no package index. */
export function diskStoredEmbeddingReads(root: string): StoredEmbeddingReads {
  return {
    resolvePrivateDir: () => resolveExistingConfinedPrivateDir(root),
    leafKind: (dir, name) => leafKindNoFollow(path.join(dir, name)),
    readLeafBytes: (dir, name, maxBytes) => readPrivateLeafBytes(path.join(dir, name), maxBytes),
  };
}

/** Read one selected regular file, checking size before allocating its contents. */
async function readSelected(reads: StoredEmbeddingReads, dir: string, name: string, binary: boolean): Promise<StoredEmbeddingRead> {
  try {
    // Presence is independent of decoding; a permission error is not absence (it rejects into the catch below).
    const entry = await reads.leafKind(dir, name);
    if (entry === "absent") return binary ? { kind: "unavailable", reason: "Binary index disappeared." } : { kind: "absent" };
    if (entry !== "regular") return { kind: "unavailable", reason: "Embedding index is not a regular file." };
    const cap = binary ? MAX_BINARY_STORE_BYTES : MAX_EMBEDDING_STORE_BYTES;
    const bytes = await reads.readLeafBytes(dir, name, cap);
    if (bytes === null) return { kind: "unavailable", reason: "Embedding index exceeds its byte limit." };
    const parsed = parseEmbeddingStore(binary ? decodeBinaryStore(bytes) : JSON.parse(bytes.toString("utf8")));
    return parsed ? { kind: "parsed", parsed } : { kind: "unavailable", reason: "Embedding index has an unsupported or invalid format." };
  } catch {
    return { kind: "unavailable", reason: "Embedding index could not be read or failed integrity validation." };
  }
}

/** Resolve authority once; refused binary never falls through to old JSON. */
export async function readStoredEmbeddings(root: string): Promise<StoredEmbeddingRead> {
  return readStoredEmbeddingsFrom(diskStoredEmbeddingReads(root));
}

/**
 * {@link readStoredEmbeddings} over {@link StoredEmbeddingReads}: THE ONE BODY.
 * A refusal to resolve the private directory REJECTS: it is not caught here. A
 * failed first look at the binary leaf is its own unavailable reason. Whatever
 * that look finds other than absence selects the binary leaf for good: it is
 * looked at a second time and read, and nothing later falls back to JSON.
 *
 * @param reads - The private directory, a leaf's kind, and a leaf's capped bytes.
 */
export async function readStoredEmbeddingsFrom(reads: StoredEmbeddingReads): Promise<StoredEmbeddingRead> {
  const dir = await reads.resolvePrivateDir();
  if (dir === null) return { kind: "absent" };
  const binaryName = path.basename(EMBEDDINGS_BINARY_FILE);
  let binary;
  try { binary = await reads.leafKind(dir, binaryName); }
  catch { return { kind: "unavailable", reason: "Binary embedding index could not be inspected." }; }
  return binary === "absent"
    ? readSelected(reads, dir, path.basename(EMBEDDINGS_FILE), false)
    : readSelected(reads, dir, binaryName, true);
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

/**
 * The PHYSICAL mechanisms the store writer runs over, named so its body can run
 * without a project root. The two looks are the reader's own members of
 * {@link StoredEmbeddingReads}, with the same promises. No member chooses a
 * format, serializes, encodes or gives a verdict: the authoritative leaf, the
 * refusal of a non-regular one, the opt-in, the limits, the bytes and the
 * notice are decided in {@link persistEmbeddingStoreFrom}.
 *
 * It is not `EmbeddingMarkerWrites`: that replacement takes a caller-built
 * confine root and absolute leaf, and text only, while this one takes a POSIX
 * project-relative locator, as the store's constants are declared, and text or
 * bytes. Atomic replacement, confinement and creation stay in the disk
 * primitives; naming these selects no backend and promises no hosted atomicity.
 */
export interface StoredEmbeddingWrites extends Pick<StoredEmbeddingReads, "resolvePrivateDir" | "leafKind"> {
  /** MECHANISM. The private directory, created when missing and confined. Rejects with the resolver's error. */
  createPrivateDir(): Promise<void>;
  /** MECHANISM. Atomic replacement of the POSIX project-relative `relPath`; text or bytes pass straight through. Rejects raw. */
  replaceLeaf(relPath: string, content: string | Uint8Array): Promise<void>;
}

/** LOCAL DISK. The incumbent looks, creating resolver and confined atomic replace for `root`. Building them does no I/O. Exported only so the writer's root forms can compose it; in no package index. */
export function diskStoredEmbeddingWrites(root: string): StoredEmbeddingWrites {
  const reads = diskStoredEmbeddingReads(root);
  return {
    resolvePrivateDir: reads.resolvePrivateDir,
    leafKind: reads.leafKind,
    createPrivateDir: async () => { await resolveConfinedPrivateDir(root); },
    // Joined natively onto the root, exactly the incumbent's `path.join(root, <constant>)`.
    replaceLeaf: (relPath, content) => replaceLeafAtomicWithin(root, path.join(root, relPath), content),
  };
}

/** Persist one selected format; only successful first automatic migration warns. */
export async function persistEmbeddingStore(root: string, store: EmbeddingStore | EmbeddingStoreV3): Promise<void> {
  return persistEmbeddingStoreFrom(diskStoredEmbeddingWrites(root), store);
}

/**
 * {@link persistEmbeddingStore} over {@link StoredEmbeddingWrites}: THE ONE BODY.
 * An existing binary leaf stays authoritative and a non-regular one is refused.
 * The bytes are serialized or encoded BEFORE the private directory is created
 * (only when the look found none), so a store that cannot be serialized or
 * encoded creates nothing. One replacement
 * publishes them, and the migration notice follows only its success.
 *
 * @param writes - The private directory's looks, its creation, and one leaf's replacement.
 * @param store - The validated store to persist.
 */
export async function persistEmbeddingStoreFrom(writes: StoredEmbeddingWrites, store: EmbeddingStore | EmbeddingStoreV3): Promise<void> {
  const dir = await writes.resolvePrivateDir();
  const binaryLeaf = dir === null ? "absent" : await writes.leafKind(dir, path.basename(EMBEDDINGS_BINARY_FILE));
  if (binaryLeaf === "other") throw new Error("refusing to replace a non-regular binary embedding index");
  const requested = binaryRequested();
  const json = binaryLeaf !== "absent" || requested ? null : serializeEmbeddingJson(store);
  const binary = json === null;
  const content = binary ? encodeForWrite(store) : json;
  if (dir === null) await writes.createPrivateDir();
  await writes.replaceLeaf(binary ? EMBEDDINGS_BINARY_FILE : EMBEDDINGS_FILE, content);
  if (binary && binaryLeaf === "absent" && !requested) {
    note("Embedding index exceeded the JSON limit; saved embeddings.bin. Future updates remain binary.");
  }
}
