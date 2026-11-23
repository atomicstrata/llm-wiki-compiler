/**
 * @file test/batch/run-store.test.ts
 * @description The batch compile's run store on real disk: versions written
 * after the last checkpoint and published early (a buffer past its bound)
 * stay INVISIBLE to every later attempt, the committed value beneath an
 * overwritten row survives a crash, counters and cursor move only with a
 * checkpoint, a second resume sees the first resume's committed work, a
 * read-only open writes nothing, and a malformed meta is refused rather than
 * read as a finished run.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { activeRunId, BatchRun } from "../../src/compiler/batch/run-store.js";

/** More rows than one buffer holds, so a phase publishes early without a checkpoint. */
const PAST_BUFFER = 4_200;
const IDENTITY = { policy: "p", sources: null, cstate: "c" };

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-run-store-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Write `count` rows `n:<i>` = `value` (publishing early past the buffer). */
async function writeMany(run: BatchRun, count: number, value: unknown): Promise<void> {
  for (let at = 0; at < count; at += 1) await run.put(`n:${String(at).padStart(6, "0")}`, value);
}

/** Every visible `n:` row. */
async function visible(run: BatchRun): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const row of run.scan("n:")) values.push(row.v);
  return values;
}

describe("crash visibility", () => {
  it("hides an unfinished unit's early-published rows from the next attempt, keeping the committed value beneath", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    await run.put("k", "v1");
    run.counters.extracted = 3;
    await run.checkpoint({ cursor: { walked: true } });
    await run.put("k", "v2");
    run.counters.extracted = 99;
    await writeMany(run, PAST_BUFFER, "ghost");
    // The process "crashes" here: no checkpoint. A new attempt resumes.
    const resumed = await BatchRun.resume(root, run.runId);
    expect([await resumed.get("k"), (await visible(resumed)).length, resumed.meta.cursor, resumed.counters.extracted]).toEqual(["v1", 0, { walked: true }, 3]);
    await resumed.put("k", "v3");
    await resumed.checkpoint({ cursor: { walked: true, hashedAfter: "f:b.md" } });
    const again = await BatchRun.resume(root, run.runId);
    expect([await again.get("k"), again.meta.cursor, again.meta.attempts.length]).toEqual(["v3", { walked: true, hashedAfter: "f:b.md" }, 3]);
  });

  it("shows a checkpointed unit's rows, and its own open rows to the attempt writing them", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    await writeMany(run, PAST_BUFFER, "open");
    expect((await visible(run)).length).toBe(PAST_BUFFER);
    await run.del("n:000000");
    await run.checkpoint({ cursor: { walked: true } });
    const resumed = await BatchRun.resume(root, run.runId);
    expect([(await visible(resumed)).length, await resumed.get("n:000000")]).toEqual([PAST_BUFFER - 1, undefined]);
  });
});

describe("committed cursor snapshots", () => {
  it("keeps a checkpointed cursor as published when its caller mutates the object before an early publication", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    await run.advance("closure");
    const position = { head: 0, tail: 1, affected: 0, seeded: true };
    await run.checkpoint({ cursor: { walk: position } });
    // The walk keeps advancing its own position object; the rows it writes force an early publication.
    position.tail = 4_000;
    position.affected = 3_999;
    await writeMany(run, PAST_BUFFER, "frontier");
    const resumed = await BatchRun.resume(root, run.runId);
    expect(resumed.meta.cursor).toEqual({ walk: { head: 0, tail: 1, affected: 0, seeded: true } });
  });
});

describe("opening", () => {
  it("writes nothing when read-only, and refuses writes through it", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    await run.put("k", 1);
    await run.checkpoint();
    const manifest = path.join(root, ".llmwiki", "indexed", `crun-${run.runId}`, "manifest.json");
    const before = await readFile(manifest);
    const reader = await BatchRun.open(root, run.runId);
    expect(await reader.get("k")).toBe(1);
    await expect(reader.put("k", 2)).rejects.toMatchObject({ code: "compile_batch_run_unknown" });
    expect((await readFile(manifest)).equals(before)).toBe(true);
    expect(await activeRunId(root)).toBe(run.runId);
  });

  it("refuses a malformed meta (even one claiming done) instead of treating the run as finished", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    const manifest = path.join(root, ".llmwiki", "indexed", `crun-${run.runId}`, "manifest.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { meta: Record<string, unknown> };
    await writeFile(manifest, JSON.stringify({ ...parsed, meta: { ...parsed.meta, phase: "done", counters: { extracted: -1 } } }));
    await expect(BatchRun.open(root, run.runId)).rejects.toMatchObject({ code: "compile_batch_run_unknown" });
    await expect(activeRunId(root)).rejects.toMatchObject({ code: "compile_batch_run_unknown" });
  });

});

describe("phase cursors", () => {
  it.each([
    ["an unknown field", "listing", { resumeFrom: 3 }],
    ["a key where a generation position belongs", "generate", { after: "999999999999" }],
    ["a position out of range", "plan-state", { after: -2 }],
    ["a field of another phase", "seeds", { after: 3 }],
    ["a resumed position without its companions", "resolve", { after: 4 }],
    ["a resolver apply position without its plan marker", "resolve", { indexed: true, hasNew: false, after: 2, planned: 1, applied: 0 }],
    ["a walk whose head passed its tail", "closure", { walk: { head: 2, tail: 1, affected: 0, seeded: true } }],
    ["an unknown residual step", "residual", { step: "publish" }],
  ])("refuses a cursor with %s", async (_label, phase, cursor) => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    const manifest = path.join(root, ".llmwiki", "indexed", `crun-${run.runId}`, "manifest.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { meta: Record<string, unknown> };
    await writeFile(manifest, JSON.stringify({ ...parsed, meta: { ...parsed.meta, phase, cursor } }));
    await expect(BatchRun.open(root, run.runId)).rejects.toMatchObject({ code: "compile_batch_run_unknown" });
  });

  it("accepts the cursor its phase writes", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: IDENTITY });
    await run.advance("generate", { after: 7 });
    expect((await BatchRun.open(root, run.runId)).meta.cursor).toEqual({ after: 7 });
  });
});
