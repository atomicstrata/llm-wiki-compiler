/**
 * @file src/portable/scoped-disk/disk-state.ts
 * @description The canonical compile state of an adopted registered
 * directory, as the scoped path reads it: ONE read of `.llmwiki/state.json`,
 * and the exact projections a proposal depends on instead of the whole file.
 *
 * - the entry of each selected source, by digest (`state-entry`);
 * - the kept-page and prompt-modifier decisions (`state-decisions`);
 * - the owners of each concept page the closure or a target consulted
 *   (`state-owners`), derived from every entry's concepts.
 *
 * The file itself is never an exact dependency, so a legacy write to an
 * unrelated entry stales nothing. Missing, corrupt or too-new state REFUSES:
 * adoption creates the file, so its absence is a loss, and a reset would spend
 * a model call recompiling decisions it cannot see. The custody record is
 * required too, and while any source custody knew has lost its entry, what
 * it owned is unknown: generation refuses rather than guess.
 */

import { classifyStateText } from "../../utils/state.js";
import type { WikiState } from "../../utils/types.js";
import type { ContentDigest, ObservedObject } from "../contracts.js";
import { recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { conceptPagePath, STATE_CUSTODY_PATH, STATE_PATH } from "../logical-paths.js";
import type { OwnershipView } from "../scoped/closure.js";
import type { ReadView } from "../store/store.js";
import { lostSources, parseCustody, type StateCustodyV2 } from "./custody.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";
const UTF8 = new TextDecoder("utf-8");

/** The canonical state as read once, with the observation it came from. */
export interface CanonicalState { state: WikiState; observed: ObservedObject }

/**
 * Read the canonical state once.
 *
 * @throws PortableRefusal when it is missing, corrupt or from a newer version.
 */
export async function readCanonicalState(view: ReadView): Promise<CanonicalState> {
  const observed = await view.observe(STATE_PATH);
  if (observed === null) {
    throw new PortableRefusal(UNSUPPORTED, "canonical compile state is missing; restore .llmwiki/state.json from backup");
  }
  const classified = classifyStateText(UTF8.decode(observed.bytes));
  if (classified.status !== "ok") throw new PortableRefusal(UNSUPPORTED, `canonical compile state is ${classified.status}`);
  return { state: classified.state, observed };
}

/**
 * Read the state-custody record.
 *
 * @throws PortableRefusal when it is missing or malformed: without it a lost
 *   entry cannot be told from one never compiled.
 */
export async function readCustody(view: ReadView, projectId: string): Promise<{ custody: StateCustodyV2; observed: ObservedObject }> {
  const observed = await view.observe(STATE_CUSTODY_PATH);
  const custody = observed === null ? null : parseCustody(UTF8.decode(observed.bytes), projectId);
  if (observed === null || custody === null) {
    throw new PortableRefusal(UNSUPPORTED, "state custody is missing or malformed; restore .llmwiki/portable/state-custody.json from backup");
  }
  return { custody, observed };
}

/** The digest of the decisions a scoped compile uses: kept pages and prompt modifiers. */
export function decisionsDigest(state: WikiState): ContentDigest {
  return recordDigest({ frozenSlugs: [...(state.frozenSlugs ?? [])].sort(), promptModifiers: state.promptModifiers ?? null });
}

/** The ownership table of the canonical state: which pages each entry owns, and who owns each page. */
export function ownershipOf(state: WikiState): OwnershipView {
  const sources = new Map<string, { concepts: readonly string[]; lost: boolean }>();
  const owners = new Map<string, string[]>();
  for (const [source, entry] of Object.entries(state.sources)) {
    const concepts = [...new Set(entry.concepts.map((slug) => conceptPagePath(slug)))].sort();
    sources.set(source, { concepts, lost: false });
    for (const path of concepts) owners.set(path, [...(owners.get(path) ?? []), source]);
  }
  for (const list of owners.values()) list.sort();
  return { sources, owners };
}

/**
 * Refuse while ANY entry custody knew has disappeared. Custody keeps only an
 * entry's digest, so what a lost entry owned — and so whether it co-owned a
 * page this proposal would write — is unknown. Nothing is reconstructed from
 * older evidence or guessed from pages: the operator restores the state first.
 *
 * @throws PortableRefusal before any model call when an entry is lost.
 */
export function refuseLostEntries(custody: StateCustodyV2, state: WikiState): void {
  const lost = lostSources(custody, state);
  if (lost.length === 0) return;
  throw new PortableRefusal(UNSUPPORTED, `compile state unknown: ${lost.length} recorded source entr${lost.length === 1 ? "y has" : "ies have"} disappeared from .llmwiki/state.json; restore it from backup before a scoped proposal`);
}

/** The owners of each consulted page, as a `state-owners` dependency records them. */
export function ownerEntries(view: OwnershipView, paths: readonly string[]): { path: string; owners: readonly string[] }[] {
  return [...new Set(paths)].sort().map((path) => ({ path, owners: view.owners.get(path) ?? [] }));
}
