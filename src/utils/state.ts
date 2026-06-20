/**
 * Manages .llmwiki/state.json — the persistent compilation state that tracks
 * source file hashes and their compiled concepts. Enables incremental
 * compilation by detecting which sources have changed since last compile.
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption
 * from interrupted compiles.
 *
 * VERSION GUARD (Phase 2, v2-aware reads): {@link KNOWN_STATE_VERSION} is the
 * highest schema version this build understands. {@link readStateClassified}
 * classifies a read into a {@link StateStatus} — `ok` / `missing` / `corrupt` /
 * `too-new` — without side effects, so read-only surfaces (freshness, lint,
 * view, export) can branch on the outcome. A `too-new` file (one whose `version`
 * exceeds the known version) is the FAIL-CLOSED case: the parsed state is carried
 * intact, nothing is written, and the recovering {@link readState} throws
 * {@link StateTooNewError} rather than starting fresh — which would clobber the
 * forward-incompatible layout on the next write. A `corrupt` (unparseable) file
 * is backed up to `.bak` and recovered as empty state instead.
 */

import { readFile, writeFile, rename, mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { LLMWIKI_DIR, STATE_FILE } from "./constants.js";
import { note } from "./output.js";
import type { WikiState, SourceState } from "./types.js";

function emptyState(): WikiState {
  return { version: 1, indexHash: "", sources: {} };
}

/**
 * Highest state.json schema version this build understands. A state file whose
 * `version` exceeds this was written by a newer llmwiki; we fail closed rather
 * than risk misinterpreting (or clobbering) a forward-incompatible layout.
 */
export const KNOWN_STATE_VERSION = 2;

/**
 * Thrown by {@link readState} when state.json was written by a newer-than-known
 * llmwiki version. Carries a distinct `.name` so callers can branch on the type
 * rather than string-matching the message.
 */
export class StateTooNewError extends Error {
  constructor(version: number) {
    super(
      `.llmwiki/state.json (version ${version}) was written by a newer llmwiki version ` +
        `(this build understands up to version ${KNOWN_STATE_VERSION}). ` +
        `Upgrade llmwiki to read this project.`,
    );
    this.name = "StateTooNewError";
  }
}

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
 * Read .llmwiki/state.json and classify the outcome WITHOUT side effects.
 * Unlike readState(), this never writes a .bak on corrupt input, so read-only
 * callers (freshness/lint/view/export) can safely use it.
 */
export async function readStateClassified(root: string): Promise<ClassifiedState> {
  const filePath = path.join(root, STATE_FILE);
  if (!existsSync(filePath)) return { status: "missing", state: emptyState() };
  try {
    const raw = await readFile(filePath, "utf-8");
    return classifyParsedState(JSON.parse(raw));
  } catch {
    return { status: "corrupt", state: emptyState() };
  }
}

/** True when `value` is an array whose every element is a string. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** True when `value` is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when one `sources` entry has the required source-state shape. */
function isValidSourceEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.hash !== "string" || typeof entry.compiledAt !== "string") return false;
  if (!isStringArray(entry.concepts)) return false;
  if ("entities" in entry && !isStringArray(entry.entities)) return false;
  return true;
}

/** True when every optional top-level frozen list, if present, is a string array. */
function hasValidFrozenLists(parsed: Record<string, unknown>): boolean {
  if ("frozenSlugs" in parsed && !isStringArray(parsed.frozenSlugs)) return false;
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

/** Read .llmwiki/state.json, recovering from corruption gracefully (writes a .bak). */
export async function readState(root: string): Promise<WikiState> {
  const classified = await readStateClassified(root);
  if (classified.status === "too-new") {
    // Fail closed: never start fresh (which would clobber a forward-incompatible
    // file on the next write) and never copy a .bak.
    throw new StateTooNewError(classified.state.version as number);
  }
  if (classified.status === "corrupt") {
    const filePath = path.join(root, STATE_FILE);
    const bakPath = filePath + ".bak";
    note(`⚠ Corrupt state.json — backed up to ${bakPath}, starting fresh.`);
    await copyFile(filePath, bakPath);
  }
  return classified.state;
}

/** Atomically write state.json (write .tmp then rename). */
export async function writeState(root: string, state: WikiState): Promise<void> {
  const dir = path.join(root, LLMWIKI_DIR);
  await mkdir(dir, { recursive: true });

  const filePath = path.join(root, STATE_FILE);
  const tmpPath = filePath + ".tmp";

  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Update a single source's entry in state after successful compilation.
 * Per-source granularity means interrupted compiles only reprocess incomplete sources.
 */
export async function updateSourceState(
  root: string,
  sourceFile: string,
  entry: SourceState,
): Promise<void> {
  const state = await readState(root);
  state.sources[sourceFile] = entry;
  await writeState(root, state);
}

/** Remove a source entry from state (for deleted sources). */
export async function removeSourceState(
  root: string,
  sourceFile: string,
): Promise<void> {
  const state = await readState(root);
  delete state.sources[sourceFile];
  await writeState(root, state);
}
