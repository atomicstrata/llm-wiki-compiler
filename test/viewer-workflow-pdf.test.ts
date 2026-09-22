/**
 * @file test/viewer-workflow-pdf.test.ts
 * @description The GENERIC final-PDF route (P9.6) `/api/workflows/:workflowId/runs/:runId/pdf`,
 * in-process with an injected projection provider on a plain (non-journey) run: every failure
 * before a bundle is touched — no verified pdfRef, an ambiguous pair, a malformed digest, a
 * malformed path, an unknown run, a provider that THROWS — is the ONE fail-visible 404 problem
 * (`pdf_unavailable`), never a 500. A generic member bundle also proves successful
 * delivery and request-time rejection after retained member bytes are changed.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { startViewer } from "../src/index.js";
import { buildWorkflowRunProjection, type LiveStageProjectionProvider, type VerifiedStageFactsV1 } from "../src/viewer/workflow-run-projection.js";
import { contentDispositionFor } from "../src/viewer/workflow-pdf.js";
import { startArtifactRun, researchArtifactProfile } from "./fixtures/artifact-seam-fixtures.js";
import { startAndParkBuild } from "./fixtures/workflow-profile.js";
import { writeBundle, bundlePaths, membersBlock } from "./fixtures/member-artifact-root.js";

/** A two-stage roster, so two verified rows can each carry a pdfRef. */
const TWO_STAGES = [
  { id: "first-step", reads: ["ideas"], writes: [] },
  { id: "second-step", reads: ["ideas"], writes: [] },
];

const PDF_REF = { artifactType: "paper-build", slug: "m1", sha256: `sha256:${"a".repeat(64)}`, member: "main.pdf" };

/** The run's roster stage ids, as core's own recorded-only projection lists them. */
async function rosterStageIds(root: string, workflowId: string, runId: string): Promise<string[]> {
  const projection = await buildWorkflowRunProjection(root, workflowId, runId);
  return "stages" in projection ? projection.stages.map((s) => s.stageId) : [];
}

/** A provider that verifies the run's FIRST roster stage with each of the given extra facts. */
function providerWith(facts: ReadonlyArray<Partial<VerifiedStageFactsV1>>): LiveStageProjectionProvider {
  return async (root, workflowId, runId, expected) => {
    const stageId = (await rosterStageIds(root, workflowId, runId))[0] ?? "plan";
    return { workflowId, runId, ...expected, stages: facts.map((f) => ({ stageId, summary: "s", appliedTargets: [], evidenceDigests: [], ...f })) };
  };
}

/** GET the pdf route of a fresh plain run (or `over.run`) through an in-process viewer with `provider`. */
async function fetchPdf(
  provider: LiveStageProjectionProvider, over: { path?: string; run?: { root: string; runId: string }; beforeFetch?: () => Promise<void> } = {},
): Promise<{ status: number; body: unknown; type: string | null }> {
  const { root, runId } = over.run ?? await startArtifactRun("pdf-route-", researchArtifactProfile());
  const viewer = await startViewer({ root, host: "127.0.0.1", port: 0 }, { liveStageProjectionProvider: provider });
  try {
    await over.beforeFetch?.();
    const res = await fetch(`http://${viewer.host}:${viewer.port}${over.path ?? `/api/workflows/build/runs/${runId}/pdf`}`);
    const type = res.headers.get("Content-Type");
    return { status: res.status, body: type?.includes("json") ? await res.json() : await res.text(), type };
  } finally {
    await viewer.close();
  }
}

/** The one stable problem shape. */
function expectProblem(r: { status: number; body: unknown }, step: RegExp): void {
  expect(r.status).toBe(404);
  expect(r.body).toMatchObject({ error: { code: "pdf_unavailable" } });
  expect((r.body as { error: { message: string } }).error.message).toMatch(step);
}

