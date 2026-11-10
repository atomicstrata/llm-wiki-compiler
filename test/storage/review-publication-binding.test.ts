/**
 * @file test/storage/review-publication-binding.test.ts
 * @description The review approval's project decisions as ONE body each over the
 * reads they need, with no project directory: the generic broken-target filter
 * (`genericBrokenTargetsWith`), the publication checks
 * (`genericPublicationRefusalWith`, `checkCandidatePublicationWith`), the
 * destination precondition (`targetUnchangedSinceProposeFrom`) and the batch
 * relation gate (`rejectBatchRelationGatesWith`). This file uses them, which
 * exist only after each was given its reads, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory reads answer each decision and log every call, so the
 * refusal ladders, the reads each branch makes (and the ones it must not), and
 * the order are pinned. The bound compositions are shown calling their lower
 * one bodies over their own seams, and the root forms reaching the incumbent
 * root readers with exact arguments.
 *
 * NOT SHOWN HERE: the citation index, link repair and the strict validator
 * themselves, or confinement; the citation, link-repair, review-approve and
 * review-batch suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as answerIndex from "../../src/citations/answer-index.js";
import type { AnswerCitationIndex } from "../../src/citations/answer-types.js";
import * as answerPublication from "../../src/citations/answer-publication.js";
import * as generic from "../../src/citations/generic-publication.js";
import { genericBrokenTargetsWith, genericCitationReadsOver } from "../../src/citations/generic-publication.js";
import * as candidateRead from "../../src/compiler/candidate-read.js";
import { rejectBatchRelationGates, rejectBatchRelationGatesWith } from "../../src/commands/review-batch-gates.js";
import type { PlannedReviewApproval } from "../../src/commands/review-batch-plan.js";
import {
  checkCandidatePublication, checkCandidatePublicationWith, genericPublicationRefusalWith, publicationCheckReadsOver, type PublicationCheckReads,
} from "../../src/commands/review-publication.js";
import { targetUnchangedSincePropose, targetUnchangedSinceProposeFrom } from "../../src/commands/review-target-precondition.js";
import { sha256Text } from "../../src/connectors/hash.js";
import * as profileBlock from "../../src/profile/block.js";
import * as diskLocalReads from "../../src/storage/disk-local-reads.js";
import { parseFrontmatter } from "../../src/utils/markdown.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import * as output from "../../src/utils/output.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

/** A candidate with only the fields a case names. */
const candidate = (fields: Partial<ReviewCandidate>): ReviewCandidate => ({ id: "cand-1", slug: "deployment", body: "---\ntitle: T\n---\n\nBody.\n", ...fields } as ReviewCandidate);
/** A retained index over `slugs`, with no pending entries of its own. */
const indexOf = (...slugs: string[]): AnswerCitationIndex =>
  ({ retained: slugs.map((slug) => ({ id: `concepts/${slug}`, pageDirectory: "concepts", slug, aliases: [] })), pending: [] }) as unknown as AnswerCitationIndex;
const DOC = "---\ntitle: Answer\n---\n\nSee [[Alpha]], [[Argo CD]], [[beta]] and [[Gone]].\n";
/** A validated answer's body, and the digest its manifest pins: the parser's body, as the check computes it. */
const ANSWER = "---\ntitle: A\n---\n\nAnswer.\n";
const ANSWER_DIGEST = sha256Text(parseFrontmatter(ANSWER).body);

/** Publication reads answering the broken targets and the validation, each call logged. */
function checkReads(log: string[], answers: { broken?: string[] | Error; validation?: Error }): PublicationCheckReads {
  return {
    brokenTargets: async () => { log.push("broken"); if (answers.broken instanceof Error) throw answers.broken; return answers.broken ?? []; },
    validateAnswer: async (_document, slug) => { log.push(`validate ${slug}`); if (answers.validation) throw answers.validation; return {}; },
  };
}

