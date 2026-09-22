/**
 * @file src/viewer/workflow-pdf.ts
 * @description The GENERIC final-PDF route (P9.6): `/api/workflows/:workflowId/runs/:runId/pdf`.
 * It builds the SAME live projection the run route builds (same provider, same anchor
 * rules, same degrade-to-recorded-only), takes the ONE `pdfRef` a verified stage
 * contributes, and serves that member's bytes — re-verified end to end at request time:
 * the bundle resolves healthy, the manifest BODY is re-read through the confined reader
 * and re-bound to the pinned digest, the member entry is snapshotted from THAT body, and
 * the member bytes are re-read confined+capped and compared to the entry's byte count and
 * sha256 (the chain the paper vertical's checks establish). The URL carries no type/slug/
 * sha — everything is derived server-side. Every failure is ONE stable fail-visible 404
 * problem (`pdf_unavailable`, message naming the step), never a 500, never sniffed bytes.
 * The response carries its OWN CSP so the viewer's same-origin iframe may embed it
 * (D-PDF-EMBED) while every other response keeps `frame-ancestors 'none'`.
 */

import type { ServerResponse } from "http";
import { loadProfile } from "../profile/load.js";
import type { ProfilePack } from "../profile/types.js";
import { resolveArtifactRef, type ArtifactResolution } from "../artifacts/resolve.js";
import { parseArtifactRef, formatArtifactRef, type ArtifactRef } from "../artifacts/ref.js";
import {
  artifactPaths, hashArtifactBody, memberLeafPath, readArtifactBody, readArtifactMemberBytes,
  type ArtifactMemberRead, type ArtifactPathsV1,
} from "../artifacts/store.js";
import { hashMemberBytes, parseMemberEntries, type ArtifactMemberEntry } from "../artifacts/members.js";
import type { ArtifactBodyRead } from "../artifacts/store.js";
import { buildWorkflowRunProjection, type LiveStageProjectionProvider, type StageProjection } from "./workflow-run-projection.js";

/** The confined reads the route performs, injectable so a witness can race them. */
export interface PdfReadIo {
  readonly resolve: (root: string, profile: ProfilePack, ref: ArtifactRef) => Promise<ArtifactResolution>;
  /** The artifact BODY (the member manifest, e.g. `paper-build.json`) — the file the pin hashes. */
  readonly readManifestBody: (root: string, paths: ArtifactPathsV1, maxBytes: number) => Promise<ArtifactBodyRead>;
  readonly readMember: (root: string, leafPath: string, expectedDir: string, maxBytes: number) => Promise<ArtifactMemberRead>;
}

/** The production reads: the store's own confined, no-follow, capped primitives. */
const PDF_READ_IO: PdfReadIo = {
  resolve: resolveArtifactRef, readManifestBody: readArtifactBody, readMember: readArtifactMemberBytes,
};

/** The one content-address grammar a provider's pdfRef carries (`sha256:<hex>`). */
const PDF_CONTENT_ADDRESS = /^sha256:([0-9a-f]{64})$/;
/** The characters an ASCII `filename=` fallback may carry verbatim; everything else becomes `_`. */
const ASCII_FILENAME_SAFE = /[^A-Za-z0-9._-]/g;

/** RFC 5987 attr-char: the bytes an `ext-value` may carry verbatim; every other byte is %XX. */
const RFC5987_ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * Percent-encode `text`'s UTF-8 bytes for an RFC 5987 `ext-value`. TOTAL: it goes through
 * `Buffer.from(text, "utf8")`, which never throws (a lone surrogate becomes U+FFFD), unlike
 * `encodeURIComponent`, which throws URIError on one.
 */
function percentEncodeUtf8(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += RFC5987_ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The `Content-Disposition` for a member name the STORE admitted (its own leaf-name contract is
 * wider than ASCII): an ASCII fallback `filename=` plus the RFC 5987 `filename*=UTF-8''…`
 * form, percent-encoded — so no byte the provider chose (CR/LF included) ever reaches the
 * header raw, and a Unicode member name still downloads under its own name. Total: never throws.
 */
export function contentDispositionFor(member: string): string {
  const ascii = member.replace(ASCII_FILENAME_SAFE, "_").replace(/^\.+/, "") || "document";
  return `inline; filename="${ascii}"; filename*=UTF-8''${percentEncodeUtf8(member)}`;
}
/** The PDF response's own CSP: nothing may load inside it, only the same-origin viewer may frame it. */
const PDF_RESPONSE_CSP = "default-src 'none'; frame-ancestors 'self'";

/** A pdfRef as a verified stage row carries it. */
type StagePdfRef = { artifactType: string; slug: string; sha256: string; member: string };

/** Parse `/api/workflows/:workflowId/runs/:runId/pdf` into its ids, or null. */
export function parsePdfPath(pathname: string): { workflowId: string; runId: string } | null {
  const segments = pathname.replace(/^\/api\/workflows\//, "").split("/");
  if (segments.length !== 4 || segments[1] !== "runs" || segments[3] !== "pdf") return null;
  try {
    const workflowId = decodeURIComponent(segments[0] as string);
    const runId = decodeURIComponent(segments[2] as string);
    return workflowId === "" || runId === "" ? null : { workflowId, runId };
  } catch {
    return null;
  }
}

/** The ONE stable fail-visible problem (404) — never a 500, never coerced bytes. */
function writePdfProblem(res: ServerResponse, message: string): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: { code: "pdf_unavailable", message } }));
}

/** The pdfRef of a VERIFIED stage row, or null. */
function verifiedPdfRef(stage: StageProjection): StagePdfRef | null {
  if (stage.verification !== "verified" || stage.pdfRef === undefined) return null;
  return stage.pdfRef;
}

