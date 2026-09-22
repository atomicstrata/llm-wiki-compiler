/**
 * @file src/preparations/lifecycle-fs/reset-operations.ts
 * @description Root-bound reset and intent-supersession filesystem operations.
 * Record parsing and authorization stay with adapters; this module owns paths,
 * no-follow observations, durable writes, cleanup, and old-key custody.
 */

import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  AtomicWriteCollisionError,
  atomicWriteNoReplaceDurable,
} from "../../utils/atomic-write.js";
import { fsyncDirectoryChain } from "../../utils/atomic-write-durability.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import {
  isConfinedDirectory,
  rmdirConfinedDurable,
  unlinkConfinedLeafDurable,
} from "../../utils/confined-delete.js";
import { lstatLeaf, readDirectoryNames } from "../../utils/fs-presence.js";
import { MAX_LIFECYCLE_RECEIPT_BYTES } from "../receipts.js";
import {
  assertLifecycleMutationPermit, type LifecycleMutationPermitV1,
} from "../lifecycle-mutation-permit.js";
import {
  assertPreparationLifecycleNamespaceCurrent,
  openPreparationLifecycleNamespace,
  PreparationLifecycleNamespaceError,
} from "./namespace.js";
import {
  lifecyclePreparationKeyFile,
  lifecycleQuarantineUnitPaths,
} from "./paths.js";

/** Closed reset-unit leaf names adapters may request. */
export type ResetUnitLeaf = "intent" | "pending-key";

/** Bounded reset-unit leaf read without caller-selected paths. */
export type ResetUnitLeafRead =
  | { readonly status: "ok"; readonly body: Buffer }
  | { readonly status: "absent" | "unavailable" };

/** Raw pre-plan unit shape needed by the intent supersession adapter. */
export type ResetIntentUnitObservation =
  | { readonly status: "unavailable" }
  | {
    readonly status: "ok";
    readonly names: readonly string[];
    readonly intentBody?: Buffer;
    readonly bytes: "absent" | "empty" | "other";
  };

/** Select one fixed reset-unit leaf under a bound namespace. */
function resetLeaf(
  paths: ReturnType<typeof lifecycleQuarantineUnitPaths>,
  leaf: ResetUnitLeaf,
): string {
  return leaf === "intent"
    ? paths.resetIntentFile
    : paths.pendingResetKeyFile;
}

/** Classify one reset unit without accepting a redirected parent. */
async function resetUnitConfinement(
  namespace: Awaited<ReturnType<typeof openPreparationLifecycleNamespace>>,
  paths: ReturnType<typeof lifecycleQuarantineUnitPaths>,
) {
  return isConfinedDirectory(namespace.root.realPath, paths.unitRoot);
}

/** Open one reset unit and classify its exact confined directory. */
async function openResetUnit(
  root: string,
  unitId: string,
  mode: "read" | "mutate",
) {
  const namespace = await openPreparationLifecycleNamespace(root, mode);
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  const confinement = await resetUnitConfinement(namespace, paths);
  return { namespace, paths, confinement };
}

/** Read one bounded reset leaf through a freshly bound namespace. */
export async function readResetUnitLeaf(
  root: string,
  unitId: string,
  leaf: ResetUnitLeaf,
): Promise<ResetUnitLeafRead> {
  try {
    return await readResetUnitLeafFromNamespace(root, unitId, leaf);
  } catch (error) {
    if (error instanceof PreparationLifecycleNamespaceError) {
      return { status: "unavailable" };
    }
    throw error;
  }
}