describe("the generic broken-target filter and the publication checks", () => {
  it("C1 reads the index, then the pending slugs, and keeps only the slugged targets the repair pass cannot resolve", async () => {
    const run = async (pending: string[]) => {
      const log: string[] = [];
      const reads = { index: async () => { log.push("index"); return indexOf("alpha", "argo-cd-guide"); }, pendingSlugs: async () => { log.push("pending"); return new Set(pending); } };
      return [await genericBrokenTargetsWith(reads, DOC), log];
    };
    // `argo-cd` repairs to its unique retained prefix match; an exact pending slug is never redirected, so `beta` stays broken.
    expect(await run(["beta"])).toEqual([["beta", "gone"], ["index", "pending"]]);
    // A pending slug sharing the prefix makes the repair ambiguous, so `argo-cd` is broken too.
    expect(await run(["argo-cd-draft"])).toEqual([["argo-cd", "beta", "gone"], ["index", "pending"]]);
  });

  it("C2 the generic refusal reads nothing for a typed candidate, names broken targets, and only warns when the check is unavailable", async () => {
    const warned = vi.spyOn(output, "status").mockImplementation(() => {});
    const run = async (fields: Partial<ReviewCandidate>, answers: Parameters<typeof checkReads>[1]) => {
      const log: string[] = [];
      return [await genericPublicationRefusalWith(checkReads(log, answers), candidate(fields)), log];
    };
    expect(await run({ targetEntityType: "papers" }, { broken: ["X"] })).toEqual([undefined, []]);
    expect(await run({}, { broken: ["Gone", "Lost"] })).toEqual(["broken citation targets: Gone, Lost", ["broken"]]);
    expect(await run({}, { broken: new Error("index down") })).toEqual([undefined, ["broken"]]);
    expect(warned.mock.calls.flat().join(" ")).toContain("citation check unavailable");
  });

  it("C3 a validated answer refuses an edited body before validating, refuses a failed validation, and otherwise passes", async () => {
    vi.spyOn(output, "status").mockImplementation(() => {});
    const answer = (digest: string) => candidate({ body: ANSWER, candidateKind: { name: "validated-answer", version: 1 }, citationManifest: { bodyDigest: digest } } as never);
    const run = async (subject: ReviewCandidate, answers: Parameters<typeof checkReads>[1] = {}) => {
      const log: string[] = [];
      return [await checkCandidatePublicationWith(checkReads(log, answers), subject), log];
    };
    expect(await run(answer("stale"))).toEqual([false, []]);
    expect(await run(answer(ANSWER_DIGEST), { validation: new Error("broken") })).toEqual([false, ["validate deployment"]]);
    expect(await run(answer(ANSWER_DIGEST))).toEqual([true, ["validate deployment"]]);
    expect(await run(candidate({}), { broken: ["Gone"] })).toEqual([false, ["broken"]]);
    expect(process.exitCode).toBe(1);
  });
});

describe("the destination precondition and the batch relation gate", () => {
  it("T1 contradictory or absent pins read nothing; only ENOENT proves absence; a hash pin must match exactly", async () => {
    const run = async (fields: Partial<ReviewCandidate>, read: string | Error) => {
      const log: string[] = [];
      const reads = { readText: async (rel: string) => { log.push(rel); if (read instanceof Error) throw read; return read; } };
      return [await targetUnchangedSinceProposeFrom(reads, candidate(fields)), log];
    };
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" }), denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const PAGE = "wiki/concepts/deployment.md";
    expect(await run({ expectTargetAbsent: true, expectedTargetHash: "h" }, "x")).toEqual([false, []]);
    expect(await run({}, "x")).toEqual([true, []]);
    expect([await run({ expectTargetAbsent: true }, enoent), await run({ expectTargetAbsent: true }, denied)]).toEqual([[true, [PAGE]], [false, [PAGE]]]);
    expect(await run({ expectTargetAbsent: true }, "present")).toEqual([false, [PAGE]]);
    expect(await run({ expectedTargetHash: sha256Text("page"), targetDirectory: "queries" }, "page")).toEqual([true, ["wiki/queries/deployment.md"]]);
    expect([await run({ expectedTargetHash: sha256Text("page") }, "edited"), await run({ expectedTargetHash: "h" }, denied)]).toEqual([[false, [PAGE]], [false, [PAGE]]]);
    expect(await run({ expectedTargetHash: "h", targetEntityType: "papers" }, denied)).toEqual([false, ["wiki/papers/deployment.md"]]);
  });

  it("T2 the gate loads the profile only for a multi-candidate batch with a typed candidate, and refuses only a relation-gated entry", async () => {
    const approval = (fields: Partial<ReviewCandidate>): PlannedReviewApproval => ({ candidate: candidate(fields), planned: [], result: { status: "approved" } } as never);
    const loaded = { profile: { entities: { papers: { lifecycle: { field: "status", transitionRelationRequirements: { published: [{}] } } } } } } as unknown as LoadedProfile;
    let loads = 0;
    const profile = async () => { loads += 1; return loaded; };
    const typed = approval({ targetEntityType: "papers", body: "---\nstatus: published\n---\n\nP.\n" });
    expect([(await rejectBatchRelationGatesWith(profile, [typed])).length, loads]).toEqual([1, 0]);
    expect([(await rejectBatchRelationGatesWith(profile, [approval({}), approval({})])).length, loads]).toEqual([2, 0]);
    const kept = await rejectBatchRelationGatesWith(profile, [approval({}), typed, approval({ targetEntityType: "papers", body: "---\nstatus: draft\n---\n\nD.\n" })]);
    expect([kept.length, loads, typed.result.status, typed.result.error]).toEqual([2, 1, "invalid", expect.stringContaining("approved individually")]);
    expect((await rejectBatchRelationGatesWith(async () => undefined, [approval({}), typed])).length).toBe(2);
  });
});

