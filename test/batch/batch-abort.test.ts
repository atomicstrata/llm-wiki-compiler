/**
 * @file test/batch/batch-abort.test.ts
 * @description Witnesses that a BATCH compile's extraction and generation
 * batches stop at their first FATAL model failure, settle what they admitted
 * before the failure escapes, and leave nothing of the failed batch recorded,
 * published or checkpointed.
 *
 * The real batch compile runs (`compileAndReport` on a `local-indexed` project
 * made ready by the shared `segment` fixture, on real disk) under the gated
 * fixture model ({@link GatedProvider}): the test answers each gated call.
 * Every assertion is about observable state: which calls started, whether the
 * compile had settled and still held its lock while a sibling call was
 * outstanding, the original error by identity, the run's committed meta
 * (phase, cursor, counters) and the concept pages on disk.
 *
 * Successful batch caps, order and the recoverable failed-extraction path are
 * covered by the batch parity files (`parity-fresh`, `parity-failure`).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { activeRunId, BatchRun } from "../../src/compiler/batch/run-store.js";
import { compileAndReport } from "../../src/compiler/index.js";
import { LOCK_FILE } from "../../src/utils/constants.js";
import { withQuiet } from "../../src/utils/output.js";
import { drainTurn, expectNoUnhandledRejections, fatal, GatedProvider, type GatedKind } from "../helpers/gated-provider.js";
import { withProvider } from "../helpers/deterministic-provider.js";
import { segment, TWIN_CASE_TIMEOUT_MS, writeSources } from "./helpers.js";

/** The cursor a phase is entered with (`advance(phase, { after: -1 })`): no batch of it checkpointed yet. */
const PHASE_START = -1;
/** Three sources, one concept each (their headings), all in one batch. */
const SOURCES = { "a.md": "# Alpha Ferry\n\nAlpha text.\n", "b.md": "# Beta Library\n\nBeta text.\n", "c.md": "# Gamma Route\n\nGamma text.\n" };

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});
expectNoUnhandledRejections();

/** A `local-indexed` project holding {@link SOURCES}, its segmented compile state ready. */
async function segmentedProject(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-abort-"));
  for (const dir of ["sources", "wiki/concepts", "wiki/queries", ".llmwiki"]) await mkdir(path.join(made, dir), { recursive: true });
  await writeSources(made, SOURCES);
  await segment(made);
  return made;
}

/** The real batch compile at concurrency 2 with `kind` gated; `events` records its settlement. */
function runBatch(project: string, kind: GatedKind) {
  const provider = new GatedProvider(new Set([kind]));
  const events: string[] = [];
  const run = withProvider(provider, () => withQuiet(() => compileAndReport(project, { batchSize: 10, embeddings: false, concurrency: 2 })));
  run.then(() => events.push("resolved"), () => events.push("rejected"));
  return { provider, run, events };
}

/**
 * Fail the first of two in-flight `kind` calls fatally; expect the compile
 * still pending, holding its lock, and no third call; then answer the second
 * and expect the original error. Returns the provider.
 */
async function failFirstOfTwo(project: string, kind: GatedKind): Promise<GatedProvider> {
  const { provider, run, events } = runBatch(project, kind);
  await provider.whenStarted(kind, 2);
  const [first, second] = provider.started(kind);
  const error = fatal(first!);
  provider.answer(kind, first!, error);
  await drainTurn();
  expect([events, existsSync(path.join(project, LOCK_FILE))]).toEqual([[], true]);
  provider.answer(kind, second!);
  await expect(run).rejects.toBe(error);
  expect(provider.started(kind)).toEqual([first, second]);
  return provider;
}

/** The committed meta of the run the failed compile left active. */
async function stoppedRunMeta(project: string) {
  const runId = await activeRunId(project);
  expect(runId).not.toBeNull();
  return (await BatchRun.open(project, runId!)).meta;
}

describe("a batch compile after a fatal model failure", () => {
  it("settles the extraction batch's in-flight call before failing and checkpoints nothing of the batch", async () => {
    root = await segmentedProject();
    const provider = await failFirstOfTwo(root, "extract");
    expect(provider.started("page")).toEqual([]);
    const meta = await stoppedRunMeta(root);
    expect([meta.phase, meta.cursor.after, meta.counters.extracted]).toEqual(["extract", PHASE_START, 0]);
  }, TWIN_CASE_TIMEOUT_MS);

  it("settles the generation batch's in-flight page before failing and publishes or checkpoints nothing of it", async () => {
    root = await segmentedProject();
    await failFirstOfTwo(root, "page");
    expect(await readdir(path.join(root, "wiki/concepts"))).toEqual([]);
    const meta = await stoppedRunMeta(root);
    expect([meta.phase, meta.cursor.after, meta.counters.pagesWritten]).toEqual(["generate", PHASE_START, 0]);
  }, TWIN_CASE_TIMEOUT_MS);
});