/** Read a reset leaf after opening its exact lifecycle namespace. */
async function readResetUnitLeafFromNamespace(
  root: string,
  unitId: string,
  leaf: ResetUnitLeaf,
): Promise<ResetUnitLeafRead> {
  const { namespace, paths, confinement } =
    await openResetUnit(root, unitId, "read");
  if (confinement !== "confined") {
    await assertPreparationLifecycleNamespaceCurrent(namespace);
    return { status: confinement === "absent" ? "absent" : "unavailable" };
  }
  const read = await readConfinedLeafBuffer(
    namespace.root.realPath,
    resetLeaf(paths, leaf),
    paths.unitRoot,
    MAX_LIFECYCLE_RECEIPT_BYTES,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  if (read.kind === "ok") return { status: "ok", body: Buffer.from(read.body) };
  return { status: read.kind === "absent" ? "absent" : "unavailable" };
}

/**
 * Bind the namespace and resolve one reset unit's paths, refusing a redirected
 * unit before any caller can act on it.
 *
 * One home for the confinement precondition every reset-unit mutator shares. Two
 * copies of a trust-boundary check is two chances for them to drift, and the
 * check is the thing standing between a mutator and a swapped directory.
 */
async function openConfinedResetUnit(root: string, unitId: string) {
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  if (await resetUnitConfinement(namespace, paths) === "redirected") {
    throw new Error("reset unit is not a real confined directory");
  }
  return { namespace, paths };
}

/** Publish one reset record create-only after creating its owned unit root. */
export async function writeResetUnitLeaf(
  root: string,
  unitId: string,
  leaf: ResetUnitLeaf,
  body: Buffer,
  permit?: LifecycleMutationPermitV1,
): Promise<void> {
  // Pass one writes the intent marker before any operation exists to permit, so
  // the permit is required only for the staged KEY - the leaf design V2 §9.2
  // names. Requiring it for the marker would make pass one unreachable.
  if (leaf === "pending-key") assertLifecycleMutationPermit(permit, unitId, "reset");
  const { namespace, paths } = await openConfinedResetUnit(root, unitId);
  await mkdir(paths.unitRoot, { recursive: true });
  if (await resetUnitConfinement(namespace, paths) !== "confined") {
    throw new Error("reset unit could not be confined after creation");
  }
  await atomicWriteNoReplaceDurable(resetLeaf(paths, leaf), body, {
    confineRoot: namespace.root.realPath,
    exactParent: true,
    mode: 0o600,
  });
  await assertPreparationLifecycleNamespaceCurrent(namespace);
}

/** Publish an active reset key create-only, reporting an occupied slot. */
export async function publishActivePreparationKey(
  root: string,
  body: string,
  unitId: string,
  permit: LifecycleMutationPermitV1,
): Promise<"created" | "exists"> {
  // Bound to the PUBLISHING unit, not to the permit's own id. Comparing the
  // permit against itself would have made this the one seam design V2 §9.2 names
  // by name that enforces only the brand.
  assertLifecycleMutationPermit(permit, unitId, "reset");
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  try {
    await atomicWriteNoReplaceDurable(
      lifecyclePreparationKeyFile(namespace),
      body,
      {
        confineRoot: namespace.root.realPath,
        exactParent: true,
        mode: 0o600,
      },
    );
    return "created";
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) return "exists";
    throw error;
  }
}

/** Observe one reset intent leaf as present, absent, or unavailable. */
export async function resetIntentLeafPresence(
  root: string,
  unitId: string,
): Promise<"present" | "absent" | "unavailable"> {
  try {
    const { namespace, paths, confinement } =
      await openResetUnit(root, unitId, "read");
    if (confinement !== "confined") {
      await assertPreparationLifecycleNamespaceCurrent(namespace);
      return confinement === "absent" ? "absent" : "unavailable";
    }
    const leaf = await lstatLeaf(paths.resetIntentFile);
    await assertPreparationLifecycleNamespaceCurrent(namespace);
    return leaf.kind;
  } catch (error) {
    if (error instanceof PreparationLifecycleNamespaceError) return "unavailable";
    throw error;
  }
}