describe("the bound compositions and the root forms", () => {
  it("B1 each composition calls its lower one body over its own seam", async () => {
    const index = indexOf("alpha"), citations = {} as never, candidateDirs = {} as never;
    const collect = vi.spyOn(answerIndex, "collectAnswerCitationIndexFrom").mockResolvedValue(index);
    const pending = vi.spyOn(candidateRead, "listLinkResolvablePendingSlugsFrom").mockResolvedValue(new Set());
    const genericReads = genericCitationReadsOver({ citations, candidateDirs });
    expect([await genericReads.index(), await genericReads.pendingSlugs()]).toEqual([index, new Set()]);
    expect([collect.mock.calls, pending.mock.calls]).toEqual([[[citations]], [[candidateDirs, { strictIo: true }]]]);
    const validate = vi.spyOn(answerPublication, "validateCitationPublicationWith").mockResolvedValue({} as never);
    await publicationCheckReadsOver({ generic: genericReads, citations }).validateAnswer(DOC, "deployment");
    expect(validate.mock.calls.map((call) => call.slice(1))).toEqual([[DOC, "approval", "deployment"]]);
  });

  it("B2 the root forms reach the incumbent root readers with exact arguments", async () => {
    vi.spyOn(output, "status").mockImplementation(() => {});
    const broken = vi.spyOn(generic, "genericBrokenTargets").mockResolvedValue([]);
    const validate = vi.spyOn(answerPublication, "validateCitationPublication").mockResolvedValue({} as never);
    const load = vi.spyOn(profileBlock, "loadNonDefaultProfile").mockResolvedValue(undefined);
    expect(await checkCandidatePublication("/project", candidate({}))).toBe(true);
    const answer = candidate({ body: ANSWER, candidateKind: { name: "validated-answer", version: 1 }, citationManifest: { bodyDigest: ANSWER_DIGEST } } as never);
    expect(await checkCandidatePublication("/project", answer)).toBe(true);
    await rejectBatchRelationGates("/project", [{ candidate: candidate({}) }, { candidate: candidate({ targetEntityType: "papers" }) }] as never);
    expect([broken.mock.calls, validate.mock.calls, load.mock.calls]).toEqual([
      [["/project", candidate({}).body]], [["/project", ANSWER, "approval", "deployment"]], [["/project"]],
    ]);
  });

  it("B3 the root destination precondition reads the routed page through the incumbent disk reads for the root", async () => {
    const readText = vi.fn(async () => "page");
    const disk = vi.spyOn(diskLocalReads, "diskLocalReads").mockReturnValue({ readText } as never);
    expect(await targetUnchangedSincePropose("/project", candidate({ expectedTargetHash: sha256Text("page") }))).toBe(true);
    expect(await targetUnchangedSincePropose("/project", candidate({ expectedTargetHash: sha256Text("edited") }))).toBe(false);
    expect([disk.mock.calls, readText.mock.calls]).toEqual([[["/project"], ["/project"]], [["wiki/concepts/deployment.md"], ["wiki/concepts/deployment.md"]]]);
  });
});
