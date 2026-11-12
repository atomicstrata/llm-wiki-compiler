/**
 * @file test/storage/connector-stage-draft-binding.test.ts
 * @description The connector run's locked staging as ONE body over its project
 * steps, `stagePreparedDraftWith` over `PreparedDraftStageSteps`, with no
 * project. This file uses the body, which exists only after staging was given its
 * steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer the candidate selection, the event
 * preflight and append, the profile, the archive and the stage, and log each
 * call with the candidate ids each event carries, so every decision is pinned
 * with the steps it reached: a selection refusal, the noop of an already-staged
 * content hash (preflight, then append), the store-full and no-profile refusals,
 * the preflight before any archive, each archive outcome, the staging failures
 * that are settled refusals against a fault that must throw, and the staged and
 * superseded results. The composition is shown reaching the selection, event and
 * profile bodies, and the root form the incumbents with its root.
 *
 * NOT SHOWN HERE: selection, archive-with-undo and candidate staging themselves;
 * the connector candidate-store suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as audit from "../../src/connectors/audit.js";
import * as supersession from "../../src/connectors/candidate-supersession.js";
import * as stageCandidate from "../../src/connectors/stage-candidate.js";
import {
  preparedDraftStageStepsOver, stagePreparedDraft, stagePreparedDraftWith, type PreparedDraft, type PreparedDraftStageSteps,
} from "../../src/connectors/stage-draft.js";
import * as events from "../../src/events/store.js";
import * as profileBlock from "../../src/profile/block.js";
import { StagedWriteOverflowError } from "../../src/trust/staged-change.js";

afterEach(() => { vi.restoreAllMocks(); });

const DRAFT = {
  entityType: "papers", slug: "paper-a", body: "b", provenance: { connectorId: "c", connectorVersion: "1" },
  idempotencyKey: "k", contentHash: "h-new", draftContentHash: "d", finalUrl: "https://example.test/a",
} as never as PreparedDraft;
const DEPS = { now: () => new Date("2026-10-14T00:00:00.000Z") };

/** One pending candidate under the run's key, staged from `contentHash`. */
const entry = (fileId: string, contentHash: string) => ({ fileId, candidate: { body: "", connectorProvenance: { idempotencyKey: "k", contentHash } } });

/** The ids one connector event carries, as `staged|noop|superseded`. */
const idsOf = (event: { payload: Record<string, unknown> }) => ["stagedCandidateIds", "noopCandidateIds", "supersededCandidateIds"].map((key) => (event.payload[key] as string[]).join(",")).join("|");

/** What the memory steps answer. */
interface StageWorld { selection?: object; profile?: null; archived?: object; stageFault?: Error }

/** Memory staging steps; each call logged. */
function stepsOf(log: string[], world: StageWorld = {}): PreparedDraftStageSteps {
  return {
    selectEntries: async (key) => { log.push(`select ${key}`); return (world.selection ?? { totalPending: 0, entries: [] }) as never; },
    preflightEvent: async (event) => { log.push(`preflight ${idsOf(event as never)}`); },
    appendEvent: async (event) => { log.push(`append ${idsOf(event as never)}`); return {} as never; },
    loadProfile: async () => { log.push("profile"); return world.profile === null ? undefined : { profile: { tag: "profile" } } as never; },
    archive: async (entries, _moves, policy) => { log.push(`archive ${entries.length} ${policy}`); return (world.archived ?? { kind: "archived", receipts: [] }) as never; },
    stage: async (_draft, _profile, _receipts, _moves, _now, _before, policy) => {
      log.push(`stage ${policy}`);
      if (world.stageFault) throw world.stageFault;
      return { kind: "staged", change: { id: "paper-a-1" } } as never;
    },
    appendConnectorEvent: async (_draft, staged, noop, superseded) => { log.push(`connector-event ${[staged, noop, superseded].map((ids) => ids.join(",")).join("|")}`); },
  };
}

/** Run the body over fresh memory steps: the result and the log. */
async function over(world: StageWorld = {}) {
  const log: string[] = [];
  return [await stagePreparedDraftWith(stepsOf(log, world), DRAFT, DEPS), log];
}

