/**
 * @file test/storage/review-batch-plan-binding.test.ts
 * @description The batch approval plan as ONE body over its steps,
 * `planReviewBatchWith`, with no project directory. This file uses it, which
 * exists only after the plan was given steps of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer each candidate's read, destination
 * precondition, citation refusal and plan, and the batch's relation gate, and
 * log every call. So the per-item order, the reads each refusal makes (and the
 * ones it must not), which errors are individual refusals and which stop the
 * batch, and the group refusal of colliding targets are pinned. The root form
 * is shown reaching every incumbent root step with exact arguments.
 *
 * NOT SHOWN HERE: the steps themselves (the candidate read, the precondition,
 * the citation check, the planners, the relation gate) and the source-snapshot
 * refusal; the review-batch and review-publication binding suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as candidates from "../../src/compiler/candidates.js";
import { UnsafeCandidateIdError } from "../../src/compiler/candidates.js";
import * as reviewApprove from "../../src/commands/review-approve.js";
import * as gates from "../../src/commands/review-batch-gates.js";
import { planReviewBatch, planReviewBatchWith, type ReviewBatchPlanSteps } from "../../src/commands/review-batch-plan.js";
import type { ReviewBatchCandidateResult, ReviewBatchItem } from "../../src/commands/review-batch-types.js";
import * as publication from "../../src/commands/review-publication.js";
import * as precondition from "../../src/commands/review-target-precondition.js";
import { sha256Text } from "../../src/connectors/hash.js";
import * as promote from "../../src/trust/promote.js";
import { CandidateProfileError } from "../../src/trust/promote.js";
import type { PagePlannedMutation } from "../../src/trust/planner.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

afterEach(() => { vi.restoreAllMocks(); });

const PAGE = "---\ntitle: T\n---\n\nBody.\n";
const PLANNED = [{ kind: "page" }] as unknown as PagePlannedMutation[];
/** A complete, ordinary (policy-reviewed, unheld) default candidate; a case overrides only the fields it names. */
const candidate = (id: string, fields: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  id, title: id, slug: id, summary: "", sources: [], body: PAGE, generatedAt: "2026-01-01T00:00:00.000Z",
  reviewMode: "policy", heldReasons: [], ...fields,
});

/** What the steps answer, by candidate id; anything left out answers as a clean default candidate does. */
interface World {
  held?: Record<string, ReviewCandidate | null | Error>;
  moved?: string[];
  refused?: Record<string, string>;
  plans?: Record<string, PagePlannedMutation[] | Error>;
}

/** Memory steps over `world`, each call logged. */
function stepsOf(log: string[], world: World = {}): ReviewBatchPlanSteps {
  const answer = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  return {
    readCandidate: async (id) => { log.push(`read ${id}`); return answer(world.held?.[id] !== undefined ? world.held[id]! : candidate(id)); },
    targetUnchanged: async ({ id }) => { log.push(`target ${id}`); return !world.moved?.includes(id); },
    publicationRefusal: async ({ id }) => { log.push(`refusal ${id}`); return world.refused?.[id]; },
    planTyped: async ({ id }) => { log.push(`typed ${id}`); return answer(world.plans?.[id] ?? PLANNED); },
    planDefault: async ({ id }) => { log.push(`default ${id}`); return answer(world.plans?.[id] ?? PLANNED); },
    relationGates: async (approvals) => { log.push(`gates ${approvals.map(({ candidate: { id } }) => id).join(",")}`); return approvals; },
  };
}

/** Plan `ids` (or items) over `world`: the approved ids, every result, and the log. */
async function plan(entries: Array<string | ReviewBatchItem>, world: World = {}, results?: ReviewBatchCandidateResult[]) {
  const items = entries.map((entry) => (typeof entry === "string" ? { id: entry } : entry));
  const outcomes = results ?? items.map(({ id }): ReviewBatchCandidateResult => ({ id, status: "failed" }));
  const log: string[] = [];
  const approvals = await planReviewBatchWith(stepsOf(log, world), items, outcomes);
  return { approved: approvals.map(({ candidate: { id } }) => id), outcomes, log };
}

