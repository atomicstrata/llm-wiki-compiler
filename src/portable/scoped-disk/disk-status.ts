/**
 * @file src/portable/scoped-disk/disk-status.ts
 * @description Where one source's canonical state stands on an adopted
 * registered directory, decided from ONE read view: compiled (its entry in
 * `state.json`), never compiled, or unknown and dirty — an entry custody
 * knew that has disappeared, or a canonical state or custody record that is
 * missing or malformed. Unknown is reported, never repaired by spending.
 *
 * The answer carries the labels of the bytes it was decided from, so the
 * caller can check current authority before delivering it. Bytes a legacy
 * writer left unbound carry their reconciled labels: the path's latest
 * binding with the project compartment, never fewer.
 */

import type { ContentDigest, LabelSet } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { sourcePath, STATE_CUSTODY_PATH, STATE_PATH } from "../logical-paths.js";
import { isScopedSourceName } from "../scoped/namespaces.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import type { ReadView } from "../store/store.js";
import type { DiskSourceStatusV2 } from "./disk-contracts.js";
import { readCanonicalState, readCustody } from "./disk-state.js";

/** Where a status is read from. */
export interface StatusSource { store: DiskProjectStore; view: ReadView; compartment: string }

/** The labels of exactly these bytes: their binding, else the reconciled union. */
async function effectiveLabels(source: StatusSource, path: string, digest: ContentDigest): Promise<LabelSet> {
  const bound = await source.view.labelsFor(path, digest);
  return bound ?? normalizeLabels([...((await source.store.lastLabels(path)) ?? []), source.compartment]);
}

/** The canonical state and custody, or `null` when either cannot be read soundly. */
async function stateAndCustody(source: StatusSource) {
  try {
    const canonical = await readCanonicalState(source.view);
    const custody = await readCustody(source.view, source.store.projectId);
    return { canonical, custody: custody.custody, custodyLabels: await effectiveLabels(source, STATE_CUSTODY_PATH, custody.observed.digest) };
  } catch (error) {
    if (error instanceof PortableRefusal) return null;
    throw error;
  }
}

/** One source's status with the labels that decide who may learn it, or `null` when nothing about it may be said. */
export async function sourceStatusIn(source: StatusSource, name: string): Promise<{ value: DiskSourceStatusV2; labels: LabelSet } | null> {
  if (!isScopedSourceName(name)) return null;
  const file = await source.view.observe(sourcePath(name));
  const fileLabels = file === null ? null : await effectiveLabels(source, sourcePath(name), file.digest);
  const read = await stateAndCustody(source);
  if (read === null) return fileLabels === null ? null : { value: { kind: "unknown", dirty: true }, labels: fileLabels };
  const stateLabels = await effectiveLabels(source, STATE_PATH, read.canonical.observed.digest);
  const entry = read.canonical.state.sources[name];
  if (entry !== undefined) {
    return { value: { kind: "compiled", hash: entry.hash, concepts: [...entry.concepts], compiledAt: entry.compiledAt }, labels: stateLabels };
  }
  // Custody decided these two answers, so its labels are part of what may be learned from them.
  const decidedLabels = normalizeLabels([...stateLabels, ...read.custodyLabels]);
  if (read.custody.entries[name] !== undefined) return { value: { kind: "unknown", dirty: true }, labels: decidedLabels };
  return fileLabels === null ? null : { value: { kind: "never_compiled" }, labels: normalizeLabels([...fileLabels, ...decidedLabels]) };
}