/** The single pdfRef among the projection's verified stages, or a problem. */
async function projectedPdfRef(
  root: string, ids: { workflowId: string; runId: string }, provider: LiveStageProjectionProvider | undefined, timeoutMs: number | undefined,
): Promise<{ readonly ref: StagePdfRef } | { readonly problem: string }> {
  const projection = await buildWorkflowRunProjection(root, ids.workflowId, ids.runId, provider, timeoutMs);
  if (!("stages" in projection)) return { problem: `run "${ids.runId}" could not be projected: ${projection.problem}` };
  const refs = projection.stages.map(verifiedPdfRef).filter((ref): ref is StagePdfRef => ref !== null);
  if (refs.length === 0) return { problem: "no verified stage of this run carries a final PDF" };
  if (refs.length > 1) return { problem: "more than one verified stage carries a final PDF; refusing an ambiguous choice" };
  return { ref: refs[0] as StagePdfRef };
}

/** The canonical {@link ArtifactRef} behind a pdfRef (prefix stripped, grammar round-tripped), or null. */
function artifactRefOf(pdf: StagePdfRef): ArtifactRef | null {
  const hex = PDF_CONTENT_ADDRESS.exec(pdf.sha256)?.[1];
  if (hex === undefined) return null;
  return parseArtifactRef(formatArtifactRef({ artifactType: pdf.artifactType, slug: pdf.slug, sha256: hex }));
}

/** A member entry snapshotted from a manifest body that re-bound to the pin, plus where its leaf lives. */
type BoundMemberEntry = { readonly entry: ArtifactMemberEntry; readonly paths: ArtifactPathsV1; readonly maxMemberBytes: number };

/** Resolve the bundle healthy, re-read its manifest BODY, re-bind it to the pin, and snapshot `member`'s entry — or a problem. */
async function boundMemberEntry(
  root: string, profile: ProfilePack, ref: ArtifactRef, member: string, io: PdfReadIo,
): Promise<BoundMemberEntry | { readonly problem: string }> {
  const def = profile.artifacts?.[ref.artifactType];
  if (def === undefined || def.members === undefined) return { problem: `artifact type "${ref.artifactType}" declares no members` };
  if ((await io.resolve(root, profile, ref)).health !== "ok") return { problem: "the pinned bundle does not verify" };
  const paths = artifactPaths(root, ref.artifactType, ref.slug, def.fileName);
  const body = await io.readManifestBody(root, paths, def.maxBytes);
  if (body.kind !== "ok") return { problem: `the bundle manifest is ${body.kind}` };
  if (hashArtifactBody(body.body) !== ref.sha256) return { problem: "the bundle manifest does not re-bind to the pinned digest" };
  const entry = parseMemberEntries(body.body)?.find((row) => row.fileName === member);
  if (entry === undefined) return { problem: `member ${member} is not in the pinned manifest` };
  return { entry, paths, maxMemberBytes: def.members.maxMemberBytes };
}

/** Read `member` of the pinned bundle, re-bound at every step, or a problem naming the failed step. */
async function readPinnedMember(
  root: string, profile: ProfilePack, ref: ArtifactRef, member: string, io: PdfReadIo,
): Promise<{ readonly bytes: Buffer } | { readonly problem: string }> {
  const bound = await boundMemberEntry(root, profile, ref, member, io);
  if ("problem" in bound) return bound;
  const { entry, paths } = bound;
  const read = await io.readMember(root, memberLeafPath(paths.expectedDir, entry.fileName), paths.expectedDir, bound.maxMemberBytes);
  if (read.kind !== "ok") return { problem: `member ${member} is ${read.kind}` };
  if (read.body.byteLength !== entry.bytes || hashMemberBytes(read.body) !== entry.sha256) {
    return { problem: `member ${member} does not match its manifest entry` };
  }
  return { bytes: read.body };
}

/** Gather the servable PDF bytes; ANY throw (profile, provider, confined read) becomes a problem. */
async function gatherPdf(
  root: string, ids: { workflowId: string; runId: string }, deps: PdfRouteDeps,
): Promise<{ readonly bytes: Buffer; readonly disposition: string } | { readonly problem: string }> {
  try {
    const projected = await projectedPdfRef(root, ids, deps.provider, deps.timeoutMs);
    if ("problem" in projected) return projected;
    const ref = artifactRefOf(projected.ref);
    if (ref === null) return { problem: "the final PDF ref is malformed" };
    const { profile } = await loadProfile(root);
    const read = await readPinnedMember(root, profile, ref, projected.ref.member, deps.io ?? PDF_READ_IO);
    return "problem" in read ? read : { bytes: read.bytes, disposition: contentDispositionFor(projected.ref.member) };
  } catch {
    return { problem: "the run, its profile, or its bundle could not be read" };
  }
}

/** What the route needs beyond the request: the projection provider/budget and (tests) the reads. */
export interface PdfRouteDeps {
  readonly provider?: LiveStageProjectionProvider;
  readonly timeoutMs?: number;
  readonly io?: PdfReadIo;
}

/**
 * Serve the run's final PDF member bytes: `application/pdf`, inline, nosniff, no-store, and
 * the PDF response's own CSP. Every failure is the one fail-visible 404 problem.
 */
export async function handleApiWorkflowPdf(res: ServerResponse, pathname: string, root: string, deps: PdfRouteDeps): Promise<void> {
  const ids = parsePdfPath(pathname);
  if (ids === null) return writePdfProblem(res, `bad pdf path: ${pathname}`);
  const served = await gatherPdf(root, ids, deps);
  if ("problem" in served) return writePdfProblem(res, served.problem);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", served.disposition);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", PDF_RESPONSE_CSP);
  res.end(served.bytes);
}
