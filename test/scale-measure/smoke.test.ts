/**
 * @file test/scale-measure/smoke.test.ts
 * @description A smoke run of the measurement harness on a TINY corpus (2
 * documents, so it is quick): every build phase and every measured operation
 * runs in its own child process through the real routes, none fails, the
 * narrow reads report their segment counters and the process-wide tallies,
 * and the offline embedding double answered at the measured width with no
 * network; the offline compile processes exactly the corpus, and after the
 * synthetic processed-source checkpoint a real compile is a true no-op; a calibration child's instrumented
 * byte tallies equal its fixture's. The `indexed-smoke` variant requests {@link SMOKE_EXPECTED_DOCUMENTS} documents
 * (init needs about 3.2 GB free on the temp volume; the graduated 10,000 needs about 8.3 GB). The real graduated
 * runs (100, 1,000 and 10,000 documents) are invoked explicitly, not by the test suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterAll, beforeAll } from "../config/storage-profile-hooks.js";
import { runMeasurements, SMOKE_EXPECTED_DOCUMENTS } from "./run.js";

/**
 * The setup runs 31 child processes one after another, its durable event and
 * relation build phases each taking over a minute on the EJ8T-backed test
 * volume, so it gets its own explicit bound. A bound, not a speed claim.
 */
const SETUP_TIMEOUT_MS = 900_000;

let base: string;
let results: { entries: Array<Record<string, unknown>> };
beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "llmwiki-measure-smoke-"));
  results = await runMeasurements(path.join(base, "results.json"), [["indexed-smoke", 2], ["calibration", 0]], path.join(base, "work")) as typeof results;
}, SETUP_TIMEOUT_MS);
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

/** The entry of one build phase or operation. */
const entry = (name: string) => results.entries.find((item) => item.name === name) as { runs: Array<{ counters: Record<string, number>; fs: Record<string, unknown>; embeddedTexts: number; result: Record<string, unknown> }> };

describe("the measurement harness", () => {
  it("runs every phase and operation in a child without a failure", () => {
    expect(results.entries.filter((item) => item.failed === true)).toEqual([]);
    expect(results.entries).toHaveLength(31);
  });

  it("reports segment counters, per-area tallies and offline embeddings at the measured width", () => {
    expect(entry("list-pages").runs[1]!.counters.rowsReturned).toBe(2);
    expect(entry("list-pages").runs[0]!.fs).toHaveProperty("indexed.opens");
    expect(entry("init").runs[0]!.result).toEqual({ expectedDocuments: SMOKE_EXPECTED_DOCUMENTS, architecture: "local-indexed" });
    expect(entry("vectors").runs[0]!.result).toEqual({ pages: 2, chunks: 2, dimensions: 1536 });
    expect(entry("vector-search").runs[0]!.result).toEqual({ pages: 2, chunks: 2 });
    expect(entry("compile-offline").runs[0]!.result).toEqual({ compiled: 2, skipped: 0, emptyExtractions: 2 });
    expect(entry("noop-checkpoint").runs[0]!.result).toEqual({ recorded: 2 });
    expect(entry("compile-noop").runs.map((run) => run.result)).toEqual([{ compiled: 0, skipped: 2 }, { compiled: 0, skipped: 2 }]);
  });

  it("counts exactly the calibration fixture's bytes through every instrumented entry point", () => {
    const { runs } = entry("fs-calibration");
    const expected = runs[0]!.result.expected as Record<string, number>;
    for (const run of runs) expect(run.fs.other).toMatchObject(expected);
  });
});
