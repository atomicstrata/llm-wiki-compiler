/**
 * @file src/preparations/lifecycle-fs/quarantine-operations.ts
 * @description Root-bound filesystem operations used by quarantine/reset
 * adapters without giving those adapters raw paths or filesystem primitives.
 */

import path from "node:path";
import { fsyncDirectoryChain } from "../../utils/atomic-write-durability.js";
import {
  assertLifecycleMutationPermit, type LifecycleMutationPermitV1,
} from "../lifecycle-mutation-permit.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import {
  isConfinedDirectory,
  unlinkConfinedLeafDurable,
} from "../../utils/confined-delete.js";
import { listUnitDirectories, lstatLeaf, readDirectoryNames } from "../../utils/fs-presence.js";
import { digestPlannedLeaf } from "../../utils/planned-bytes.js";
import { MAX_PREPARATION_EVIDENCE_OBJECT_BYTES } from "../constants.js";
import {
  MAX_LIFECYCLE_RECEIPT_BYTES,
  type QuarantineObjectV1,
} from "../receipts.js";
import { PREPARATION_PRUNE_REGISTRY } from "../paths.js";
import {
  assertPreparationLifecycleNamespaceCurrent,
  openPreparationLifecycleNamespace,
} from "./namespace.js";
import { lifecycleQuarantineUnitPaths } from "./paths.js";

/** One fully digested lifecycle leaf ready for a signed destructive plan. */
export interface LifecycleScopedObject {
  readonly sourcePath: string;
  readonly logicalPath: string;
  readonly byteCount: number;
  readonly digest: string;
}

/** One prune-registry leaf a project reset must take into custody. */
export interface PruneCustodyLeaf {
  readonly relativePath: string;
  readonly byteCount: number;
}

/** Capture and digest one project-private lifecycle leaf under a bound root. */
export async function captureLifecycleScopedObject(
  root: string,
  relativePath: string,
  byteCount: number,
): Promise<LifecycleScopedObject> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  const sourcePath = path.join(namespace.privateRoot.lexicalPath, relativePath);
  const digest = await digestPlannedLeaf(
    namespace.root.realPath,
    sourcePath,
    path.dirname(sourcePath),
    MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  return { sourcePath, logicalPath: relativePath, byteCount, digest };
}

/** Enumerate every regular leaf held by the bound prune registry. */
export async function enumeratePruneCustodyLeaves(
  root: string,
): Promise<readonly PruneCustodyLeaf[]> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  if (namespace.pruneRegistry.status === "unavailable") {
    throw new Error("prune registry cannot be bound for custody");
  }
  if (namespace.pruneRegistry.status === "absent") return [];
  const listing = await listUnitDirectories(namespace.pruneRegistry.realPath);
  if (listing.status !== "ok") {
    throw new Error("prune registry cannot be enumerated for custody");
  }
  const leaves: PruneCustodyLeaf[] = [];
  for (const unitId of listing.unitIds) {
    leaves.push(...await pruneUnitLeaves(namespace.pruneRegistry.realPath, unitId));
  }
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  return leaves;
}

/** Enumerate one prune unit without following non-regular entries. */
async function pruneUnitLeaves(
  registry: string,
  unitId: string,
): Promise<PruneCustodyLeaf[]> {
  const unitRoot = path.join(registry, unitId);
  const entries = await readDirectoryNames(unitRoot);
  if (entries.kind === "unavailable") {
    throw new Error(`prune unit ${unitId} cannot be listed`);
  }
  if (entries.kind === "absent") return [];
  const leaves: PruneCustodyLeaf[] = [];
  for (const entry of [...entries.names].sort()) {
    const relativePath = path.join(PREPARATION_PRUNE_REGISTRY, unitId, entry);
    const leaf = await lstatLeaf(path.join(unitRoot, entry));
    if (leaf.kind !== "present" || !leaf.stats.isFile() || leaf.stats.isSymbolicLink()) {
      throw new Error(`prune unit leaf cannot be taken into custody: ${relativePath}`);
    }
    leaves.push({ relativePath, byteCount: leaf.stats.size });
  }
  return leaves;
}

/** Prove one quarantine unit is absent or a real confined directory. */
export async function quarantineUnitConfinement(
  root: string,
  unitId: string,
): Promise<"absent" | "confined" | "redirected"> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  const result = await isConfinedDirectory(namespace.root.realPath, paths.unitRoot);
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  return result;
}

/** Read only the presence class of a unit's bounded completed receipt. */
export async function quarantineCompletedReceiptStatus(
  root: string,
  unitId: string,
): Promise<"absent" | "present" | "unavailable"> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  const read = await readConfinedLeafBuffer(
    namespace.root.realPath,
    paths.completedReceiptFile,
    paths.unitRoot,
    MAX_LIFECYCLE_RECEIPT_BYTES,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  if (read.kind === "absent") return "absent";
  return read.kind === "ok" ? "present" : "unavailable";
}

/**
 * Refuse a unit holding bytes the settled receipt does not name.
 *
 * §10.6: purge "rejects unknown unit contents instead of recursively destroying
 * them". Before this, the destroy walked only the receipt's own list and never
 * looked at what else was in the bytes root -- so an unexpected file was left
 * behind silently while the operation reported success and told the operator the
 * unit had been destroyed.
 *
 * Refusing is right rather than deleting the extra: nobody signed for those bytes,
 * and this is the one operation that cannot be undone.
 */
async function assertNoUnknownUnitContents(
  bytesRoot: string,
  objects: readonly Pick<QuarantineObjectV1, "objectName">[],
): Promise<void> {
  const named = new Set(objects.map((object) => object.objectName));
  // `readDirectoryNames` distinguishes absent from unreadable -- an absent bytes
  // root is a completed or resumed purge, while an UNREADABLE one must never read
  // as "nothing unknown here".
  const read = await readDirectoryNames(bytesRoot);
  if (read.kind === "unavailable") {
    throw new Error("quarantine unit bytes are unreadable; refusing to destroy");
  }
  const present = read.kind === "absent" ? [] : read.names;
  const unknown = present.filter((entry) => !named.has(entry)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `quarantine unit holds contents its receipt does not name: ${unknown.slice(0, 5).join(", ")}`,
    );
  }
}

/** Delete only authenticated quarantine object names and durably retain receipts. */
export async function destroyQuarantineUnitBytes(
  permit: LifecycleMutationPermitV1,
  root: string,
  unitId: string,
  objects: readonly Pick<QuarantineObjectV1, "objectName">[],
): Promise<void> {
  // PERMIT-GATED from Task 9E chunk C2, and bound to `purge` specifically: this
  // is the only seam that irreversibly destroys quarantined bytes, and exactly
  // one operation may reach it. A permit minted for quarantine or reset must not
  // open it, which is what `expectedOperation` is for -- review previously found
  // that field authorizing nothing at all.
  assertLifecycleMutationPermit(permit, unitId, "purge");
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  if (await isConfinedDirectory(namespace.root.realPath, paths.unitRoot) !== "confined") {
    throw new Error("quarantine unit is not a real confined directory");
  }
  await assertNoUnknownUnitContents(paths.bytesRoot, objects);
  for (const object of objects) {
    await unlinkConfinedLeafDurable(
      namespace.root.realPath,
      paths.byteObjectFile(object.objectName),
      paths.bytesRoot,
    );
  }
  await fsyncDirectoryChain(paths.unitRoot);
  await assertPreparationLifecycleNamespaceCurrent(namespace);
}
