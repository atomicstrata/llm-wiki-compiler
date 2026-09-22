/**
 * @file src/operation-bundles/stage-capacity.ts
 * @description Candidate-aware staging capacity arithmetic. Only missing
 * durable material is charged as active growth, while complete bundle and
 * founding-store limits are always proven before the first write.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import {
  type OperationInventory, type StageCapacityProjection,
} from "./capacity.js";
import { createCatalogRecord } from "./catalog-store.js";
import { MAX_CATALOG_RECORD_BYTES } from "./constants.js";
import { projectionCapacity } from "./stage-intent.js";
import type { StageMaterialization } from "./stage-materialization.js";
import type { OperationBundleManifest } from "./types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

interface StageCapacityInput {
  manifest: OperationBundleManifest;
  manifestBytes: Buffer;
  payloads: ReadonlyMap<string, Buffer>;
}

/** Calculate future catalog bytes through the founding store constructor. */
function catalogProjection(input: StageCapacityInput): {
  records: number; bytes: number; largest: number;
} {
  let bytes = 0, largest = 0, records = 0;
  for (const mutation of input.manifest.mutations) {
    if (mutation.kind !== "catalog-record") continue;
    const payload = parseBoundedUniqueJson(
      STRICT_UTF8.decode(input.payloads.get(mutation.payloadRef)!), MAX_CATALOG_RECORD_BYTES,
    );
    const record = createCatalogRecord({
      logicalRecordId: mutation.target.logicalRecordId,
      mutationId: mutation.mutationId, payload,
      ...(mutation.target.supersedesRecordId === undefined ? {} : {
        supersedesRecordId: mutation.target.supersedesRecordId,
      }),
      createdAt: input.manifest.createdAt,
    });
    const recordBytes = canonicalBytes(record).byteLength;
    bytes += recordBytes + 1;
    largest = Math.max(largest, recordBytes);
    records += 1;
  }
  return { records, bytes, largest };
}

/** Combine durable inventory with all candidate growth still able to occur. */
export function projectStageCapacity(
  input: StageCapacityInput,
  inventory: OperationInventory,
  materialization: StageMaterialization,
): StageCapacityProjection {
  const payloadSizes = [...input.payloads.values()].map((bytes) => bytes.byteLength);
  const sourceRefs = new Set(input.manifest.mutations.filter((item) =>
    item.kind === "source-retain").map((item) => item.payloadRef));
  const sourceSizes = [...sourceRefs].map((ref) => input.payloads.get(ref)!.byteLength);
  const current = inventory.workspaces.get(input.manifest.workspaceId) ?? {
    sourceBytes: 0, largestSourceBytes: 0, catalogBytes: 0, catalogRecords: 0,
    projectionBytes: 0, largestProjectionBytes: 0, sourceDigests: new Set<string>(),
  };
  const future = !materialization.complete;
  const catalog = catalogProjection(input), projection = projectionCapacity(input.manifest);
  const sourceGrowth = future ? [...sourceRefs].filter((ref) =>
    !current.sourceDigests.has(ref)).reduce((sum, ref) =>
    sum + input.payloads.get(ref)!.byteLength, 0) : 0;
  const activeGrowth = materialization.physicalActiveByteDelta;
  return {
    newBundles: materialization.missingManifest ? 1 : 0,
    pendingBundles: inventory.pendingBundles + (future ? 1 : 0),
    mutationCount: input.manifest.mutations.length,
    largestPayloadBytes: Math.max(0, ...payloadSizes),
    bundlePayloadBytes: payloadSizes.reduce((sum, value) => sum + value, 0),
    manifestBytes: input.manifestBytes.byteLength,
    activeBundleBytes: inventory.activeBytes + activeGrowth,
    largestSourceBytes: Math.max(current.largestSourceBytes, ...sourceSizes, 0),
    workspaceSourceBytes: current.sourceBytes + sourceGrowth,
    catalogRecordBytes: catalog.largest,
    catalogRecords: current.catalogRecords + (future ? catalog.records : 0),
    catalogBytes: current.catalogBytes + (future ? catalog.bytes : 0),
    largestProjectionBytes: Math.max(current.largestProjectionBytes, projection.largest),
    workspaceProjectionBytes: current.projectionBytes + (future ? projection.total : 0),
    largestEvidenceBytes: 0,
    runEvidenceBytes: 0,
  };
}
