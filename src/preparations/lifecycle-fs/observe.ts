/**
 * @file src/preparations/lifecycle-fs/observe.ts
 * @description Bounded, root-anchored observation of both lifecycle registries.
 * It enumerates each physical registry once, captures every unit identity, and
 * records a closed inventory without parsing or classifying authority records.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  isPortableQuarantineStorageDirectory,
  isSafeQuarantineComponent,
} from "../paths.js";
import { assertPreparationLifecycleNamespaceCurrent } from "./namespace.js";
import type {
  BoundLifecycleDirectoryV1,
  BoundLifecycleRegistryV1,
  LifecycleDirectoryObservation,
  LifecycleObservationSet,
  LifecycleRegistryObservation,
  LifecycleStorageCapture,
  LifecycleUnitObservation,
  PreparationLifecycleNamespaceV1,
} from "./types.js";
import type { LifecycleScanBounds } from "./bounds.js";
import { lifecyclePruneUnitPaths, lifecycleQuarantineUnitPaths } from "./paths.js";
import {
  lifecycleObservationProblem, lifecycleRelativePath, unavailableLifecycleUnit,
} from "./observation-problems.js";
import {
  boundedDirectoryNames,
  captureLifecycleDirectory,
  captureLifecycleDirectoryVersion,
  lifecycleDirectoryVersionsMatch,
} from "./directory-observation.js";
import {
  captureForeignDirectoryStorage,
  captureStorageFile,
  captureUnitStorage,
  retainStorageDirectory,
  storageObservation,
} from "./storage-observation.js";

type OptionalDirectoryKind = "absent" | "directory" | "regular" | "unavailable";
type DirectoryNamesResult = Awaited<ReturnType<typeof boundedDirectoryNames>>;

/** Capture one unit's root and optional quarantine bytes directory. */
async function observeUnit(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  unitId: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<LifecycleUnitObservation> {
  const unitRoot = registry === "quarantine"
    ? lifecycleQuarantineUnitPaths(namespace, unitId).unitRoot
    : lifecyclePruneUnitPaths(namespace, unitId).unitRoot;
  const captured = await captureLifecycleDirectory(unitRoot);
  if (captured === null) {
    return unavailableLifecycleUnit(
      namespace,
      registry,
      unitId,
      unitRoot,
      "unit is redirected or unreadable",
      "unit-entry-unavailable",
    );
  }
  const names = await boundedDirectoryNames(unitRoot, bounds, storage);
  if (names === "unavailable" || names === "exhausted") {
    return unavailableLifecycleUnit(
      namespace, registry, unitId, unitRoot,
      names === "exhausted" ? "unit entry bound exhausted" : "unit cannot be enumerated",
      names === "exhausted" ? "registry-entries-exhausted" : "unit-unavailable",
    );
  }
  const directory = { ...captured, names };
  return registry === "prune"
    ? { registry, unitId, unitRoot, directory }
    : observeQuarantineBytes(namespace, unitId, unitRoot, directory, bounds, storage);
}

/** Attach the optional bytes-directory observation to one quarantine unit. */
async function observeQuarantineBytes(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
  unitRoot: string,
  directory: LifecycleDirectoryObservation,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<LifecycleUnitObservation> {
  const bytesRoot = lifecycleQuarantineUnitPaths(namespace, unitId).bytesRoot;
  const bytes = await observeOptionalDirectory(bytesRoot, bounds, storage);
  if (bytes === "regular") {
    await captureStorageFile(namespace, bytesRoot, unitRoot, storage);
  }
  if (bytes === "unavailable" || bytes === "exhausted") {
    storage.complete = false;
    storage.handledPaths.add(bytesRoot);
  }
  if (bytes === "regular" || bytes === "unavailable" || bytes === "exhausted") {
    return {
      ...unavailableLifecycleUnit(
        namespace, "quarantine", unitId, bytesRoot,
        bytes === "exhausted" ? "unit entry bound exhausted" : "bytes directory is unavailable",
        bytes === "exhausted" ? "registry-entries-exhausted" : "unit-unavailable",
      ),
      unitRoot,
      directory,
    };
  }
  return { registry: "quarantine", unitId, unitRoot, directory, bytes };
}

/** Observe an optional real directory while distinguishing absence from faults. */
async function optionalDirectoryKind(directory: string): Promise<OptionalDirectoryKind> {
  try {
    const leaf = await lstat(directory);
    if (leaf.isFile() && !leaf.isSymbolicLink()) return "regular";
    return leaf.isDirectory() && !leaf.isSymbolicLink() ? "directory" : "unavailable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
}

/** Capture one optional real directory only after its physical kind is known. */
async function observeOptionalDirectory(
  directory: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<
  LifecycleDirectoryObservation |
  { readonly status: "absent"; readonly path: string } |
  "regular" |
  "unavailable" |
  "exhausted"
> {
  const kind = await optionalDirectoryKind(directory);
  if (kind === "absent") return { status: "absent", path: directory };
  if (kind !== "directory") return kind;
  const captured = await captureLifecycleDirectory(directory);
  if (captured === null) return "unavailable";
  const names = await boundedDirectoryNames(directory, bounds, storage);
  if (names === "unavailable" || names === "exhausted") return names;
  return { ...captured, names };
}

/** Observe and account one direct registry entry before semantic classification. */
async function observeRegistryEntry(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  root: string,
  unitId: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<LifecycleUnitObservation> {
  const entry = path.join(root, unitId);
  const metadata = await lstat(entry).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink()) {
    storage.complete = false;
    return unavailableLifecycleUnit(namespace, registry, unitId, entry, "unit entry is unavailable",
      "unit-entry-unavailable");
  }
  if (metadata.isFile()) {
    await captureStorageFile(namespace, entry, root, storage);
    return unavailableLifecycleUnit(
      namespace, registry, unitId, entry, "unit entry is not a directory",
      "unit-entry-unavailable");
  }
  if (!metadata.isDirectory() || !isPortableQuarantineStorageDirectory(unitId)) {
    storage.complete = false;
    return unavailableLifecycleUnit(
      namespace, registry, unitId, entry, "unit entry is not portable",
      "unit-entry-unavailable");
  }
  if (!isSafeQuarantineComponent(unitId)) {
    await captureForeignDirectoryStorage(namespace, entry, bounds, storage);
    return unavailableLifecycleUnit(
      namespace, registry, unitId, entry, "unit entry is not a lifecycle unit",
      "unit-entry-unavailable");
  }
  const unit = await observeUnit(namespace, registry, unitId, bounds, storage);
  await captureUnitStorage(namespace, unit, bounds, storage);
  return unit;
}

/** Refuse additional unit I/O after the one global registry bound exhausts. */
async function observeBoundedRegistryEntry(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  root: string,
  unitId: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<LifecycleUnitObservation> {
  if (bounds.registryEntries <= bounds.maxRegistryEntries) {
    return observeRegistryEntry(namespace, registry, root, unitId, bounds, storage);
  }
  storage.complete = false;
  return unavailableLifecycleUnit(
    namespace, registry, unitId, path.join(root, unitId),
    "registry entry bound was already exhausted", "registry-entries-exhausted",
  );
}

/** Initialize isolated mutable storage capture for one physical registry. */
function lifecycleStorageCapture(): LifecycleStorageCapture {
  return {
    files: [],
    directories: [],
    handledPaths: new Set(),
    traversalEntries: 0,
    complete: true,
    exhausted: false,
  };
}

/** Enumerate a root once and retain a stable non-enumerating version proof. */
async function enumerateRegistryRoot(
  binding: Extract<BoundLifecycleDirectoryV1, { status: "present" }>,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<DirectoryNamesResult> {
  const before = await captureLifecycleDirectoryVersion(binding.realPath);
  const names = await boundedDirectoryNames(binding.realPath, bounds, storage);
  const after = await captureLifecycleDirectoryVersion(binding.realPath);
  const stable = before !== null &&
    after !== null &&
    lifecycleDirectoryVersionsMatch(before, after) &&
    Number(after.dev) === binding.dev &&
    Number(after.ino) === binding.ino;
  if (!stable) storage.complete = false;
  if (Array.isArray(names) && after !== null) {
    retainStorageDirectory(storage, {
      path: binding.realPath,
      dev: binding.dev,
      ino: binding.ino,
      names,
      version: after,
    });
  }
  return names;
}

/** Project one unavailable registry enumeration without attempting unit I/O. */
function unavailableRegistry(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  root: string,
  names: Exclude<DirectoryNamesResult, readonly string[]>,
  storage: LifecycleStorageCapture,
): LifecycleRegistryObservation {
  const code = names === "exhausted" ? "registry-entries-exhausted" : "registry-unavailable";
  storage.complete = false;
  return {
    units: [],
    problems: [lifecycleObservationProblem(
      namespace, code, registry, root, `${registry} registry cannot be enumerated`,
    )],
    storage: storageObservation(storage),
  };
}

/** Observe all names from the sole registry-root inventory. */
async function observeRegistryUnits(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  root: string,
  names: readonly string[],
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<LifecycleUnitObservation[]> {
  const units: LifecycleUnitObservation[] = [];
  for (const unitId of names) {
    units.push(await observeBoundedRegistryEntry(
      namespace, registry, root, unitId, bounds, storage,
    ));
  }
  return units;
}

/** Add the aggregate exhaustion problem when no unit already carries it. */
function registryProblems(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  root: string,
  units: readonly LifecycleUnitObservation[],
  storage: LifecycleStorageCapture,
) {
  const problems = units.flatMap((unit) => unit.problem === undefined ? [] : [unit.problem]);
  if (storage.exhausted &&
      !problems.some((candidate) => candidate.code === "registry-entries-exhausted")) {
    problems.push(lifecycleObservationProblem(
      namespace, "registry-entries-exhausted", registry, root,
      `${registry} registry entry bound exhausted`,
    ));
  }
  return problems;
}

/** Enumerate one bound registry exactly once and observe all of its units. */
async function observeRegistry(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  binding: BoundLifecycleRegistryV1, bounds: LifecycleScanBounds,
): Promise<LifecycleRegistryObservation> {
  const storage = lifecycleStorageCapture();
  if (binding.status === "absent") {
    return { units: [], problems: [], storage: storageObservation(storage) };
  }
  // A registry the namespace could not bind is observable as unavailable rather
  // than as a rejected capture. Storage completeness carries it to every prune
  // consumer, which is what keeps them fail-closed. A registry that cannot be
  // BOUND equally cannot be ENUMERATED, so it joins that refusal family rather
  // than inventing a second one — the binding fault is named after the colon.
  if (binding.status === "unavailable") {
    storage.complete = false;
    return {
      units: [],
      problems: [lifecycleObservationProblem(
        namespace, "registry-unavailable", registry, binding.lexicalPath,
        `${registry} registry cannot be enumerated: ${binding.detail}`,
      )],
      storage: storageObservation(storage),
    };
  }
  const names = await enumerateRegistryRoot(binding, bounds, storage);
  if (names === "unavailable" || names === "exhausted") {
    return unavailableRegistry(namespace, registry, binding.realPath, names, storage);
  }
  const units = await observeRegistryUnits(
    namespace, registry, binding.realPath, names, bounds, storage,
  );
  const problems = registryProblems(namespace, registry, binding.realPath, units, storage);
  return { units, problems, storage: storageObservation(storage) };
}

/** Observe both physical registries once beneath one revalidated namespace. */
export async function observeLifecycleRegistries(
  namespace: PreparationLifecycleNamespaceV1,
  bounds: LifecycleScanBounds,
  onEnumerated?: (registry: "quarantine" | "prune") => void,
): Promise<LifecycleObservationSet> {
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  const quarantine = await observeRegistry(
    namespace, "quarantine", namespace.quarantineRegistry, bounds,
  );
  onEnumerated?.("quarantine");
  const prune = await observeRegistry(
    namespace, "prune", namespace.pruneRegistry, bounds,
  );
  onEnumerated?.("prune");
  return {
    units: [...quarantine.units, ...prune.units],
    problems: [...quarantine.problems, ...prune.problems],
    storage: { quarantine: quarantine.storage, prune: prune.storage },
  };
}

export type { LifecycleObservationSet, LifecycleUnitObservation } from "./types.js";

export { lifecycleRelativePath } from "./observation-problems.js";
