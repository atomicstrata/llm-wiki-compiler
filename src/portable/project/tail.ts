/**
 * @file src/portable/project/tail.ts
 * @description The derived tail of an apply: compile state, the wiki index and
 * the Map of Content, computed from the project AS IT WILL BE once the apply's
 * pages are written.
 *
 * These are re-derivable objects, never a reason to doubt a committed apply.
 * The host computes them — a client never does — from the post-apply logical
 * view: the stored pages with this apply's writes laid over them. The content
 * comes from the same builders a local compile uses, so a store with no
 * directory gets the same index and MOC a directory would.
 *
 * Where they land is the adapter's protocol: a manifest store makes them
 * visible in the same head swap as the pages they describe; on disk they are
 * best-effort writes after the receipt. Each carries the project's labels.
 */

import { mergeApprovedSourceStates } from "../../commands/review-finalize.js";
import { indexContentFromPages, type PageText } from "../../compiler/indexgen.js";
import { mocContentFromPages } from "../../compiler/obsidian.js";
import { classifyStateText, serializeState } from "../../utils/state.js";
import type { ReviewCandidate } from "../../utils/types.js";
import { CONCEPTS_PREFIX, INDEX_PATH, MOC_PATH, QUERIES_PREFIX, STATE_PATH } from "../logical-paths.js";
import type { ProjectStore, StoredWrite, TailWrite } from "../store/store.js";

const UTF8 = new TextDecoder("utf-8");

/** Every Markdown page under `prefix`, with this apply's writes laid over what is stored. */
async function pagesAfterApply(store: ProjectStore, prefix: string, writes: readonly StoredWrite[]): Promise<PageText[]> {
  const pages = new Map<string, Uint8Array>();
  for (const path of await store.list(prefix)) {
    const stored = await store.read(path);
    if (stored !== null) pages.set(path, stored);
  }
  for (const write of writes) {
    if (write.path.startsWith(prefix)) pages.set(write.path, write.bytes);
  }
  return [...pages.entries()]
    .filter(([path]) => path.endsWith(".md"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ slug: path.slice(prefix.length, -".md".length), content: UTF8.decode(bytes) }));
}

/** The compile state with the applied candidates' sources recorded as compiled, or `null`. */
async function stateAfterApply(store: ProjectStore, applied: readonly ReviewCandidate[]): Promise<string | null> {
  const stored = await store.read(STATE_PATH);
  const classified = classifyStateText(stored === null ? null : UTF8.decode(stored));
  // A state written by a newer version is left alone rather than rewritten.
  if (classified.status === "too-new" || !mergeApprovedSourceStates(classified.state, applied)) return null;
  return serializeState(classified.state);
}

/**
 * The tail writes for one apply.
 *
 * @param store - The project's store, read under the gate.
 * @param writes - The page writes this apply is about to publish.
 * @param applied - The candidates those writes come from.
 * @param labels - The labels every tail object carries.
 */
export async function applyTail(
  store: ProjectStore, writes: readonly StoredWrite[], applied: readonly ReviewCandidate[], labels: readonly string[],
): Promise<TailWrite[]> {
  const concepts = await pagesAfterApply(store, CONCEPTS_PREFIX, writes);
  const queries = await pagesAfterApply(store, QUERIES_PREFIX, writes);
  const tail: TailWrite[] = [
    { path: INDEX_PATH, bytes: Buffer.from(indexContentFromPages(concepts, queries), "utf8"), labels },
    { path: MOC_PATH, bytes: Buffer.from(mocContentFromPages(concepts), "utf8"), labels },
  ];
  const state = await stateAfterApply(store, applied);
  if (state !== null) tail.push({ path: STATE_PATH, bytes: Buffer.from(state, "utf8"), labels });
  return tail;
}
