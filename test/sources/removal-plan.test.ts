/**
 * @file test/sources/removal-plan.test.ts
 * @description Coverage for the pure removal planner (`src/sources/removal-plan.ts`)
 * that decides what `llmwiki rm` is allowed to delete.
 *
 * The suite pins the one rule the maintainer cares about most: a concept owned by
 * more than one source must survive even when one of its sources is removed. That
 * guarantee comes from delegating to `findSharedConcepts` — the same function
 * compile's `markOrphaned` uses — so this suite is exercising the delegation
 * itself, not a parallel reimplementation of the rule that could quietly drift
 * from it. It also covers the plan's two downstream consequences (wikilinks a
 * deletion would break, pending review candidates that reference the removed
 * source) and the total case of a source with no state entry at all.
 *
 * `partitionConcepts` is covered directly as well as through the planner,
 * because it is now the SHARED split used twice per removal — once for the
 * pre-lock plan and once by `applyRemovalLocked` against state read under the
 * lock. Those two comparing at all depends on them being the same function.
 */

import { describe, it, expect } from "vitest";
import {
  computeRemovalPlan,
  partitionConcepts,
  type RemovalPlan,
  type RemovalPlanInput,
} from "../../src/sources/removal-plan.js";
import type { WikiState, ReviewCandidate } from "../../src/utils/types.js";

/** A v1 state where `bad.md` owns `junk` + `shared`, and `good.md` also owns `shared`. */
function twoSourceState(): WikiState {
  return {
    version: 1,
    indexHash: "h",
    sources: {
      "bad.md": { hash: "a", concepts: ["junk", "shared"], compiledAt: "2026-01-01T00:00:00Z" },
      "good.md": { hash: "b", concepts: ["shared"], compiledAt: "2026-01-01T00:00:00Z" },
    },
  };
}

/**
 * `computeRemovalPlan` with the inputs this suite rarely varies pre-filled:
 * removing `bad.md` from {@link twoSourceState} on a default project whose
 * source file is still on disk. Each test overrides only the field it is
 * actually about, so the calls don't drift into near-identical copies (which
 * fallow's clone detector flags) and adding an input field doesn't mean editing
 * every test.
 */
function planFor(overrides: Partial<RemovalPlanInput> = {}): RemovalPlan {
  return computeRemovalPlan({
    sourceFile: "bad.md",
    state: twoSourceState(),
    pages: [],
    candidates: [],
    profileId: null,
    sourcePresent: true,
    ...overrides,
  });
}

describe("partitionConcepts", () => {
  it("splits a source's concepts into exclusively-owned and still-shared", () => {
    expect(partitionConcepts("bad.md", twoSourceState())).toEqual({
      deleteSlugs: ["junk"],
      keptSlugs: ["shared"],
    });
  });

  it("returns two empty lists for a source with no state entry", () => {
    expect(partitionConcepts("never-compiled.md", twoSourceState())).toEqual({
      deleteSlugs: [],
      keptSlugs: [],
    });
  });
});

describe("computeRemovalPlan", () => {
  it("deletes exclusively-owned concepts and keeps shared ones", () => {
    const plan = planFor();

    expect(plan.deleteSlugs).toEqual(["junk"]);
    expect(plan.keptSlugs).toEqual(["shared"]);
  });

  it("reports surviving pages whose wikilinks point at a deleted page", () => {
    const plan = planFor({
      pages: [
        { filePath: "wiki/concepts/shared.md", content: "see [[Junk]] and [[Shared]]" },
        { filePath: "wiki/concepts/junk.md", content: "the doomed page's own [[Junk]] link" },
      ],
    });

    // Only the SURVIVOR is reported; the doomed page's own link is irrelevant.
    expect(plan.brokenLinks).toEqual([{ file: "wiki/concepts/shared.md", target: "junk" }]);
  });

  it("reports pending candidates that reference the removed source", () => {
    const candidate = { id: "c1", sources: ["bad.md"] } as ReviewCandidate;
    const other = { id: "c2", sources: ["good.md"] } as ReviewCandidate;

    const plan = planFor({ candidates: [candidate, other] });

    expect(plan.candidateRefs).toEqual(["c1"]);
  });

  it("returns an empty plan for a source with no state entry", () => {
    const plan = planFor({
      sourceFile: "never-compiled.md",
      pages: [{ filePath: "wiki/concepts/shared.md", content: "[[Shared]]" }],
    });

    expect(plan).toEqual({
      sourceFile: "never-compiled.md",
      deleteSlugs: [],
      keptSlugs: [],
      brokenLinks: [],
      candidateRefs: [],
      profileId: null,
      sourcePresent: true,
    });
  });

  // P1 audit fix: typed entity pages record no source ownership anywhere, so
  // the plan's `profileId` is the CLI's only signal that `deleteSlugs`/
  // `keptSlugs` aren't the full story for this source. The planner must not
  // originate that value itself — it only ever echoes what the caller supplied.
  it("returns profileId: null for a default project", () => {
    expect(planFor().profileId).toBeNull();
  });

  it("passes a non-null profileId straight through, unmodified", () => {
    expect(planFor({ profileId: "sample" }).profileId).toBe("sample");
  });

  // sourcePresent is likewise echoed, never inferred: the planner does no I/O,
  // and `false` is what tells the CLI to stop claiming it deleted a source file
  // that a previous, interrupted removal had already unlinked.
  it("passes sourcePresent straight through for a resumed removal", () => {
    expect(planFor({ sourcePresent: false }).sourcePresent).toBe(false);
  });
});
