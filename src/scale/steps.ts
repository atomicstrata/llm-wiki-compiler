/**
 * @file src/scale/steps.ts
 * @description The two LOCAL-FILES preparation steps of a `local-large`
 * transition. Each is idempotent and checks reality every time it runs, so a
 * resumed transition re-verifies the actual resources rather than trusting a
 * recorded checkpoint.
 *
 * `capacity-preflight` compares free disk space at the project root with the
 * CONSERVATIVE full estimate (see `preflightRequiredBytes`). It is a guard,
 * not a capacity verdict, and it never subtracts observed usage.
 *
 * `embedding-container` eagerly converts an existing JSON embedding store to
 * the existing binary container:
 * - The store is validated by the codec's own `assertEmbeddingStoreValid`
 *   before any byte is written.
 * - The encoded bytes are decoded in memory and must equal the store with
 *   every vector value mapped through float32 (`Math.fround`), which is the
 *   container's documented semantics, and every metadata field identical.
 *   Counts or the model alone are not accepted as proof.
 * - One atomic replacement publishes the container, and a re-read must be
 *   byte-identical to the verified bytes.
 * - The JSON store stays untouched as the backup. A container already present
 *   is authoritative and is only verified; an unreadable one parks the step,
 *   and NOTHING falls back to the JSON.
 *
 * Neither step touches `sources/`, `wiki/`, labels or custody, and neither
 * needs a provider, the network or a background process.
 */

