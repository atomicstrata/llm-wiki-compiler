/**
 * @file src/operations-packs/handlers/set-select.ts
 * @description The set-select host-handler family (design section 16.3): a PURE,
 * host-owned deterministic policy over validated evidence — stable dedup by
 * declared identity, filter by CLOSED registered predicates, stable sort by
 * declared fields, bounded top-N with an explicit overflow/completeness
 * disposition, set union/intersection/difference, and grouping by a declared
 * scalar key. There is NO arbitrary comparator or expression language: the single
 * `operation` discriminant selects one closed branch, ordering keys come only from
 * declared fields, and a predicate is either a registered id (an unregistered id
 * fails closed) or one of the CLOSED parameterised forms, whose parameters are a
 * declared field and a declared value set — never an expression. Model judgment
 * or semantic ranking belongs in a provider, never here.
 *
 * RESOLVED FROM PROSE (section 16.3). The launch closed predicate family is
 * `has-identity` (every declared identity field present and non-empty) and
 * `non-empty` (no declared field is an empty string); each is parameterless and
 * total. The one parameterised form is `one-of` (see {@link oneOfPredicate}): it
 * is the ADMISSION predicate, and its refusals are counted as a completeness
 * deficit UNCONDITIONALLY, under their own exclusion reason. The parameterless
 * family shares the single `filtered-out` reason, which is counted only when the
 * body also declares `exactly-one-present` — so that family's refusals are
 * counted conditionally and cannot be told apart from one another.
 * Overflow beyond top-N or the item ceiling is dispositioned by the body:
 * `fail` throws, `record-deficit` truncates in stable order and counts one deficit.
 */

import { capItems, enforceOutputBytes, identityKey, sortKey, stableSortByKey, type PackOverflowPolicyV1 } from "./evidence.js";
import { PackHostHandlerError } from "./types.js";
import { isSlugSafe } from "../../profile/identity.js";
import { slugify } from "../../utils/markdown.js";
import type { SelectFilterPredicateV2, SelectOneOfPredicateV2, SelectPhaseBodyV2 } from "../recipe-types.js";
import type {
  PackCompletenessDeficitV1, PackEvidenceItemV1, PackExclusionV1, PackHandlerSelectionV1,
  PackSelectGroupV1, PackSelectInputV1, PackSelectOperationV1, PackSelectResultV1,
} from "./types.js";

/**
 * The closed launch predicate family; an unregistered id fails closed.
 *
 * `exactly-one-present` is the VALIDATION predicate (spec §2.1 change 3): over
 * the declared identity fields, exactly one must be non-empty. It exists for
 * rows that carry their class in WHICH key field is populated — a row with no
 * key populated, or several, is malformed rather than merely routed elsewhere,
 * so its exclusions are counted as `invalid-row` deficits (see
 * {@link validationDeficit}) instead of vanishing into `filtered-out`, which is
 * how a malformed provider row used to be silently dropped.
 *
 * The registry holds the PARAMETERLESS family; the parameterised `one-of`
 * admission predicate resolves through {@link resolvePredicate} from its parsed
 * body entry (see {@link oneOfPredicate}).
 */
const PREDICATES: Readonly<Record<string, SelectPredicateFnV1>> = {
  "has-identity": (item, fields) => fields.every((field) => nonEmpty(item.fields[field])),
  "non-empty": (item) => Object.values(item.fields).every(nonEmpty),
  "exactly-one-present": (item, fields) => fields.filter((field) => nonEmpty(item.fields[field])).length === 1,
};

/** One resolved predicate over an item and the body's declared identity fields. */
type SelectPredicateFnV1 = (item: PackEvidenceItemV1, identityFields: readonly string[]) => boolean;

/**
 * The parameterised `one-of` admission predicate: the declared field must equal
 * EXACTLY ONE declared value by full-string equality (the values are
 * parse-validated distinct, so membership IS exactly-one).
 *
 * It reads the field EXACTLY the way the downstream `whenEquals` intent gates
 * do (intent-compile.ts `groupItems`: the value's string form), and it NEVER
 * trims: provider decode preserves the JSON scalar unchanged
 * (provider-response.ts `decodeItem` assigns the raw value), so a
 * `" supported"` field a trimming predicate admitted here would match NO
 * intent group downstream and vanish silently. Whitespace is an invalid row,
 * surfaced as a deficit — never repaired by a normalization layer two readers
 * could disagree about.
 */
