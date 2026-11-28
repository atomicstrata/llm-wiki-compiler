/**
 * @file src/portable/scoped/closure.ts
 * @description The bounded shared-concept closure of a scoped proposal,
 * decided from an AUTHORITATIVE ownership table at one head.
 *
 * When a source in scope owns a concept page another source also owns,
 * compiling it properly means re-reading that co-owner too. The closure is:
 *
 * - expanded: co-owners admitted under `maxExpandedSources`, compiled with the scope;
 * - frontier: co-owners beyond that bound and the next hop's co-owners,
 *   reported and never compiled or marked complete;
 * - refused: more co-owners than the bound plus the host's frontier ceiling,
 *   or any source in the closure whose record is lost (its state is unknown).
 *
 * Discovery itself is bounded: it stops as soon as it has seen one co-owner
 * more than it could admit or report, so a concept shared by corpus-many
 * sources never materializes all of them. The proposal depends on the
 * exact owner lists of the concepts it consulted, so an ownership change there stales it.
 */

import { PortableRefusal } from "../errors.js";
import { SCOPED_HOST_CEILINGS, type CompileScopeV2 } from "./contracts.js";

/** The admitted expansion, the reported frontier, and every concept page whose owners decided them. */
export interface Closure { expanded: readonly string[]; frontier: readonly string[]; consulted: readonly string[] }

/**
 * An authoritative ownership table at one head: which concept pages each
 * source owns, and which sources own each page. The authority-only store's
 * namespace snapshot is one; a registered directory's is derived from its
 * canonical `state.json`. A `lost` source has unknown state.
 */
export interface OwnershipView {
  owners: { get(path: string): readonly string[] | undefined };
  sources: { get(source: string): { concepts: readonly string[]; lost: boolean } | undefined };
}

/** Every owner of each of `sources`' concepts, lazily (duplicates included), noting each concept consulted. */
function* ownerships(snapshot: OwnershipView, sources: readonly string[], consulted: Set<string>): Generator<string> {
  for (const source of [...sources].sort()) {
    for (const concept of snapshot.sources.get(source)?.concepts ?? []) {
      consulted.add(concept);
      yield* snapshot.owners.get(concept) ?? [];
    }
  }
}

/** Distinct co-owners of `sources`' concepts outside `exclude`, sorted; at most `limit + 1` are ever collected. */
function coOwners(
  snapshot: OwnershipView, sources: readonly string[], exclude: ReadonlySet<string>, limit: number, consulted: Set<string>,
): string[] {
  const found = new Set<string>();
  for (const owner of ownerships(snapshot, sources, consulted)) {
    if (!exclude.has(owner)) found.add(owner);
    if (found.size > limit) break;
  }
  return [...found].sort();
}

/** Refuse when any source the compile would read has a lost record: its state is unknown, not absent. */
function refuseUnknown(snapshot: OwnershipView, sources: readonly string[]): void {
  if (sources.some((source) => snapshot.sources.get(source)?.lost === true)) {
    throw new PortableRefusal("operation_unsupported_on_portable_path", "source state unknown: restore it from retained evidence first");
  }
}

/**
 * Decide the closure of `scope` in `snapshot`.
 *
 * @throws PortableRefusal `limit_exceeded` when the co-owners exceed what can be admitted or reported,
 *   `operation_unsupported_on_portable_path` when a source in the closure has unknown state.
 */
export function decideClosure(snapshot: OwnershipView | undefined, scope: Pick<CompileScopeV2, "sources" | "bounds">): Closure {
  const named = scope.sources.names;
  if (snapshot === undefined) return { expanded: [], frontier: [], consulted: [] };
  const consulted = new Set<string>();
  refuseUnknown(snapshot, named);
  const maxExpanded = scope.bounds.maxExpandedSources;
  const reportable = maxExpanded + SCOPED_HOST_CEILINGS.maxFrontier;
  const firstHop = coOwners(snapshot, named, new Set(named), reportable, consulted);
  if (firstHop.length > reportable) throw new PortableRefusal("limit_exceeded", "shared-concept co-owners");
  const expanded = firstHop.slice(0, maxExpanded);
  refuseUnknown(snapshot, expanded);
  const inside = new Set([...named, ...firstHop]);
  const secondHop = coOwners(snapshot, expanded, inside, SCOPED_HOST_CEILINGS.maxFrontier, consulted);
  const frontier = [...firstHop.slice(maxExpanded), ...secondHop].sort();
  if (frontier.length > SCOPED_HOST_CEILINGS.maxFrontier) throw new PortableRefusal("limit_exceeded", "shared-concept frontier");
  return { expanded, frontier, consulted: [...consulted].sort() };
}
