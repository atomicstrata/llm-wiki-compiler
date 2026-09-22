/**
 * @file src/operations-packs/handlers/reconcile.ts
 * @description The reconcile host-handler family (design section 16.6): a PURE
 * comparison of proposed evidence against the current knowledge/workspace snapshot
 * that produces findings and NEVER writes. Each proposed identity is classified
 * into exactly one of the closed finding classes, restricted to the classes the
 * body declares; a naturally-applicable class the body does not declare is counted
 * as a suppressed-finding deficit rather than silently dropped. Resolution choices
 * are the caller's job downstream (an intent phase or a reviewed replacement); this
 * family only reports.
 *
 * RESOLVED FROM PROSE (section 16.6). The launch classifier derives seven of the
 * nine classes from a deterministic byte/version/shape comparison: `duplicate-identity`
 * (a repeated proposed identity), `absent` (no snapshot match), `identical` (equal
 * payload digest), `supersession-candidate` / `stale-precondition` (a higher / lower
 * declared `version`), `compatible-update` (an additive change), and `conflicting`
 * (any other divergence). `unavailable-authority` and `unsupported-mutation` remain
 * in the closed enum for the authority/mutation checks a later slice supplies.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { projectItem } from "./projection.js";
import { CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD } from "../runtime/store-snapshot.js";
import { capItems, enforceOutputBytes, stableSortByKey } from "./evidence.js";
import { PackHostHandlerError } from "./types.js";
import type { PackProjectionV2 } from "../recipe-types.js";
import type {
  PackEvidenceItemV1, PackEvidenceScalarV1, PackReconcileFindingClassV1, PackReconcileFindingV1,
  PackReconcileInputV1, PackReconcileResultV1,
} from "./types.js";

/** The canonical author-read digest form the gate requires: `sha256:` + 64 lowercase hex. */
const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The IN-RECONCILE author-read-digest chokepoint (a generic artifact-UPDATE
 * primitive). When the body names `expectedCurrentDigestRef`, every proposed
 * identity that MATCHES a snapshot page (a would-be update) must carry, under that
 * field, a canonical `sha256:<64hex>` digest EQUAL to that page's host-derived
 * current-digest. It is checked on the RAW snapshot, before {@link withoutOnDiskFields}
 * strips the on-disk digest, so the value compared is exactly the one the update's
 * precondition later sources. A stale digest — the page changed since the caller
 * read it — fails closed with no finding emitted; a proposal with no snapshot match
 * (a create) is not an update and is left ungated. But a proposal that MATCHES a
 * snapshot page (a would-be update) and seals NO digest REFUSES: skipping it would
 * let a caller read a draft, allow a body edit, then update WITHOUT a digest —
 * reconcile would source the precondition from the NEWER snapshot while writing the
 * stale body, clobbering the edit. Once a body declares the ref, EVERY update it
 * drives must seal the digest.
 */
function enforceExpectedCurrentDigest(
  proposed: readonly PackEvidenceItemV1[], snapshot: readonly PackEvidenceItemV1[], ref: string,
): void {
  const currentById = firstByIdentity(snapshot);
  for (const item of proposed) {
    const current = currentById.get(item.itemId);
    if (current === undefined) continue; // absent → a create, not a gated update
    const sealed = item.fields[ref];
    if (sealed === undefined) {
      throw new PackHostHandlerError(
        `reconcile requires the author-read digest field "${ref}" to update "${item.itemId}", but the proposal sealed none; refusing`);
    }
    if (typeof sealed !== "string" || !CANONICAL_SHA256.test(sealed)) {
      throw new PackHostHandlerError(
        `reconcile author-read digest field "${ref}" on "${item.itemId}" is not a canonical sha256:<64hex> value; refusing`);
    }
    const currentDigest = current.fields[CURRENT_DIGEST_FIELD];
    if (typeof currentDigest !== "string") {
      throw new PackHostHandlerError(
        `reconcile snapshot item "${item.itemId}" carries no current-digest to gate the author-read digest against; refusing`);
    }
    if (sealed !== `sha256:${currentDigest}`) {
      throw new PackHostHandlerError(
        `reconcile author-read digest "${sealed}" for "${item.itemId}" does not equal the current page digest "sha256:${currentDigest}"; refusing a stale artifact-update`);
    }
  }
}

/** The canonical payload digest of one item's closed fields. */
function payloadDigest(item: PackEvidenceItemV1): string {
  return canonicalDigest(item.fields);
}