function oneOfPredicate(declared: SelectOneOfPredicateV2): SelectPredicateFnV1 {
  return (item) => declared.values.includes(String(item.fields[declared.field] ?? ""));
}

/** True when a scalar is present and not the empty string. */
function nonEmpty(value: unknown): boolean {
  return value !== undefined && value !== "";
}

/** The per-invocation ordering closures over the body's declared fields. */
interface SelectContextV1 {
  readonly input: PackSelectInputV1;
  readonly identityOf: (item: PackEvidenceItemV1) => string;
  readonly sortOf: (item: PackEvidenceItemV1) => string;
}

/** One operation's ordered result plus the identities it excluded. */
interface SelectOutcomeV1 {
  readonly items: readonly PackEvidenceItemV1[];
  readonly excluded: readonly PackExclusionV1[];
}

/** Fail closed unless a two-set operation was given its secondary set. */
function requireSecondary(input: PackSelectInputV1): readonly PackEvidenceItemV1[] {
  if (input.secondary === undefined) throw new PackHostHandlerError(`${input.body.operation} requires a secondary set`);
  return input.secondary;
}

/** Stable dedup by declared identity, keeping the first of each identity (16.3). */
function dedupe(items: readonly PackEvidenceItemV1[], identityOf: (item: PackEvidenceItemV1) => string): SelectOutcomeV1 {
  const seen = new Set<string>();
  const kept: PackEvidenceItemV1[] = [];
  const excluded: PackExclusionV1[] = [];
  for (const item of items) {
    const key = identityOf(item);
    if (seen.has(key)) excluded.push({ itemId: item.itemId, reason: "duplicate-identity" });
    else { seen.add(key); kept.push(item); }
  }
  return { items: kept, excluded };
}

/**
 * The counted deficit a VALIDATING select emits for its malformed rows.
 *
 * Scoped to `exactly-one-present` deliberately: a routing split's `has-identity`
 * exclusions are intended (each class's split drops every other class's rows),
 * so counting those as deficits would fail every fan-out. The validation
 * predicate's exclusions are different in kind — a row failing it is malformed,
 * not routed — and a `required` completeness class turns this count into a run
 * failure instead of a silent drop.
 */
function validationDeficit(body: SelectPhaseBodyV2, outcome: SelectOutcomeV1): PackCompletenessDeficitV1[] {
  // `invalid-value` exclusions come ONLY from the `one-of` admission predicate,
  // so they always count, and counting them costs a fan-out split nothing: a row
  // a routing predicate dropped carries `filtered-out` instead.
  // `filtered-out` counts only under the original exactly-one-present special
  // case, whose PRE-EXISTING breadth this change does not narrow — every
  // parameterless predicate shares the one `filtered-out` reason, so a body
  // declaring exactly-one-present ALONGSIDE a routing predicate still counts
  // that predicate's routine exclusions. No shipped pack declares that mix.
  const counted = new Set<PackExclusionV1["reason"]>(["invalid-value"]);
  if (body.filterPredicateIds.includes("exactly-one-present")) counted.add("filtered-out");
  const dropped = outcome.excluded.filter((exclusion) => counted.has(exclusion.reason)).length;
  if (dropped === 0) return [];
  return [{ completenessClass: body.completenessClass, reason: "invalid-row", droppedCount: dropped }];
}

/**
 * Keep items passing every registered predicate; reject the rest (section 16.3).
 *
 * Classification is ORDER-INDEPENDENT: routing/registry predicates are always
 * evaluated before the `one-of` admission predicate regardless of declared
 * order, so a row a route drops is labeled with that route's intended
 * `filtered-out` reason and `invalid-value` (the counted deficit) is reserved
 * for rows that passed every routing predicate and failed admission. Without
 * this, declaring `one-of` first would re-label a legitimately routed-away row
 * as malformed and turn a fan-out split into a spurious REQUIRED refusal.
 */
