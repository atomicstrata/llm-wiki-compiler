/**
 * Manages .llmwiki/state.json — the persistent compilation state that tracks
 * source file hashes and their compiled concepts. Enables incremental
 * compilation by detecting which sources have changed since last compile.
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption
 * from interrupted compiles.
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
    return classifyParsedState(JSON.parse(raw) as WikiState);
  } catch {
    return { status: "corrupt", state: emptyState() };
  }
}

/**
 * Classify a successfully parsed state. Fails closed on a newer-than-known
 * `version` by returning `too-new` with the parsed state carried intact — no
 * reset and no disk write, so read-only callers can surface the condition.
 */
function classifyParsedState(state: WikiState): ClassifiedState {
  if ((state.version as number) > KNOWN_STATE_VERSION) {
    return { status: "too-new", state };
  }
  return { status: "ok", state };
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
