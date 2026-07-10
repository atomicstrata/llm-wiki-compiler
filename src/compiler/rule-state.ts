/**
 * Rule-extraction change-detection state (rule pipeline).
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

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { RULE_STATE_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/markdown.js";
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

/**
 * Atomically write rule-state.json via the shared hardened {@link atomicWrite}
 * primitive (random O_EXCL temp + rename), so this cursor writer inherits the
 * same leaf-symlink write-escape defenses rather than carrying its own temp+rename.
 */
async function writeRuleState(root: string, state: WikiState): Promise<void> {
  const filePath = path.join(root, RULE_STATE_FILE);
  await atomicWrite(filePath, JSON.stringify(state, null, 2), { confineRoot: root });
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
