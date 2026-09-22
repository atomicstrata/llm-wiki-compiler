/**
 * @file test/operation-bundles/stage-capacity-fixtures.ts
 * @description Practical stage-level capacity fixtures. Each helper seeds only
 * valid authoritative state, proves refusal is byte-identical, and then proves
 * a non-growing in-bounds staging request still succeeds.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import {
  MAX_CATALOG_FILE_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE,
  MAX_PAYLOAD_BYTES, MAX_RETAINED_SOURCE_BYTES,
} from "../../src/operation-bundles/constants.js";
import { type MutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  stageOperationBundleLocked, type OperationBundleDraft,
  type OperationMutationDraft, type StageOperationBundleRequest,
} from "../../src/operation-bundles/stage.js";
import { listProjectFiles } from "../fixtures/project-files.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const AT = "2026-07-18T12:00:00.000Z";

/** Return the lowercase content address for exact bytes. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build the common closed manifest envelope around supplied mutations. */
function draft(mutations: readonly OperationMutationDraft[]): OperationBundleDraft {
  return {
    workspaceId: "research", createdBy: "planner",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: { packId: "pack", packDigest: DIGEST,
      actionId: "prepare", actionDescriptorDigest: DIGEST },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST, inputs: [],
    preparationEvidence: [], bounds: [], reconciliations: [], planningWarnings: [],
    completeness: { attempted: 0, completed: 0, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST },
    mutations,
    run: { actor: { id: "planner", surface: "sdk", grants: [] },
      declaredCompensatorIndexes: [], controlTransitionAllowance: 32 },
  };
}

/** Build one stage request from exact mutation and payload snapshots. */
function request(
  mutations: readonly OperationMutationDraft[],
  payloads: readonly Buffer[],
): StageOperationBundleRequest {
  return {
    draft: draft(mutations),
    payloads: new Map(payloads.map((bytes) => [digest(bytes), bytes])),
    clock: { now: () => new Date(AT) },
  };
}

/** Build one source-retain staging request around exact payload bytes. */
export function sourceStageRequest(bytes: Buffer): StageOperationBundleRequest {
  return request([sourceMutation(bytes)], [bytes]);
}

/** Build one retained-source mutation bound to its payload. */
function sourceMutation(bytes: Buffer): OperationMutationDraft {
  const payloadRef = digest(bytes), bound = `sha256:${payloadRef}` as const;
  return {
    kind: "source-retain", operation: "create", target: { digest: payloadRef }, payloadRef,
    dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "absent-or-same", digest: bound, byteCount: bytes.length },
    postcondition: { digest: bound, byteCount: bytes.length },
  };
}

/** Build one ordinary page mutation for the subsequent success proof. */
function pageRequest(): StageOperationBundleRequest {
  const bytes = Buffer.from("subsequent in-bounds page"), payloadRef = digest(bytes);
  return request([{
    kind: "page", operation: "create", payloadRef,
    target: { kind: "entity", entityType: "concept", slug: "capacity-proof" },
    dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" },
    postcondition: { digest: `sha256:${payloadRef}`, byteCount: bytes.length },
  }], [bytes]);
}

/** Hash every private file sequentially so large fixtures remain bounded. */
async function privateFingerprint(root: string): Promise<Record<string, string>> {
  const files = (await listProjectFiles(root)).filter((file) => file.startsWith(".llmwiki/")).sort();
  const result: Record<string, string> = {};
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    result[file] = `${bytes.length}:${digest(bytes)}`;
  }
  return result;
}

/** Prove one refusal is zero-write and a smaller non-growing request succeeds. */
async function expectRefusalThenSuccess(
  root: string,
  staged: StageOperationBundleRequest,
  message: RegExp,
): Promise<void> {
  const before = await privateFingerprint(root);
  await expect(stageOperationBundleLocked(root, staged)).rejects.toThrow(message);
  expect(await privateFingerprint(root)).toEqual(before);
  await expect(stageOperationBundleLocked(root, pageRequest()))
    .resolves.toMatchObject({ wrote: true });
}

/** Exercise the individual payload ceiling through real stage preflight. */
export async function proveIndividualPayloadCap(root: string): Promise<void> {
  const bytes = Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61);
  await expectRefusalThenSuccess(root, request([sourceMutation(bytes)], [bytes]), /payload.*cap/i);
}

/** Exercise the per-bundle aggregate payload ceiling with in-cap leaves. */
export async function proveAggregatePayloadCap(root: string): Promise<void> {
  const payloads = Array.from({ length: 5 }, (_, index) =>
    Buffer.alloc(13 * 1024 * 1024, 0x61 + index));
  await expectRefusalThenSuccess(
    root, request(payloads.map(sourceMutation), payloads), /bundle-payloads.*cap/i,
  );
}