function filter(ctx: SelectContextV1): SelectOutcomeV1 {
  const declared = ctx.input.body.filterPredicateIds;
  const canonical = [
    ...declared.filter((entry) => typeof entry === "string"),
    ...declared.filter((entry) => typeof entry !== "string"),
  ];
  const predicates = canonical.map((entry) => ({
    reason: exclusionReasonOf(entry), test: resolvePredicate(entry),
  }));
  const kept: PackEvidenceItemV1[] = [];
  const excluded: PackExclusionV1[] = [];
  for (const item of ctx.input.primary) {
    const failed = predicates.find(({ test }) => !test(item, ctx.input.body.identityFields));
    if (failed === undefined) kept.push(item);
    else excluded.push({ itemId: item.itemId, reason: failed.reason });
  }
  return { items: kept, excluded };
}

/** The distinct reason a `one-of` refusal carries; every plain predicate filters. */
function exclusionReasonOf(entry: SelectFilterPredicateV2): PackExclusionV1["reason"] {
  return typeof entry === "string" ? "filtered-out" : "invalid-value";
}

/**
 * The identity one item takes when its phase derives identity from content:
 * each declared identity field slugified, joined in declared order.
 *
 * EVERY declared field must contribute. Dropping an empty one would let two
 * records that differ only in that field collapse onto one identity, which is
 * the silent overwrite this whole mechanism exists to prevent.
 */
function contentIdentity(item: PackEvidenceItemV1, fields: readonly string[]): string {
  const parts = fields.map((field) => slugify(String(item.fields[field] ?? "")));
  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw new PackHostHandlerError(
      "a select phase deriving identity from content produced an empty identity: its declared "
      + "identityFields are empty, or hold no letters or digits, on at least one selected item",
    );
  }
  const slug = parts.join("-");
  if (!isSlugSafe(slug)) {
    throw new PackHostHandlerError(
      "a select phase derived an identity that is not slug-safe from its identityFields",
    );
  }
  return slug;
}

/**
 * Re-key selected items by content, refusing a collision.
 *
 * REFUSING RATHER THAN DEDUPING is the point: `dedupe` drops a later duplicate
 * because the caller asked for a set, but here a collision means two DIFFERENT
 * records were handed the same identity, and keeping the first would silently
 * discard the second while the run reported success. That is an authoring
 * error in the declared identity fields, and it is the pack author's to fix.
 */
function rekeyByContent(
  items: readonly PackEvidenceItemV1[], fields: readonly string[],
): PackEvidenceItemV1[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const itemId = contentIdentity(item, fields);
    if (seen.has(itemId)) {
      throw new PackHostHandlerError(
        "two selected items derive the same content identity, so one would silently replace "
        + "the other: the declared identityFields do not distinguish them",
      );
    }
    seen.add(itemId);
    return { itemId, fields: item.fields };
  });
}

/** Resolve one registered filter predicate or fail closed on an unknown id. */
function resolvePredicate(entry: SelectFilterPredicateV2): SelectPredicateFnV1 {
  if (typeof entry !== "string") return oneOfPredicate(entry);
  const predicate = PREDICATES[entry];
  if (predicate === undefined) throw new PackHostHandlerError(`filter predicate is not registered: ${entry}`);
  return predicate;
}

/** Keep primary items whose identity is present in the secondary set (16.3). */
function intersection(ctx: SelectContextV1): SelectOutcomeV1 {
  const others = new Set(requireSecondary(ctx.input).map(ctx.identityOf));
  return splitBySecondary(ctx, others, "not-in-secondary", true);
}

/** Keep primary items whose identity is ABSENT from the secondary set (16.3). */
function difference(ctx: SelectContextV1): SelectOutcomeV1 {
  const others = new Set(requireSecondary(ctx.input).map(ctx.identityOf));
  return splitBySecondary(ctx, others, "in-secondary", false);
}

/** Partition primary by secondary membership, keeping the requested side. */
function splitBySecondary(ctx: SelectContextV1, others: ReadonlySet<string>, reason: PackExclusionV1["reason"], keepWhenPresent: boolean): SelectOutcomeV1 {
  const kept: PackEvidenceItemV1[] = [];
  const excluded: PackExclusionV1[] = [];
  for (const item of ctx.input.primary) {
    if (others.has(ctx.identityOf(item)) === keepWhenPresent) kept.push(item);
    else excluded.push({ itemId: item.itemId, reason });
  }
  return { items: kept, excluded };
}

