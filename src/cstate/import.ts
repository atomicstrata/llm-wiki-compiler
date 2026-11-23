/**
 * @file src/cstate/import.ts
 * @description The preparation of the `segmented-compile-state-1`
 * capability: import `.llmwiki/state.json` into the segmented compile state
 * (`./contracts.ts`).
 *
 * FENCE. It runs only while the scale record holds the capability as
 * `preparing` (written before this step, the first effect on the store), so
 * the gate blocks every mutation meanwhile and older builds refuse the record.
 *
 * COHERENCE. The file is captured ONCE (stamp, exact bytes, SHA-256) and
 * parsed from exactly those bytes by the incumbent classifier; a corrupt or
 * too-new state, or one with fields the store cannot hold, parks the step
 * (repair it first). After the capture, the file's stamp must still match.
 *
 * ATOMIC, RESUMABLE. The whole import is ONE conditional commit, so a crash
 * leaves nothing but unreferenced segments (a rerun imports again; a
 * collection later removes them) or the whole import. A rerun over an
 * existing store accepts it only when it binds the same bytes; anything else
 * parks. The file itself is never written; it stays as the legacy backup.
 */

import { isDeepStrictEqual } from "node:util";
import { assertCaptureCurrent, captureLegacy } from "../history/contracts.js";
import { newCounters } from "../segments/counters.js";
import { sortedByKey } from "../segments/contracts.js";
import { STATE_FILE } from "../utils/constants.js";
import { classifyStateText } from "../utils/state-shape.js";
import { compileStateMetaOf, MAX_STATE_FILE_BYTES } from "./contracts.js";
import { assertHoldable, metaOfState, openCompileState, ordinalsOf, rowsOfState } from "./store.js";

/** What the import did. */
export interface CompileStateImportV1 {
  readonly imported: boolean;
  readonly sources: number;
  readonly owners: number;
  readonly frozen: number;
}

/** Import `state.json` of `root` into its segmented compile state (or confirm an earlier import of the same bytes). */
export async function importCompileState(root: string): Promise<CompileStateImportV1> {
  const counters = newCounters();
  const capture = await captureLegacy(root, STATE_FILE, MAX_STATE_FILE_BYTES, counters);
  const classified = classifyStateText(capture.body === null ? null : capture.body.toString("utf8"));
  if (classified.status !== "ok" && classified.status !== "missing") throw new Error(`${STATE_FILE} is ${classified.status}; repair it (llmwiki state reset, or restore it) before preparing the segmented compile state`);
  assertHoldable(classified.state);
  const store = await openCompileState(root);
  // Ordinals are the incumbent insertion order of the parsed state.
  const { ordinals, nextOrdinal } = ordinalsOf(classified.state, new Map(), 0);
  const rows = rowsOfState(classified.state, ordinals);
  const meta = metaOfState(classified.state, rows, nextOrdinal, { ...capture.snapshot, records: ordinals.size });
  if (store.exists) {
    if (!isDeepStrictEqual(compileStateMetaOf(store).legacy, meta.legacy)) throw new Error(`the segmented compile state binds a different ${STATE_FILE}; it was changed after an earlier import began`);
    return { imported: false, sources: meta.sources, owners: meta.owners, frozen: meta.frozen };
  }
  await assertCaptureCurrent(root, capture, counters);
  await store.commit({ rows: sortedByKey([...rows].map(([k, v]) => ({ k, v }))), meta: { ...meta } });
  return { imported: true, sources: meta.sources, owners: meta.owners, frozen: meta.frozen };
}
