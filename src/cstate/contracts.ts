/**
 * @file src/cstate/contracts.ts
 * @description The SEGMENTED COMPILE STATE (`cstate`): the compile-state
 * authority of a `local-indexed` project whose scale record carries the
 * version 3 capability `segmented-compile-state-1` as `ready`. It replaces
 * `.llmwiki/state.json` as the authority, row by row, so a compile can read
 * and advance one source without materializing the whole state.
 *
 * ORDER IS PART OF THE STATE. The incumbent compile iterates `state.sources`
 * in INSERTION order (owner lists, the shared-owner closure and the merge
 * consume it), so every source carries its insertion ORDINAL: the position
 * the incumbent object gives it. A rewritten entry keeps its ordinal; a new
 * source takes the next one; a removed source frees its own.
 *
 * ROWS, in one store `.llmwiki/indexed/cstate/`:
 * - `s:<sourceFile>` → `{o, v}`: the source's ordinal and its `SourceState`
 *   exactly as `state.json` held it (hash, concepts, compiledAt, the
 *   extraction snapshot, the typed mirror; extra source keys preserved
 *   verbatim);
 * - `o:<ordinal>` → the source file: the ORDER INDEX, so sources stream in
 *   incumbent order;
 * - `c:<slug>\0<ordinal>` → the source file: the OWNER INDEX, one row per
 *   concept a source owns, so a slug's owners are one prefix scan, in
 *   incumbent owner order;
 * - `z:<slug>` → its position in the frozen list, and `f:<position>` → the
 *   slug: the FROZEN-ORDER index, so the list streams in order and no two
 *   frozen slugs can claim one position.
 *
 * META binds the whole-state fields (`version`, `indexHash`, the prompt
 * modifiers digest, whether a frozen list was present), the row counts, the
 * next free ordinal, and `state.json` as an exact-bytes LEGACY BACKUP
 * (`../history/contracts.ts`): imported once at the capability's preparation
 * and never rewritten; a change to it afterwards refuses writes and fails
 * verification.
 */

import { hasExactKeys, isCount, isLegacySnapshot, type LegacySnapshot } from "../history/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { STATE_FILE } from "../utils/constants.js";

/** The store's name under `.llmwiki/indexed/`. */
export const CSTATE_STORE = "cstate";
/** The capability that makes the store the compile-state authority. */
export const CSTATE_CAPABILITY = "segmented-compile-state-1";
/** Source rows. */
export const SOURCE_PREFIX = "s:";
/** Order-index rows. */
export const ORDER_PREFIX = "o:";
/** Owner-index rows. */
export const OWNER_PREFIX = "c:";
/** Frozen-slug rows. */
export const FROZEN_PREFIX = "z:";
/** Frozen-order rows. */
export const FROZEN_ORDER_PREFIX = "f:";
/** The separator between a slug and its owner's ordinal in an owner-index key (never in a slug). */
const OWNER_SEPARATOR = "\0";
/** Digits of a zero-padded ordinal, so key order is ordinal order. */
const ORDINAL_DIGITS = 12;
/** The first ordinal a key cannot represent; every ordinal and the next free one stay below it. */
export const ORDINAL_LIMIT = 10 ** ORDINAL_DIGITS;
/** The source key no plain-object state map can hold as an own entry. */
const PROTOTYPE_KEY = "__proto__";
/** The largest `state.json` the preparation imports (and a backup carries as its legacy file). */
export const MAX_STATE_FILE_BYTES = 256 * 1024 * 1024;
/** The largest whole state a compatibility read materializes; beyond it the read refuses. */
export const MAX_STATE_MATERIALIZE_BYTES = 64 * 1024 * 1024;

/** The whole-state facts and counts the manifest carries. */
export interface CompileStateMeta {
  readonly schema: 1;
  readonly version: 1 | 2;
  readonly indexHash: string;
  /** The prompt modifiers digest, or `null` when the state carried none. */
  readonly promptModifiers: string | null;
  /** Whether the state carried a `frozenSlugs` list (an empty one included). */
  readonly frozenPresent: boolean;
  readonly sources: number;
  readonly owners: number;
  readonly frozen: number;
  /** The ordinal the next new source takes; above every stored one. */
  readonly nextOrdinal: number;
  /** The batch compile run whose state-finalize commit last wrote the state, or `null` (an import or a whole-state write). */
  readonly lastRun: string | null;
  readonly legacy: LegacySnapshot;
}

/** A stored source row: its insertion ordinal and its entry. */
export interface SourceRowV1<T = unknown> { readonly o: number; readonly v: T }