/** The flat dispatch table: one closed branch per registered set operation. */
const OPERATIONS: Readonly<Record<PackSelectOperationV1, (ctx: SelectContextV1) => SelectOutcomeV1>> = {
  dedupe: (ctx) => dedupe(ctx.input.primary, ctx.identityOf),
  filter,
  sort: (ctx) => ({ items: stableSortByKey(ctx.input.primary, ctx.sortOf), excluded: [] }),
  "top-n": (ctx) => ({ items: stableSortByKey(ctx.input.primary, ctx.sortOf), excluded: [] }),
  union: (ctx) => dedupe([...ctx.input.primary, ...requireSecondary(ctx.input)], ctx.identityOf),
  intersection,
  difference,
  "group-by": (ctx) => ({ items: stableSortByKey(ctx.input.primary, (item) => `${groupKey(ctx.input.body, item)}:${item.itemId}`), excluded: [] }),
};

/** The declared group key of one item, or fail closed when none is declared. */
function groupKey(body: SelectPhaseBodyV2, item: PackEvidenceItemV1): string {
  if (body.groupByField === undefined) throw new PackHostHandlerError("group-by requires a groupByField");
  return String(item.fields[body.groupByField] ?? "");
}

/** The item ceiling this operation enforces: top-N, else the descriptor cap. */
function itemCap(input: PackSelectInputV1): number {
  if (input.body.operation !== "top-n") return input.bounds.maximumItems;
  if (input.body.topN === undefined) throw new PackHostHandlerError("top-n requires topN");
  return Math.min(input.body.topN, input.bounds.maximumItems);
}

/** The overflow disposition the body declares for over-cap items (section 16.3). */
function overflowPolicy(body: SelectPhaseBodyV2): PackOverflowPolicyV1 {
  if (body.overflowDisposition === "fail") return { kind: "fail" };
  return { kind: "record-deficit", completenessClass: body.completenessClass, reason: "overflow" };
}

/** Build the stable group summary from the already-bounded item list. */
function buildGroups(items: readonly PackEvidenceItemV1[], body: SelectPhaseBodyV2): PackSelectGroupV1[] {
  const byKey = new Map<string, string[]>();
  for (const item of items) {
    const key = groupKey(body, item);
    const bucket = byKey.get(key) ?? [];
    bucket.push(item.itemId);
    byKey.set(key, bucket);
  }
  return [...byKey.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, itemIds]) => ({ key, itemIds }));
}

/** The selection and per-item over-cap disposition after the item cap is applied. */
function cappedSelection(outcome: SelectOutcomeV1, kept: readonly PackEvidenceItemV1[], operation: PackSelectOperationV1): PackHandlerSelectionV1 {
  const reason: PackExclusionV1["reason"] = operation === "top-n" ? "over-top-n" : "over-item-budget";
  const overCap = outcome.items.slice(kept.length).map((item) => ({ itemId: item.itemId, reason }));
  return { included: kept.map((item) => item.itemId), excluded: [...outcome.excluded, ...overCap] };
}

/**
 * Run one closed deterministic set-select operation over validated evidence,
 * producing bounded output items and a visible included/excluded identity set
 * (section 16.3). Pure: identical input yields identical output bytes; it never
 * writes. Overflow beyond top-N / the item cap is dispositioned by the body.
 */
export function selectSet(input: PackSelectInputV1): PackSelectResultV1 {
  const ctx: SelectContextV1 = {
    input,
    identityOf: (item) => identityKey(item, input.body.identityFields),
    sortOf: (item) => sortKey(item, input.body.sortFields),
  };
  const outcome = OPERATIONS[input.body.operation](ctx);
  const bounded = capItems(outcome.items, itemCap(input), overflowPolicy(input.body));
  // Re-key the SURVIVORS only. An excluded item keeps its positional identity
  // on purpose: it has no content identity to speak of — it may have been
  // excluded precisely because its identity field was empty — and the caller's
  // list position is what locates it in the input they actually wrote.
  const kept = input.body.identityFrom === "identity-fields"
    ? rekeyByContent(bounded.kept, input.body.identityFields)
    : bounded.kept;
  const groups = input.body.operation === "group-by" ? buildGroups(kept, input.body) : undefined;
  const result: PackSelectResultV1 = {
    operation: input.body.operation, items: kept, ...(groups === undefined ? {} : { groups }),
    selection: cappedSelection(outcome, kept, input.body.operation),
    deficits: [
      ...(bounded.deficit === undefined ? [] : [bounded.deficit]),
      ...validationDeficit(input.body, outcome),
    ],
  };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
