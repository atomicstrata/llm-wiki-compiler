/**
 * @file src/portable/scoped-disk/disk-validate.ts
 * @description Re-validation of a disk scoped proposal's dependencies, under
 * the gate, at persist, at approval and at apply.
 *
 * A directory has no authority-maintained fence, so every form is re-proved
 * from current bytes, at a cost proportional to what it names:
 *
 * - an exact object by its full digest AND its label binding;
 * - an absence or an existence by a lookup;
 * - a complete list by re-listing it, COUNTING first — a list over the title
 *   bound refuses, and one whose count moved is stale, before any member is
 *   read — then re-hashing every member (no stat gate, no cached body);
 * - the state projections from ONE fresh read of the canonical state: each
 *   selected entry by digest, the kept-page and modifier decisions, and the
 *   owners of every consulted page. An unrelated entry is never compared.
 *
 * Every byte observed counts against the proposal's declared read bound, so
 * validation is bounded by the same envelope as the generation it checks.
 * Every target's pre-image is checked first.
 */

import { normalizeLabels, recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import type { ScopeBoundsV2 } from "../scoped/contracts.js";
import { assertTargetsHold, bindingHolds, existenceHolds } from "../scoped/scoped-validate.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import { entryDigestOf } from "./custody.js";
import type { DiskScopedDependenciesV2, DiskScopedDependencyV2 } from "./disk-contracts.js";
import type { DiskScopedCounters } from "./disk-access.js";
import { decisionsDigest, ownerEntries, ownershipOf, readCanonicalState, type CanonicalState } from "./disk-state.js";

/** What validation compares against and is bounded by. */
interface Current {
  view: DiskProjectStore; bounds: ScopeBoundsV2; counters: DiskScopedCounters; compartment: string;
  /** Bytes this validation observed, against the read bound (the counters may accumulate across validations). */
  observed: number;
  /** The canonical state, read once per validation. */
  canonical: () => Promise<CanonicalState>;
}

/** Count `bytes` over `objects` observed by this validation, refusing past the declared read bound. */
function consume(current: Current, bytes: number, objects = 1): void {
  current.counters.objectsObserved += objects;
  current.counters.bytesObserved += bytes;
  current.observed += bytes;
  if (current.observed > current.bounds.maxReadBytes) throw new PortableRefusal("limit_exceeded", "validation read bytes");
}

/**
 * True when a complete list still has exactly the recorded members with the
 * recorded bytes. The listing is counted before any member is read.
 */
async function listHolds(current: Current, form: Extract<DiskScopedDependencyV2, { form: "complete-list" }>): Promise<boolean> {
  const paths = await current.view.list(form.prefix);
  current.counters.listingNames += paths.length;
  if (paths.length > current.bounds.maxTitleEntries) throw new PortableRefusal("limit_exceeded", "title entries");
  if (paths.length !== form.entries) return false;
  const members: [string, string][] = [];
  for (const path of paths) {
    const seen = await current.view.observe(path);
    if (seen !== null) consume(current, seen.bytes.byteLength);
    members.push([path, seen?.digest ?? "absent"]);
    current.counters.listMembersHashed += 1;
  }
  // The same digest generation recorded: over the ordered (path, digest) membership.
  return recordDigest(members) === form.completeListDigest;
}

/**
 * True when a consumed file's current labels — its exact binding, else the
 * reconciled union a legacy write would get — are still exactly the recorded labels. A same-byte widening does
 * not hold; a later unbound edit that changed no classification does.
 */
async function labelsHold(current: Current, form: Extract<DiskScopedDependencyV2, { form: "labels" }>): Promise<boolean> {
  const seen = await current.view.observe(form.path);
  if (seen === null) return false;
  consume(current, seen.bytes.byteLength);
  // Unbound bytes carry what a reconciliation would give them: the latest binding with the compartment.
  const labels = (await current.view.labelsFor(form.path, seen.digest))
    ?? [...((await current.view.lastLabels(form.path)) ?? []), current.compartment];
  return recordDigest(normalizeLabels(labels)) === recordDigest(normalizeLabels(form.labels));
}

/** True when one recorded form still holds now. */
async function formHolds(current: Current, form: DiskScopedDependencyV2): Promise<boolean> {
  const { view } = current;
  // Exact and existence checks observe through a tally that charges this validation's read bound.
  const tally = { objectsObserved: 0, bytesObserved: 0 };
  const charge = <T>(result: T): T => {
    if (tally.objectsObserved > 0) consume(current, tally.bytesObserved, tally.objectsObserved);
    return result;
  };
  switch (form.form) {
    case "exact": return charge(await bindingHolds(view, tally, form.path, form.digest, form.labels));
    case "absence": return (await view.observe(form.path)) === null;
    case "existence": return charge(await existenceHolds(view, tally, form));
    case "complete-list": return listHolds(current, form);
    case "state-entry": return entryDigestOf((await current.canonical()).state.sources[form.source]) === form.entryDigest;
    case "state-decisions": return decisionsDigest((await current.canonical()).state) === form.decisionsDigest;
    case "labels": return labelsHold(current, form);
    case "state-owners": {
      const now = ownerEntries(ownershipOf((await current.canonical()).state), form.entries.map((entry) => entry.path));
      // Compared canonically: a stored record's key order is not the order it was built in.
      return recordDigest(now) === recordDigest(form.entries);
    }
  }
}

/** A short name for a form, for the refusal's detail. */
function formName(form: DiskScopedDependencyV2): string {
  if ("path" in form) return form.path;
  if (form.form === "complete-list") return `complete list of ${form.prefix} (${form.entries} entries): a page was created, removed or edited`;
  return form.form === "state-entry" ? `state entry ${form.source}` : form.form;
}

/** What a validation is bounded by and reports to. */
export interface ValidationEnvelope {
  bounds: ScopeBoundsV2;
  counters: DiskScopedCounters;
  /** The project compartment: what bytes a legacy writer left unbound are reconciled with. */
  compartment: string;
}

/**
 * Check that every semantic input of a disk scoped proposal is still what its
 * generation saw, within the proposal's declared bounds.
 *
 * @throws PortableRefusal `target_precondition_failed` for a target mismatch,
 *   `stale_read_set` naming the first other form that moved, `limit_exceeded`
 *   past the declared bounds, or the canonical state's own refusal when it is
 *   missing, corrupt or too new.
 */
export async function validateDiskDependencies(
  view: DiskProjectStore, dependencies: DiskScopedDependenciesV2, envelope: ValidationEnvelope,
): Promise<void> {
  const { bounds, counters } = envelope;
  let canonical: Promise<CanonicalState> | null = null;
  const current: Current = { view, bounds, counters, compartment: envelope.compartment, observed: 0, canonical: () => canonical ??= readOnce() };
  const targets = { objectsObserved: 0, bytesObserved: 0 };
  await assertTargetsHold(view, targets, dependencies.targets);
  consume(current, targets.bytesObserved, targets.objectsObserved);
  async function readOnce(): Promise<CanonicalState> {
    const read = await readCanonicalState(view);
    consume(current, read.observed.bytes.byteLength);
    counters.stateBytesRead += read.observed.bytes.byteLength;
    return read;
  }
  for (const form of dependencies.forms) {
    if (!(await formHolds(current, form))) throw new PortableRefusal("stale_read_set", formName(form));
  }
}