/** Remove staged reset key material first, then the intent commit marker. */
export async function removeResetCrashLeaves(
  root: string,
  unitId: string,
  permit: LifecycleMutationPermitV1,
): Promise<void> {
  // This DESTROYS crash-resumption material — the staged key first, then the
  // intent marker — so it is a permit-gated mutation like every other one, and
  // it must run inside the operation that earned the permit rather than after it.
  assertLifecycleMutationPermit(permit, unitId, "reset");
  const { namespace, paths } = await openConfinedResetUnit(root, unitId);
  await unlinkConfinedLeafDurable(
    namespace.root.realPath,
    paths.pendingResetKeyFile,
    paths.unitRoot,
  );
  await unlinkConfinedLeafDurable(
    namespace.root.realPath,
    paths.resetIntentFile,
    paths.unitRoot,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
}

/** Move the old active key into reset custody, preserving both parent fsyncs. */
export async function moveOldPreparationKey(
  root: string,
  unitId: string,
  permit: LifecycleMutationPermitV1,
): Promise<"absent" | "moved"> {
  assertLifecycleMutationPermit(permit, unitId, "reset");
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  const keyFile = lifecyclePreparationKeyFile(namespace);
  const leaf = await lstatLeaf(keyFile);
  if (leaf.kind === "unavailable") throw new Error("old key leaf cannot be examined");
  if (leaf.kind === "absent") {
    await assertPreparationLifecycleNamespaceCurrent(namespace);
    return "absent";
  }
  if (!leaf.stats.isFile() || leaf.stats.isSymbolicLink()) {
    throw new Error("old key leaf is not a movable regular file");
  }
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  if (await resetUnitConfinement(namespace, paths) === "redirected") {
    throw new Error("reset unit is not a real confined directory");
  }
  const bytesConfinement = await isConfinedDirectory(
    namespace.root.realPath,
    paths.bytesRoot,
  );
  if (bytesConfinement === "redirected") {
    throw new Error("reset bytes directory is not a real confined directory");
  }
  await mkdir(paths.bytesRoot, { recursive: true });
  if (await isConfinedDirectory(
    namespace.root.realPath,
    paths.bytesRoot,
  ) !== "confined") {
    throw new Error("reset bytes directory could not be confined after creation");
  }
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  await rename(keyFile, paths.byteObjectFile("old-key"));
  await fsyncDirectoryChain(paths.bytesRoot);
  await fsyncDirectoryChain(path.dirname(keyFile));
  return "moved";
}

/** Observe the exact filesystem shape used by intent-only supersession. */
export async function observeResetIntentUnit(
  root: string,
  unitId: string,
): Promise<ResetIntentUnitObservation> {
  try {
    const namespace = await openPreparationLifecycleNamespace(root, "read");
    const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
    if (await resetUnitConfinement(namespace, paths) !== "confined") {
      return { status: "unavailable" };
    }
    const listing = await readDirectoryNames(paths.unitRoot);
    if (listing.kind !== "entries") return { status: "unavailable" };
    const bytes = await observeSupersessionBytes(paths.bytesRoot);
    const intent = await readConfinedLeafBuffer(
      namespace.root.realPath,
      paths.resetIntentFile,
      paths.unitRoot,
      MAX_LIFECYCLE_RECEIPT_BYTES,
    );
    await assertPreparationLifecycleNamespaceCurrent(namespace);
    return {
      status: "ok",
      names: listing.names,
      ...(intent.kind === "ok" ? { intentBody: Buffer.from(intent.body) } : {}),
      bytes,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Distinguish absent, exactly empty, and materialized bytes state. */
async function observeSupersessionBytes(
  bytesRoot: string,
): Promise<"absent" | "empty" | "other"> {
  const leaf = await lstatLeaf(bytesRoot);
  if (leaf.kind === "absent") return "absent";
  if (leaf.kind !== "present" ||
      !leaf.stats.isDirectory() ||
      leaf.stats.isSymbolicLink()) return "other";
  const contents = await readDirectoryNames(bytesRoot);
  return contents.kind === "entries" && contents.names.length === 0
    ? "empty"
    : "other";
}

/** Clear an already-classified intent-only unit with marker-last ordering. */
export async function clearResetIntentUnit(
  root: string,
  unitId: string,
  hasEmptyBytesDirectory: boolean,
): Promise<void> {
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  if (await resetUnitConfinement(namespace, paths) !== "confined") {
    throw new Error("reset unit is not a real confined directory");
  }
  if (hasEmptyBytesDirectory) {
    await rmdirConfinedDurable(
      namespace.root.realPath,
      paths.bytesRoot,
      paths.unitRoot,
    );
  }
  await unlinkConfinedLeafDurable(
    namespace.root.realPath,
    paths.resetIntentFile,
    paths.unitRoot,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
}