/** Build one large but individually bounded relation mutation. */
function relationMutation(index: number): OperationMutationDraft {
  const attributes = Object.fromEntries(Array.from({ length: 60 }, (_, field) =>
    [`field-${field}`, "x".repeat(1_000)]));
  return {
    kind: "relation", operation: "create",
    target: { relationType: "supports", from: `concept/from-${index}`, to: `concept/to-${index}` },
    attributes, dependsOn: [], reconciliationRefs: [], precondition: { kind: "absent" },
    postcondition: { digest: DIGEST, recordId: `relation-${index}` },
  };
}

/** Exercise the canonical manifest ceiling with closed-grammar data. */
export async function proveManifestCap(root: string): Promise<void> {
  const oversized = request(Array.from({ length: 72 }, (_, index) => relationMutation(index)), []);
  await expectRefusalThenSuccess(root, oversized, /manifest|json.*cap|byte cap/i);
}

/** Seed exactly the retained-source aggregate ceiling with valid blobs. */
async function seedSourceCap(root: string): Promise<void> {
  const paths = operationPaths(root, "research");
  await mkdir(paths.sourcesRoot, { recursive: true });
  for (let index = 0; index < 32; index += 1) {
    const bytes = Buffer.alloc(MAX_RETAINED_SOURCE_BYTES, index);
    await writeFile(paths.sourceFile(digest(bytes)), bytes);
  }
}

/** Exercise workspace retained-source growth from an exact-cap inventory. */
export async function proveWorkspaceSourceCap(root: string): Promise<void> {
  await seedSourceCap(root);
  const bytes = Buffer.from("one more retained source");
  await expectRefusalThenSuccess(
    root, request([sourceMutation(bytes)], [bytes]), /workspace-sources.*cap/i,
  );
}

/** Return one deterministic valid catalog mutation identity. */
function catalogMutationId(index: number): MutationId {
  return `opm_${createHash("sha256").update(`catalog-${index}`).digest("hex")}` as MutationId;
}

/** Construct one canonical independent catalog root record. */
function catalogLine(index: number, payload: unknown = { value: index }): Buffer {
  const record = createCatalogRecord({
    logicalRecordId: `record-${index}`, mutationId: catalogMutationId(index),
    payload, createdAt: AT,
  });
  return Buffer.concat([canonicalBytes(record), Buffer.from("\n")]);
}

/** Write one already-validated catalog byte sequence into its authority path. */
async function writeCatalog(root: string, body: Buffer): Promise<void> {
  const file = operationPaths(root, "research").catalogFile;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

/** Build one catalog-append staging request. */
function catalogRequest(bytes = Buffer.from('{"candidate":true}')): StageOperationBundleRequest {
  const payloadRef = digest(bytes);
  return request([{
    kind: "catalog-record", operation: "create", payloadRef,
    target: { logicalRecordId: "candidate" }, dependsOn: [], reconciliationRefs: [],
    precondition: { kind: "absent" }, postcondition: { digest: `sha256:${payloadRef}` },
  }], [bytes]);
}

/** Exercise the catalog record-count ceiling through staging. */
export async function proveCatalogRecordCountCap(root: string): Promise<void> {
  const lines = Array.from({ length: MAX_CATALOG_RECORDS_PER_WORKSPACE }, (_, index) =>
    catalogLine(index));
  await writeCatalog(root, Buffer.concat(lines));
  await expectRefusalThenSuccess(root, catalogRequest(), /catalog-records.*cap/i);
}

/** Fill a valid catalog until one more similarly sized record cannot fit. */
function nearCatalogByteCap(): Buffer {
  const lines: Buffer[] = [];
  let bytes = 0, index = 0;
  for (;;) {
    const line = catalogLine(index, { body: "x".repeat(60_000) });
    if (bytes + line.byteLength > MAX_CATALOG_FILE_BYTES) break;
    lines.push(line);
    bytes += line.byteLength;
    index += 1;
  }
  return Buffer.concat(lines);
}

/** Exercise aggregate catalog bytes from valid near-cap authority state. */
export async function proveCatalogByteCap(root: string): Promise<void> {
  await writeCatalog(root, nearCatalogByteCap());
  const candidate = Buffer.from(JSON.stringify({ body: "y".repeat(60_000) }));
  await expectRefusalThenSuccess(root, catalogRequest(candidate), /catalog.*cap/i);
}
