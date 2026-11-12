/**
 * @file test/storage/pending-source-states-binding.test.ts
 * @description What the pending proposal queue means to a compile, as ONE body
 * over a supplied candidate listing, `pendingSourceStatesFrom`, with no project.
 * This file uses the body, which exists only after the projection was given its
 * listing, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. A memory listing returns hand-built candidates in a fixed
 * order, so the projection's policy is pinned: one snapshot per source, the LATER
 * candidate's snapshot replacing an earlier one's for the same source, each
 * carrying its own candidate's modifiers, `""` for a candidate that recorded
 * none, and nothing from a candidate without source states. The local compile
 * records are then shown listing the queue of their root through the incumbent,
 * once, and projecting that answer.
 *
 * NOT SHOWN HERE: the candidate listing itself (order, sanitizing, refusals); the
 * candidate-read suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as candidateRead from "../../src/compiler/candidate-read.js";
import { diskCompileAccess, pendingSourceStatesFrom } from "../../src/compiler/compile-access.js";

afterEach(() => { vi.restoreAllMocks(); });

/** A pending candidate holding `hashes` per source, generated under `modifiers` when given. */
const candidate = (hashes: Record<string, string> | undefined, modifiers?: string) => ({
  ...(hashes === undefined ? {} : { sourceStates: Object.fromEntries(Object.entries(hashes).map(([source, hash]) => [source, { hash, concepts: [], compiledAt: "t" }])) }),
  ...(modifiers === undefined ? {} : { promptModifiers: modifiers }),
});

const QUEUE = [
  candidate({ "a.md": "h-a1", "b.md": "h-b" }, "m-old"),
  candidate(undefined, "m-ignored"),
  candidate({ "a.md": "h-a2" }),
  candidate({ "c.md": "h-c" }, "m-c"),
];

describe("the pending-queue projection over a supplied listing", () => {
  it("P1 keeps one snapshot per source, the later candidate's replacing an earlier one's, each with its own modifiers", async () => {
    let listings = 0;
    const states = await pendingSourceStatesFrom(async () => { listings += 1; return QUEUE as never; });
    expect([[...states.entries()], listings]).toEqual([[
      ["a.md", { hash: "h-a2", modifiers: "" }], ["b.md", { hash: "h-b", modifiers: "m-old" }], ["c.md", { hash: "h-c", modifiers: "m-c" }],
    ], 1]);
  });

  it("P2 an empty queue, or one whose candidates recorded no sources, projects to no snapshot", async () => {
    expect((await pendingSourceStatesFrom(async () => [])).size).toBe(0);
    expect((await pendingSourceStatesFrom(async () => [candidate(undefined, "m"), candidate({})] as never)).size).toBe(0);
  });
});

describe("the local compile records", () => {
  it("B1 list the queue of their root through the incumbent, once, and project that answer", async () => {
    const list = vi.spyOn(candidateRead, "listCandidates").mockResolvedValue(QUEUE as never);
    const states = await diskCompileAccess("/project").pendingSourceStates();
    expect([list.mock.calls, states.get("a.md")]).toEqual([[["/project"]], { hash: "h-a2", modifiers: "" }]);
  });
});