describe("viewer — /api/workflows/:workflowId/runs/:runId/pdf (generic, pre-bundle refusals)", () => {
  it("serves a retained PDF and refuses changed member bytes on the next request", async () => {
    const profile = researchArtifactProfile();
    profile.artifacts = { bundle: { fileName: "bundle.json", contentKind: "json", maxBytes: 65536,
      members: membersBlock({ allowedExtensions: [".pdf"] }) } };
    profile.workflows!.build.stages[0]!.artifactWrites = ["bundle"];
    const run = await startArtifactRun("pdf-generic-bundle-", profile);
    const bytes = Buffer.from("%PDF-1.4\nretained generic document\n%%EOF");
    const ref = await writeBundle(run.root, [{ fileName: "main.pdf", bytes }]);
    const provider = providerWith([{ pdfRef: { ...ref, sha256: `sha256:${ref.sha256}`, member: "main.pdf" } }]);
    const response = await fetchPdf(provider, { run });
    expect(response).toEqual({ status: 200, type: "application/pdf", body: bytes.toString() });
    await writeFile(path.join(bundlePaths(run.root).expectedDir, "main.pdf"), "changed bytes");
    expectProblem(await fetchPdf(provider, { run }), /does not verify|does not match/);
  });

  it("404s when no verified stage carries a pdfRef", async () => {
    expectProblem(await fetchPdf(providerWith([{}])), /no verified stage .* final PDF/);
  });

  it("404s when two verified stages carry a pdfRef (ambiguous)", async () => {
    const two: LiveStageProjectionProvider = async (root, workflowId, runId, expected) => {
      const ids = (await rosterStageIds(root, workflowId, runId)).slice(0, 2);
      return { workflowId, runId, ...expected, stages: ids.map((stageId) => ({ stageId, summary: "s", appliedTargets: [], evidenceDigests: [], pdfRef: PDF_REF })) };
    };
    const run = await startAndParkBuild("pdf-two-", TWO_STAGES);
    expectProblem(await fetchPdf(two, { run }), /more than one verified stage/);
  });

  it("names the member in Content-Disposition only through the RFC 5987 encoder — no raw byte, CR/LF included, ever reaches the header", () => {
    const crlf = contentDispositionFor("main.pdf\r\nX-Injected: 1");
    expect(crlf).not.toMatch(/[\r\n]/);
    expect(crlf).toBe(`inline; filename="main.pdf__X-Injected__1"; filename*=UTF-8''main.pdf%0D%0AX-Injected%3A%201`);
    expect(contentDispositionFor("main.pdf")).toBe(`inline; filename="main.pdf"; filename*=UTF-8''main.pdf`);
    expect(contentDispositionFor("报告.pdf")).toBe(`inline; filename="__.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`);
    expect(contentDispositionFor("_main.pdf")).toBe(`inline; filename="_main.pdf"; filename*=UTF-8''_main.pdf`);
    expect(contentDispositionFor("..")).toBe(`inline; filename="document"; filename*=UTF-8''..`);
    // TOTAL: a lone UTF-16 surrogate (which encodeURIComponent throws on) encodes as U+FFFD's bytes.
    expect(contentDispositionFor("\uD800.pdf")).toBe(`inline; filename="_.pdf"; filename*=UTF-8''%EF%BF%BD.pdf`);
    expect(contentDispositionFor("")).toBe(`inline; filename="document"; filename*=UTF-8''`);
  });

  it("a member the store would never admit (a traversal) is still the one 404 problem, never bytes", async () => {
    expectProblem(await fetchPdf(providerWith([{ pdfRef: { ...PDF_REF, member: "../main.pdf" } }])), /declares no members|not in the pinned manifest|could not be read/);
  });

  it("404s on a malformed digest, a malformed path, and an unknown run", async () => {
    expectProblem(await fetchPdf(providerWith([{ pdfRef: { ...PDF_REF, sha256: "sha256:zz" } }])), /no verified stage .* final PDF|malformed/);
    // A path the pdf grammar does not match never reaches the route: the workflows dispatcher's own 404.
    expect((await fetchPdf(providerWith([{ pdfRef: PDF_REF }]), { path: "/api/workflows/build/runs/r/pdf/extra" })).status).toBe(404);
    expectProblem(await fetchPdf(providerWith([{ pdfRef: PDF_REF }]), { path: "/api/workflows/build/runs/no-such-run/pdf" }), /could not be projected|not readable/);
  });

  it("a provider that THROWS, or a profile that breaks AFTER startup, is a 404 problem — never a 500", async () => {
    const throwing: LiveStageProjectionProvider = async () => { throw new Error("provider exploded"); };
    const r = await fetchPdf(throwing);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { code: "pdf_unavailable" } });
    // The route's OWN catch: the projection succeeds with a pdfRef, then the profile load throws.
    const run = await startArtifactRun("pdf-route-broken-profile-", researchArtifactProfile());
    const broken = await fetchPdf(providerWith([{ pdfRef: PDF_REF }]), { run, beforeFetch: () => writeFile(path.join(run.root, PROFILE_FILE), "{ not json") });
    expect(broken.status).toBe(404);
    expect(broken.body).toMatchObject({ error: { code: "pdf_unavailable" } });
  });
});