describe("the batch plan's one body over memory steps", () => {
  it("P1 per candidate reads, checks the destination, then citations, then plans typed or default; the gate runs once on the rest", async () => {
    const { approved, outcomes, log } = await plan(["a", "p"], { held: { p: candidate("p", { targetEntityType: "papers" }) } });
    expect(approved).toEqual(["a", "p"]);
    expect(log).toEqual(["read a", "target a", "refusal a", "default a", "read p", "target p", "refusal p", "typed p", "gates a,p"]);
    expect(outcomes.map(({ pagePath }) => pagePath)).toEqual(["wiki/concepts/a.md", "wiki/papers/p.md"]);
  });

  it("P2 refuses each candidate individually at its own step, asking nothing after it", async () => {
    const answer = candidate("v", { candidateKind: { name: "validated-answer", version: 1 } } as never);
    const { approved, outcomes, log } = await plan([{ id: "s", draftContentHash: "stale" }, "m", "v", "t", "c", "x", "e", "u", "y"], {
      held: { m: null, v: answer, x: candidate("x", { body: "no frontmatter" }), u: new UnsafeCandidateIdError("id", "u"), y: candidate("y", { targetEntityType: "papers" }) },
      moved: ["t"], refused: { c: "broken citation targets: Gone" }, plans: { e: [], y: new CandidateProfileError("papers", "no-profile") },
    });
    expect([approved, outcomes.map(({ status }) => status)]).toEqual([[], Array(9).fill("invalid")]);
    expect(outcomes.map(({ error }) => error)).toEqual([
      "Content hash missing or stale; re-review required.", "Candidate missing or malformed.", "Validated answers must be approved individually with review approve.",
      "Target page changed since this proposal; re-propose against the current page.", "broken citation targets: Gone", "Candidate failed page validation.",
      "Candidate blocked by the write planner.", expect.stringContaining("unsafe candidate id"), expect.stringContaining("no non-default profile"),
    ]);
    expect(log).toEqual(["read s", "read m", "read v", "read t", "target t", "read c", "target c", "refusal c", "read x", "target x", "refusal x",
      "read e", "target e", "refusal e", "default e", "read u", "read y", "target y", "refusal y", "typed y", "gates "]);
  });

  it("P3 a matching body pin passes; an unexpected fault stops the batch before the gate", async () => {
    expect((await plan([{ id: "a", draftContentHash: sha256Text(PAGE) }])).approved).toEqual(["a"]);
    const fault = new Error("EIO");
    const log: string[] = [];
    await expect(planReviewBatchWith(stepsOf(log, { held: { b: fault } }), [{ id: "a" }, { id: "b" }, { id: "c" }],
      ["a", "b", "c"].map((id): ReviewBatchCandidateResult => ({ id, status: "failed" })))).rejects.toBe(fault);
    expect(log).toEqual(["read a", "target a", "refusal a", "default a", "read b"]);
  });

  it("P4 skips an input already in conflict, and refuses every candidate whose target collides under portable comparison", async () => {
    const results: ReviewBatchCandidateResult[] = [{ id: "d", status: "conflict" }, { id: "a", status: "failed" }, { id: "b", status: "failed" }, { id: "k", status: "failed" }];
    const { approved, outcomes, log } = await plan(["d", "a", "b", "k"], { held: { a: candidate("a", { slug: "straße" }), b: candidate("b", { slug: "STRASSE" }) } }, results);
    expect([approved, outcomes.map(({ status }) => status)]).toEqual([["k"], ["conflict", "conflict", "conflict", "failed"]]);
    expect([log.some((line) => line.endsWith(" d")), log.at(-1)]).toEqual([false, "gates k"]);
  });
});

describe("the root form", () => {
  it("R1 reaches every incumbent root step with its old arguments", async () => {
    const held = candidate("a"), typed = candidate("p", { targetEntityType: "papers" });
    const read = vi.spyOn(candidates, "readCandidate").mockImplementation(async (_root, id) => (id === "a" ? held : typed));
    const target = vi.spyOn(precondition, "targetUnchangedSincePropose").mockResolvedValue(true);
    const refusal = vi.spyOn(publication, "genericPublicationRefusal").mockResolvedValue(undefined);
    const planDefault = vi.spyOn(reviewApprove, "planDefaultCandidateWrite").mockResolvedValue(PLANNED);
    const planTyped = vi.spyOn(promote, "planTypedCandidate").mockResolvedValue(PLANNED);
    const gate = vi.spyOn(gates, "rejectBatchRelationGates").mockImplementation(async (_root, approvals) => approvals);
    const approvals = await planReviewBatch("/project", [{ id: "a" }, { id: "p" }], [{ id: "a", status: "failed" }, { id: "p", status: "failed" }]);
    expect(read.mock.calls).toEqual([["/project", "a", { strictIo: true }], ["/project", "p", { strictIo: true }]]);
    expect([target.mock.calls, refusal.mock.calls]).toEqual([[["/project", held], ["/project", typed]], [["/project", held], ["/project", typed]]]);
    expect([planDefault.mock.calls, planTyped.mock.calls, gate.mock.calls]).toEqual([[["/project", held]], [["/project", typed]], [["/project", approvals]]]);
  });
});
