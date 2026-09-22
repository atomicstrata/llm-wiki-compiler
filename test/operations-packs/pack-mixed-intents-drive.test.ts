/**
 * @file test/operations-packs/pack-mixed-intents-drive.test.ts
 * @description One terminal, three intent GROUPS — the bootstrap shape: a paper
 * page per source, a `cites` relation per source with its relationType pinned as
 * a pack STRING constant, and ONE projection page gated by `whenPresent` to the
 * render output item. Before the group grammar an intent body stamped every
 * draft with its one mutation kind, so this mixed obligation was unauthorable.
 *
 * The draft-set assertion is the teeth: exactly five drafts — two pages, two
 * relations, one projection whose content IS the rendered index — so a
 * regression to single-kind stamping, a dropped whenPresent gate, or a refused
 * string constant each redden a distinct expectation.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { PackIntentDraftV1 } from "../../src/operations-packs/handlers/types.js";
import {
  compileMixedBootstrapAction, driveStagedRun, readPhaseOutput, resultReason,
  stageCompiledAction, stagedRunTracker,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

const INPUT = {
  topic: "superconductivity",
  doi: ["10.1/a", "10.1/b"],
  pid: ["papers/alpha", "papers/beta"],
  cites: ["papers/gamma", "papers/delta"],
} as const;

/** Stage, drive to a handoff, and read the terminal's published drafts. */
async function drivenDrafts(): Promise<PackIntentDraftV1[]> {
  const run = tracker.add(await stageCompiledAction(await compileMixedBootstrapAction(INPUT)));
  const result = await driveStagedRun(run);
  expect(result.status, resultReason(result)).toBe("handed-off");
  return (await readPhaseOutput(run, "propose") as { drafts: PackIntentDraftV1[] }).drafts;
}

describe("G4c-pre: one terminal drafts pages, relations, and a projection", () => {
  it("hands off five drafts across three groups with the pinned relation constant", async () => {
    const drafts = await drivenDrafts();
    const kinds = drafts.map((draft) => draft.mutationKind).sort();
    expect(kinds).toEqual([
      "artifact-upsert", "artifact-upsert", "artifact-upsert", "relation-upsert", "relation-upsert",
    ]);
    const relations = drafts.filter((draft) => draft.mutationKind === "relation-upsert");
    expect(relations.map((draft) => draft.fields["relation-type"])).toEqual(["cites", "cites"]);
    expect(relations.map((draft) => draft.fields.to).sort()).toEqual(["papers/delta", "papers/gamma"]);
  });

  it("gates the projection group to the render item: ONE projection carrying the rendered index", async () => {
    const projections = (await drivenDrafts()).filter((draft) => typeof draft.fields.content === "string");
    expect(projections).toHaveLength(1);
    expect(projections[0]!.fields.content).toBe("# Papers\n- superconductivity\n- superconductivity\n");
    expect(projections[0]!.fields.format).toBe("markdown");
  });
});