import { statfs } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { replaceLeafAtomicWithin } from "../storage/disk-guarded-leaves.js";
import { EMBEDDINGS_FILE, MAX_EMBEDDING_STORE_BYTES } from "../utils/constants.js";
import { decodeBinaryStore, encodeBinaryStore, MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import {
  diskStoredEmbeddingReads, EMBEDDINGS_BINARY_FILE, readStoredEmbeddingsFrom, type StoredEmbeddingReads,
} from "../utils/embeddings-storage.js";
import type { EmbeddingStore } from "../utils/embeddings-store.js";
import { MAX_STEP_DETAIL_CHARS } from "./contracts.js";

/** What one run of a step found. */
export interface StepOutcome {
  readonly status: "done" | "parked";
  readonly detail: string;
}

/** The free-space fact the preflight asks for. */
export interface PreflightIo {
  /** Bytes available to this user at the project root. REJECTS when unmeasurable. */
  freeBytes(): Promise<number>;
}

/** The mechanisms the container step runs over. No member takes a project root. */
export interface EmbeddingContainerIo {
  /** The incumbent stored-embedding reads (private dir, leaf kind, capped bytes). */
  readonly reads: StoredEmbeddingReads;
  /** Atomically publish the binary container. REJECTS raw. */
  replaceBinary(bytes: Uint8Array): Promise<void>;
  /** TEST SEAM: runs right after the container is published, before its re-read. Absent locally. */
  afterBinaryWrite?(): Promise<void>;
}

const BINARY_LEAF = path.basename(EMBEDDINGS_BINARY_FILE);
const JSON_LEAF = path.basename(EMBEDDINGS_FILE);

/** A bounded outcome. */
function outcome(status: StepOutcome["status"], detail: string): StepOutcome {
  return { status, detail: detail.slice(0, MAX_STEP_DETAIL_CHARS) };
}

/** Run the disk-space preflight against `requiredBytes`. */
export async function capacityPreflightFrom(io: PreflightIo, requiredBytes: number): Promise<StepOutcome> {
  let free: number;
  try { free = await io.freeBytes(); } catch { return outcome("parked", "free disk space could not be measured"); }
  const comparison = `free ${free} B, conservative estimate ${requiredBytes} B`;
  return free >= requiredBytes
    ? outcome("done", `${comparison}; this guard is not a capacity verdict`)
    : outcome("parked", `insufficient-disk: ${comparison}; free space or lower the expected scale`);
}

/** The store as the container must hold it: every vector value through float32, all else identical. */
export function float32Expected(store: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(store);
  for (const list of [copy.entries, copy.chunks]) {
    if (!Array.isArray(list)) continue;
    for (const record of list as Array<{ vector?: unknown }>) {
      if (Array.isArray(record.vector)) record.vector = record.vector.map((value) => Math.fround(value as number));
    }
  }
  return copy;
}

/** Encode and verify in memory, or say why the store cannot be converted. */
function encodeVerified(store: Record<string, unknown>): Buffer | string {
  let bytes: Buffer;
  try { bytes = encodeBinaryStore(store as unknown as EmbeddingStore); } catch (error) {
    return `the embedding store cannot be converted: ${error instanceof Error ? error.message : String(error)}`;
  }
  return isDeepStrictEqual(decodeBinaryStore(bytes), float32Expected(store)) ? bytes : "the encoded container does not reproduce the store";
}

/** Convert a parsed JSON store, publish it, and prove the published bytes. */
async function convert(io: EmbeddingContainerIo, dir: string, store: Record<string, unknown>): Promise<StepOutcome> {
  const bytes = encodeVerified(store);
  if (typeof bytes === "string") return outcome("parked", bytes);
  await io.replaceBinary(bytes);
  await io.afterBinaryWrite?.();
  const back = await io.reads.readLeafBytes(dir, BINARY_LEAF, MAX_BINARY_STORE_BYTES).catch(() => null);
  if (back === null || !back.equals(bytes)) {
    return outcome("parked", "the published .llmwiki/embeddings.bin does not match the verified bytes; inspect it before any further step");
  }
  const entries = (store.entries as unknown[]).length + ((store.chunks as unknown[] | undefined)?.length ?? 0);
  return outcome("done", `converted ${entries} embedding entries to the binary container; .llmwiki/embeddings.json kept as backup`);
}

/** Whether the JSON backup, if any, holds exactly what the authoritative container holds. */
async function backupAgreement(io: EmbeddingContainerIo, dir: string, decoded: Record<string, unknown>): Promise<string> {
  const json = await io.reads.readLeafBytes(dir, JSON_LEAF, MAX_EMBEDDING_STORE_BYTES).catch(() => null);
  if (json === null) return "no JSON backup";
  try {
    const same = isDeepStrictEqual(decoded, float32Expected(JSON.parse(json.toString("utf8")) as Record<string, unknown>));
    return same ? "matches the JSON backup" : "differs from the older JSON backup (the container is authoritative)";
  } catch {
    return "the JSON backup is not readable (the container is authoritative)";
  }
}

/** Verify an existing, authoritative container. It never falls back to JSON. */
async function verifyExisting(io: EmbeddingContainerIo, dir: string): Promise<StepOutcome> {
  const read = await readStoredEmbeddingsFrom(io.reads).catch(() => null);
  if (read === null || read.kind !== "parsed") {
    return outcome("parked", `the binary container is authoritative and unreadable: ${read?.kind === "unavailable" ? read.reason : "not readable"}`);
  }
  return outcome("done", `binary container verified; ${await backupAgreement(io, dir, read.parsed.store)}`);
}

/** Run the embedding-container step over `io`: THE ONE BODY. */
export async function prepareEmbeddingContainerFrom(io: EmbeddingContainerIo): Promise<StepOutcome> {
  let dir: string | null;
  try { dir = await io.reads.resolvePrivateDir(); } catch { return outcome("parked", "the private directory is not confined"); }
  if (dir === null) return outcome("done", "no embedding store yet; the first store will be written binary");
  const binary = await io.reads.leafKind(dir, BINARY_LEAF).catch(() => "unknown" as const);
  if (binary !== "absent") return verifyExisting(io, dir);
  const read = await readStoredEmbeddingsFrom(io.reads).catch(() => null);
  if (read === null) return outcome("parked", "the embedding store could not be read");
  if (read.kind === "absent") return outcome("done", "no embedding store yet; the first store will be written binary");
  if (read.kind === "unavailable") return outcome("parked", `the JSON embedding store is unreadable: ${read.reason}`);
  return convert(io, dir, read.parsed.store);
}

/** LOCAL DISK. Free bytes at `root` by `statfs`. */
export function diskPreflightIo(root: string): PreflightIo {
  return { freeBytes: async () => { const info = await statfs(root); return Number(info.bavail) * Number(info.bsize); } };
}

/** LOCAL DISK. The incumbent embedding reads and the confined atomic replace for `root`. */
export function diskEmbeddingContainerIo(root: string): EmbeddingContainerIo {
  return {
    reads: diskStoredEmbeddingReads(root),
    replaceBinary: (bytes) => replaceLeafAtomicWithin(root, path.join(root, EMBEDDINGS_BINARY_FILE), bytes),
  };
}