/** An ordinal in its key form. */
const ordinalText = (ordinal: number): string => String(ordinal).padStart(ORDINAL_DIGITS, "0");
/** The key of `sourceFile`'s row. */
export const sourceKey = (sourceFile: string): string => `${SOURCE_PREFIX}${sourceFile}`;
/** The key of the order row of ordinal `ordinal`. */
export const orderKey = (ordinal: number): string => `${ORDER_PREFIX}${ordinalText(ordinal)}`;
/** The key of the owner row of `slug` by the source at `ordinal`. */
export const ownerKey = (slug: string, ordinal: number): string => `${OWNER_PREFIX}${slug}${OWNER_SEPARATOR}${ordinalText(ordinal)}`;
/** The prefix of every owner row of `slug`. */
export const ownersPrefix = (slug: string): string => `${OWNER_PREFIX}${slug}${OWNER_SEPARATOR}`;
/** The key of frozen slug `slug`. */
export const frozenKey = (slug: string): string => `${FROZEN_PREFIX}${slug}`;
/** The key of the frozen-order row of position `at`. */
export const frozenOrderKey = (at: number): string => `${FROZEN_ORDER_PREFIX}${ordinalText(at)}`;

/**
 * Whether `sourceFile` can key a source row unambiguously: a non-empty
 * RELATIVE path under `sources/`, `/`-separated, with no NUL, no backslash
 * (an ambiguous separator), and no empty, `.` or `..` component. Ordinary
 * source names are kept exactly as the scan selects them, dot-files and names
 * with spaces included (`.notes.md`, `my notes.md`). The one key `__proto__`
 * is refused: the incumbent state helpers assign source entries by plain
 * property assignment, which cannot hold it as an own entry.
 */
export function isRepresentableSourceKey(sourceFile: string): boolean {
  if (sourceFile.length === 0 || sourceFile === PROTOTYPE_KEY || sourceFile.includes("\0") || sourceFile.includes("\\")) return false;
  return sourceFile.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** The slug and owner ordinal of an owner-index key; `null` when the key is not one. */
export function parseOwnerKey(key: string): { slug: string; ordinal: number } | null {
  const at = key.lastIndexOf(OWNER_SEPARATOR);
  const digits = key.slice(at + 1);
  if (!key.startsWith(OWNER_PREFIX) || at < OWNER_PREFIX.length || !/^\d{12}$/.test(digits)) return null;
  return { slug: key.slice(OWNER_PREFIX.length, at), ordinal: Number(digits) };
}

/** The ordinal (or frozen position) of an order-index key under `prefix`; `null` when the key is not one. */
export function parseOrderKey(key: string, prefix: string = ORDER_PREFIX): number | null {
  const digits = key.slice(prefix.length);
  return key.startsWith(prefix) && /^\d{12}$/.test(digits) ? Number(digits) : null;
}

/** Whether `value` is an ordinal a key can represent. */
const isOrdinal = (value: unknown): value is number => isCount(value) && value < ORDINAL_LIMIT;

/** Whether `value` is a stored source row (its entry is checked by the caller). */
export function isSourceRow(value: unknown): value is SourceRowV1 {
  return hasExactKeys(value, ["o", "v"]) && isOrdinal(value.o);
}

/** A compile-state refusal with a stable code; nothing was changed. */
export class CompileStateError extends Error {
  constructor(readonly code: "compile_state_unavailable" | "compile_state_too_large" | "compile_state_legacy_changed", message: string) {
    super(`${code}: ${message}`);
    this.name = "CompileStateError";
  }
}

/** Whether the meta's counts are counts, the next ordinal within the key range. */
const metaCounts = (value: Record<string, unknown>): boolean => [value.sources, value.owners, value.frozen, value.nextOrdinal].every(isCount) && (value.nextOrdinal as number) <= ORDINAL_LIMIT;
/** Whether `value` is `null` or a string. */
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
/** Whether `value` is `null` or a run id. */
const nullableRunId = (value: unknown): boolean => value === null || (typeof value === "string" && /^[0-9a-f]{12}$/.test(value));

/** Whether `value` is the closed meta shape. */
function isMeta(value: unknown): value is CompileStateMeta {
  const keys = ["schema", "version", "indexHash", "promptModifiers", "frozenPresent", "sources", "owners", "frozen", "nextOrdinal", "lastRun", "legacy"];
  if (!hasExactKeys(value, keys) || value.schema !== 1 || ![1, 2].includes(value.version as number)) return false;
  const fields = typeof value.indexHash === "string" && nullableString(value.promptModifiers) && typeof value.frozenPresent === "boolean";
  return metaCounts(value) && fields && nullableRunId(value.lastRun) && isLegacySnapshot(value.legacy, STATE_FILE);
}

/** The validated meta of an opened compile state; anything else is unavailable. */
export function compileStateMetaOf(store: SegmentStore): CompileStateMeta {
  if (!store.exists) throw new CompileStateError("compile_state_unavailable", "the segmented compile state has no manifest");
  if (!isMeta(store.meta)) throw new CompileStateError("compile_state_unavailable", "the segmented compile state manifest is malformed");
  return store.meta;
}
