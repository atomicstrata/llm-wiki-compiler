/**
 * Rule-extraction change-detection state (radar W2).
 *
 * `llmwiki rules extract` must decide which sources to (re)process on its own
 * cadence, independent of the concept compiler. If it reused `.llmwiki/state.json`
 * a source already compiled into pages would be considered "unchanged" and
 * yield zero rule candidates, while a source not yet compiled would be
 * re-extracted on every run. This module persists a parallel per-source hash
 * map in `.llmwiki/rule-state.json` so rule extraction advances its own cursor.
 *
 * The shape mirrors {@link WikiState} (so `detectChanges` can compare against
 * it directly), but only the per-source `hash` is meaningful here — `concepts`
 * is always empty because rule extraction produces candidates, not pages.
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { LLMWIKI_DIR, RULE_STATE_FILE } from "../utils/constants.js";
import type { WikiState, SourceState } from "../utils/types.js";

/** A fresh, empty rule-extraction state. */
function emptyRuleState(): WikiState {
  return { version: 1, indexHash: "", sources: {} };
}

/**
 * Read `.llmwiki/rule-state.json`, returning an empty state when it is missing
 * or unreadable (a corrupt cursor must never block extraction — it just means
 * everything looks new).
 * @param root - Project root directory.
 */
export async function readRuleState(root: string): Promise<WikiState> {
  const filePath = path.join(root, RULE_STATE_FILE);
  if (!existsSync(filePath)) return emptyRuleState();
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as WikiState;
  } catch {
    return emptyRuleState();
  }
}

/** Atomically write rule-state.json (write .tmp then rename). */
async function writeRuleState(root: string, state: WikiState): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  const filePath = path.join(root, RULE_STATE_FILE);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Record that a source was processed by rule extraction at the given hash, so
 * a subsequent `rules extract` skips it until the source changes again.
 * @param root - Project root directory.
 * @param sourceFile - Source filename within `sources/`.
 * @param entry - The source's hash + processing timestamp.
 */
export async function updateRuleSourceState(
  root: string,
  sourceFile: string,
  entry: SourceState,
): Promise<void> {
  const state = await readRuleState(root);
  state.sources[sourceFile] = entry;
  await writeRuleState(root, state);
}
