/**
 * @file test/batch/frontier-kill.test.ts
 * @description A REAL PROCESS DEATH inside the batch compile's closure
 * frontier, past the run store's 4,096-row early-publication bound and before
 * the walk's next checkpoint, then a fresh-process resume (CHILD processes,
 * `./fixtures/frontier-child.ts`).
 *
 * 5,000 compiled sources all own one shared concept and one is edited, so the
 * production closure's FIRST visit affects the 4,999 co-owners (~15,000 row
 * writes). Each process is observed where the walk first reads its second
 * queued source: the uninterrupted process and the resumed one must see the
 * same affected list, queue and visited set there (the resumed one in its
 * second attempt). One visit only, so the witness stays linear in the
 * sources. (The injected-exception resume witnesses are in
 * `./resume.test.ts`; this one is process death.)
 *
 * TWO TIMED PHASES. Building the two identical fixture projects (5,000
 * sources each, written serially, then prepared `local-indexed` with the
 * segmented compile state) is a precondition, not part of the witness, so it
 * runs in `beforeAll` under its own bound; the correctness action (observe,
 * kill, resume, compare) runs in the case under the same bound. The fixtures,
 * their order and every assertion are unchanged; only which timer covers the
 * setup changed. This allows more total time than one shared timer did; it
 * claims no speedup or timing reliability.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterAll, beforeAll } from "../config/storage-profile-hooks.js";
import { sourceHashOf } from "../../src/compiler/batch/sources.js";
import { writeState } from "../../src/utils/state.js";
import type { WikiState } from "../../src/utils/types.js";
import { bundleChild, runChild } from "../helpers-child-process.js";
import { segment, sourceNaming, writeSources } from "./helpers.js";

/**
 * The bound of EACH phase: the fixture setup (bundling and both projects, in
 * `beforeAll`) and the correctness action (the case). Writing, preparing and
 * hashing 5,000 sources on the loaded test volume takes minutes per phase.
 */
const FRONTIER_TIMEOUT_MS = 900_000;
const SOURCE_COUNT = 5_000;
/** The closure write the kill lands on: well past the 4,096-row early-publication bound. */
const KILL_AT_WRITE = 9_000;
const owned: string[] = [];
let script = "";
/** The project compiled without interruption, and the one killed then resumed (built in that order). */
let whole = "";
let killed = "";

beforeAll(async () => {
  script = await bundleChild("test/batch/fixtures/frontier-child.ts");
  whole = await sharedHubProject();
  killed = await sharedHubProject();
}, FRONTIER_TIMEOUT_MS);
afterAll(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A segmented project of compiled sources sharing "hub", with `s00000.md` then edited. */
async function sharedHubProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-frontier-"));
  owned.push(root);
  const sources: Record<string, string> = {};
  const state: WikiState = { version: 1, indexHash: "", sources: {} };
  for (let at = 0; at < SOURCE_COUNT; at += 1) {
    const name = `s${String(at).padStart(5, "0")}.md`;
    sources[name] = sourceNaming(`S${at}`, "Hub");
    state.sources[name] = { hash: sourceHashOf(sources[name]!), concepts: ["hub"], compiledAt: "2026-10-01T00:00:00.000Z" };
  }
  await writeSources(root, sources);
  await writeState(root, state);
  await segment(root);
  await writeFile(path.join(root, "sources", "s00000.md"), sourceNaming("S0 edited", "Hub"));
  return root;
}

/** What one child observed at the second visit. */
async function observed(root: string): Promise<Record<string, unknown>> {
  const end = await runChild(script, ["observe", root]);
  expect(end.json?.outcome, end.stderr).toBe("observed");
  return end.json!.seen as Record<string, unknown>;
}

describe("a process death inside the closure frontier", () => {
  it("resumes in a fresh process to exactly the uninterrupted frontier", async () => {
    const expected = await observed(whole);
    expect(expected).toMatchObject({ affected: { count: SOURCE_COUNT - 1 }, queue: { count: SOURCE_COUNT }, attempts: 1 });
    const death = await runChild(script, ["kill", killed, String(KILL_AT_WRITE)]);
    expect([death.signal, death.json]).toEqual(["SIGKILL", null]);
    const resumed = await observed(killed);
    expect(resumed).toEqual({ ...expected, attempts: 2 });
  }, FRONTIER_TIMEOUT_MS);
});
