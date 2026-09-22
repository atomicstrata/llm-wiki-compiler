/**
 * @file src/preparations/lifecycle-fs/prune-protocol.ts
 * @description Root-bound filesystem owner for prune and sweep protocol I/O.
 *
 * Retention decides eligibility and signed authority. This module alone derives
 * receipt, source, and staging paths from a captured lifecycle namespace and owns
 * create-only publication plus crash-resumable verified deletion.
 */

import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteNoReplaceDurable } from "../../utils/atomic-write.js";
import {
  assertLifecycleMutationPermit, type LifecycleMutationPermitV1,
} from "../lifecycle-mutation-permit.js";
import { fsyncDirectoryChain } from "../../utils/atomic-write-durability.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import { isConfinedDirectory } from "../../utils/confined-delete.js";
import { lstatLeaf } from "../../utils/fs-presence.js";
import {
  deleteStagedLeaf,
  stageAndDeleteLeaf,
} from "../../utils/planned-bytes.js";
import { MAX_PREPARATION_EVIDENCE_OBJECT_BYTES } from "../constants.js";
import {
  parseLifecycleReceipt,
  verifyLifecycleReceipt,
  MAX_LIFECYCLE_RECEIPT_BYTES,
  type PruneReceiptContentV1,
  type PruneReceiptV1,
} from "../receipts.js";
import { lifecycleStagedDeleteName } from "../paths.js";
import {
  assertPreparationLifecycleNamespaceCurrent,
  openPreparationLifecycleNamespace,
} from "./namespace.js";
import { lifecyclePruneUnitPaths } from "./paths.js";

/** Receipt leaf selected by the expected signed record kind. */
function receiptLeaf(
  paths: ReturnType<typeof lifecyclePruneUnitPaths>,
  kind: PruneReceiptContentV1["kind"],
): string {
  return kind === "prune-planned"
    ? paths.plannedReceiptFile
    : paths.completedReceiptFile;
}

/**
 * Read a bounded prune receipt and verify it under the current key. A valid HMAC
 * alone proves only that some receipt was signed; kind, unit, and operation bind
 * the record to this exact protocol step.
 */
export async function readVerifiedPruneReceipt(
  root: string,
  unitId: string,
  key: Buffer,
  kind: PruneReceiptContentV1["kind"],
  operation: PruneReceiptContentV1["operation"],
): Promise<PruneReceiptV1 | null> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  const paths = lifecyclePruneUnitPaths(namespace, unitId);
  const read = await readConfinedLeafBuffer(
    namespace.root.realPath,
    receiptLeaf(paths, kind),
    paths.unitRoot,
    MAX_LIFECYCLE_RECEIPT_BYTES,
  );
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new Error("prune receipt is unreadable");
  const receipt = parseLifecycleReceipt(read.body.toString("utf8")) as PruneReceiptV1;
  if (!verifyLifecycleReceipt(key, receipt)) {
    throw new Error("prune receipt failed verification");
  }
  if (receipt.kind !== kind ||
      receipt.unitId !== unitId ||
      receipt.operation !== operation) {
    throw new Error("prune receipt does not bind this unit, kind, and operation");
  }
  return receipt;
}

/** Prove one prune unit is absent or a real directory under the bound registry. */
export async function assertConfinedPruneUnit(
  root: string,
  unitId: string,
): Promise<void> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  const unitRoot = lifecyclePruneUnitPaths(namespace, unitId).unitRoot;
  const confinement = await isConfinedDirectory(namespace.root.realPath, unitRoot);
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  if (confinement === "redirected") {
    throw new Error("prune unit is not a real directory");
  }
}

/** Ensure one bound prune unit exists and return its owned paths. */
async function openMutablePruneUnit(root: string, unitId: string) {
  const namespace = await openPreparationLifecycleNamespace(root, "mutate");
  const paths = lifecyclePruneUnitPaths(namespace, unitId);
  const confinement = await isConfinedDirectory(
    namespace.root.realPath,
    paths.unitRoot,
  );
  if (confinement === "redirected") {
    throw new Error("prune unit is not a real directory");
  }
  await mkdir(paths.unitRoot, { recursive: true });
  if (await isConfinedDirectory(
    namespace.root.realPath,
    paths.unitRoot,
  ) !== "confined") {
    throw new Error("prune unit could not be confined after creation");
  }
  return { namespace, paths };
}

