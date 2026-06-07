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
import type { WikiState, SourceState } from "./types.js";

function emptyState(): WikiState {
  return { version: 1, indexHash: "", sources: {} };
}

/** State file read outcome: ok = parsed, missing = no file, corrupt = unparseable. */
export interface ClassifiedState {
  status: "ok" | "missing" | "corrupt";
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
    return { status: "ok", state: JSON.parse(raw) as WikiState };
  } catch {
    return { status: "corrupt", state: emptyState() };
  }
}

/** Read .llmwiki/state.json, recovering from corruption gracefully (writes a .bak). */
export async function readState(root: string): Promise<WikiState> {
  const classified = await readStateClassified(root);
  if (classified.status === "corrupt") {
    const filePath = path.join(root, STATE_FILE);
    const bakPath = filePath + ".bak";
    console.warn(`⚠ Corrupt state.json — backed up to ${bakPath}, starting fresh.`);
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
