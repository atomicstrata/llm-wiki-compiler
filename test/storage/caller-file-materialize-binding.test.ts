/**
 * @file test/storage/caller-file-materialize-binding.test.ts
 * @description Caller-file materialization as ONE body over its two project
 * calls, `materializeCallerFileInputWith` over `CallerFileEvidenceSteps`, with no
 * project directory: only the CALLER's file is real, as it must be. This file
 * uses the body, which exists only after it was given its steps, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. A caller file is written and planned by the real planner;
 * memory steps answer the evidence stream and the presence read and log each
 * call, so the copy-then-recheck order, each stream outcome's refusal, the
 * recheck after a swap and the presence check are pinned. The composition is
 * shown reaching the evidence store's own bodies, and the root form the
 * incumbents with exact arguments.
 *
 * NOT SHOWN HERE: the CAS itself and the caller file's confinement; the evidence
 * store, prepared-input and input-swap suites show those.
 */

import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import {
  MAX_PREPARED_INPUT_OBJECT_BYTES, callerFileEvidenceStepsOver, materializeCallerFileInput, materializeCallerFileInputWith, planCallerFileInput,
  type CallerFileEvidenceSteps,
} from "../../src/preparations/inputs.js";
import { tempRootTracker } from "../temp-roots.js";
import { callerSource, writeSourceFile } from "../preparations/inputs-fixture.js";

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

const LOCATION = { workspaceId: "research", preparationId: "prep_1" } as never;

/** A real caller file planned by the real planner: its path and its prepared descriptor. */
async function plannedCallerFile(bytes = Buffer.from("caller-bytes")) {
  const sources = `${await tracker.create("caller-file-binding-")}/sources`;
  const leaf = await writeSourceFile(sources, "input.txt", bytes);
  const planned = await planCallerFileInput(callerSource(sources, leaf));
  if (planned.status !== "planned") throw new Error("the caller file did not plan");
  return { leaf, prepared: planned.prepared };
}

/** Memory project steps answering `stream` and `present`, each call logged. */
function stepsOf(log: string[], stream = "written", present = "ok"): CallerFileEvidenceSteps {
  return {
    streamEvidence: async (_location, _source, digest, max) => { log.push(`stream ${digest.slice(0, 15)} ${max}`); return { status: stream } as never; },
    readEvidence: async (_location, digest) => { log.push(`read ${digest.slice(0, 15)}`); return { status: present } as never; },
  };
}

describe("caller-file materialization over its project steps", () => {
  it("M1 streams the caller file into the CAS, rechecks the caller file, then confirms presence", async () => {
    const { prepared } = await plannedCallerFile();
    const log: string[] = [];
    expect(await materializeCallerFileInputWith(stepsOf(log), LOCATION, prepared)).toEqual({ status: "materialized" });
    expect(log).toEqual([`stream ${prepared.digest.slice(0, 15)} ${MAX_PREPARED_INPUT_OBJECT_BYTES}`, `read ${prepared.digest.slice(0, 15)}`]);
  });

  it("M2 maps each stream outcome to its refusal and never confirms presence after one", async () => {
    const { prepared } = await plannedCallerFile();
    const refusals: unknown[] = [];
    for (const stream of ["oversize", "read-fault", "digest-mismatch"]) {
      const log: string[] = [];
      refusals.push([await materializeCallerFileInputWith(stepsOf(log, stream), LOCATION, prepared), log.length]);
    }
    expect(refusals).toEqual([
      [{ status: "unavailable", code: "oversize" }, 1], [{ status: "unavailable", code: "second-read-unavailable" }, 1],
      [{ status: "unavailable", code: "changed-digest" }, 1],
    ]);
  });

  it("M3 a caller file swapped before the recheck refuses without the presence read; an absent object after it refuses", async () => {
    const { leaf, prepared } = await plannedCallerFile(Buffer.from("stable-1"));
    const log: string[] = [];
    const swapped = await materializeCallerFileInputWith(stepsOf(log), LOCATION, prepared, { beforeRecheck: () => writeFile(leaf, Buffer.from("stable-2")) });
    expect([swapped.status, log.filter((call) => call.startsWith("read"))]).toEqual(["unavailable", []]);
    const fresh = await plannedCallerFile(Buffer.from("other"));
    expect(await materializeCallerFileInputWith(stepsOf([], "written", "absent"), LOCATION, fresh.prepared)).toEqual({ status: "unavailable", code: "second-read-unavailable" });
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition reaches the evidence store's own stream and read bodies over their seams", async () => {
    const { prepared } = await plannedCallerFile();
    const seams = { writes: { tag: "writes" }, reads: { tag: "reads" } } as never as Record<string, never>;
    const stream = vi.spyOn(evidenceStore, "streamPreparationEvidenceCreateOnlyWith").mockResolvedValue({ status: "written" } as never);
    const read = vi.spyOn(evidenceStore, "readPreparationEvidenceFrom").mockResolvedValue({ status: "ok", byteCount: 1 });
    await materializeCallerFileInputWith(callerFileEvidenceStepsOver({ writes: seams.writes, reads: seams.reads }), LOCATION, prepared);
    expect([stream.mock.calls[0]?.[0], stream.mock.calls[0]?.[1], stream.mock.calls[0]?.[3], read.mock.calls]).toEqual([seams.writes, LOCATION, prepared.digest, [[seams.reads, LOCATION, prepared.digest]]]);
  });

  it("B2 the root form reaches the incumbent stream and read with its root", async () => {
    const { prepared } = await plannedCallerFile();
    const stream = vi.spyOn(evidenceStore, "streamPreparationEvidenceCreateOnly").mockResolvedValue({ status: "written" } as never);
    const read = vi.spyOn(evidenceStore, "readPreparationEvidence").mockResolvedValue({ status: "ok", byteCount: 1 });
    expect(await materializeCallerFileInput("/project", LOCATION, prepared)).toEqual({ status: "materialized" });
    expect([stream.mock.calls[0]?.[0], stream.mock.calls[0]?.[1], stream.mock.calls[0]?.[3], read.mock.calls]).toEqual(["/project", LOCATION, prepared.digest, [["/project", LOCATION, prepared.digest]]]);
  });
});
