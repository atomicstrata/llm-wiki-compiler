/**
 * @file src/portable/scoped/scoped-validate.ts
 * @description Re-validation of a scoped proposal's dependencies, under the
 * gate, at persist, at approval and at apply.
 *
 * Each form is checked by the proof that fits it, against the CURRENT head:
 * an exact object by its digest AND its label binding (a same-byte relabel is
 * a change), an absence by a lookup, an existence by a lookup and, when
 * present, its labels, a title projection by the namespace's title fence, a
 * retrieval result by the namespace's member fence, and consulted ownership
 * by the exact owner lists. The fences are maintained by the
 * authority at every bind, so one comparison is sound here: this store's
 * authority is the only writer. Every target's pre-image is checked first.
 */

import type { ContentDigest, LabelSet, ObjectImage } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import type { ScopedDependenciesV2, ScopedDependencyV2 } from "./contracts.js";
import { PortableRefusal } from "../errors.js";
import type { ReadView } from "../store/store.js";
import type { ScopedStoreSurface } from "./store-types.js";

/** The observation counters a validation keeps. */
export interface ValidationCounters { objectsObserved: number; bytesObserved: number }

/** The current digest at `path`, or "absent", counting the observation. */
async function currentDigest(view: ReadView, counters: ValidationCounters, path: string): Promise<string> {
  const seen = await view.observe(path);
  if (seen === null) return "absent";
  counters.objectsObserved += 1;
  counters.bytesObserved += seen.bytes.byteLength;
  return seen.digest;
}

/** The current fence a projection or retrieval form names, counting the comparison. */
function currentFence(store: ScopedStoreSurface, namespace: string, kind: "title" | "member"): string {
  store.scopedCounters.fencesCompared += 1;
  const snapshot = store.currentNamespaces().get(namespace);
  return kind === "title" ? snapshot?.titleFence ?? "titles-0" : snapshot?.memberFence ?? "members-0";
}

/** True when every consulted concept still has exactly the recorded owners in the authoritative table. */
function ownersHold(store: ScopedStoreSurface, form: Extract<ScopedDependencyV2, { form: "owners" }>): boolean {
  const snapshot = store.currentNamespaces().get(form.namespace);
  return form.entries.every((entry) => {
    store.scopedCounters.fencesCompared += 1;
    return JSON.stringify(snapshot?.owners.get(entry.path) ?? []) === JSON.stringify(entry.owners);
  });
}

/** True when `path` is bound now to exactly `digest` under exactly `labels`. A same-byte relabel does not hold. */
export async function bindingHolds(
  view: ReadView, counters: ValidationCounters, path: string, digest: string, labels: LabelSet,
): Promise<boolean> {
  if ((await currentDigest(view, counters, path)) !== digest) return false;
  const current = await view.labelsFor(path, digest as ContentDigest);
  return current !== null && JSON.stringify(normalizeLabels(current)) === JSON.stringify(normalizeLabels(labels));
}

/** True when an existence fact still holds: present under the same labels, or still absent. */
export async function existenceHolds(
  view: ReadView, counters: ValidationCounters, form: { path: string; exists: boolean; labels: LabelSet | null },
): Promise<boolean> {
  const seen = await view.observe(form.path);
  if (!form.exists || seen === null) return (seen !== null) === form.exists;
  return bindingHolds(view, counters, form.path, seen.digest, form.labels ?? []);
}

/**
 * Check every target's pre-image against the current head.
 *
 * @throws PortableRefusal `target_precondition_failed` naming the first target that moved.
 */
export async function assertTargetsHold(
  view: ReadView, counters: ValidationCounters, targets: readonly { path: string; pre: ObjectImage }[],
): Promise<void> {
  for (const target of targets) {
    const expected = target.pre.state === "present" ? target.pre.digest : "absent";
    if ((await currentDigest(view, counters, target.path)) !== expected) throw new PortableRefusal("target_precondition_failed", target.path);
  }
}

/** True when one recorded form still holds now. */
async function formHolds(store: ScopedStoreSurface, form: ScopedDependencyV2): Promise<boolean> {
  switch (form.form) {
    case "exact": return bindingHolds(store, store.scopedCounters, form.path, form.digest, form.labels);
    case "absence": return (await store.observe(form.path)) === null;
    case "existence": return existenceHolds(store, store.scopedCounters, form);
    case "title-projection": return currentFence(store, form.namespace, "title") === form.titleFence;
    case "retrieval": return currentFence(store, form.namespace, "member") === form.memberFence;
    case "owners": return ownersHold(store, form);
  }
}

/** A short name for a form, for the refusal's detail. */
function formName(form: ScopedDependencyV2): string {
  return "path" in form ? form.path : `${form.form}:${form.namespace}`;
}

/**
 * Check that every semantic input of a scoped proposal is still what its
 * generation saw.
 *
 * @throws PortableRefusal `target_precondition_failed` for a target mismatch,
 *   `stale_read_set` for any other dependency.
 */
export async function validateScopedDependencies(store: ScopedStoreSurface, dependencies: ScopedDependenciesV2): Promise<void> {
  await assertTargetsHold(store, store.scopedCounters, dependencies.targets);
  for (const form of dependencies.forms) {
    if (!(await formHolds(store, form))) throw new PortableRefusal("stale_read_set", formName(form));
  }
}
