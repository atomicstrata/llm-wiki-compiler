/**
 * @file test/storage/viewer-pdf-binding.test.ts
 * @description The final-PDF route's decision as ONE body over its reads,
 * `gatherPdfWith`, bound through `pdfReadsOver`, with no project directory.
 * This file uses both, which exist only after the route was given reads of its
 * own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory reads answer the projection, the profile, the
 * resolution, the manifest body and the member bytes, and log every call, so
 * the refusal ladder, the reads each branch makes (and the ones it must not)
 * and their order are pinned. The bound composition is shown calling the lower
 * one bodies and the artifact store's leaves; the root route is shown reaching
 * the incumbent projection, profile loader and its `PdfReadIo` with exact
 * arguments, and writing the served bytes.
 *
 * NOT SHOWN HERE: the projection's own ladder (the viewer projection binding
 * suite), confinement and the live response headers (the viewer PDF suite).
 */

import { afterEach, describe, expect, it, vi, type Mock } from "bun:test";
import * as resolve from "../../src/artifacts/resolve.js";
import { hashMemberBytes } from "../../src/artifacts/members.js";
import { artifactPaths, hashArtifactBody, memberLeafPath } from "../../src/artifacts/store.js";
import * as profileLoad from "../../src/profile/load.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import { contentDispositionFor, gatherPdfWith, handleApiWorkflowPdf, pdfReadsOver, type PdfReadIo, type PdfReads } from "../../src/viewer/workflow-pdf.js";
import * as projection from "../../src/viewer/workflow-run-projection.js";

afterEach(() => { vi.restoreAllMocks(); });

const IDS = { workflowId: "build", runId: "r" };
const PDF = Buffer.from("%PDF-1.4\nretained\n%%EOF");
const MANIFEST = JSON.stringify({ members: [{ fileName: "main.pdf", bytes: PDF.byteLength, sha256: hashMemberBytes(PDF) }] });
const REF = { artifactType: "bundle", slug: "m1", sha256: hashArtifactBody(MANIFEST) };
const PDF_REF = { artifactType: "bundle", slug: "m1", sha256: `sha256:${REF.sha256}`, member: "main.pdf" };
const BUNDLE_DEF = { fileName: "bundle.json", contentKind: "json", maxBytes: 65536, members: { maxCount: 4, maxMemberBytes: 4096, maxTotalBytes: 8192, allowedExtensions: [".pdf"] } };
const LOADED = { profile: { schemaVersion: 1, profileId: "p", artifacts: { bundle: BUNDLE_DEF } }, digest: "d" } as unknown as LoadedProfile;

/** A projection envelope whose verified stages carry `refs`, and one recorded stage. */
const envelopeWith = (...refs: unknown[]) => ({ ...IDS, stages: [
  ...refs.map((pdfRef, at) => ({ stageId: `s${at}`, verification: "verified", pdfRef })), { stageId: "plain", verification: "recorded-only" },
] });

/** What each read answers; anything left out answers as the healthy bundle does. */
interface Answers { projected?: unknown; profile?: LoadedProfile | Error; health?: string; body?: unknown; member?: unknown }

/** Memory reads answering `answers`, each call logged. */
function readsOf(log: string[], answers: Answers = {}): PdfReads {
  return {
    projection: async (ids) => { log.push(`projection ${ids.workflowId}/${ids.runId}`); return (answers.projected ?? envelopeWith(PDF_REF)) as never; },
    loadProfile: async () => { log.push("profile"); if (answers.profile instanceof Error) throw answers.profile; return answers.profile ?? LOADED; },
    resolve: async (_profile, ref) => { log.push(`resolve ${ref.sha256 === REF.sha256}`); return { health: answers.health ?? "ok" } as never; },
    readManifestBody: async (ref, fileName, max) => { log.push(`body ${ref.slug} ${fileName} ${max}`); return (answers.body ?? { kind: "ok", body: MANIFEST }) as never; },
    readMember: async (ref, fileName, member, max) => { log.push(`member ${ref.slug} ${fileName} ${member} ${max}`); return (answers.member ?? { kind: "ok", body: PDF }) as never; },
  };
}

/** The served answer, or the problem, and the reads it made. */
async function run(answers: Answers = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const served = await gatherPdfWith(readsOf(log, answers), IDS);
  return ["problem" in served ? served.problem : served, log];
}

const FULL = ["projection build/r", "profile", "resolve true", "body m1 bundle.json 65536", "member m1 bundle.json main.pdf 4096"];