/** Read one numeric field, or undefined when it is absent or non-numeric. */
function numberField(item: PackEvidenceItemV1, field: string): number | undefined {
  const value = item.fields[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** True when every snapshot field is present and unchanged in the proposal. */
function isCompatible(proposed: PackEvidenceItemV1, current: PackEvidenceItemV1): boolean {
  return Object.entries(current.fields).every(([key, value]) => proposed.fields[key] === value);
}

/** Classify a changed proposal by declared version, then by additive shape. */
function versionOrShape(proposed: PackEvidenceItemV1, current: PackEvidenceItemV1): PackReconcileFindingClassV1 {
  const next = numberField(proposed, "version");
  const prior = numberField(current, "version");
  if (next !== undefined && prior !== undefined && next !== prior) {
    return next > prior ? "supersession-candidate" : "stale-precondition";
  }
  return isCompatible(proposed, current) ? "compatible-update" : "conflicting";
}

/** The natural finding class of one proposed identity against the snapshot (16.6). */
function classify(identity: string, proposed: PackEvidenceItemV1, snapshot: ReadonlyMap<string, PackEvidenceItemV1>): PackReconcileFindingClassV1 {
  const current = snapshot.get(identity);
  if (current === undefined) return "absent";
  if (payloadDigest(proposed) === payloadDigest(current)) return "identical";
  return versionOrShape(proposed, current);
}

/** Count how many proposed items carry each identity (for duplicate detection). */
function identityCounts(items: readonly PackEvidenceItemV1[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + 1);
  return counts;
}

/** The first proposed item per identity, preserving first-seen determinism. */
function firstByIdentity(items: readonly PackEvidenceItemV1[]): Map<string, PackEvidenceItemV1> {
  const first = new Map<string, PackEvidenceItemV1>();
  for (const item of items) if (!first.has(item.itemId)) first.set(item.itemId, item);
  return first;
}

/** The natural class of one identity: duplicate first, else the snapshot compare. */
function naturalClass(identity: string, item: PackEvidenceItemV1, counts: ReadonlyMap<string, number>, snapshot: ReadonlyMap<string, PackEvidenceItemV1>): PackReconcileFindingClassV1 {
  return (counts.get(identity) ?? 0) > 1 ? "duplicate-identity" : classify(identity, item, snapshot);
}

/**
 * The field a chainable finding stamps its verdict under. It is a SLUG because
 * the pack grammar's identifiers are slugs: a camelCase key is unaddressable
 * from a recipe, so a pack could never gate on a verdict it could not name.
 */
export const FINDING_CLASS_FIELD = "finding-class";

/**
 * The findings republished as CHAINABLE evidence, one item per finding.
 *
 * A finding is a verdict ABOUT a proposal, and the phase that proposes next has
 * to act on it — draft the identities the store does not hold, leave the
 * colliding ones alone. Until this existed the verdicts were durable evidence a
 * human could read and a successor phase could not receive at all: the
 * phase-output decoder reads a predecessor's `items`, and reconcile published
 * only `findings`. So a pack could surface collisions and then propose over them
 * anyway, which is precisely the "partial" in a partial bootstrap.
 *
 * The item carries the proposal's own fields with `findingClass` stamped beside
 * them, so a successor can both DISPOSITION by the verdict and still read the
 * values it was going to write. `findings` is unchanged — it remains the report
 * surface, and nothing that reads it needs to know this view exists.
 */
/**
 * Project one proposal into the fields BOTH sides can actually express.
 *
 * The projection's `listFields` are dropped, and that is a correctness fix
 * rather than a convenience. A stored page carries those as YAML LISTS, and the
 * store snapshot admits only closed scalars — so a list-valued frontmatter key
 * is absent from the snapshot item while the projected proposal carries it as a
 * scalar. Comparing on it guarantees the payload digests differ no matter what
 * the page says, which would keep `identical` unreachable for every class that
 * declares one — exactly the defect the projection exists to remove. Comparing
 * on a field one side structurally cannot carry is not evidence of a
 * difference; it is a broken comparison.
 *
 * The write is unaffected: the terminal still emits the list from the same
 * projection, so nothing is lost from the page — only from the comparison.
 */
function comparableItem(
  item: PackEvidenceItemV1, projection: PackProjectionV2,
): PackEvidenceItemV1 {
  const projected = projectItem(projection.fieldMappings, item);
  const listFields = new Set(projection.listFields ?? []);
  if (listFields.size === 0) return projected;
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const [key, value] of Object.entries(projected.fields)) {
    if (!listFields.has(key)) fields[key] = value;
  }
  return { itemId: projected.itemId, fields };
}

function chainableItems(
  findings: readonly PackReconcileFindingV1[],
  original: ReadonlyMap<string, PackEvidenceItemV1>,
  comparable: ReadonlyMap<string, PackEvidenceItemV1>,
  stored: ReadonlyMap<string, PackEvidenceItemV1>,
): PackEvidenceItemV1[] {
  return findings.map((finding) => ({
    itemId: finding.identity,
    // BOTH VOCABULARIES, canonical winning. The COMPARISON uses the projected
    // fields alone, but a successor terminal usually drafts more than the one
    // class that was compared — the bootstrap proposes `cites` relations from
    // `citing`/`cited`, which a projection onto `papers` frontmatter drops. So
    // the chainable view carries the original fields too, and publishing only
    // the projected ones would silently starve every other group in the phase.
    fields: {
      ...(original.get(finding.identity)?.fields ?? {}),
      ...(comparable.get(finding.identity)?.fields ?? {}),
      // RESTORED for identities the store already holds: stripped from the
      // COMPARISON (they have no counterpart in a proposal, so they would make
      // every page differ) but required DOWNSTREAM, because an authored update
      // sources its precondition from them. Without this an `artifact-update`
      // is unreachable through the real pipeline.
      ...onDiskFieldsOf(stored.get(finding.identity)),
      [FINDING_CLASS_FIELD]: finding.findingClass,
    },
  }));
}

/**
 * Compare proposed evidence with the current snapshot and emit the findings whose
 * class the body declares (section 16.6). Pure and deterministic: identical input
 * yields identical output bytes. It never writes. A proposed set beyond the item
 * ceiling fails closed; a suppressed class is counted as a deficit.
 */
/** The reserved on-disk fields a snapshot item carries but a proposal never has. */
const ON_DISK_FIELDS: readonly string[] = [CURRENT_DIGEST_FIELD, CURRENT_BYTES_FIELD];

/** The on-disk identity fields a stored page carries, if it is present. */
function onDiskFieldsOf(
  stored: PackEvidenceItemV1 | undefined,
): Record<string, PackEvidenceScalarV1> {
  if (stored === undefined) return {};
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const key of ON_DISK_FIELDS) {
    const value = stored.fields[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/** One snapshot item without its on-disk identity fields, for comparison only. */
function withoutOnDiskFields(item: PackEvidenceItemV1): PackEvidenceItemV1 {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const [key, value] of Object.entries(item.fields)) {
    if (!ON_DISK_FIELDS.includes(key)) fields[key] = value;
  }
  return { itemId: item.itemId, fields };
}

export function reconcileEvidence(input: PackReconcileInputV1): PackReconcileResultV1 {
  capItems(input.proposed, input.bounds.maximumItems, { kind: "fail" });
  // AUTHOR-READ-DIGEST CHOKEPOINT (before any finding is emitted): gate each
  // would-be update against the CURRENT page on the raw snapshot, while it still
  // carries the on-disk digest that `withoutOnDiskFields` strips below.
  if (input.body.expectedCurrentDigestRef !== undefined) {
    enforceExpectedCurrentDigest(input.proposed, input.snapshot, input.body.expectedCurrentDigestRef);
  }
  // CANONICALIZE BEFORE COMPARING. Without the projection the proposals carry
  // the caller's input field names while the snapshot carries page frontmatter,
  // so the payload digests cannot match and `identical` is unreachable.
  const projection = input.projection;
  const compared = projection === undefined
    ? input.proposed
    : input.proposed.map((item) => comparableItem(item, projection));
  // STRIP THE ON-DISK IDENTITY FIELDS BEFORE COMPARING. The snapshot carries
  // the current page's byte digest so a later UPDATE can use it as a
  // precondition, but a proposal has no such field — leaving them in would put
  // them in the payload digest and make every existing page compare different,
  // putting `identical` back out of reach for a new reason.
  const snapshot = firstByIdentity(input.snapshot.map(withoutOnDiskFields));
  const counts = identityCounts(compared);
  const declared = new Set<PackReconcileFindingClassV1>(input.body.findingClasses);
  const findings: PackReconcileFindingV1[] = [];
  let suppressed = 0;
  for (const [identity, item] of firstByIdentity(compared)) {
    const findingClass = naturalClass(identity, item, counts, snapshot);
    if (declared.has(findingClass)) findings.push({ identity, findingClass });
    else suppressed += 1;
  }
  const ordered = stableSortByKey(findings, (finding) => `${finding.identity}:${finding.findingClass}`);
  const result: PackReconcileResultV1 = {
    reconcilePolicyId: input.body.reconcilePolicyId, comparedEvidenceClass: input.body.comparedEvidenceClass,
    findings: ordered,
    items: chainableItems(
      ordered, firstByIdentity(input.proposed), firstByIdentity(compared), firstByIdentity(input.snapshot)),
    deficits: suppressed === 0 ? [] : [{ completenessClass: input.body.comparedEvidenceClass, reason: "suppressed-finding", droppedCount: suppressed }],
  };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
