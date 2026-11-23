/**
 * @file src/utils/state-shape.ts
 * @description The pure SHAPE of the compile state (`.llmwiki/state.json` and
 * the segmented compile state that replaces it): the empty state, the highest
 * known schema version, the typed-ownership mirror re-derivation, the
 * serialized text, and the fail-closed classification of read text
 * (`ok` / `missing` / `corrupt` / `too-new`) with every validator it uses. It
 * reads and writes nothing, so the segmented compile state and the legacy
 * record binding can share it without importing each other
 * (`./state.ts` keeps the I/O and re-exports these names).
 */

import { isSafeFilenameComponent } from "../profile/identity.js";
import { mintConceptEntities } from "../state/migrate.js";
import type { WikiState, SourceState } from "./types.js";

/** The schema version that carries the typed-ownership mirror. */
const TYPED_MIRROR_VERSION = 2;

/**
 * Re-derive the v2 typed-ownership mirror from the v1 string lists so the two
 * never desync, regardless of which writer produced the state. For a v2 state
 * each source's `entities` is re-derived from its `concepts` and the top-level
 * `frozenEntities` from `frozenSlugs`, using the SAME tolerant minting as the
 * migration ({@link mintConceptEntities}) so non-slug-safe (e.g. Unicode) slugs
 * are simply absent from the typed mirror rather than aborting the write.
 *
 * For a v1 state this is a STRICT no-op — the input is returned unchanged so the
 * default-profile (v1) on-disk bytes are byte-identical to before.
 *
 * NOTE: this re-derives the CONCEPTS mirror only. A later phase that introduces
 * non-concept typed entities must extend this to preserve those, since blindly
 * re-deriving from `concepts` would drop them.
 */
export function syncEntityMirror(state: WikiState): WikiState {
  if (state.version !== TYPED_MIRROR_VERSION) return state;
  const sources: Record<string, SourceState> = {};
  for (const [file, source] of Object.entries(state.sources)) {
    sources[file] = { ...source, entities: mintConceptEntities(source.concepts) };
  }
  return {
    ...state,
    sources,
    frozenEntities: mintConceptEntities(state.frozenSlugs ?? []),
  };
}

/** The state of a project nothing has been compiled into yet. */
export function emptyState(): WikiState {
  return { version: 1, indexHash: "", sources: {} };
}

/**
 * Highest state.json schema version this build understands. A state file whose
 * `version` exceeds this was written by a newer llmwiki; we fail closed rather
 * than risk misinterpreting (or clobbering) a forward-incompatible layout.
 */
export const KNOWN_STATE_VERSION = 2;

/**
 * Readability classification of `.llmwiki/state.json`, shared by every
 * read-only surface so the fail-closed `too-new` outcome is represented
 * uniformly:
 * - ok = parsed and within the known schema range
 * - missing = no file
 * - corrupt = unparseable
 * - too-new = parsed but `version` exceeds {@link KNOWN_STATE_VERSION}; the
 *   parsed state is carried (never reset) and nothing is written to disk.
 */
export type StateStatus = "ok" | "missing" | "corrupt" | "too-new";

/** State file read outcome plus the carried (parsed or empty) state. */
export interface ClassifiedState {
  status: StateStatus;
  state: WikiState;
}

/**
 * Classify compile-state text that has already been read, by whatever means.
 * `null` is a state that does not exist yet. A reader with no filesystem uses
 * this so "missing", "corrupt" and "too-new" mean the same thing everywhere.
 */
export function classifyStateText(raw: string | null): ClassifiedState {
  if (raw === null) return { status: "missing", state: emptyState() };
  try {
    return classifyParsedState(JSON.parse(raw));
  } catch {
    return { status: "corrupt", state: emptyState() };
  }
}

/** The stored text of a compile state, with the typed mirror re-derived. */
export function serializeState(state: WikiState): string {
  return JSON.stringify(syncEntityMirror(state), null, 2);
}

/** True when `value` is an array whose every element is a string. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * True when `value` is a string array whose every element is a SAFE filename
 * component (no `/`, `\`, `..`, leading dot, NUL). Stored `concepts` /
 * `frozenSlugs` flow UNVALIDATED into `path.join(root, CONCEPTS_DIR, slug+'.md')`
 * by the orphan pass, so a poisoned `../../escape` slug would mint an out-of-tree
 * write. Gating slug-safety AT READ classifies a poisoned state CORRUPT (its
 * existing fail-closed `.bak`+fresh path), defanging the chain regardless of how
 * the bytes arrived. Compile slugs come from Unicode-aware `slugify`, so this
 * uses the Unicode-tolerant {@link isSafeFilenameComponent}, NOT ASCII slug-safe.
 */
function isSafeSlugArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((s) => typeof s === "string" && isSafeFilenameComponent(s));
}

/** True when `value` is a non-null, non-array plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when one `sources` entry has the required source-state shape. */
export function isValidSourceEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.hash !== "string" || typeof entry.compiledAt !== "string") return false;
  if (!isSafeSlugArray(entry.concepts)) return false; // slugs path-join into orphan writes
  if ("entities" in entry && !isStringArray(entry.entities)) return false;
  return true;
}

/** True when every optional top-level frozen list, if present, is a string array. */
function hasValidFrozenLists(parsed: Record<string, unknown>): boolean {
  if ("frozenSlugs" in parsed && !isSafeSlugArray(parsed.frozenSlugs)) return false; // path-join into orphan writes
  if ("frozenEntities" in parsed && !isStringArray(parsed.frozenEntities)) return false;
  return true;
}

/**
 * True when `parsed` is a structurally valid {@link WikiState}: a plain object
 * with a string `indexHash`, a plain-object `sources` map whose every value is a
 * valid source entry, and (when present) string-array `frozenSlugs` /
 * `frozenEntities`. Unknown EXTRA fields are tolerated so a future format that
 * adds fields is not falsely rejected here. `version` is validated separately by
 * {@link classifyParsedState}.
 */
function isValidWikiStateShape(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  if (typeof parsed.indexHash !== "string") return false;
  if (!isPlainObject(parsed.sources)) return false;
  if (!Object.values(parsed.sources).every(isValidSourceEntry)) return false;
  return hasValidFrozenLists(parsed);
}

/**
 * Classify a successfully parsed state, failing closed on anything this build
 * cannot safely treat as healthy:
 *  1. an integer `version` ABOVE the known max ⇒ `too-new` (carried intact, NOT
 *     deep-validated — a future format may legitimately differ in shape);
 *  2. an integer `version` in the known range (1..KNOWN) AND a valid shape ⇒ `ok`;
 *  3. anything else (non-integer/out-of-range version, or malformed shape) ⇒
 *     `corrupt`, routing it into the existing `.bak`/empty-state recovery path.
 */
function classifyParsedState(parsed: unknown): ClassifiedState {
  const version = isPlainObject(parsed) ? parsed.version : undefined;
  const empty = { status: "corrupt" as const, state: emptyState() };
  if (typeof version !== "number" || !Number.isInteger(version)) return empty;
  if (version > KNOWN_STATE_VERSION) return { status: "too-new", state: parsed as WikiState };
  if (version >= 1 && isValidWikiStateShape(parsed)) {
    return { status: "ok", state: parsed as WikiState };
  }
  return empty;
}
