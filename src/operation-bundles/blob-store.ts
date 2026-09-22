/**
 * @file src/operation-bundles/blob-store.ts
 * @description Shared exact-byte create-only publication for Task 4's three
 * content-addressed stores. Public stores retain namespace ownership by
 * resolving their own leaf and owned root before entering this helper.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { AtomicWriteCollisionError, atomicWrite } from "../utils/atomic-write.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";

/** Inputs already resolved by one public store into its owned namespace. */
export interface CreateOnlyBlobRequest {
  root: string;
  file: string;
  ownedRoot: string;
  digest: string;
  bytes: Buffer;
  maxBytes: number;
}

/** Stable outcome for a new blob and an exact idempotent replay. */
export type CreateOnlyBlobResult = "created" | "same";

/** Return the lowercase SHA-256 filename for exact raw bytes. */
export function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalize request paths and require the requested file to be an owned leaf. */
function normalizeOwnedLeaf(request: CreateOnlyBlobRequest): CreateOnlyBlobRequest {
  const root = path.resolve(request.root), file = path.resolve(request.file);
  const ownedRoot = path.resolve(request.ownedRoot);
  if (path.dirname(file) !== ownedRoot) {
    throw new Error("content-addressed blob must be a direct leaf under its owned root");
  }
  return { ...request, root, file, ownedRoot };
}

/** Reject a content-address request before it can publish mismatched bytes. */
function assertRequestedBytes(request: CreateOnlyBlobRequest): void {
  assertBlobWithinCap(request);
  if (contentDigest(request.bytes) !== request.digest) {
    throw new Error("content-address digest does not match bytes");
  }
}

/** Refuse oversized caller memory before taking the private byte snapshot. */
function assertBlobWithinCap(request: CreateOnlyBlobRequest): void {
  if (request.bytes.byteLength > request.maxBytes) {
    throw new Error(`blob exceeds the ${request.maxBytes}-byte cap`);
  }
}

/** Confirm an existing owned leaf is the same capped byte sequence. */
async function isExactReplay(request: CreateOnlyBlobRequest): Promise<boolean> {
  const read = await readDurableOperationLeafBuffer(
    request.root, request.file, request.ownedRoot, request.maxBytes,
  );
  if (read.kind !== "ok") throw new Error(`existing content-addressed blob is ${read.kind}`);
  return read.body.byteLength === request.bytes.byteLength &&
    contentDigest(read.body) === request.digest && read.body.equals(request.bytes);
}

/** Durably create one immutable blob or prove its exact prior publication. */
export async function writeContentAddressedBlob(request: CreateOnlyBlobRequest): Promise<CreateOnlyBlobResult> {
  const normalized = normalizeOwnedLeaf(request);
  assertBlobWithinCap(normalized);
  const prepared = { ...normalized, bytes: Buffer.from(normalized.bytes) };
  assertRequestedBytes(prepared);
  try {
    await atomicWrite(prepared.file, prepared.bytes, {
      confineRoot: prepared.root, exactParent: true, createOnly: true,
    });
    return "created";
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  if (await isExactReplay(prepared)) return "same";
  throw new Error("content-addressed blob byte/digest conflict");
}
