/**
 * @file test/storage/rule-export-selection-binding.test.ts
 * @description The rule-candidate export's scope selection as ONE body over a
 * supplied listing, `collectRuleCandidatesForExportFrom`, with no project. This
 * file uses the body, which exists only after the selection was given its
 * listing, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. A memory listing returns hand-built candidates of every status
 * in a fixed order, and counts its reads, so the policy is pinned: `approved` by
 * default, each status scope keeping only that status in listing order, `all`
 * keeping the whole listing in its order, one read per selection. The root form
 * is shown listing the candidates of its root through the incumbent.
 *
 * NOT SHOWN HERE: the listing itself (order, parsing) and the serialized JSON;
 * the rule-candidate suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ruleCandidates from "../../src/compiler/rule-candidates.js";
import { collectRuleCandidatesForExport, collectRuleCandidatesForExportFrom } from "../../src/export/rule-candidates-json.js";

afterEach(() => { vi.restoreAllMocks(); });

/** Candidates in listing order, one id per status, with two approved ones apart. */
const LISTING = [
  { id: "rulecand.a.one", status: "approved" },
  { id: "rulecand.a.two", status: "proposed" },
  { id: "rulecand.a.three", status: "rejected" },
  { id: "rulecand.a.four", status: "approved" },
] as never[];

/** The selection over a memory listing: the selected ids and how often it listed. */
async function select(scope?: "approved" | "proposed" | "all") {
  let reads = 0;
  const selected = await collectRuleCandidatesForExportFrom(async () => { reads += 1; return LISTING; }, scope);
  return [selected.map((candidate) => candidate.id), reads];
}

describe("the export scope selection over a supplied listing", () => {
  it("S1 keeps approved candidates by default, in listing order, after one read", async () => {
    expect(await select()).toEqual([["rulecand.a.one", "rulecand.a.four"], 1]);
  });

  it("S2 a status scope keeps only that status; all keeps the whole listing in its order", async () => {
    expect([await select("approved"), await select("proposed"), await select("all")]).toEqual([
      [["rulecand.a.one", "rulecand.a.four"], 1], [["rulecand.a.two"], 1],
      [["rulecand.a.one", "rulecand.a.two", "rulecand.a.three", "rulecand.a.four"], 1],
    ]);
  });
});

describe("the root form", () => {
  it("B1 lists the candidates of its root through the incumbent and selects from that answer", async () => {
    const list = vi.spyOn(ruleCandidates, "listRuleCandidates").mockResolvedValue(LISTING);
    expect([(await collectRuleCandidatesForExport("/project")).length, list.mock.calls]).toEqual([2, [["/project"]]]);
  });
});
