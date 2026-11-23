/**
 * @file src/indexed/pin-format.ts
 * @description The on-disk FORMAT of a pinned snapshot, shared by the pin
 * reader and writer (`./pins.ts`) and the interrupted-publication recovery of
 * an explicit unpin (`./pin-recovery.ts`): where pins live, their reserved
 * leaf names, the index format, its bounds, and the strict predicates for one
 * index entry and the index header.
 *
 * A pin is `.llmwiki/indexed-pins/<label>/`: one `<store>.manifest` per store
 * (the manifest's exact bytes, mode 0600) and a `pin.json` index written LAST,
 * naming each store with its byte length and SHA-256. Nothing here reads or
 * writes the disk; it only says what a well-formed pin looks like.
 */

import path from "node:path";
import { MAX_SEGMENT_MANIFEST_BYTES, STORE_NAME_PATTERN } from "../segments/contracts.js";

/** Where pins live, relative to the project root. */
export const PINS_DIR = ".llmwiki/indexed-pins";
/** A pin label: a short lowercase identifier. */
export const PIN_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The index leaf, written last. */
export const PIN_INDEX = "pin.json";
/** A copied manifest's leaf suffix (never a store-name collision with the index). */
export const COPY_SUFFIX = ".manifest";
export const PIN_FORMAT = "llmwiki-indexed-pin";
/** Most pins a project may hold. */
export const MAX_PINS = 1000;
/**
 * Most stores one pin may copy. Bounds the index: an entry is at most about
 * 150 bytes, so 5,000 entries stay well inside the read cap the index is
 * parsed under ({@link MAX_SEGMENT_MANIFEST_BYTES}).
 */
export const MAX_PIN_STORES = 5_000;
/** Every pin leaf is private. */
export const PRIVATE_FILE_MODE = 0o600;

/** One store a pin copied. */
export interface PinnedStore { readonly store: string; readonly sha256: string; readonly bytes: number }

/** The directory of pin `label`, relative to the project root. */
export const pinDir = (label: string): string => path.posix.join(PINS_DIR, label);

/** The store a settled copy leaf name belongs to, or null when `name` is no copy name. */
export function copyStoreOf(name: string): string | null {
  if (!name.endsWith(COPY_SUFFIX)) return null;
  const store = name.slice(0, -COPY_SUFFIX.length);
  return STORE_NAME_PATTERN.test(store) ? store : null;
}

/** Whether `bytes` is a manifest size a pin may record. */
const isManifestSize = (bytes: unknown): boolean => typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_SEGMENT_MANIFEST_BYTES;

/** Whether `entry` is one strictly valid pin-index store entry. */
export function isPinnedStore(entry: Record<string, unknown>): boolean {
  if (Object.keys(entry ?? {}).sort().join() !== "bytes,sha256,store") return false;
  const { store, sha256, bytes } = entry;
  const validStore = typeof store === "string" && STORE_NAME_PATTERN.test(store);
  const validSha = typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256);
  return validStore && validSha && isManifestSize(bytes);
}

/** Whether `value` has a pin index's exact keys, format and version, for pin `label`. */
export function isPinHeader(value: Record<string, unknown>, label: string): boolean {
  return Object.keys(value ?? {}).sort().join() === "createdAt,format,label,stores,version" && value.format === PIN_FORMAT && value.version === 1 && value.label === label;
}
