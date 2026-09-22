/**
 * @file test/operations-packs/pack-multi-source-drive.test.ts
 * @description G4a multi-item action input, proven end to end: a `string-list`
 * input field is a COLUMN, so a two-doi input decodes to two evidence items and
 * the paper pipeline drafts one page per source in ONE preparation run. The
 * eligibility half shows the per-source gate: an identityless source is filtered
 * at pick — visible in its published exclusion — and the run still hands off the
 * surviving source. Before G4a any list-valued input field refused the phase
 * outright (`pack-input-field-unrepresentable`), so a multi-source bootstrap was
 * unrepresentable in a single run.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { RunPreparationResultV1 } from "../../src/preparations/runner.js";
import {
  compileMultiSourcePaperAction, driveStagedRun, readPhaseOutput, resultReason,
  stageCompiledAction, stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** Stage and drive the multi-source paper action over the given doi column. */
async function driveSources(
  doi: readonly string[],
): Promise<{ run: StagedPackRunV1; result: RunPreparationResultV1 }> {
  const run = tracker.add(await stageCompiledAction(
    await compileMultiSourcePaperAction({ topic: "superconductivity", doi })));
  return { run, result: await driveStagedRun(run) };
}

/** The drafts the terminal published, with the fields this suite asserts on. */
async function draftsOf(run: StagedPackRunV1): Promise<{ sourceItemId: string; payloadDigest: string }[]> {
  const published = await readPhaseOutput(run, "propose") as {
    drafts: { sourceItemId: string; payloadDigest: string }[];
  };
  return published.drafts;
}

describe("G4a: a multi-source action input drives one item per source", () => {
  it("hands off TWO drafts with DIFFERENT payloads for a two-doi input", async () => {
    const { run, result } = await driveSources(["10.1/a", "10.1/b"]);
    expect(result.status, resultReason(result)).toBe("handed-off");
    const drafts = await draftsOf(run);
    expect(drafts.map((draft) => draft.sourceItemId)).toEqual(["source-0", "source-1"]);
    // The per-item doi is mapped into the draft, so the two payloads must differ
    // — two sources produce two proposals, not two copies of one.
    expect(new Set(drafts.map((draft) => draft.payloadDigest)).size).toBe(2);
  });

  it("filters an identityless source at pick and still hands off the survivor", async () => {
    const { run, result } = await driveSources(["10.1/a", ""]);
    expect(result.status, resultReason(result)).toBe("handed-off");
    expect((await draftsOf(run)).map((draft) => draft.sourceItemId)).toEqual(["source-0"]);
    // The drop is visible where it happened: pick's published selection names
    // the excluded source. The terminal's completeness sees pick's OUTPUT, so
    // this is an eligibility exclusion, not a required deficit.
    const pick = await readPhaseOutput(run, "pick") as { selection: { excluded: unknown } };
    expect(pick.selection.excluded).toEqual([{ itemId: "source-1", reason: "filtered-out" }]);
  });
});
