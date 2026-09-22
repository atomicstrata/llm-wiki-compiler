/**
 * @file test/preparations/lifecycle-snapshot-fixture.ts
 * @description Small byte-level fixture builder for the Task 9B lifecycle
 * snapshot tests. It writes the same signed receipts and custody shapes as the
 * production quarantine/prune engines without invoking those mutators, so each
 * classifier state can be isolated precisely.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import {
  signPruneReceipt,
  signQuarantineReceipt,
  type PruneReceiptContentV1,
  type QuarantineObjectV1,
  type QuarantineReceiptContentV1,
} from "../../src/preparations/receipts.js";
import {
  openPreparationLifecycleNamespace,
  type PreparationLifecycleNamespaceV1,
} from "../../src/preparations/lifecycle-fs/namespace.js";
import {
  lifecyclePreparationKeyFile,
  lifecyclePruneUnitPaths,
  lifecycleQuarantineUnitPaths,
} from "../../src/preparations/lifecycle-fs/paths.js";

const ACTOR = { id: "operator", surface: "cli" } as const;
const AT = "2026-07-28T12:00:00.000Z";

/** One root with a healthy key and both bound lifecycle registries. */
export async function lifecycleSnapshotFixture(
  root: string,
): Promise<{ namespace: PreparationLifecycleNamespaceV1; key: Buffer; keyEpochId: string }> {
  const bootstrap = await openPreparationLifecycleNamespace(root, "mutate");
  const key = randomBytes(32);
  await writeFile(lifecyclePreparationKeyFile(bootstrap), key.toString("base64"), { mode: 0o600 });
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  return { namespace, key, keyEpochId: preparationKeyEpochId(key) };
}

/** One quarantine object with a deterministic source and destination. */
export function quarantineObject(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
  body = Buffer.from("retained-evidence"),
): { object: QuarantineObjectV1; source: string; destination: string; body: Buffer } {
  const logicalPath = path.join("workspaces", "ws", `${unitId}.bin`);
  return {
    object: {
      logicalPath,
      objectName: "obj-000000",
      byteCount: body.byteLength,
      digest: createHash("sha256").update(body).digest("hex"),
    },
    source: path.join(namespace.root.realPath, ".llmwiki", logicalPath),
    destination: lifecycleQuarantineUnitPaths(namespace, unitId).byteObjectFile("obj-000000"),
    body,
  };
}

/** Write one signed quarantine planned/completed receipt pair or prefix. */
export async function writeQuarantineReceipts(input: {
  namespace: PreparationLifecycleNamespaceV1;
  key: Buffer;
  keyEpochId: string;
  unitId: string;
  objects: readonly QuarantineObjectV1[];
  completed?: boolean;
  completedAt?: string;
  scope?: "per-run" | "project-reset";
  runId?: string | null;
  retiredUnits?: readonly { unitId: string; receiptDigest: string }[];
}): Promise<{ planned: Buffer; completed?: Buffer }> {
  const paths = lifecycleQuarantineUnitPaths(input.namespace, input.unitId);
  await mkdir(paths.unitRoot, { recursive: true });
  const common = quarantineContent(input);
  const planned = canonicalBytes(signQuarantineReceipt(input.key, {
    ...common, kind: "quarantine-planned",
  }));
  await writeFile(paths.plannedReceiptFile, planned);
  if (!input.completed) return { planned };
  const completed = canonicalBytes(signQuarantineReceipt(input.key, {
    ...common,
    kind: "quarantine-completed",
    ...(input.completedAt === undefined ? {} : { at: input.completedAt }),
  }));
  await writeFile(paths.completedReceiptFile, completed);
  return { planned, completed };
}

/** Build the shared signed quarantine receipt fields. */
function quarantineContent(
  input: Parameters<typeof writeQuarantineReceipts>[0],
): Omit<QuarantineReceiptContentV1, "kind"> {
  const scope = input.scope ?? "per-run";
  const runId = input.runId === undefined
    ? (scope === "per-run" ? `run-${input.unitId}` : null)
    : input.runId;
  return {
    schemaVersion: 1,
    scope,
    reason: scope === "project-reset" ? "missing-key" : "run-integrity-invalid",
    unitId: input.unitId,
    keyEpochId: input.keyEpochId,
    ...(runId === null ? {} : { runId }),
    objects: [...input.objects],
    residualObligations: [],
    ...(input.retiredUnits === undefined ? {} : { retiredUnits: [...input.retiredUnits] }),
    actor: ACTOR,
    at: AT,
  };
}

/** Write one signed prune/sweep planned/completed receipt pair or prefix. */
export async function writePruneReceipts(input: {
  namespace: PreparationLifecycleNamespaceV1;
  key: Buffer;
  keyEpochId: string;
  unitId: string;
  operation: "prune" | "sweep";
  objects: PruneReceiptContentV1["objects"];
  completed?: boolean;
  runId?: string | null;
}): Promise<void> {
  const paths = lifecyclePruneUnitPaths(input.namespace, input.unitId);
  await mkdir(paths.unitRoot, { recursive: true });
  const runId = input.runId === undefined
    ? (input.operation === "prune" ? `run-${input.unitId}` : null)
    : input.runId;
  const common = {
    schemaVersion: 1 as const,
    operation: input.operation,
    unitId: input.unitId,
    ...(runId === null ? {} : { runId }),
    keyEpochId: input.keyEpochId,
    objects: [...input.objects],
    actor: ACTOR,
    at: AT,
  };
  await writeFile(paths.plannedReceiptFile,
    canonicalBytes(signPruneReceipt(input.key, { ...common, kind: "prune-planned" })));
  if (input.completed) {
    await writeFile(paths.completedReceiptFile,
      canonicalBytes(signPruneReceipt(input.key, { ...common, kind: "prune-completed" })));
  }
}