/**
 * Durably publish one planned or completed receipt create-only.
 *
 * PERMIT-GATED from Task 9E. This publishes the record that authorises byte
 * destruction; before 9E it took no permit, so any importer could mint a plan the
 * delete phase would then honour.
 */
export async function writePruneReceiptBytes(
  permit: LifecycleMutationPermitV1,
  root: string,
  unitId: string,
  kind: PruneReceiptContentV1["kind"],
  body: Buffer,
): Promise<void> {
  assertLifecycleMutationPermit(permit, unitId);
  const { namespace, paths } = await openMutablePruneUnit(root, unitId);
  await atomicWriteNoReplaceDurable(receiptLeaf(paths, kind), body, {
    confineRoot: namespace.root.realPath,
    exactParent: true,
    mode: 0o600,
  });
  await assertPreparationLifecycleNamespaceCurrent(namespace);
}

/** The staged-delete slot name for one planned object index. */
function stagedDeleteSlot(stagingDir: string, index: number): string {
  // The name comes from the ONE derivation, shared with the postcondition
  // classifier. It was derived twice -- privately here and publicly there -- so
  // the executor that STAGED a file and the observer that CLASSIFIES it computed
  // the same name from two implementations. A drift in either would have made the
  // classifier inspect a different file than the executor wrote, which is the
  // check-and-executor split this package has been bitten by repeatedly.
  return path.join(stagingDir, lifecycleStagedDeleteName(index));
}

/** Ensure one bound prune unit exists and return its owned staging directory. */
async function openPruneStaging(
  root: string,
  unitId: string,
) {
  const { namespace, paths } = await openMutablePruneUnit(root, unitId);
  return { namespace, stagingDir: paths.unitRoot };
}

/**
 * Locate a planned leaf across source and staging. The create-only link commit
 * briefly permits both names to hold the same inode; different objects conflict.
 */
async function classifyDeleteEnds(
  source: string,
  staging: string,
  logicalPath: string,
): Promise<{
  sourcePresent: "present" | "absent";
  stagingPresent: "present" | "absent";
}> {
  const sourceLeaf = await lstatLeaf(source);
  const stagingLeaf = await lstatLeaf(staging);
  if (sourceLeaf.kind === "unavailable" || stagingLeaf.kind === "unavailable") {
    throw new Error(`prune target cannot be examined: ${logicalPath}`);
  }
  if (sourceLeaf.kind !== "present" || stagingLeaf.kind !== "present") {
    return {
      sourcePresent: sourceLeaf.kind,
      stagingPresent: stagingLeaf.kind,
    };
  }
  if (sourceLeaf.stats.dev !== stagingLeaf.stats.dev ||
      sourceLeaf.stats.ino !== stagingLeaf.stats.ino) {
    throw new Error(
      `prune target present at both its source and staging slot: ${logicalPath}`,
    );
  }
  await unlink(staging);
  await fsyncDirectoryChain(path.dirname(staging));
  return { sourcePresent: "present", stagingPresent: "absent" };
}

/**
 * Delete one signed planned object through a bound namespace. The operation is
 * crash-resumable whether bytes are still at source, staged, or at both linked names.
 *
 * PERMIT-GATED from Task 9E: this is the irreversible unlink.
 */
export async function deletePlannedPruneObject(
  permit: LifecycleMutationPermitV1,
  root: string,
  unitId: string,
  index: number,
  object: PruneReceiptContentV1["objects"][number],
  afterStaged?: () => Promise<void>,
): Promise<void> {
  assertLifecycleMutationPermit(permit, unitId);
  const opened = await openPruneStaging(root, unitId);
  const source = path.join(
    opened.namespace.privateRoot.lexicalPath,
    object.logicalPath,
  );
  const staging = stagedDeleteSlot(opened.stagingDir, index);
  const shared = {
    root: opened.namespace.root.realPath,
    plan: object,
    label: "prune target",
    maxBytes: MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
  } as const;
  const ends = await classifyDeleteEnds(source, staging, object.logicalPath);
  if (ends.stagingPresent === "present") {
    await deleteStagedLeaf({
      ...shared,
      file: staging,
      expectedDir: opened.stagingDir,
      originalDir: path.dirname(source),
    });
  } else if (ends.sourcePresent === "present") {
    await stageAndDeleteLeaf({
      ...shared,
      file: source,
      expectedDir: path.dirname(source),
      staging,
      stagingDir: opened.stagingDir,
      ...(afterStaged === undefined ? {} : { afterStaged }),
    });
  }
  await assertPreparationLifecycleNamespaceCurrent(opened.namespace);
}