describe("the PDF route's one body over memory reads", () => {
  it("P1 projects, loads the profile, resolves, re-binds the manifest and re-checks the member, in that order", async () => {
    expect(await run()).toEqual([{ bytes: PDF, disposition: contentDispositionFor("main.pdf") }, FULL]);
  });

  it("P2 refuses before the profile when the projection carries no single well-formed verified pdfRef", async () => {
    const before = ["projection build/r"];
    expect(await run({ projected: { ...IDS, problem: "gone" } })).toEqual(['run "r" could not be projected: gone', before]);
    expect(await run({ projected: envelopeWith() })).toEqual(["no verified stage of this run carries a final PDF", before]);
    expect((await run({ projected: envelopeWith(PDF_REF, PDF_REF) }))[0]).toMatch(/more than one verified stage/);
    expect(await run({ projected: envelopeWith({ ...PDF_REF, sha256: REF.sha256 }) })).toEqual(["the final PDF ref is malformed", before]);
  });

  it("P3 refuses a memberless type before resolving, and an unhealthy bundle or unreadable manifest before the member", async () => {
    const plain = { ...LOADED, profile: { ...LOADED.profile, artifacts: { bundle: { ...BUNDLE_DEF, members: undefined } } } } as unknown as LoadedProfile;
    expect(await run({ profile: plain })).toEqual(['artifact type "bundle" declares no members', FULL.slice(0, 2)]);
    expect(await run({ health: "artifact-bytes-tampered" })).toEqual(["the pinned bundle does not verify", FULL.slice(0, 3)]);
    expect(await run({ body: { kind: "absent" } })).toEqual(["the bundle manifest is absent", FULL.slice(0, 4)]);
    expect(await run({ body: { kind: "ok", body: `${MANIFEST} ` } })).toEqual(["the bundle manifest does not re-bind to the pinned digest", FULL.slice(0, 4)]);
  });

  it("P4 refuses a member the manifest lacks, an unreadable member, and bytes that differ from the entry; any throw is one problem", async () => {
    expect(await run({ projected: envelopeWith({ ...PDF_REF, member: "other.pdf" }) })).toEqual(["member other.pdf is not in the pinned manifest", FULL.slice(0, 4)]);
    expect(await run({ member: { kind: "unavailable" } })).toEqual(["member main.pdf is unavailable", FULL]);
    expect((await run({ member: { kind: "ok", body: Buffer.from("short") } }))[0]).toBe("member main.pdf does not match its manifest entry");
    const sameSize = Buffer.alloc(PDF.byteLength, 0x20);
    expect((await run({ member: { kind: "ok", body: sameSize } }))[0]).toBe("member main.pdf does not match its manifest entry");
    expect(await run({ profile: new Error("profile gone") })).toEqual(["the run, its profile, or its bundle could not be read", FULL.slice(0, 2)]);
  });
});

describe("the bound composition and the root route", () => {
  it("B1 the composition calls the lower bodies and the store's leaves at the ref and the type's file name", async () => {
    const built = vi.spyOn(projection, "buildWorkflowRunProjectionWith").mockResolvedValue(envelopeWith(PDF_REF) as never);
    const loaded = vi.spyOn(profileLoad, "loadProfileFrom").mockResolvedValue(LOADED);
    const resolved = vi.spyOn(resolve, "resolveArtifactRefFrom").mockResolvedValue({ health: "ok" } as never);
    const log: string[] = [];
    const store = { artifactAt: (type: string, slug: string, fileName: string) => {
      log.push(`at ${type}/${slug}/${fileName}`);
      return { readBodyText: async (max: number) => { log.push(`body ${max}`); return { kind: "ok", body: MANIFEST } as const; },
        readMemberBytes: async (name: string, max: number) => { log.push(`member ${name} ${max}`); return { kind: "ok", body: PDF } as const; } };
    } } as never;
    const live = vi.fn(), runs = {} as never, profile = {} as never;
    const served = await gatherPdfWith(pdfReadsOver({ runs, profile, store, live, timeoutMs: 7 }), IDS);
    expect(served).toEqual({ bytes: PDF, disposition: contentDispositionFor("main.pdf") });
    expect(built.mock.calls).toEqual([[expect.objectContaining({ readRun: expect.any(Function), loadProfile: expect.any(Function) }), "build", "r", live, 7]]);
    expect([loaded.mock.calls, resolved.mock.calls]).toEqual([[[profile]], [[store, LOADED.profile, REF]]]);
    expect(log).toEqual(["at bundle/m1/bundle.json", "body 65536", "at bundle/m1/bundle.json", "member main.pdf 4096"]);
  });

  it("B2 the root route reaches the incumbent projection, profile loader and PdfReadIo with exact arguments, then serves", async () => {
    const provider = vi.fn();
    const built = vi.spyOn(projection, "buildWorkflowRunProjection").mockResolvedValue(envelopeWith(PDF_REF) as never);
    const loaded = vi.spyOn(profileLoad, "loadProfile").mockResolvedValue(LOADED);
    const io = { resolve: vi.fn(async () => ({ health: "ok" })), readManifestBody: vi.fn(async () => ({ kind: "ok", body: MANIFEST })),
      readMember: vi.fn(async () => ({ kind: "ok", body: PDF })) } as unknown as PdfReadIo;
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await handleApiWorkflowPdf(res as never, "/api/workflows/build/runs/r/pdf", "/project", { provider, timeoutMs: 9, io });
    const paths = artifactPaths("/project", "bundle", "m1", "bundle.json");
    expect([built.mock.calls, loaded.mock.calls]).toEqual([[["/project", "build", "r", provider, 9]], [["/project"]]]);
    expect([(io.resolve as unknown as Mock<typeof io.resolve>).mock.calls, (io.readManifestBody as unknown as Mock<typeof io.readManifestBody>).mock.calls, (io.readMember as unknown as Mock<typeof io.readMember>).mock.calls]).toEqual([
      [["/project", LOADED.profile, REF]], [["/project", paths, 65536]], [["/project", memberLeafPath(paths.expectedDir, "main.pdf"), paths.expectedDir, 4096]],
    ]);
    expect([res.statusCode, res.end.mock.calls]).toEqual([200, [[PDF]]]);
  });
});
