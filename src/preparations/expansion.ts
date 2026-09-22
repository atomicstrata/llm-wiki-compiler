/**
 * @file src/preparations/expansion.ts
 * @description The fan-out core (Chunk 3 unit B): the two pure decisions the
 * runner drives fan-out with. `enumerateMapExpansion` turns a `map` phase's
 * source-evidence items into the ordered, bounded, de-duplicated instance set,
 * classifying overflow against the plan's declared disposition.
 * `repeatIterationDecision` decides, after each committed `bounded-repeat`
 * iteration, whether to continue, converge, or apply the limit disposition.
 * Both are pure over their inputs — the runner reads durable evidence and hands
 * the decoded values here, so this module never touches the store and can be
 * exhaustively unit-tested without one.
 *
 * The identity of a `canonical-item-digest` item is the sha256 of its canonical
 * bytes, so two structurally-equal items collide and `deduplicate` drops the
 * second; a `host-id` item is identified by its own declared id. `deduplicate`
 * keeps first-seen order; `fail` refuses any duplicate. Overflow past
 * `maximumItems` is either a hard refusal (`fail-closed`) or a counted deficit
 * against a named completeness class (`count-as-incomplete`) — the class id is
 * pack vocabulary, so the same enumerator serves any pack.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { mapExpansionIdentity } from "./ids.js";

/** One item's declared host id, when `itemIdentity` is `host-id`. */
interface HostIdentifiedItem {
  readonly hostId: string;
  readonly value: unknown;
}

/** The disposition applied when a bounded expansion overflows or fails to converge. */
export type ExpansionDeficitDispositionV1 =
  | { readonly kind: "fail-closed" }
  | { readonly kind: "count-as-incomplete"; readonly completenessClassId: string };

/** The map expansion's data-only shape (a structural mirror of the plan type). */
export interface MapExpansionInputV1 {
  readonly maximumItems: number;
  readonly itemIdentity: "host-id" | "canonical-item-digest";
  readonly duplicateDisposition: "deduplicate" | "fail";
  readonly overflowDisposition: ExpansionDeficitDispositionV1;
}

/** One enumerated fan-out instance: its stable identity and the source item. */
export interface MapInstanceV1 {
  readonly expansionIdentity: string;
  readonly itemDigest: string;
  readonly item: unknown;
}

/** The enumeration outcome — instances to drive, or a typed refusal. */
export type MapEnumerationV1 =
  | { readonly status: "ok"; readonly instances: readonly MapInstanceV1[]; readonly overflowDeficit: number; readonly deficitClassId: string | null }
  | { readonly status: "refused"; readonly reason: string };

/** Item identity, either the declared host id or the canonical-content digest. */
function itemDigestOf(item: unknown, mode: MapExpansionInputV1["itemIdentity"]): string | null {
  if (mode === "host-id") {
    const hostId = (item as Partial<HostIdentifiedItem>)?.hostId;
    return typeof hostId === "string" && hostId.length > 0 ? `host:${hostId}` : null;
  }
  return `sha256:${canonicalDigest(item)}`;
}

/**
 * Enumerate one `map` expansion over its source items.
 *
 * @param items - The decoded source-evidence items, in source order.
 * @param expansion - The map expansion's declared policy.
 * @returns The bounded, de-duplicated instance set plus any overflow deficit,
 *   or a typed refusal when a duplicate is forbidden or overflow is fail-closed.
 */
export function enumerateMapExpansion(
  items: readonly unknown[], expansion: MapExpansionInputV1,
): MapEnumerationV1 {
  const seen = new Set<string>();
  const unique: MapInstanceV1[] = [];
  for (const item of items) {
    const itemDigest = itemDigestOf(item, expansion.itemIdentity);
    if (itemDigest === null) return { status: "refused", reason: "an item carries no usable identity" };
    if (seen.has(itemDigest)) {
      if (expansion.duplicateDisposition === "fail") {
        return { status: "refused", reason: `duplicate item ${itemDigest} under a fail duplicate policy` };
      }
      continue; // deduplicate: drop the second, keep first-seen order
    }
    seen.add(itemDigest);
    unique.push({ expansionIdentity: `${mapExpansionIdentity(expansion.itemIdentity)}:${itemDigest}`, itemDigest, item });
  }
  return boundInstances(unique, expansion);
}

/** Apply `maximumItems` and route the overflow through its declared disposition. */
function boundInstances(
  unique: readonly MapInstanceV1[], expansion: MapExpansionInputV1,
): MapEnumerationV1 {
  if (unique.length <= expansion.maximumItems) {
    return { status: "ok", instances: unique, overflowDeficit: 0, deficitClassId: null };
  }
  const overflow = unique.length - expansion.maximumItems;
  if (expansion.overflowDisposition.kind === "fail-closed") {
    return { status: "refused", reason: `fan-out of ${unique.length} exceeds the ${expansion.maximumItems} cap (fail-closed)` };
  }
  return {
    status: "ok",
    instances: unique.slice(0, expansion.maximumItems),
    overflowDeficit: overflow,
    deficitClassId: expansion.overflowDisposition.completenessClassId,
  };
}

/**
 * The two bounded-repeat continuations the runner drives (Chunk 3 unit B,
 * design v3 §4). `fixed-count` runs a plan-declared number of iterations and
 * never reads output; `until-empty` runs while the iteration's decoded
 * remaining-queue is non-empty. The third plan continuation (`while-boolean`)
 * is deliberately absent — the runner refuses it rather than mis-driving it.
 */
export type RepeatContinuationInputV1 =
  | { readonly kind: "fixed-count"; readonly count: number }
  | { readonly kind: "until-empty" };

/** What a bounded-repeat does after one committed iteration commits. */
export type RepeatDecisionV1 =
  | { readonly kind: "continue" }
  | { readonly kind: "converged" }
  | { readonly kind: "stopped-incomplete"; readonly deficitClassId: string }
  | { readonly kind: "refused"; readonly reason: string };

/** The just-committed iteration and the state the continuation reads. */
export interface RepeatIterationInputV1 {
  readonly completedIndex: number;
  readonly maximumIterations: number;
  readonly continuation: RepeatContinuationInputV1;
  readonly remainingIsEmpty: boolean;
  readonly limitDisposition: ExpansionDeficitDispositionV1;
}

/**
 * Decide what a bounded-repeat does after committing iteration `completedIndex`.
 *
 * `fixed-count` converges once the declared count of iterations has run.
 * `until-empty` converges the moment the remaining-queue empties; otherwise it
 * continues until `maximumIterations`, then applies the limit disposition — a
 * hard refusal (`fail-closed`) or a counted deficit against a completeness class.
 *
 * @param input - The committed iteration index and the continuation state.
 * @returns Whether to drive the next iteration, stop converged, stop with a
 *   counted deficit, or refuse the non-convergent run.
 */
export function repeatIterationDecision(input: RepeatIterationInputV1): RepeatDecisionV1 {
  const nextIndex = input.completedIndex + 1;
  if (input.continuation.kind === "fixed-count") {
    return nextIndex >= input.continuation.count ? { kind: "converged" } : { kind: "continue" };
  }
  if (input.remainingIsEmpty) return { kind: "converged" };
  if (nextIndex < input.maximumIterations) return { kind: "continue" };
  if (input.limitDisposition.kind === "fail-closed") {
    return { kind: "refused", reason: `did not converge within ${input.maximumIterations} iterations (fail-closed)` };
  }
  return { kind: "stopped-incomplete", deficitClassId: input.limitDisposition.completenessClassId };
}
