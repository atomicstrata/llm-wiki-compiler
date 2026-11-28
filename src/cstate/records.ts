/**
 * @file src/cstate/records.ts
 * @description The compile-state ROUTE of the local record binding: on a
 * project whose segmented compile state is the authority (capability
 * `segmented-compile-state-1` ready), every read and write of
 * `.llmwiki/state.json` through `diskLocalRecords` reaches the store instead,
 * so each incumbent state reader and writer (`../utils/state.ts`, the compile
 * draft, status, lint, export, the viewer) keeps its code path:
 * - `exists` is true;
 * - the text is the CAPPED materialization of the store (`compile_state_too_large` beyond it);
 * - a whole-state write is the store's diff commit, under the caller's lock;
 * - a copy (only the corrupt-state backup ever copies it) refuses: the
 *   materialized state is never corrupt, and `state.json` itself is the
 *   untouched legacy backup.
 * Every other record, and every project without the capability `ready`
 * (including while it is `preparing`), is the base binding unchanged.
 */

import { indexedActive } from "../indexed/routing.js";
import { capabilityStatus } from "../scale/capability-status.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import { STATE_FILE } from "../utils/constants.js";
import { serializeState } from "../utils/state-shape.js";
import type { WikiState } from "../utils/types.js";
import { CompileStateError, CSTATE_CAPABILITY } from "./contracts.js";
import { commitWholeState, materializeCompileState } from "./store.js";

/**
 * Whether the segmented compile state is the compile-state authority of the
 * project at `root`. Selected through the indexed route first, so it fails
 * closed exactly as that route does: indexed stores with a missing or
 * unreadable scale record refuse (`scale-state-unreadable`), as does a
 * foreign restore marker; `state.json` is never served in their place.
 */
export async function compileStateSegmented(root: string): Promise<boolean> {
  if (!(await indexedActive(root))) return false;
  return (await capabilityStatus(root, CSTATE_CAPABILITY)) === "ready";
}

/**
 * The materialized state, or a `compile_state_*` refusal for ANY store fault
 * (a malformed manifest, a corrupt segment), so the state classifier can never
 * mistake a store fault for a corrupt `state.json` and start fresh.
 */
async function materializedOrRefused(root: string): Promise<WikiState> {
  try {
    return await materializeCompileState(root);
  } catch (error) {
    if (error instanceof CompileStateError) throw error;
    throw new CompileStateError("compile_state_unavailable", `the segmented compile state cannot be read (${error instanceof Error ? error.message : String(error)}); it is never replaced by ${STATE_FILE}`);
  }
}

/** `base` with `.llmwiki/state.json` routed to the segmented compile state of `root` while it is the authority. */
export function routedStateRecords(root: string, base: LegacyLocalRecords): LegacyLocalRecords {
  const segmented = (relPath: string): Promise<boolean> => (relPath === STATE_FILE ? compileStateSegmented(root) : Promise.resolve(false));
  return {
    exists: async (relPath) => (await segmented(relPath)) || base.exists(relPath),
    readTextNoFollow: async (relPath) => ((await segmented(relPath)) ? serializeState(await materializedOrRefused(root)) : base.readTextNoFollow(relPath)),
    copy: async (fromRelPath, toRelPath) => {
      if (await segmented(fromRelPath)) throw new CompileStateError("compile_state_unavailable", `${STATE_FILE} is the legacy backup of the segmented compile state and is not copied`);
      return base.copy(fromRelPath, toRelPath);
    },
    writeAtomic: async (relPath, text) => ((await segmented(relPath)) ? commitWholeState(root, JSON.parse(text) as WikiState) : base.writeAtomic(relPath, text)),
    locate: base.locate,
  };
}
