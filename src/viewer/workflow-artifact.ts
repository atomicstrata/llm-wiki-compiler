/**
 * @file src/viewer/workflow-artifact.ts
 * @description The GENERIC run/stage-bound artifact BODY route (P9.3):
 * `/api/workflows/:workflowId/runs/:runId/stage/:stageId/output`. It serves the bytes of
 * a stage's RECORDED output artifact so the viewer can link to / download it. The exact
 * `ArtifactRef` is DERIVED SERVER-side from `run.outputs[stageId]` (the URL carries no
 * type/slug/sha), re-hashed to its pinned digest by `readVerifiedArtifactBody`, and served
 * with a content-type FIXED by the artifact TYPE's declared `contentKind` — never sniffed,
 * never client-controlled. `no-store` because the URL is NOT content-addressed (a failed
 * run's output can be cleared on resume, and adaptation can remap output keys), so it must
 * not be cached as immutable. Workflow-GENERIC: it reads only run outputs + the profile's
 * declared content kind — no product vocabulary. The member/PDF variant is deferred;
 * embedding also needs a reviewed CSP because this response inherits the server's
 * `frame-ancestors 'none'`, which forbids even a same-origin viewer ancestor.
 */

import type { ServerResponse } from "http";
import { readRun } from "../workflow-history/store.js";
import { loadProfile } from "../profile/load.js";
import { readVerifiedArtifactBody } from "../artifacts/read-verified.js";
import { parseArtifactRef, formatArtifactRef, type ArtifactRef } from "../artifacts/ref.js";

/** Fixed, safe content-type + download filename per the artifact type's declared content kind. */
const SERVABLE_KINDS: Readonly<Record<string, { readonly contentType: string; readonly filename: string }>> = {
  json: { contentType: "application/json; charset=utf-8", filename: "output.json" },
  text: { contentType: "text/plain; charset=utf-8", filename: "output.txt" },
};

/** A fail-VISIBLE JSON problem (404) — never a 500, never a coerced/sniffed body. */
function writeArtifactProblem(res: ServerResponse, message: string): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: { code: "artifact_unavailable", message } }));
}

/** Parse `/api/workflows/:workflowId/runs/:runId/stage/:stageId/output` into its ids, or null. */
export function parseStageOutputPath(
  pathname: string,
): { workflowId: string; runId: string; stageId: string } | null {
  const segments = pathname.replace(/^\/api\/workflows\//, "").split("/");
  if (segments.length !== 6 || segments[1] !== "runs" || segments[3] !== "stage" || segments[5] !== "output") {
    return null;
  }
  try {
    const workflowId = decodeURIComponent(segments[0] as string);
    const runId = decodeURIComponent(segments[2] as string);
    const stageId = decodeURIComponent(segments[4] as string);
    return workflowId === "" || runId === "" || stageId === "" ? null : { workflowId, runId, stageId };
  } catch {
    return null;
  }
}

/**
 * Strictly validate a stage's recorded output into a canonical {@link ArtifactRef}, or null.
 * The round-trip through the canonical grammar enforces slug-safety AND a lowercase 64-hex
 * sha256, so a malformed digest, slug, or type refuses before any read is attempted.
 */
function validateOutputRef(recorded: unknown): ArtifactRef | null {
  if (typeof recorded !== "object" || recorded === null) return null;
  const ref = recorded as Record<string, unknown>;
  if (typeof ref.artifactType !== "string" || typeof ref.slug !== "string" || typeof ref.sha256 !== "string") {
    return null;
  }
  return parseArtifactRef(formatArtifactRef({ artifactType: ref.artifactType, slug: ref.slug, sha256: ref.sha256 }));
}

/** The verified bytes + their fixed content mapping, or a fail-visible problem message. */
type ServableOutput = { readonly bytes: Buffer; readonly mapping: { contentType: string; filename: string } } | { readonly problem: string };

/** Resolve the run and derive its stage-output {@link ArtifactRef} server-side, or a problem. */
async function resolveStageOutputRef(
  root: string, ids: { workflowId: string; runId: string; stageId: string },
): Promise<{ readonly ref: ArtifactRef } | { readonly problem: string }> {
  const read = await readRun(root, ids.runId);
  if (read.status !== "ok") return { problem: `run "${ids.runId}" is not readable` };
  if (read.run.workflowId !== ids.workflowId) {
    return { problem: `run belongs to workflow "${read.run.workflowId}", not "${ids.workflowId}"` };
  }
  const ref = validateOutputRef(read.run.outputs[ids.stageId]);
  return ref === null ? { problem: `stage "${ids.stageId}" has no verifiable recorded output` } : { ref };
}

/**
 * Gather + verify a stage's servable output, or a problem message. Reads that can THROW
 * (loadProfile on a profile gone unavailable after startup, the verified-artifact reader)
 * are caught here, so EVERY failure becomes the route's typed problem — never a 500.
 */
async function gatherServableOutput(
  root: string, ids: { workflowId: string; runId: string; stageId: string },
): Promise<ServableOutput> {
  try {
    const resolved = await resolveStageOutputRef(root, ids);
    if ("problem" in resolved) return resolved;
    const { profile } = await loadProfile(root);
    const mapping = SERVABLE_KINDS[profile.artifacts?.[resolved.ref.artifactType]?.contentKind ?? ""];
    if (mapping === undefined) return { problem: `artifact type "${resolved.ref.artifactType}" is not a servable content kind` };
    const body = await readVerifiedArtifactBody(root, profile, resolved.ref);
    if (body.health !== "ok" || body.bytes === undefined) return { problem: `artifact did not verify (${body.health})` };
    return { bytes: body.bytes, mapping };
  } catch {
    return { problem: "the run or its artifact could not be read" };
  }
}

/**
 * Serve a stage's recorded output artifact bytes. Every failure — a malformed path, an
 * unreadable run, a workflow-id mismatch, a missing/malformed output ref, an unservable
 * content kind, a body that does not re-verify, or ANY thrown read/profile error — is a
 * fail-visible 404 problem, never a 500 and never coerced bytes.
 */
export async function handleApiStageOutput(res: ServerResponse, pathname: string, root: string): Promise<void> {
  const ids = parseStageOutputPath(pathname);
  if (ids === null) return writeArtifactProblem(res, `bad stage-output path: ${pathname}`);
  const served = await gatherServableOutput(root, ids);
  if ("problem" in served) return writeArtifactProblem(res, served.problem);
  res.statusCode = 200;
  res.setHeader("Content-Type", served.mapping.contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${served.mapping.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(served.bytes);
}