describe("connector staging over its project steps", () => {
  it("D1 returns a selection refusal as is; an already-staged content hash is a noop that preflights then appends its event", async () => {
    expect(await over({ selection: { kind: "unavailable", reason: "store locked" } })).toEqual([{ kind: "unavailable", reason: "store locked" }, ["select k"]]);
    expect(await over({ selection: { totalPending: 1, entries: [entry("paper-a-0", "h-new")] } })).toEqual([
      { kind: "noop", candidateIds: ["paper-a-0"] }, ["select k", "preflight |paper-a-0|", "append |paper-a-0|"],
    ]);
  });

  it("D2 refuses a full store before the profile, and a missing profile before any event", async () => {
    const [full, fullLog] = await over({ selection: { totalPending: 500, entries: [] } });
    expect([(full as { kind: string }).kind, fullLog]).toEqual(["unavailable", ["select k"]]);
    expect(await over({ profile: null })).toEqual([{ kind: "unavailable", reason: "connector profile unavailable" }, ["select k", "profile"]]);
  });

  it("D3 preflights the staged stand-in before archiving, stages, then appends the event: superseded with a predecessor, staged without", async () => {
    expect(await over({ selection: { totalPending: 1, entries: [entry("paper-a-0", "h-old")] } })).toEqual([
      { kind: "superseded", archivedIds: ["paper-a-0"], candidateIds: ["paper-a-1"] },
      ["select k", "profile", "preflight paper-a-ffffffff||paper-a-0", "archive 1 public", "stage public", "connector-event paper-a-1||paper-a-0"],
    ]);
    expect((await over())[0]).toEqual({ kind: "staged", candidateIds: ["paper-a-1"] });
  });

  it("D4 maps each archive outcome and each settled staging failure; an unsettled fault throws", async () => {
    expect(await over({ archived: { kind: "recovery-required", candidateIds: ["paper-a-0"] } })).toEqual([
      { kind: "recovery-required", candidateIds: ["paper-a-0"] }, ["select k", "profile", "preflight paper-a-ffffffff||", "archive 0 public"],
    ]);
    expect((await over({ archived: { kind: "failed-and-restored" } }))[0]).toEqual({ kind: "unavailable", reason: "connector could not archive a superseded candidate" });
    const [settled, settledLog] = await over({ stageFault: new StagedWriteOverflowError("per-session", 201, 200) });
    expect([(settled as { kind: string }).kind, (settledLog as string[]).at(-1)]).toEqual(["unavailable", "stage public"]);
    await expect(over({ stageFault: new Error("EIO") })).rejects.toThrow("EIO");
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches the selection, event and profile bodies over their seams", async () => {
    const seams = { selection: { tag: "selection" }, events: { tag: "events" }, profile: { tag: "profile" } } as never as Record<string, never>;
    const select = vi.spyOn(supersession, "selectConnectorCandidateEntriesForRunFrom").mockResolvedValue({ totalPending: 0, entries: [] });
    const preflight = vi.spyOn(events, "preflightEventAppendFrom").mockResolvedValue();
    const append = vi.spyOn(events, "appendEventLockedFrom").mockResolvedValue({} as never);
    const profile = vi.spyOn(profileBlock, "loadNonDefaultProfileFrom").mockResolvedValue({ profile: {} } as never);
    const memory = stepsOf([]);
    await stagePreparedDraftWith(preparedDraftStageStepsOver(seams as never, { archive: memory.archive, stage: memory.stage }), DRAFT, DEPS);
    expect([select.mock.calls[0]?.slice(0, 2), preflight.mock.calls[0]?.[0], profile.mock.calls, append.mock.calls[0]?.[0], idsOf(append.mock.calls[0]?.[1] as never)]).toEqual([
      [seams.selection, "k"], seams.events, [[seams.profile]], seams.events, "paper-a-1||",
    ]);
  });

  it("B2 the root form reaches each incumbent with its root", async () => {
    const select = vi.spyOn(supersession, "selectConnectorCandidateEntriesForRun").mockResolvedValue({ totalPending: 0, entries: [] });
    const preflight = vi.spyOn(events, "preflightEventAppend").mockResolvedValue();
    const profile = vi.spyOn(profileBlock, "loadNonDefaultProfile").mockResolvedValue({ profile: {} } as never);
    const archive = vi.spyOn(supersession, "archiveCandidatesWithUndo").mockResolvedValue({ kind: "archived", receipts: [] });
    const stage = vi.spyOn(stageCandidate, "stageConnectorCandidate").mockResolvedValue({ kind: "staged", change: { id: "paper-a-1" } } as never);
    const event = vi.spyOn(audit, "appendConnectorEvent").mockResolvedValue({});
    expect(await stagePreparedDraft("/project", DRAFT, DEPS)).toEqual({ kind: "staged", candidateIds: ["paper-a-1"] });
    expect([select, preflight, profile, archive, stage, event].map((spy) => spy.mock.calls[0]?.[0])).toEqual(Array(6).fill("/project"));
  });
});
