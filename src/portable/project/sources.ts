/**
 * @file src/portable/project/sources.ts
 * @description `source.add`: publish one source through the authority.
 *
 * The upload is a prepared, re-sendable set of bytes with a declared digest.
 * The host treats that digest as a claim: it hashes what it actually received,
 * privately, BEFORE taking the gate or writing any record. A mismatch rejects
 * the submission and leaves any existing operation and its outcome untouched.
 * Labels a caller supplies are a classification request; the host assigns the
 * project compartment and a request can never remove or lower it.
 */

import { isSafeFilenameComponent } from "../../profile/identity.js";
import { MAX_SOURCE_CHARS } from "../../utils/constants.js";
import { intentDigestOf, runOperation, type ResolvedPublication } from "../authority/authority.js";
import type { ObjectImage, PublicationOutcome } from "../contracts.js";
import { bytesDigest, normalizeLabels } from "../digest.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import { authorize } from "../host/policy.js";
import { sourcePath } from "../logical-paths.js";
import type { AddSourceRequest } from "./api.js";
import { clearedWriteFloor } from "./label-floor.js";
import type { ProjectRuntime } from "./runtime.js";

/** A source name: one safe Markdown file name directly under `sources/`. */
function isValidSourceName(name: string): boolean {
  return isSafeFilenameComponent(name) && name.endsWith(".md") && !name.startsWith(".");
}

/** True when the bytes are valid UTF-8 text within the single-source cap. */
function isWithinSourceCap(runtime: ProjectRuntime, bytes: Uint8Array): boolean {
  if (bytes.byteLength > runtime.store.capabilities.limits.maxObjectBytes) return false;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).length <= MAX_SOURCE_CHARS;
  } catch {
    return false;
  }
}

/** The current image of the source path: what this add creates or replaces. */
async function currentImage(runtime: ProjectRuntime, path: string, labels: readonly string[]): Promise<ObjectImage> {
  const seen = await runtime.store.observe(path);
  if (seen === null) return { state: "absent" };
  return { state: "present", digest: seen.digest, byteCount: seen.bytes.byteLength, labels };
}

/** Resolve the add under the gate: target, pre-image, host-assigned labels and fence. */
async function resolveAdd(runtime: ProjectRuntime, request: AddSourceRequest): Promise<ResolvedPublication> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) throw new PortableDenied();
  if (!isWithinSourceCap(runtime, request.upload.bytes)) throw new PortableRefusal("limit_exceeded");
  const path = sourcePath(request.name);
  // A replaced source keeps any stricter labels its path retains, and only a writer cleared for them may replace it.
  const floor = await clearedWriteFloor(runtime, path, "source.write");
  const labels = floor.length === 0 ? [control.compartment] : normalizeLabels([control.compartment, ...floor]);
  return {
    writes: [{ path, bytes: request.upload.bytes, pre: await currentImage(runtime, path, labels), labels }],
    tail: [], skipped: [], onBehalfOf: [],
    policyFence: { policyRevision: control.policyRevision, ticketRevision: control.ticketRevision },
    consumedApprovalId: null, consumedTicketId: null,
  };
}

/** Add one source. A same-id retry sends the same prepared upload and has one effect. */
export async function addSource(runtime: ProjectRuntime, request: AddSourceRequest): Promise<PublicationOutcome> {
  await authorize(runtime.control, runtime.principal, "source.write");
  if (!isValidSourceName(request.name)) {
    return { kind: "refused", operationId: request.operationId, code: "operation_unsupported_on_portable_path" };
  }
  // Verify the received bytes privately, before the gate or any record (C5).
  if (bytesDigest(request.upload.bytes) !== request.upload.byteDigest) {
    return { kind: "rejected", reason: "upload_digest_mismatch" };
  }
  const supersedes = request.supersedes ?? null;
  const payload = {
    name: request.name, byteDigest: request.upload.byteDigest,
    requestedLabels: normalizeLabels(request.requestedLabels ?? []),
  };
  const operation = {
    operationId: request.operationId, kind: "source.add" as const, supersedes, requires: ["source.write" as const],
    intentDigest: intentDigestOf(runtime.principal, "source.add", request.operationId, supersedes, payload),
  };
  return (await runOperation(runtime, runtime.principal, operation, () => resolveAdd(runtime, request))) as PublicationOutcome;
}
